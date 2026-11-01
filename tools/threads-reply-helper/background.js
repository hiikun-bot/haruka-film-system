// Chrome 116+ / Manifest V3
const MENU_ID = "threads-generate-reply";

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "この投稿の返信案を作る",
    contexts: ["all"],
    documentUrlPatterns: [
      "https://threads.net/*", "https://www.threads.net/*",
      "https://threads.com/*", "https://www.threads.com/*"
    ]
  });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // APIキーをコンテンツスクリプトに公開しない
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  // ユーザー操作に直接続けてパネルを開く（await より前）
  if (tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);

  (async () => {
    let sourceText = (info.selectionText || "").trim();
    if (!sourceText && tab?.id) {
      try {
        const captured = await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_CONTEXT_POST" });
        sourceText = (captured?.text || "").trim();
      } catch (error) {
        console.warn("投稿を自動取得できませんでした", error);
      }
    }
    await chrome.storage.session.set({
      capture: {
        text: sourceText.slice(0, 4000),
        url: info.pageUrl || tab?.url || "",
        at: Date.now()
      }
    });
  })().catch(console.error);
});
