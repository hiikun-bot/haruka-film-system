// utils/notification-settings.js — 通知の受信設定カタログ（ADR 043）
//
// 役割:
//   ・「どの通知種別を本人が ON/OFF できるか」「既定値は何か」「notification_settings のどの列か」を
//     1 箇所で定義する。サーバー（発火時のフィルタ・設定 API）とフロント（メンバー編集モーダルの
//     通知タブ）が同じ定義を見る（GET /api/notifications/settings が catalog を返す）。
//   ・supabase に依存しない純関数だけを置く（jest で単体テストできる）。
//
// 既定 OFF の根拠（2026-09-24 に本番 notification_logs 直近 90 日を集計）:
//   ・creative_registered … admin / 秘書 4 人に 2,114 件（1 人 1 日平均 10.5 件）・既読率 35%
//   ・ball_returned        … 3,436 件。Dチェック依頼などの creative_status と同じ遷移で二重に鳴るうえ、
//                            DB トリガーが delivered_at を入れておらず実質未配信（既読率 0%）だった
//   それ以外は業務連絡（チェック依頼・コメント）か既読率 6〜8 割の反応系なので既定 ON のまま。
//
// 通知種別を追加する手順:
//   1) migration で notification_settings に <type>_enabled BOOLEAN NOT NULL DEFAULT <既定> 列を追加
//   2) 下の CATALOG に 1 行追加（column / defaultEnabled / label / description）
//   3) public/js/notification-card.js の ICON_BY_TYPE にアイコンを追加
//   常時 ON（設定で止められない）にしたい種別は CATALOG に載せない。

// 表示順 = この配列の順（メンバー編集モーダルの通知タブ）
const CATALOG = [
  {
    type: 'creative_status',
    column: 'creative_status_enabled',
    defaultEnabled: true,
    icon: '🎬',
    label: 'チェック依頼・修正依頼・進行の連絡',
    description: 'Dチェック依頼 / Wチェック依頼 / 修正依頼 / クライアントチェックに進んだとき',
  },
  {
    type: 'creative_comment',
    column: 'creative_comment_enabled',
    defaultEnabled: true,
    icon: '💬',
    label: 'クリエイティブへのコメント・返信',
    description: '自分が担当する動画・静止画にコメントや返信が付いたとき',
  },
  {
    type: 'ball_returned',
    column: 'ball_returned_enabled',
    defaultEnabled: false,
    icon: '⚪',
    label: 'ボールが自分に来たとき',
    description: '上の「チェック依頼・修正依頼」と同じタイミングで重ねて鳴るため、ふだんはオフで十分です',
  },
  {
    type: 'creative_registered',
    column: 'creative_registered_enabled',
    defaultEnabled: false,
    icon: '🆕',
    label: 'クリエイティブの新規登録（admin・秘書向け）',
    description: '誰かがクリエイティブを登録するたびに届きます。件数が多いので既定はオフ',
  },
  {
    type: 'mention',
    column: 'mention_enabled',
    defaultEnabled: true,
    icon: '@',
    label: 'つぶやきで @メンションされたとき',
    description: '',
  },
  {
    type: 'post_comment',
    column: 'post_comment_enabled',
    defaultEnabled: true,
    icon: '💬',
    label: 'つぶやきへの返信',
    description: '自分のつぶやき・自分の返信に返信が付いたとき',
  },
  {
    type: 'post_reaction',
    column: 'post_reaction_enabled',
    defaultEnabled: true,
    icon: '❤️',
    label: 'つぶやきへのリアクション',
    description: '同じ人からのリアクションは 24 時間分まとめて 1 件で届きます',
  },
  {
    type: 'portfolio_reaction',
    column: 'portfolio_reaction_enabled',
    defaultEnabled: true,
    icon: '👏',
    label: '作品への 👏 拍手',
    description: '自分が制作した作品に拍手が付いたとき',
  },
  {
    type: 'portfolio_comment',
    column: 'portfolio_comment_enabled',
    defaultEnabled: true,
    icon: '💬',
    label: '作品への 💬 ひとこと',
    description: '',
  },
];

