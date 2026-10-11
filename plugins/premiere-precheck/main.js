// main.js — HARUKA 投稿前チェック パネル（ADR 050）
//
// パネルの仕事は「読む・送る・見せる・飛ぶ・印を付ける」だけ。判定はすべてサーバー。
// Premiere の API は非同期（メソッド）と同期（プロパティ）が混在するので、メソッドは必ず await する。

const ppro = require('premierepro');
const { parseTelopValue, looksLikeTextParam, flattenTranscript } = require('./telop-parse.js');

const VERSION = '0.1.2';
const MARKER_PREFIX = '[投稿前チェック]';
const $ = id => document.getElementById(id);

// 手元テスト用（scripts/build-premiere-plugin.sh --dev が dev.json を同梱する。配布物には入らない）
let DEV = null;
try { DEV = require('./dev.json'); } catch (_) { DEV = null; }

const state = {
  server: (DEV && DEV.server) || localStorage.getItem('precheck.server') || 'https://app.harukafilm.com',
  token: (DEV && DEV.token) || localStorage.getItem('precheck.token') || '',
  set: localStorage.getItem('precheck.set') || '',
  result: null,
  dismissed: new Set(),
  checked: new Set(),
};

// ==================== サーバー ====================
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(state.server + path, {
    method,
    headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 本文なし */ }
  if (!res.ok) throw new Error((data && data.error) || `サーバーエラー（${res.status}）`);
  return data;
}

function setStatus(text, kind = 'muted') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

async function connect() {
  state.token = $('token').value.trim();
  state.server = $('server').value;
  localStorage.setItem('precheck.token', state.token);
  localStorage.setItem('precheck.server', state.server);
  if (!state.token) { $('who').textContent = '未接続（トークンを貼ってください）'; $('setup').open = true; return; }
  try {
    const me = await api('/api/precheck/me');
    $('who').textContent = `✅ ${me.user.name || 'メンバー'} として接続中`;
    $('who').className = 'ok';
    const sel = $('set');
    sel.innerHTML = '';
    // UXP の select は value の代入が効かないことがあるため、option.selected で選ぶ
    if (!me.sets.some(s => s.id === state.set)) state.set = me.sets[0] ? me.sets[0].id : '';
    for (const s of me.sets) {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.name;
      if (s.id === state.set) o.selected = true;
      sel.appendChild(o);
    }
    $('run').disabled = false;
    $('setup').open = false;
  } catch (e) {
    $('who').textContent = `接続できません: ${e.message}`;
    $('who').className = 'err';
    $('run').disabled = true;
    $('setup').open = true;
  }
}

// ==================== Premiere から読む ====================
async function getSequence() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('プロジェクトが開かれていません');
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error('シーケンスを開いてください');
  return { project, sequence };
}

async function forEachVideoClip(sequence, fn) {
  const trackCount = await sequence.getVideoTrackCount();
  for (let ti = 0; ti < trackCount; ti += 1) {
    const track = await sequence.getVideoTrack(ti);
    if (!track) continue;
    const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (const item of items || []) {
      await fn(item, ti);
    }
  }
}

// テロップ（文字を持つクリップ）を全部集める。diag=true なら読み取りの手がかりも残す
//   読み方は 3 段: ① getStartValue ② getValueAtTime（クリップの開始時刻） ③ クリップ名
//   Premiere 26.5 では ① が null を返すことを実機で確認（2026-10-11）。グラフィックのクリップ名は
//   既定で 1 つ目のテキストの中身になるので、③ を最後の手段にする（source: 'clip_name'）。
const SKIP_COMPONENTS = /ADBE (Opacity|Motion)$/;
const GENERIC_CLIP_NAMES = /^(グラフィック|Graphic|テキスト|Text)\s*\d*$/i;

async function readParam(param, atTime) {
  let value = null;
  try { value = await param.getStartValue(); } catch (_) { /* 読めないパラメータ */ }
  if (value == null || (value.value && value.value.value == null)) {
    try { value = await param.getValueAtTime(atTime); } catch (_) { /* 版によって無い */ }
  }
  return value;
}

