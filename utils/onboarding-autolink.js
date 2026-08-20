// utils/onboarding-autolink.js
// =============================================================
// 新メンバーがHFSに登録された瞬間のオンボーディング自動処理
//
// 呼び出し元: POST /api/invitations/register（招待リンク経由の本人登録）と
//             POST /api/haruka/members（admin によるメンバー作成）
//
// 動作:
//   1) user_id 未紐付け・進行中のオンボーディングレコードから名前一致
//      （氏名 or ニックネーム）を探す
//      - ちょうど1件 → user_id を自動紐付け ＋「HFSへメンバー招待」タスクを自動チェック
//      - 複数件      → 誤紐付け防止のため何もしない（ログのみ）
//   2) 一致が無い場合、ロールが editor/designer なら
//      オンボーディングレコード自体を自動作成（紐付け＆招待タスク済みの状態で）
//
// 登録フローを絶対に壊さないよう、この関数は throw しない。
// =============================================================

const supabase = require('../supabase');
const {
  buildOnboardingTasks,
  onboardingNameMatches,
  roleToOnboardingOccupation,
} = require('./onboarding');

// 「HFSへメンバー招待」タスクを完了にする（done_by は本人）
async function completeHfsInviteTask(recordId, userId) {
  const { error } = await supabase.from('onboarding_tasks')
    .update({ done: true, done_at: new Date().toISOString(), done_by: userId || null })
    .eq('record_id', recordId)
    .eq('task_key', 'hfs_invite')
    .eq('done', false);
  if (error) console.warn('[onboarding-autolink] hfs_invite 完了マーク失敗:', error.message);
}

/**
 * @param {{ id: string, full_name?: string, nickname?: string, role?: string, is_external?: boolean }} user
 * @returns {Promise<{ action: 'linked'|'created'|'ambiguous'|'skipped'|'error', recordId?: string }>}
 */
async function handleNewHfsUser(user) {
  try {
    if (!user || !user.id || user.is_external) return { action: 'skipped' };

    const { data: records, error } = await supabase
      .from('onboarding_records')
      .select('id, member_name')
      .is('user_id', null)
      .eq('status', 'in_progress');
    if (error) {
      // テーブル未作成環境などでも登録フローは止めない
      console.warn('[onboarding-autolink] レコード取得失敗:', error.message);
      return { action: 'error' };
    }

    const matches = (records || []).filter(r =>
      onboardingNameMatches(r.member_name, { fullName: user.full_name, nickname: user.nickname }));

    if (matches.length === 1) {
      const rec = matches[0];
      const { error: linkErr } = await supabase.from('onboarding_records')
        .update({ user_id: user.id, updated_at: new Date().toISOString() })
        .eq('id', rec.id)
        .is('user_id', null); // 併走登録との競合ガード
      if (linkErr) {
        console.warn('[onboarding-autolink] 紐付け失敗:', linkErr.message);
        return { action: 'error' };
      }
      await completeHfsInviteTask(rec.id, user.id);
      console.log(`[onboarding-autolink] 自動紐付け: ${rec.member_name} ← ${user.full_name} (${user.id})`);
      return { action: 'linked', recordId: rec.id };
    }

    if (matches.length > 1) {
      console.warn(`[onboarding-autolink] 名前一致が複数（${matches.length}件）のため自動紐付けをスキップ: ${user.full_name}`);
      return { action: 'ambiguous' };
    }

    // 一致なし → 対象ロールならレコードを自動作成
    const occupation = roleToOnboardingOccupation(user.role);
    if (!occupation || !user.full_name) return { action: 'skipped' };

    const { data: rec, error: recErr } = await supabase.from('onboarding_records')
      .insert({
        member_name: String(user.full_name).trim(),
        user_id: user.id,
        occupation,
        note: 'HFSメンバー登録を検知して自動作成',
      })
      .select('id').single();
    if (recErr) {
      console.warn('[onboarding-autolink] 自動作成失敗:', recErr.message);
      return { action: 'error' };
    }
    const tasks = buildOnboardingTasks(occupation).map(t => ({ ...t, record_id: rec.id }));
    const { error: taskErr } = await supabase.from('onboarding_tasks').insert(tasks);
    if (taskErr) {
      console.warn('[onboarding-autolink] タスク展開失敗→ロールバック:', taskErr.message);
      await supabase.from('onboarding_records').delete().eq('id', rec.id);
      return { action: 'error' };
    }
    await completeHfsInviteTask(rec.id, user.id);
    console.log(`[onboarding-autolink] レコード自動作成: ${user.full_name} (${occupation})`);
    return { action: 'created', recordId: rec.id };
  } catch (e) {
    console.warn('[onboarding-autolink] 例外:', e?.message || e);
    return { action: 'error' };
  }
}

module.exports = { handleNewHfsUser };
