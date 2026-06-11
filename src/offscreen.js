// src/offscreen.js
// Clears the clipboard ~45 s after a code was copied — but only if it still
// holds that exact code, so a newer user copy is never clobbered. Uses the
// documented offscreen execCommand pattern (clipboard API needs page focus,
// which offscreen documents never have).

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type !== "clipboard.clearIfMatches") return;

  const buf = document.getElementById("buf");

  buf.value = "";
  buf.focus();
  document.execCommand("paste");
  const current = buf.value;

  let cleared = false;
  if (current === msg.expected) {
    buf.value = " "; // execCommand("copy") is a no-op on an empty selection
    buf.select();
    cleared = document.execCommand("copy");
  }
  sendResponse({ cleared });
});
