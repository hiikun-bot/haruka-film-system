/*
 * ChatGPT UI adapter. Never reads or scrapes ChatGPT answers.
 * This script only stages user-supplied input (prompt + screenshot).
 * ChatGPT is a changing UI: manual image-paste fallback is always shown.
 */
let staged = false;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isComposer(node) {
  return Boolean(node && (node.isContentEditable || node instanceof HTMLTextAreaElement));
}
function findComposer() {
  const selectors = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]'
  ];
  for (const css of selectors) {
    for (const el of document.querySelectorAll(css)) {
      if (isComposer(el)) return el;
    }
  }
  return null;
}
async function waitForComposer(limitMs=20000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const composer = findComposer();
    if (composer) return composer;
    await sleep(300);
  }
  return null;
}
function putPrompt(composer, text) {
  if (composer instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(composer, text);
    composer.dispatchEvent(new Event("input", {bubbles:true}));
    return composer.value === text;
  }
  // A trusted edit command normally integrates with rich text editors.
  composer.focus();
  composer.replaceChildren();
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted || !composer.textContent?.includes(text.slice(0, 20))) {
    composer.textContent = text;
    composer.dispatchEvent(new InputEvent("input", {bubbles:true, inputType:"insertText", data:text}));
  }
  return Boolean(composer.textContent?.includes(text.slice(0, 20)));
}
function fileFromDataURL(dataUrl) {
  const parts = dataUrl.match(/^data:(image\/png);base64,(.+)$/s);
  if (!parts) throw new Error("PNG画像が取得できません");
  const bytes = Uint8Array.from(atob(parts[2]), char => char.charCodeAt(0));
  return new File([bytes], "threads-screenshot.png", {type:"image/png"});
}
async function attachScreenshot(dataUrl) {
  const candidates = () => [...document.querySelectorAll('input[type="file"]')].filter(el => !el.disabled);
  let input = candidates()[0];
  if (!input) {
    // The attach menu may create an input lazily; do not click unrelated controls.
    const add = document.querySelector('[data-testid="composer-plus-btn"], button[aria-label="Add files and more"]');
    if (add instanceof HTMLElement) {
      add.click();
      await sleep(500);
      input = candidates()[0];
    }
  }
  if (!input) return false;
  try {
    const data = new DataTransfer();
    data.items.add(fileFromDataURL(dataUrl));
    input.files = data.files;
    input.dispatchEvent(new Event("change", {bubbles:true}));
    // The event firing does NOT guarantee ChatGPT accepted the file.
    return true;
  } catch (error) {
    console.warn("ChatGPT画像添付は手動操作が必要です", error);
    return false;
  }
}
function showStatus(text) {
  document.getElementById("threads-chatgpt-handoff-status")?.remove();
  const note = document.createElement("div");
  note.id="threads-chatgpt-handoff-status";
  note.setAttribute("role","status");
  Object.assign(note.style, {
    position:"fixed",right:"20px",bottom:"88px",zIndex:"2147483647",
    maxWidth:"340px",background:"#12323a",color:"#fff",padding:"14px 16px",
    borderRadius:"12px",fontFamily:"system-ui,sans-serif",fontSize:"13px",
    lineHeight:"1.7",boxShadow:"0 8px 32px #0004"
  });
  const p=document.createElement("div");
  p.textContent=text;
  const close=document.createElement("button");
  close.textContent="閉じる";
  Object.assign(close.style,{background:"transparent",border:"1px solid #789",
    borderRadius:"6px",padding:"4px 9px",color:"#fff",cursor:"pointer",marginTop:"9px"});
  close.addEventListener("click",()=>note.remove());
  note.append(p,close);
  document.body.append(note);
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if (message?.type !== "STAGE_CHATGPT_REQUEST") return;
  (async () => {
    if (staged) return {ok:true};
    const composer = await waitForComposer();
    if (!composer) return {ok:false};
    const promptReady = putPrompt(composer, message.prompt);
    const attachAttempted = await attachScreenshot(message.imageDataUrl);
    staged = promptReady;
    if (!promptReady) {
      showStatus("入力欄を自動設定できませんでした。ChatGPTの入力欄へ返信依頼を入力してください。");
      return {ok:false};
    }
    const platformPaste = /Mac/i.test(navigator.platform) ? "⌘+V" : "Ctrl+V";
    showStatus(attachAttempted
      ? "返信指示を入力し、画像の自動添付を試みました。画像のプレビューを必ず確認してから送信してください。添付がなければ " + platformPaste + " で貼り付けてください。回答ができたらChatGPTの「コピー」を押します。"
      : "返信指示を入力しました。スクリーンショットはクリップボードに保存を試みました。入力欄で " + platformPaste + " を押して画像を添付し、送信してください。完成した回答は「コピー」を押します。");
    composer.focus();
    return {ok:true, attachAttempted};
  })().then(sendResponse).catch(error=>{
    console.error(error);
    sendResponse({ok:false,error:error.message});
  });
  return true;
});
chrome.runtime.sendMessage({type:"CHATGPT_HANDOFF_READY"}).catch(()=>{});
