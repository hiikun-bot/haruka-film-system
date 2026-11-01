// 右クリックした位置に近い投稿テキストのみを取り出す。
// Threads のHTML構造は変わる可能性があり、結果は必ずパネルで確認する。
let lastCapture = "";

function normalize(text) {
  return String(text || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n").trim().slice(0, 4000);
}
function captureFromTarget(target) {
  const selection = normalize(window.getSelection()?.toString() || "");
  if (selection.length >= 4) return selection;
  if (!(target instanceof Element)) target = target?.parentElement;
  if (!(target instanceof Element)) return "";

  // 投稿単位の要素があれば優先。選択不能な場合もフォールバック。
  const semantic = target.closest('article, [data-pressable-container="true"], [data-testid="post"]');
  if (semantic) return normalize(semantic.innerText || semantic.textContent);

  let node = target;
  for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
    const text = normalize(node.innerText || "");
    // ページ全体・タイムライン全体の誤取り込みを回避
    if (text.length >= 15 && text.length <= 1500 && (node.querySelector('a[href*="/post/"]') || depth >= 2)) {
      return text;
    }
  }
  return normalize(target.innerText || target.textContent).slice(0, 1000);
}
document.addEventListener("contextmenu", (event) => {
  lastCapture = captureFromTarget(event.target);
}, true);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CAPTURE_CONTEXT_POST") sendResponse({ text: lastCapture });
});
