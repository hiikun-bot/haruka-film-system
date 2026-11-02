/*
 * Threads → ChatGPT handoff (no API access, no automated output extraction).
 * A user click grants activeTab for a screenshot of the currently visible Threads tab.
 * The screenshot is staged in session storage, copied as PNG to the clipboard as
 * a manual-upload fallback, then passed to the content script on a NEW ChatGPT tab.
 */
const CHAT_URL = "https://chatgpt.com/";
const ALLOWED_THREADS = new Set(["threads.com", "www.threads.com", "threads.net", "www.threads.net"]);
const ALLOWED_CHAT = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com"]);
const MAX_AGE_MS = 10 * 60 * 1000;
const deliveryInProgress = new Set();
let creatingOffscreen;

function hostname(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

const TONES = {
  conversation: "自然に相手を褒め、答えやすい質問を一つ添えて会話を続ける",
  empathy: "相手の考えや気持ちに共感し、自然な言葉で寄り添う",
  praise: "相手の具体的な行動や工夫を自然に称賛する"
};
function promptFor(tone) {
  const instruction = TONES[tone] || TONES.conversation;
  return [
    "この画像はThreadsの画面です。画像中央にある、私が返信しようとしている投稿に対し、自然な日本語の返信文を１つ作ってください。",
    "目的：" + instruction,
    "条件：",
    "・相手が書いた内容に具体的に触れる。根拠のない褒め言葉を避ける。",
    "・馴れ馴れしさ、売り込み、説教は避け、やさしく親しみやすい口調にする。",
    "・文字数は40〜120字程度。絵文字は自然な範囲で0〜2個。",
    "・投稿にない経歴、数字、事実、感情は創作しない。",
    "・複数の投稿が重なり対象を特定できない場合は、推測せず確認が必要と伝える。",
    "・回答は完成した返信文の１案だけ。前置き、番号、Markdown、引用符は不要。"
  ].join("\n");
}
async function setupOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  const uri = chrome.runtime.getURL("offscreen.html");
  creatingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [uri]
    });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url:"offscreen.html",
        reasons:["CLIPBOARD"],
        justification:"ユーザーが撮影したThreads画像を、ChatGPTへの手動貼付フォールバックとしてクリップボードへ保存するため"
      });
    }
  })().finally(() => { creatingOffscreen = undefined; });
  return creatingOffscreen;
}
async function screenshotToClipboard(dataUrl) {
  try {
    await setupOffscreen();
    const result = await chrome.runtime.sendMessage({
      target:"offscreen", type:"COPY_PNG", dataUrl
    });
    return Boolean(result?.ok);
  } catch (error) {
    console.warn("クリップボードへの画像保存に失敗", error);
    return false;
  }
}
async function prepare(tab, tone="conversation") {
  if (!tab?.id || !tab.windowId || !ALLOWED_THREADS.has(hostname(tab.url))) {
    // No screenshot is taken outside a Threads page.
    if (tab?.id) await chrome.tabs.create({url:CHAT_URL});
    return;
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {format:"png"});
    const clipboardReady = await screenshotToClipboard(dataUrl);
    const job = {
      dataUrl,
      prompt:promptFor(tone),
      createdAt:Date.now(),
      sourceUrl:tab.url,
      clipboardReady
    };
    // Save BEFORE creating ChatGPT tab, to avoid content-script readiness race.
    await chrome.storage.session.set({pendingHandoff:job});
    const target = await chrome.tabs.create({url:CHAT_URL, active:true});
    await chrome.storage.session.set({pendingHandoff:{...job,chatTabId:target.id}});
    await deliver(target.id);
  } catch (error) {
    console.error("スクリーンショットの受け渡しに失敗", error);
  }
}

async function deliver(tabId) {
  if (!tabId || deliveryInProgress.has(tabId)) return;
  deliveryInProgress.add(tabId);
  try {
    const {pendingHandoff:job} = await chrome.storage.session.get("pendingHandoff");
    if (!job || job.chatTabId !== tabId || Date.now() - job.createdAt > MAX_AGE_MS) return;
    const tab = await chrome.tabs.get(tabId);
    if (!ALLOWED_CHAT.has(hostname(tab.url))) return;
    const response = await chrome.tabs.sendMessage(tabId, {
      type:"STAGE_CHATGPT_REQUEST",
      imageDataUrl:job.dataUrl,
      prompt:job.prompt,
      clipboardReady:job.clipboardReady
    });
    if (response?.ok) await chrome.storage.session.remove("pendingHandoff");
  } catch (error) {
    // The content script may not yet be loaded or ChatGPT may need login.
    console.debug("ChatGPTページの準備待ち:", error.message);
  } finally {
    deliveryInProgress.delete(tabId);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id:"threads-parent", title:"ChatGPTでこの投稿の返信文を考える",
    contexts:["all"],
    documentUrlPatterns:["https://threads.com/*","https://www.threads.com/*","https://threads.net/*","https://www.threads.net/*"]
  });
  for (const [id, label] of [
    ["conversation","会話を続ける返信"],
    ["empathy","共感する返信"],
    ["praise","相手を自然に褒める返信"]
  ]) chrome.contextMenus.create({id:"tone-"+id,parentId:"threads-parent",title:label,contexts:["all"]});
});
chrome.action.onClicked.addListener(tab => { prepare(tab, "conversation").catch(console.error); });
chrome.contextMenus.onClicked.addListener((info,tab) => {
  if (info.menuItemId.startsWith("tone-")) {
    prepare(tab, info.menuItemId.slice(5)).catch(console.error);
  }
});
chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.status === "complete" && ALLOWED_CHAT.has(hostname(tab.url))) {
    deliver(tabId).catch(console.error);
  }
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "CHATGPT_HANDOFF_READY" && sender.tab?.id &&
      ALLOWED_CHAT.has(hostname(sender.tab.url))) {
    deliver(sender.tab.id).catch(console.error);
  }
});
