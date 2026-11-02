// Chrome 116+ offscreen document; only user-initiated screenshot PNG is copied.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen" || message.type !== "COPY_PNG") return;
  (async () => {
    const response = await fetch(message.dataUrl);
    const blob = await response.blob();
    if (blob.type !== "image/png") throw new Error("PNG以外の形式です");
    await navigator.clipboard.write([new ClipboardItem({"image/png":blob})]);
    return {ok:true};
  })().then(sendResponse).catch(error => {
    console.warn("画像のクリップボード転送に失敗", error);
    sendResponse({ok:false,error:error.message});
  });
  return true;
});
