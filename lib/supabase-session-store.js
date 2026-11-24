// express-session のセッションストア（Supabase テーブル http_sessions 版・ADR 040）
//
// 以前は connect-sqlite3 で Railway Volume 上の /app/data/sessions.db に保存していた。
// Volume 付きサービスは Volume を同時に 1 コンテナにしかマウントできないため、Railway のデプロイが
// 「旧停止 → 新起動」の順次切替になり、デプロイのたびに約 13 秒の 502 が出ていた。
// セッションを Supabase に移して Volume を外すことで、healthcheck 経由の重なり切替（ゼロダウンタイム）にする。
//
// 実装方針:
//   - get は毎リクエスト呼ばれる → プロセス内キャッシュ（TTL 5 秒）で、1 画面ぶんの API 連打を 1 回の select にまとめる。
//     TTL を短くしているのは、デプロイの重なり切替中など 2 コンテナが同時に動くとき、片方の logout / 再認証の
//     書込みがもう片方のキャッシュに見えない時間を数秒に抑えるため（キャッシュはプロセスごとで共有しない）。
//     set / destroy は write-through でキャッシュも更新・削除。
//     キャッシュにはシリアライズ済み JSON を置き、返すときに parse する（参照共有で意図せず書き換わるのを防ぐ）。
//   - DB に無い sid（切替直後の旧 SQLite の Cookie 等）も同じ TTL だけ「無し」として覚え、静的ファイルの連打で
//     select が並ばないようにする（後から set されれば上書き）。
//   - get の select 待ちの間に同じ sid へ set / destroy が走ったら、その get の結果はキャッシュに入れない
//     （logout 直後に古い「ログイン中」のセッションがキャッシュに戻るのを防ぐ）。
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
  cacheTtlMs: 5 * 1000,                // get のキャッシュ有効期間（DB に無い sid の「無し」キャッシュも同じ）
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
    // json が null のエントリは「DB に無い sid」の否定キャッシュ
    this._cache = new Map();
    // 書込み（set / destroy）の通し番号。get / touch の DB 待ちの間に同じ sid へ書込みがあったかを見分ける
    this._seq = 0;
    this._lastWriteSeq = new Map(); // sid -> 最後の set / destroy の通し番号
    this._pruneSeq = 0;

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

  _markWrite(sid) {
    const seq = ++this._seq;
    this._lastWriteSeq.set(sid, seq);
    return seq;
  }

  _writtenSince(sid, seq) {
    return (this._lastWriteSeq.get(sid) || 0) > seq;
  }

  _cachePut(sid, entry) {
    // Map は挿入順を保つので、上限超過時は先頭（最も長く使われていないもの）から捨てる。
    // キャッシュヒット時も入れ直すので、よく使われるセッションほど後ろに残る（LRU）
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
      if (cached.json === null) {
        if (now - cached.cachedAt < this.cacheTtlMs) return null;
      } else if (cached.expiredAt <= now) {
        this._cache.delete(sid);
        return null;
      } else if (now - cached.cachedAt < this.cacheTtlMs) {
        this._cachePut(sid, cached); // LRU: 使われたものを後ろへ
        return JSON.parse(cached.json);
      }
    }
    const startSeq = this._seq;
    const { data, error } = await this.supabase
      .from(this.table)
      .select('sess, expired_at')
      .eq('sid', sid)
      .maybeSingle();
    if (error) throw new Error(`[session-store] get failed: ${error.message}`);
    if (!data) {
      if (this._writtenSince(sid, startSeq)) return null; // 待っている間に set された → キャッシュは set のものを残す
      this._cachePut(sid, { json: null, expiredAt: 0, cachedAt: now, lastTouchWriteAt: 0 });
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
    // select を待っている間に set / destroy が走っていたら、この結果は古いのでキャッシュしない
    if (this._writtenSince(sid, startSeq)) return JSON.parse(json);
    this._cachePut(sid, {
      json,
      expiredAt,
      cachedAt: now,
      lastTouchWriteAt: cached && cached.json !== null ? cached.lastTouchWriteAt : now,
    });
    return JSON.parse(json);
  }

  async _set(sid, sess) {
    const now = Date.now();
    const expiredAt = this._expiryOf(sess);
    const json = JSON.stringify(sess);
    const mySeq = this._markWrite(sid);
    const { error } = await this.supabase
      .from(this.table)
      .upsert({
        sid,
        sess: JSON.parse(json),
        expired_at: new Date(expiredAt).toISOString(),
        updated_at: new Date(now).toISOString(),
      }, { onConflict: 'sid' });
    if (error) {
      this._cache.delete(sid);
      throw new Error(`[session-store] set failed: ${error.message}`);
    }
    // 待っている間に後から set / destroy が来ていたら、そちらが正なので上書きしない
    if (this._lastWriteSeq.get(sid) === mySeq) {
      this._cachePut(sid, { json, expiredAt, cachedAt: now, lastTouchWriteAt: now });
    }
  }

  async _touch(sid, sess) {
    const now = Date.now();
    const expiredAt = this._expiryOf(sess);
    let cached = this._cache.get(sid);
    if (cached && cached.json === null) cached = null; // 否定キャッシュは無視（DB を正とする）
    if (cached) {
      cached.expiredAt = expiredAt; // キャッシュ上の寿命は毎回伸ばす（DB 書込は間引く）
      if (now - cached.lastTouchWriteAt < this.touchThrottleMs) return;
    }
    const startSeq = this._seq;
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
    } else if (!this._writtenSince(sid, startSeq)) {
      this._cachePut(sid, { json: JSON.stringify(sess), expiredAt, cachedAt: now, lastTouchWriteAt: now });
    }
  }

  async _destroy(sid) {
    this._markWrite(sid);
    this._cache.delete(sid);
    const { error } = await this.supabase.from(this.table).delete().eq('sid', sid);
    this._cache.delete(sid); // 待っている間に入ったキャッシュも捨てる
    if (error) throw new Error(`[session-store] destroy failed: ${error.message}`);
  }

  /** 失効した行を削除する（15 分周期。起動直後にも 1 回呼ぶ） */
  async cleanupExpired() {
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    for (const [sid, entry] of this._cache) {
      if (entry.json === null ? nowMs - entry.cachedAt >= this.cacheTtlMs : entry.expiredAt <= nowMs) this._cache.delete(sid);
    }
    // 書込み番号の記録は、前回のスイープより前のもの（＝もう待っている get / touch が無いもの）を捨てる
    for (const [sid, seq] of this._lastWriteSeq) {
      if (seq <= this._pruneSeq) this._lastWriteSeq.delete(sid);
    }
    this._pruneSeq = this._seq;
    const { error } = await this.supabase.from(this.table).delete().lt('expired_at', nowIso);
    if (error) throw new Error(`[session-store] cleanup failed: ${error.message}`);
  }

  /** テスト・シャットダウン用 */
  close() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = null;
    this._cache.clear();
    this._lastWriteSeq.clear();
  }
}

module.exports = { SupabaseSessionStore, DEFAULTS };
