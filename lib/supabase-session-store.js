// express-session のセッションストア（Supabase テーブル http_sessions 版・ADR 040）
//
// 以前は connect-sqlite3 で Railway Volume 上の /app/data/sessions.db に保存していた。
// Volume 付きサービスは Volume を同時に 1 コンテナにしかマウントできないため、Railway のデプロイが
// 「旧停止 → 新起動」の順次切替になり、デプロイのたびに約 13 秒の 502 が出ていた。
// セッションを Supabase に移して Volume を外すことで、healthcheck 経由の重なり切替（ゼロダウンタイム）にする。
//
// 実装方針:
//   - get は毎リクエスト呼ばれる → プロセス内キャッシュ（TTL 60 秒）で Supabase 往復を減らす。
//     set / destroy は write-through でキャッシュも更新・削除。
//     キャッシュにはシリアライズ済み JSON を置き、返すときに parse する（参照共有で意図せず書き換わるのを防ぐ）。
//   - express-session は resave:false でも「変更なし」のリクエストごとに touch を呼ぶ。
//     毎回 UPDATE すると 1 画面で数十回の書込になるため、sid ごとに 10 分に 1 回だけ expired_at を書き戻す
//     （Cookie maxAge 7 日に対して誤差 10 分は無視できる）。
//   - 失効行は 15 分周期のスイープで削除（idx_http_sessions_expired_at）。
//   - Supabase 到達不能時は get がエラーになりそのリクエストは 500。アプリのデータ自体が Supabase なので
//     この状況では元々サービス不能であり、SQLite 併用などのフォールバックは持たない。
'use strict';

const { Store } = require('express-session');

const DEFAULTS = {
  table: 'http_sessions',
  ttlMs: 7 * 24 * 60 * 60 * 1000,      // cookie.maxAge / expires が無いときの既定寿命
  cacheTtlMs: 60 * 1000,               // get のキャッシュ有効期間
  touchThrottleMs: 10 * 60 * 1000,     // touch の DB 書込間隔（sid ごと）
  cleanupIntervalMs: 15 * 60 * 1000,   // 失効行スイープ周期（0 以下で無効）
  maxCacheEntries: 5000,               // キャッシュ上限（超えたら古い順に捨てる）
};

class SupabaseSessionStore extends Store {
  /**
   * @param {object} opts
   * @param {import('@supabase/supabase-js').SupabaseClient} opts.supabase  service_role クライアント
   * @param {string}  [opts.table]
   * @param {number}  [opts.ttlMs]
   * @param {number}  [opts.cacheTtlMs]
   * @param {number}  [opts.touchThrottleMs]
   * @param {number}  [opts.cleanupIntervalMs]
   * @param {number}  [opts.maxCacheEntries]
   * @param {{log:Function,warn:Function,error:Function}} [opts.logger]
   */
  constructor(opts = {}) {
    super();
    if (!opts.supabase) throw new Error('[session-store] supabase client is required');
    this.supabase = opts.supabase;
    this.table = opts.table || DEFAULTS.table;
    this.ttlMs = opts.ttlMs || DEFAULTS.ttlMs;
    this.cacheTtlMs = opts.cacheTtlMs != null ? opts.cacheTtlMs : DEFAULTS.cacheTtlMs;
    this.touchThrottleMs = opts.touchThrottleMs != null ? opts.touchThrottleMs : DEFAULTS.touchThrottleMs;
    this.maxCacheEntries = opts.maxCacheEntries || DEFAULTS.maxCacheEntries;
    this.logger = opts.logger || console;
    // sid -> { json, expiredAt(ms), cachedAt(ms), lastTouchWriteAt(ms) }
    this._cache = new Map();

    const cleanupIntervalMs = opts.cleanupIntervalMs != null ? opts.cleanupIntervalMs : DEFAULTS.cleanupIntervalMs;
    if (cleanupIntervalMs > 0) {
      this._cleanupTimer = setInterval(() => {
        this.cleanupExpired().catch((e) => {
          try { this.logger.warn('[session-store] 失効セッションの掃除に失敗:', e.message); } catch (_) {}
        });
      }, cleanupIntervalMs);
      if (typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref();
    }
  }

  // ---- express-session インターフェース（コールバック形式） ----

  get(sid, cb) {
    this._get(sid).then((sess) => cb(null, sess), (err) => cb(err));
  }

  set(sid, sess, cb) {
    this._set(sid, sess).then(() => cb && cb(null), (err) => cb && cb(err));
  }

  touch(sid, sess, cb) {
    this._touch(sid, sess).then(() => cb && cb(null), (err) => cb && cb(err));
  }

  destroy(sid, cb) {
    this._destroy(sid).then(() => cb && cb(null), (err) => cb && cb(err));
  }

  // ---- 内部実装（Promise） ----

  _expiryOf(sess) {
    const cookie = sess && sess.cookie;
    if (cookie && cookie.expires) {
      const t = new Date(cookie.expires).getTime();
      if (Number.isFinite(t)) return t;
    }
    const maxAge = cookie && cookie.maxAge;
    return Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : this.ttlMs);
  }

