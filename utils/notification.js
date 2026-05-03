// utils/notification.js — 通知発火ヘルパー（Phase 1）
//
// 役割:
//   ・notification_logs への INSERT を一箇所に集約
//   ・受信者の notification_settings.{type}_enabled フラグを尊重（Phase 2のUIで利用）
//   ・全体通知向けの一括INSERT（bulk）も提供
//
// 使い方:
//   const { createNotification, createBulkNotifications } = require('./utils/notification');
//   await createNotification({
//     userId: 'uuid', type: 'ball_returned',
//     title: 'ボールが返ってきました',
//     body: '001_ARU_UGC01_v1のボールが返ってきました',
//     linkUrl: '/creatives/abc-123',
//     meta: { creative_id: 'abc-123' },
//     senderId: 'uuid_yamada',
//   });
//
// エラーハンドリング方針:
//   notification_logs への INSERT は補助処理。失敗しても主処理（status更新やコメント投稿）を
//   止めたくないので、catch して console.error に残すだけ。throw しない。
//
// 注意:
//   ball_returned 通知だけは DBトリガー (notify_ball_returned) が直接 notification_logs に
//   INSERT するルートを持っている。アプリ側からこのヘルパで発火させる必要はない（重複発火回避）。
//   このヘルパを使うのは global / mention / post_reaction / post_comment などアプリ層発火の通知。

const supabase = require('../supabase');

// notification_settings の {type}_enabled 列名対応表。
// type が settings 列に対応していないものは「常時ON扱い」（settings 確認をスキップ）
const TYPE_TO_SETTING_COL = {
  ball_returned:  'ball_returned_enabled',
  global:         'global_enabled',
  mention:        'mention_enabled',
  post_reaction:  'post_reaction_enabled',
  post_comment:   'post_comment_enabled',
  sos:            'sos_enabled',
  deadline:       'deadline_enabled',
  assignment:     'assignment_enabled',
  invoice:        'invoice_enabled',
};

/**
 * 単件の通知を発火する。
 *
 * @param {object}  args
 * @param {string}  args.userId    受信者 user_id
 * @param {string}  args.type      notification_type コード
 * @param {string}  args.title     見出し（最大80文字想定）
 * @param {string=} args.body      プレビュー本文（最大200文字想定）
 * @param {string=} args.linkUrl   タップ後の遷移先
 * @param {object=} args.meta      追加情報 jsonb
 * @param {string=} args.senderId  送信者 user_id（システム発火なら null）
 *
 * @returns {Promise<object|null>} INSERT 結果の行、設定でOFFまたは失敗時は null
 */
async function createNotification({ userId, type, title, body = null, linkUrl = null, meta = {}, senderId = null }) {
  if (!userId || !type || !title) {
    console.error('[notification] createNotification: 必須パラメータ不足', { userId, type, title });
    return null;
  }

  // 受信者の設定を確認（対応する _enabled 列がある型のみ）
  const settingCol = TYPE_TO_SETTING_COL[type];
  if (settingCol) {
    try {
      const { data: settings } = await supabase
        .from('notification_settings')
        .select(settingCol)
        .eq('user_id', userId)
        .maybeSingle();
      if (settings && settings[settingCol] === false) {
        return null; // ユーザーが種別ごと OFF にしている
      }
    } catch (e) {
      console.error('[notification] settings 取得失敗（処理は継続）:', e.message);
    }
  }

  try {
    const { data, error } = await supabase
      .from('notification_logs')
      .insert({
        user_id: userId,
        notification_type: type,
        title,
        body,
        link_url: linkUrl,
        meta,
        sender_id: senderId,
      })
      .select()
      .single();
    if (error) {
      console.error('[notification] INSERT 失敗:', error.message);
      return null;
    }
    return data;
  } catch (e) {
    console.error('[notification] 例外:', e.message);
    return null;
  }
}

/**
 * 複数通知を一括発火する。全体通知（admin が全員へ告知）等で使う。
 * notification_settings の確認は省略（全体通知を個別 OFF にする UI は Phase 2で別途）。
 *
 * @param {Array<{user_id, notification_type, title, body?, link_url?, meta?, sender_id?}>} notifications
 * @returns {Promise<Array>} INSERT 結果の行配列、失敗時は空配列
 */
async function createBulkNotifications(notifications) {
  if (!Array.isArray(notifications) || notifications.length === 0) return [];
  try {
    const { data, error } = await supabase
      .from('notification_logs')
      .insert(notifications)
      .select();
    if (error) {
      console.error('[notification] bulk INSERT 失敗:', error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error('[notification] bulk 例外:', e.message);
    return [];
  }
}

/**
 * 投稿本文（つぶやき / コメント）から `@名前` 表記のメンションを抽出して
 * users テーブルから user_id を解決する。
 *
 * 仕様:
 *   ・正規表現は /@([\p{L}\p{N}_]+)/gu — 全角OK / アンダースコア許容
 *   ・名前部分は半角/全角スペース・改行・文末で区切られる
 *   ・大文字小文字無視（lower で比較）
 *   ・nickname または full_name と完全一致で照合（nickname優先）
 *   ・重複排除して string[] (UUID) を返す
 *   ・0件マッチ時 / 解決失敗時は空配列
 *
 * @param {string} body  投稿本文
 * @returns {Promise<string[]>} ユニークな user_id 配列
 */
async function extractMentions(body) {
  if (!body || typeof body !== 'string') return [];

  const matches = body.match(/@([\p{L}\p{N}_]+)/gu);
  if (!matches || matches.length === 0) return [];

  // 先頭の @ を除いて重複排除
  const names = Array.from(new Set(
    matches.map(m => m.replace(/^@/, '').trim()).filter(Boolean)
  ));
  if (names.length === 0) return [];

  // users から nickname / full_name を取得して名前→id マップを作る
  // （IN 句を投げる前に重複排除済み。10名くらい想定なので一括で全件取らない）
  try {
    const { data: users } = await supabase
      .from('users')
      .select('id, full_name, nickname')
      .or(
        // nickname / full_name どちらかが候補名と一致
        names.flatMap(n => [`nickname.eq.${n}`, `full_name.eq.${n}`]).join(',')
      );
    if (!users || users.length === 0) return [];

    // 大文字小文字無視で照合: 名前 → user_id
    const lowerNames = new Set(names.map(n => n.toLowerCase()));
    const resolved = new Set();
    for (const u of users) {
      const nick = (u.nickname || '').toLowerCase();
      const full = (u.full_name || '').toLowerCase();
      if ((nick && lowerNames.has(nick)) || (full && lowerNames.has(full))) {
        resolved.add(u.id);
      }
    }
    return Array.from(resolved);
  } catch (e) {
    console.error('[notification] extractMentions 失敗:', e.message);
    return [];
  }
}

module.exports = { createNotification, createBulkNotifications, extractMentions };
