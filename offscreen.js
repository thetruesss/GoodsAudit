setInterval(() => {
  try {
    chrome.runtime.sendMessage({ type: "SW_KEEPALIVE" }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
  }
}, 20000);

try {
  chrome.runtime.sendMessage({ type: "SW_KEEPALIVE" }, () => {
    void chrome.runtime.lastError;
  });
} catch {
}