async function collectTelops(sequence, { diag = false } = {}) {
  const telops = [];
  const diagnostics = [];
  await forEachVideoClip(sequence, async (item, trackIndex) => {
    let disabled = false;
    try { disabled = await item.isDisabled(); } catch (_) { /* 古い版 */ }
    if (disabled) return;
    const startTime = await item.getStartTime();
    const start = startTime.seconds;
    const end = (await item.getEndTime()).seconds;
    const name = await item.getName().catch(() => '');
    const chain = await item.getComponentChain();
    const count = chain.getComponentCount();
    const clipDiag = diag ? { track: trackIndex, start, end, name, components: [] } : null;
    let hasText = false;
    let readAny = false;
    for (let ci = 0; ci < count; ci += 1) {
      const comp = chain.getComponentAtIndex(ci);
      const matchName = await comp.getMatchName().catch(() => '');
      if (SKIP_COMPONENTS.test(matchName)) continue;
      const isTextComp = /ADBE (Text|Capsule)|Graphic/i.test(matchName);
      if (isTextComp) hasText = true;
      const compDiag = clipDiag ? { matchName, displayName: await comp.getDisplayName().catch(() => ''), params: [] } : null;
      const paramCount = comp.getParamCount();
      for (let pi = 0; pi < paramCount; pi += 1) {
        const param = comp.getParam(pi);
        const textish = looksLikeTextParam(param.displayName) || isTextComp;
        if (!textish && !diag) continue;
        const value = await readParam(param, startTime);
        const telop = parseTelopValue(value, { plainStringIsText: looksLikeTextParam(param.displayName) });
        if (compDiag && (textish || compDiag.params.length < 4)) {
          const d = describeValue(param.displayName, value, telop);
          if (looksLikeTextParam(param.displayName)) d.probe = await probeParam(param, startTime);
          compDiag.params.push(d);
        }
        if (telop) {
          readAny = true;
          telops.push({ index: telops.length, start, end, track: trackIndex, source: 'param', ...telop });
        }
      }
      if (clipDiag && compDiag.params.length) clipDiag.components.push(compDiag);
    }
    if (hasText && !readAny && name && !GENERIC_CLIP_NAMES.test(name.trim())) {
      telops.push({ index: telops.length, start, end, track: trackIndex, source: 'clip_name', text: name.trim(), font_size: null, font: null, color: null });
    }
    if (clipDiag && clipDiag.components.length && diagnostics.length < 40) diagnostics.push(clipDiag);
  });
  telops.sort((a, b) => a.start - b.start || a.track - b.track);
  telops.forEach((t, i) => { t.index = i; });
  return { telops, diagnostics };
}

// 文字のパラメータについて、読めそうな手段を全部試して結果を残す（診断用）
async function probeParam(param, startTime) {
  const out = {};
  const tryIt = async (key, fn) => {
    try {
      const v = await fn();
      out[key] = v == null ? 'null' : (typeof v === 'object' ? `${(v.constructor && v.constructor.name) || 'object'}:${safeJson(v)}` : `${typeof v}:${String(v)}`).slice(0, 300);
    } catch (e) { out[key] = `throw:${String(e && e.message).slice(0, 120)}`; }
  };
  await tryIt('valueAtStart', () => param.getValueAtTime(startTime));
  await tryIt('valueAtZero', () => param.getValueAtTime(ppro.TickTime.TIME_ZERO));
  await tryIt('isTimeVarying', () => param.isTimeVarying());
  await tryIt('keyframes', () => (param.getKeyframeListAsTickTimes() || []).length);
  await tryIt('keyframesSupported', () => param.areKeyframesSupported());
  return out;
}

function safeJson(v) {
  try {
    const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(v) || {}).concat(Object.keys(v));
    return `${JSON.stringify(v)} keys=${keys.slice(0, 20).join(',')}`;
  } catch (_) { return '(json不可)'; }
}

