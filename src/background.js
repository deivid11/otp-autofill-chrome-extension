// src/background.js
// MV3 service worker. Grants content scripts session-storage access, routes the
// keyboard command, and powers the right-click "scan QR" import. Imports the
// shared libs so it can decode QR images and persist accounts.
importScripts(
  "totp.js",
  "otpauth.js",
  "storage.js",
  "../vendor/jsQR.js",
  "qr.js"
);

const { parseImport, getAccounts, saveAccounts, qr } = globalThis.OTP;

function grantSessionAccess() {
  try {
    chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
    });
  } catch (e) {
    // older Chrome without session access levels — content script falls back
    // to chrome.storage.local automatically.
  }
}

grantSessionAccess();

chrome.runtime.onInstalled.addListener(() => {
  grantSessionAccess();
  chrome.contextMenus.create(
    {
      id: "add-totp-qr",
      title: "Add authenticator (scan QR in this image)",
      contexts: ["image"],
    },
    () => void chrome.runtime.lastError
  );
});
chrome.runtime.onStartup.addListener(grantSessionAccess);

// brief badge feedback on the toolbar icon
function flashBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3500);
}

function sameIdentity(a, b) {
  const n = (s) => (s || "").trim().toLowerCase();
  return n(a.account) === n(b.account) && n(a.issuer) === n(b.issuer);
}

// Add account(s) from a decoded QR / otpauth string. Returns {added,dup} or
// {error}. The right-click flow has no UI to ask, so duplicates are skipped
// (the popup's Import offers an override prompt).
async function addFromDecoded(decoded) {
  if (!decoded) return { error: "no-qr" };
  if (/^otpauth-migration:\/\//i.test(decoded)) {
    return { error: "migration-unsupported" };
  }
  const parsed = parseImport(decoded);
  if (!parsed.length) return { error: "not-otpauth" };
  const accounts = await getAccounts();
  let added = 0;
  let dup = 0;
  for (const p of parsed) {
    if (accounts.some((a) => sameIdentity(a, p))) {
      dup++;
      continue;
    }
    accounts.push(p);
    added++;
  }
  await saveAccounts(accounts);
  return { added, dup };
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "add-totp-qr" || !info.srcUrl) return;
  try {
    const decoded = await qr.decodeFromUrl(info.srcUrl);
    const res = await addFromDecoded(decoded);
    if (res.added > 0) flashBadge("+" + res.added, "#2fbf71");
    else if (res.dup > 0) flashBadge("=", "#e0a52f"); // already exists
    else if (res.error === "migration-unsupported") flashBadge("mig", "#e0a52f");
    else flashBadge("?", "#a3303c");
  } catch (e) {
    flashBadge("err", "#a3303c");
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "fill-otp") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id != null) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "FILL_NOW" }, () => {
        void chrome.runtime.lastError;
      });
    }
  });
});