  _cachePut(sid, entry) {
    // Map は挿入順を保つので、上限超過時は先頭（最も古い put）から捨てる
    if (this._cache.has(sid)) this._cache.delete(sid);
    this._cache.set(sid, entry);
    while (this._cache.size > this.maxCacheEntries) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }

  async _get(sid) {
    const now = Date.now();
    const cached = this._cache.get(sid);
    if (cached) {
      if (cached.expiredAt <= now) {
        this._cache.delete(sid);
        return null;
      }
      if (now - cached.cachedAt < this.cacheTtlMs) return JSON.parse(cached.json);
    }
    const { data, error } = await this.supabase
      .from(this.table)
      .select('sess, expired_at')
      .eq('sid', sid)
      .maybeSingle();
    if (error) throw new Error(`[session-store] get failed: ${error.message}`);
    if (!data) {
      this._cache.delete(sid);
      return null;
    }
    const expiredAt = new Date(data.expired_at).getTime();
    if (!(expiredAt > now)) {
      this._cache.delete(sid);
      // 失効行は読まずに捨てる（削除失敗はスイープに任せる）
      this._destroy(sid).catch(() => {});
      return null;
    }
    const json = typeof data.sess === 'string' ? data.sess : JSON.stringify(data.sess);
    this._cachePut(sid, {
      json,
      expiredAt,
      cachedAt: now,
      lastTouchWriteAt: cached ? cached.lastTouchWriteAt : now,
    });
    return JSON.parse(json);
  }

  async _set(sid, sess) {
    const now = Date.now();
    const expiredAt = this._expiryOf(sess);
    const json = JSON.stringify(sess);
    const { error } = await this.supabase
      .from(this.table)
      .upsert({
        sid,
        sess: JSON.parse(json),
        expired_at: new Date(expiredAt).toISOString(),
        updated_at: new Date(now).toISOString(),
      }, { onConflict: 'sid' });
    if (error) throw new Error(`[session-store] set failed: ${error.message}`);
    this._cachePut(sid, { json, expiredAt, cachedAt: now, lastTouchWriteAt: now });
  }

  async _touch(sid, sess) {
    const now = Date.now();
    const expiredAt = this._expiryOf(sess);
    const cached = this._cache.get(sid);
    if (cached) {
      cached.expiredAt = expiredAt; // キャッシュ上の寿命は毎回伸ばす（DB 書込は間引く）
      if (now - cached.lastTouchWriteAt < this.touchThrottleMs) return;
    }
    const { error } = await this.supabase
      .from(this.table)
      .update({
        expired_at: new Date(expiredAt).toISOString(),
        updated_at: new Date(now).toISOString(),
      })
      .eq('sid', sid);
    if (error) throw new Error(`[session-store] touch failed: ${error.message}`);
    if (cached) {
      cached.lastTouchWriteAt = now;
    } else {
      this._cachePut(sid, { json: JSON.stringify(sess), expiredAt, cachedAt: now, lastTouchWriteAt: now });
    }
  }

  async _destroy(sid) {
    this._cache.delete(sid);
    const { error } = await this.supabase.from(this.table).delete().eq('sid', sid);
    if (error) throw new Error(`[session-store] destroy failed: ${error.message}`);
  }

  /** 失効した行を削除する（15 分周期。起動直後にも 1 回呼ぶ） */
  async cleanupExpired() {
    const nowIso = new Date().toISOString();
    for (const [sid, entry] of this._cache) {
      if (entry.expiredAt <= Date.now()) this._cache.delete(sid);
    }
    const { error } = await this.supabase.from(this.table).delete().lt('expired_at', nowIso);
    if (error) throw new Error(`[session-store] cleanup failed: ${error.message}`);
  }

  /** テスト・シャットダウン用 */
  close() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = null;
    this._cache.clear();
  }
}

module.exports = { SupabaseSessionStore, DEFAULTS };