function describeValue(name, value, telop) {
  let kind = typeof value;
  let sample = '';
  try {
    if (value && typeof value === 'object') {
      kind = (value.constructor && value.constructor.name) || 'object';
      const inner = value.value && typeof value.value === 'object' && 'value' in value.value ? value.value.value : undefined;
      if (inner !== undefined) { kind += `>${typeof inner}`; sample = String(inner); }
      else if (typeof value.getText === 'function') sample = value.getText();
      else sample = JSON.stringify(value);
    } else {
      sample = String(value);
    }
  } catch (e) { sample = `(読めない: ${e.message})`; }
  return { name, kind, sample: String(sample).slice(0, 300), telop: !!telop };
}

// Premiere の文字起こし（素材に付いているもの）をシーケンスの時刻に直して集める
async function collectTranscript(sequence) {
  const out = [];
  const seen = new Set();
  const trackCount = await sequence.getAudioTrackCount();
  for (let ti = 0; ti < trackCount; ti += 1) {
    const track = await sequence.getAudioTrack(ti);
    const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (const item of items || []) {
      try {
        const projectItem = await item.getProjectItem();
        const clip = ppro.ClipProjectItem.cast(projectItem);
        if (!clip || !ppro.Transcript.hasTranscript(clip)) continue;
        const start = (await item.getStartTime()).seconds;
        const end = (await item.getEndTime()).seconds;
        const inPoint = (await item.getInPoint()).seconds;
        const key = `${start}:${inPoint}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const json = await ppro.Transcript.exportToJSON(clip);
        out.push(...flattenTranscript(json, start - inPoint, [start, end]));
      } catch (_) { /* 文字起こしが無い素材は飛ばす */ }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ==================== チェック ====================
async function runCheck() {
  $('run').disabled = true;
  try {
    const { project, sequence } = await getSequence();
    $('seq').textContent = `シーケンス: ${sequence.name}`;
    setStatus('テロップを読んでいます…');
    const { telops } = await collectTelops(sequence);
    let transcript = [];
    if ($('optSpeech').checked) {
      setStatus(`テロップ ${telops.length} 件。文字起こしを読んでいます…`);
      transcript = await collectTranscript(sequence).catch(() => []);
    }
    if (!telops.length && !transcript.length) {
      setStatus('テロップが 1 件も読めませんでした。下の「診断データを送る」を押してください', 'err');
      return;
    }
    setStatus(`テロップ ${telops.length} 件・話した言葉 ${transcript.length} 件をチェック中…（10 秒ほど）`);
    state.set = $('set').value || state.set;
    if (!state.set) throw new Error('案件を選んでください');
    localStorage.setItem('precheck.set', state.set);
    const result = await api('/api/precheck/check', {
      method: 'POST',
      body: {
        set: state.set,
        sequence_name: sequence.name,
        telops,
        transcript,
        caption: $('caption').value.trim() || undefined,
        plugin_version: VERSION,
      },
    });
    state.result = result;
    state.dismissed = new Set();
    state.checked = new Set();
    render();
    if ($('optMarkers').checked) await writeMarkers(project, sequence, result.findings).catch(e => console.error(e));
    const head = result.code ? `${result.code}${result.video ? `（${[result.video.field, result.video.grade, result.video.minor].filter(Boolean).join('・')}）` : ''}` : '管理番号なし';
    setStatus(`${head} をチェックしました${result.ai_error ? `（AI の判定は失敗: ${result.ai_error}）` : ''}`, result.ai_error ? 'err' : 'ok');
  } catch (e) {
    setStatus(e.message, 'err');
  } finally {
    $('run').disabled = false;
  }
}

function fmt(sec) {
  if (sec == null) return '--:--';
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function render() {
  const r = state.result;
  if (!r) return;
  $('result').style.display = 'block';
  const box = $('findings');
  box.innerHTML = '';
  r.findings.forEach((f, i) => {
    const key = `f${i}`;
    const item = el('div', `item ${f.severity}${state.dismissed.has(key) ? ' dismissed' : ''}`);
    const head = el('div', 'head');
    head.appendChild(el('span', 't', `${f.severity === 'error' ? '✕' : '△'} ${fmt(f.time_sec)}`));
    head.appendChild(el('span', 'grow', `No.${f.rule_no}${f.source === 'speech' ? '（話した言葉）' : f.source === 'thumbnail' ? '（サムネ）' : f.source === 'caption' ? '（キャプション）' : ''}`));
    if (f.time_sec != null) {
      const go = el('button', 'small', '移動');
      go.addEventListener('click', () => jumpTo(f.time_sec));
      head.appendChild(go);
    }
    const ok = el('button', 'small', state.dismissed.has(key) ? '戻す' : '問題なし');
    ok.addEventListener('click', () => { state.dismissed.has(key) ? state.dismissed.delete(key) : state.dismissed.add(key); render(); });
    head.appendChild(ok);
    item.appendChild(head);
    if (f.quote) item.appendChild(el('div', 'quote', `「${f.quote}」`));
    if (f.suggestion) item.appendChild(el('div', 'sugg', `→ ${f.suggestion}`));
    if (f.reason) item.appendChild(el('div', 'why', f.reason));
    box.appendChild(item);
  });
  if (!r.findings.length) box.appendChild(el('div', 'ok', '指摘はありません 🎉'));

  const man = $('manual');
  man.innerHTML = '';
  r.manual.forEach(m => {
    const row = el('label', 'man');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.checked.has(m.rule_no);
    cb.addEventListener('change', () => { cb.checked ? state.checked.add(m.rule_no) : state.checked.delete(m.rule_no); updateCounts(); });
    row.appendChild(cb);
    row.appendChild(el('span', '', `No.${m.rule_no} ${m.label}${m.hint ? `（${m.hint}）` : ''}`));
    man.appendChild(row);
  });
  updateCounts();
}

function remaining() {
  const r = state.result;
  const open = r.findings.filter((f, i) => !state.dismissed.has(`f${i}`));
  return {
    err: open.filter(f => f.severity === 'error').length,
    warn: open.filter(f => f.severity === 'warn').length,
    man: r.manual.filter(m => !state.checked.has(m.rule_no)).length,
  };
}

function updateCounts() {
  const n = remaining();
  $('nErr').textContent = n.err;
  $('nWarn').textContent = n.warn;
  $('nMan').textContent = n.man;
  $('summary').disabled = !(n.err === 0 && n.man === 0);
}

async function jumpTo(sec) {
  try {
    const { sequence } = await getSequence();
    await sequence.setPlayerPosition(ppro.TickTime.createWithSeconds(Number(sec) + 0.01));
  } catch (e) {
    setStatus(`移動できません: ${e.message}`, 'err');
  }
}

// 前回このパネルが打ったマーカーを消してから、今回の指摘を打ち直す
async function writeMarkers(project, sequence, findings) {
  const markers = await ppro.Markers.getMarkers(sequence);
  const old = (markers.getMarkers() || []).filter(m => String(m.getName() || '').startsWith(MARKER_PREFIX));
  const targets = findings.filter(f => f.time_sec != null).slice(0, 80);
  const added = [];
  project.lockedAccess(() => {
    project.executeTransaction(compound => {
      for (const m of old) compound.addAction(markers.createRemoveMarkerAction(m));
      for (const f of targets) {
        const name = `${MARKER_PREFIX} ${f.severity === 'error' ? '✕' : '△'} No.${f.rule_no} ${f.quote || ''}`.slice(0, 120);
        const comment = [f.suggestion && `→ ${f.suggestion}`, f.reason].filter(Boolean).join('\n');
        compound.addAction(markers.createAddMarkerAction(
          name, ppro.Marker.MARKER_TYPE_COMMENT, ppro.TickTime.createWithSeconds(Number(f.time_sec)), ppro.TickTime.TIME_ZERO, comment,
        ));
        added.push({ name, severity: f.severity });
      }
    }, '投稿前チェックのマーカー');
  });
  // 色は作ったあとでしか付けられない（作り直した一覧を取り直す）
  const fresh = await ppro.Markers.getMarkers(sequence);
  const now = (fresh.getMarkers() || []).filter(m => String(m.getName() || '').startsWith(MARKER_PREFIX));
  const colorIndex = sev => (sev === 'error' ? ppro.Constants.MarkerColor.RED : ppro.Constants.MarkerColor.YELLOW);
  project.lockedAccess(() => {
    project.executeTransaction(compound => {
      for (const m of now) {
        const a = added.find(x => x.name === m.getName());
        if (a) compound.addAction(m.createSetColorByIndexAction(colorIndex(a.severity)));
      }
    }, '投稿前チェックのマーカーの色');
  });
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.setContent) await navigator.clipboard.setContent({ 'text/plain': text });
    else await navigator.clipboard.writeText(text);
    return true;
  } catch (_) { return false; }
}

async function copySummary() {
  const r = state.result;
  const dismissed = r.findings.filter((f, i) => state.dismissed.has(`f${i}`));
  const lines = [
    '✅ 投稿前チェック済み',
    `案件: ${r.set.name}${r.code ? ` / 管理番号: ${r.code}` : ''}`,
    `チェック日時: ${new Date(r.checked_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
    `ルール ${r.counts.rules} 件 / テロップ ${r.counts.telops} 件`,
  ];
  if (dismissed.length) {
    lines.push('', '「問題なし」と判断した指摘:');
    dismissed.forEach(f => lines.push(`・No.${f.rule_no} ${fmt(f.time_sec)} 「${f.quote}」`));
  }
  const ok = await copyText(lines.join('\n'));
  setStatus(ok ? '提出用のまとめをコピーしました' : 'コピーできませんでした', ok ? 'ok' : 'err');
}

// テロップが読めないとき、Premiere がどんな形で値を返しているかをサーバーに送る（ADR 050 §6）
async function sendDiagnostic() {
  try {
    const { sequence } = await getSequence();
    setStatus('診断データを集めています…');
    const { telops, diagnostics } = await collectTelops(sequence, { diag: true });
    let host = {};
    try { const uxp = require('uxp'); host = { app: uxp.host.name, version: uxp.host.version, uxp: uxp.versions && uxp.versions.uxp }; } catch (_) { /* 取れなくてもよい */ }
    await api('/api/precheck/diagnostic', {
      method: 'POST',
      body: { plugin_version: VERSION, host, sequence_name: sequence.name, telops_found: telops.length, clips: diagnostics },
    });
    setStatus(`診断データを送りました（読めたテロップ ${telops.length} 件）。担当者が確認します`, 'ok');
  } catch (e) {
    setStatus(`送れませんでした: ${e.message}`, 'err');
  }
}

// ==================== 起動 ====================
if (DEV && DEV.server) {
  const o = document.createElement('option');
  o.value = DEV.server; o.textContent = `手元テスト（${DEV.server}）`;
  $('server').appendChild(o);
}
$('token').value = state.token;
$('server').value = state.server;
$('connect').addEventListener('click', connect);
$('run').addEventListener('click', runCheck);
$('summary').addEventListener('click', copySummary);
$('diag').addEventListener('click', sendDiagnostic);
$('set').addEventListener('change', () => { state.set = $('set').value || state.set; localStorage.setItem('precheck.set', state.set); });
if (state.token) {
  connect().then(async () => {
    // 手元テストでは、開いた瞬間に診断とチェックを流してサーバーのログで確かめる
    if (DEV && DEV.autorun && !$('run').disabled) {
      await sendDiagnostic();
      await runCheck();
    }
  });
} else {
  $('setup').open = true;
}