// notification_settings に列はあるが CATALOG（UI）には出さない種別。
// 設定行に値があれば尊重するが、既定は ON。将来使うときに CATALOG へ昇格する。
const LEGACY_COLUMNS = {
  global:     { column: 'global_enabled',     defaultEnabled: true },
  sos:        { column: 'sos_enabled',        defaultEnabled: true },
  deadline:   { column: 'deadline_enabled',   defaultEnabled: true },
  assignment: { column: 'assignment_enabled', defaultEnabled: true },
  invoice:    { column: 'invoice_enabled',    defaultEnabled: true },
};

const BY_TYPE = new Map();
for (const c of CATALOG) BY_TYPE.set(c.type, c);
for (const [type, c] of Object.entries(LEGACY_COLUMNS)) {
  if (!BY_TYPE.has(type)) BY_TYPE.set(type, { type, ...c });
}

/** 設定で ON/OFF できる種別か（CATALOG または LEGACY に列があるか） */
function isConfigurableType(type) {
  return BY_TYPE.has(type);
}

/** 種別 → notification_settings の列名。列が無い種別（常時 ON）は null */
function settingColumnFor(type) {
  const c = BY_TYPE.get(type);
  return c ? c.column : null;
}

/** 種別の既定値。設定できない種別（常時 ON）は true */
function defaultEnabledFor(type) {
  const c = BY_TYPE.get(type);
  return c ? c.defaultEnabled !== false : true;
}

/**
 * 受信者の設定行（無ければ null）と種別から「この通知を届けるか」を返す。
 *   ・列が無い種別 → 常に true
 *   ・設定行が無い / 列が未定義（migration 未適用）→ 既定値
 *   ・列が boolean → その値
 */
function isEnabledFor(settingsRow, type) {
  const col = settingColumnFor(type);
  if (!col) return true;
  const v = settingsRow ? settingsRow[col] : undefined;
  if (v === true || v === false) return v;
  return defaultEnabledFor(type);
}

/**
 * bulk INSERT 用: rows（user_id / notification_type を持つ）を、設定 map に従って間引く。
 * @param {Array<object>} rows
 * @param {Map<string, object>} settingsByUser  user_id → notification_settings 行
 * @returns {Array<object>} 届けてよい行だけ
 */
function filterRowsBySettings(rows, settingsByUser) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(r => {
    if (!r || !r.user_id) return false;
    const s = settingsByUser instanceof Map ? settingsByUser.get(r.user_id) : null;
    return isEnabledFor(s || null, r.notification_type);
  });
}

/**
 * 設定行（無ければ null）を UI 向けの { type: boolean } に整形する。
 * CATALOG に載っている種別だけ返す。
 */
function toClientSettings(settingsRow) {
  const out = {};
  for (const c of CATALOG) out[c.type] = isEnabledFor(settingsRow || null, c.type);
  return out;
}

/**
 * PUT で受け取った { type: boolean } を notification_settings の UPDATE 列に変換する。
 * CATALOG に無い key・boolean でない値は無視する。
 * @returns {{ patch: object, ignored: string[] }}
 */
function toSettingsPatch(body) {
  const patch = {};
  const ignored = [];
  if (!body || typeof body !== 'object') return { patch, ignored };
  for (const [key, val] of Object.entries(body)) {
    const c = CATALOG.find(x => x.type === key);
    if (!c) { ignored.push(key); continue; }
    if (val === true || val === false) patch[c.column] = val;
    else if (val === 'true' || val === 'false') patch[c.column] = (val === 'true');
    else ignored.push(key);
  }
  return { patch, ignored };
}

/** クライアントへ返す catalog（列名は内部情報なので落とす） */
function publicCatalog() {
  return CATALOG.map(({ type, defaultEnabled, icon, label, description }) => ({
    type, default_enabled: defaultEnabled !== false, icon, label, description,
  }));
}

module.exports = {
  CATALOG,
  isConfigurableType,
  settingColumnFor,
  defaultEnabledFor,
  isEnabledFor,
  filterRowsBySettings,
  toClientSettings,
  toSettingsPatch,
  publicCatalog,
};
