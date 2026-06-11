// src/background.js
// MV3 service worker — the ONLY context that touches account seeds.
// Content scripts ask for at most a 6-digit code via messages; the seed never
// enters a tab. Also powers the keyboard command, the right-click "scan QR"
// import, the master-password vault and the clipboard auto-clear.
importScripts(
  "totp.js",
  "otpauth.js",
  "storage.js",
  "vault.js",
  "../vendor/jsQR.js",
  "qr.js"
);

const {
  parseImport,
  parseOtpauth,
  toOtpauth,
  normalizeAccount,
  normalizeEmail,
  displayName,
  validateBase32,
  generateTOTP,
  secondsRemaining,
  registrableDomain,
  getSettings,
  setCapturedEmail,
  getCapturedEmail,
  setDomainEmail,
  getDomainEmail,
  vaultState,
  vaultLock,
  vaultUnlock,
  vaultEnable,
  vaultDisable,
  vaultChangePassword,
  getAccountsSecure,
  saveAccountsSecure,
  encryptEnvelope,
  decryptEnvelope,
  qr,
} = globalThis.OTP;

const CLIPBOARD_ALARM = "clipboard-clear";
const CLIPBOARD_SESSION_KEY = "clipboardPending";
const CLIPBOARD_CLEAR_MS = 45000;

// Captured emails live in chrome.storage.session, which must stay readable by
// trusted (extension) contexts only — content scripts go through messages.
function restrictSessionAccess() {
  try {
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (e) {
    /* default is already trusted-only */
  }
}

restrictSessionAccess();

chrome.runtime.onInstalled.addListener(() => {
  restrictSessionAccess();
  chrome.contextMenus.create(
    {
      id: "add-totp-qr",
      title: "Add authenticator (scan QR in this image)",
      contexts: ["image"],
    },
    () => void chrome.runtime.lastError
  );
});
chrome.runtime.onStartup.addListener(restrictSessionAccess);

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

// Reject anything we can't generate correct codes for, at add time.
function validateAccount(acc) {
  if ((acc.type || "totp") !== "totp") {
    return { error: "HOTP accounts aren't supported — only TOTP" };
  }
  const v = validateBase32(acc.secret);
  if (!v.ok) return { error: v.error };
  return { ok: true };
}

// ---- account matching ------------------------------------------------------

// Exact registrable-domain match by default, so issuer "GitHub" matches
// github.com / login.github.com but NOT github.evil.com or
// login-github.attacker.io. Passing exact=false opts into the legacy loose
// mode (issuer token appears anywhere in the hostname) — phishable, but some
// setups need it (settings.issuerExactMatch).
function issuerMatchesHost(issuer, host, exact) {
  if (!issuer) return false;
  const hostNorm = String(host || "").toLowerCase();
  const issuerNorm = String(issuer).toLowerCase().trim();
  const token = issuerNorm.split(/[^a-z0-9]+/)[0];
  if (exact === false) {
    if (!token || token.length < 3) return false;
    return hostNorm.includes(token);
  }
  const domain = registrableDomain(hostNorm);
  if (!domain) return false;
  if (issuerNorm.includes(".")) {
    // issuer is itself a domain ("github.com")
    return registrableDomain(issuerNorm) === domain;
  }
  if (!token || token.length < 3) return false;
  return domain.split(".")[0] === token;
}

async function pickAccount(accounts, settings, origin, host) {
  if (!accounts.length) return null;

  // Email captured in this flow (session) first, then the durable
  // last-login email remembered for this domain.
  const domain = registrableDomain(host);
  const candidates = [];
  const sessionEmail = await getCapturedEmail(origin);
  if (sessionEmail) candidates.push(sessionEmail);
  const domainEmail = await getDomainEmail(domain);
  if (domainEmail && domainEmail !== sessionEmail) candidates.push(domainEmail);

  for (const email of candidates) {
    const match = accounts.find(
      (a) => normalizeEmail(a.account) === normalizeEmail(email)
    );
    if (match) return { account: match, reason: "email" };
  }

  if (settings.matchByIssuer) {
    const exact = settings.issuerExactMatch !== false;
    const byIssuer = accounts.find((a) =>
      issuerMatchesHost(a.issuer, host, exact)
    );
    if (byIssuer) return { account: byIssuer, reason: "issuer" };
  }

  if (settings.fallbackSingle && accounts.length === 1) {
    return { account: accounts[0], reason: "only-account" };
  }

  return null;
}

// ---- sender validation -------------------------------------------------------

const EXT_ORIGIN = "chrome-extension://" + chrome.runtime.id;

function isExtensionSender(sender) {
  return (
    sender.origin === EXT_ORIGIN ||
    (sender.url || "").startsWith(EXT_ORIGIN + "/")
  );
}

function senderHost(sender) {
  try {
    return new URL(sender.url).hostname;
  } catch (e) {
    return null;
  }
}

function senderOrigin(sender) {
  try {
    return new URL(sender.url).origin;
  } catch (e) {
    return null;
  }
}

// A subframe whose site differs from the top page never gets a code — a page
// must not be able to harvest OTPs by embedding another site's login.
function isCrossSiteFrame(sender) {
  if (!sender.tab || sender.frameId === 0) return false;
  try {
    const frameDomain = registrableDomain(new URL(sender.url).hostname);
    const topDomain = registrableDomain(new URL(sender.tab.url).hostname);
    return frameDomain !== topDomain;
  } catch (e) {
    return true; // can't verify the top frame -> refuse
  }
}

// ---- code decision (the autofill trust model) -------------------------------

// gesture=true means the request came from an explicit user action (floating
// button click, popup "Fill tab", keyboard command). Accounts are bound to the
// registrable domains they've been explicitly used on; only bound domains may
// auto-fill without a gesture. An explicit fill on a new domain remembers it.
async function decideCode(sender, gesture) {
  if (isCrossSiteFrame(sender)) return { blocked: "cross-origin-frame" };
  const host = senderHost(sender);
  const origin = senderOrigin(sender);
  if (!host) return { blocked: "no-host" };

  const st = await getAccountsSecure();
  if (st.locked) return { locked: true };
  const accounts = st.accounts;
  if (!accounts.length) return { none: true, hasAccounts: false };

  const settings = await getSettings();
  const picked = await pickAccount(accounts, settings, origin, host);
  if (!picked) return { none: true, hasAccounts: true };

  const domain = registrableDomain(host);
  const domains = picked.account.domains || [];
  if (!domains.includes(domain)) {
    if (!gesture) {
      return { needsGesture: true, label: displayName(picked.account) };
    }
    picked.account.domains = domains.concat(domain);
    await saveAccountsSecure(accounts);
  }

  try {
    const code = await generateTOTP(picked.account);
    return { ok: true, code, reason: picked.reason };
  } catch (e) {
    return { none: true, hasAccounts: true, error: "bad-secret" };
  }
}

// ---- clipboard auto-clear ----------------------------------------------------

async function scheduleClipboardClear(expected) {
  await chrome.storage.session.set({
    [CLIPBOARD_SESSION_KEY]: { expected, ts: Date.now() },
  });
  chrome.alarms.create(CLIPBOARD_ALARM, {
    when: Date.now() + CLIPBOARD_CLEAR_MS,
  });
}

async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: "src/offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "Clear the copied OTP code from the clipboard",
    });
  } catch (e) {
    // already open — fine
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== CLIPBOARD_ALARM) return;
  const r = await chrome.storage.session.get(CLIPBOARD_SESSION_KEY);
  const pending = r[CLIPBOARD_SESSION_KEY];
  await chrome.storage.session.remove(CLIPBOARD_SESSION_KEY);
  if (!pending || !pending.expected) return;
  await ensureOffscreen();
  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "clipboard.clearIfMatches",
      expected: pending.expected,
    });
  } finally {
    chrome.offscreen.closeDocument(() => void chrome.runtime.lastError);
  }
});

// ---- QR add (right-click context menu) ---------------------------------------

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
  const st = await getAccountsSecure();
  if (st.locked) return { error: "locked" };
  const accounts = st.accounts;
  let added = 0;
  let dup = 0;
  let rejected = 0;
  for (const p of parsed) {
    if (!validateAccount(p).ok) {
      rejected++;
      continue;
    }
    if (accounts.some((a) => sameIdentity(a, p))) {
      dup++;
      continue;
    }
    accounts.push(p);
    added++;
  }
  if (added) await saveAccountsSecure(accounts);
  return { added, dup, rejected };
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "add-totp-qr" || !info.srcUrl) return;
  try {
    const decoded = await qr.decodeFromUrl(info.srcUrl);
    const res = await addFromDecoded(decoded);
    if (res.added > 0) flashBadge("+" + res.added, "#2fbf71");
    else if (res.dup > 0) flashBadge("=", "#e0a52f"); // already exists
    else if (res.rejected > 0) flashBadge("✗", "#a3303c"); // hotp / bad secret
    else if (res.error === "locked") flashBadge("lock", "#e0a52f");
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

// ---- message router -----------------------------------------------------------

// Content scripts may use these (page-derived data only, origin from sender):
const contentHandlers = {
  // Settings + frame state the content script needs to decide what UI to
  // show. Deliberately does NOT touch the vault — this runs on every frame
  // load, and lock/account state is delivered per code.request instead.
  "ctx.get": async (msg, sender) => {
    const settings = await getSettings();
    return {
      settings: {
        autoFill: settings.autoFill,
        autoSubmit: settings.autoSubmit,
        showButton: settings.showButton,
        debug: settings.debug,
      },
      blocked: isCrossSiteFrame(sender),
    };
  },

  "email.captured": async (msg, sender) => {
    const email = String(msg.email || "").trim();
    if (email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false };
    }
    const origin = senderOrigin(sender);
    const host = senderHost(sender);
    if (!origin || !host) return { ok: false };
    await setCapturedEmail(origin, email);
    const settings = await getSettings();
    if (settings.rememberDomainEmail) {
      await setDomainEmail(registrableDomain(host), email);
    }
    return { ok: true };
  },

  "code.request": (msg, sender) => decideCode(sender, !!msg.gesture),

  // the floating button can't open the popup itself; ask the browser to
  "popup.open": async () => {
    try {
      await chrome.action.openPopup();
      return { ok: true };
    } catch (e) {
      flashBadge("lock", "#e0a52f"); // draw the eye to the toolbar instead
      return { ok: false };
    }
  },
};

// Extension pages (popup) only:
const popupHandlers = {
  "vault.status": async () => {
    const settings = await getSettings();
    return {
      state: await vaultState(),
      autoLockMinutes: parseInt(settings.autoLockMinutes, 10) || 0,
    };
  },
  "vault.enable": (msg) => vaultEnable(msg.password),
  "vault.unlock": (msg) => vaultUnlock(msg.password),
  "vault.lock": async () => {
    await vaultLock();
    return { ok: true };
  },
  "vault.disable": (msg) => vaultDisable(msg.password),
  "vault.changePassword": (msg) => vaultChangePassword(msg.current, msg.next),

  // sanitized list — no secrets — for the account cards
  "accounts.list": async () => {
    const st = await getAccountsSecure();
    if (st.locked) return { locked: true };
    return {
      accounts: st.accounts.map((a) => ({
        id: a.id,
        issuer: a.issuer,
        account: a.account,
        algorithm: a.algorithm,
        digits: a.digits,
        period: a.period,
        domains: a.domains || [],
      })),
    };
  },

  // full record for the edit form
  "accounts.get": async (msg) => {
    const st = await getAccountsSecure();
    if (st.locked) return { locked: true };
    const acc = st.accounts.find((a) => a.id === msg.id);
    return acc ? { account: acc } : { error: "not-found" };
  },

  "accounts.codes": async () => {
    const st = await getAccountsSecure();
    if (st.locked) return { locked: true };
    const codes = [];
    for (const a of st.accounts) {
      try {
        codes.push({
          id: a.id,
          code: await generateTOTP(a),
          remaining: secondsRemaining(a.period),
          period: a.period || 30,
        });
      } catch (e) {
        codes.push({ id: a.id, error: true });
      }
    }
    return { codes };
  },

  "accounts.code": async (msg) => {
    const st = await getAccountsSecure();
    if (st.locked) return { locked: true };
    const acc = st.accounts.find((a) => a.id === msg.id);
    if (!acc) return { error: "not-found" };
    try {
      return { code: await generateTOTP(acc) };
    } catch (e) {
      return { error: "bad-secret" };
    }
  },

  // add or update (msg.account.id decides), with strict validation
  "accounts.save": async (msg) => {
    const acc = normalizeAccount(msg.account);
    if (!acc) return { error: "Invalid account" };
    const v = validateAccount(acc);
    if (v.error) return { error: v.error };
    acc.secret = validateBase32(acc.secret).normalized;
    const st = await getAccountsSecure();
    if (st.locked) return { locked: true };
    const accounts = st.accounts;
    const idx = accounts.findIndex((a) => a.id === acc.id);
    if (idx >= 0) acc.domains = accounts[idx].domains || [];
    if (idx >= 0) accounts[idx] = acc;
    else accounts.push(acc);
    const res = await saveAccountsSecure(accounts);
    if (res.locked) return { locked: true };
    return { ok: true, updated: idx >= 0 };
  },

  "accounts.remove": async (msg) => {
    const st = await getAccountsSecure();
    if (st.locked) return { locked: true };
    const res = await saveAccountsSecure(
      st.accounts.filter((a) => a.id !== msg.id)
    );
    return res.locked ? { locked: true } : { ok: true };
  },

  // forget one bound domain (edit view)
  "accounts.removeDomain": async (msg) => {
    const st = await getAccountsSecure();
    if (st.locked) return { locked: true };
    const acc = st.accounts.find((a) => a.id === msg.id);
    if (!acc) return { error: "not-found" };
    acc.domains = (acc.domains || []).filter((d) => d !== msg.domain);
    const res = await saveAccountsSecure(st.accounts);
    return res.locked ? { locked: true } : { ok: true };
  },

  // one import candidate at a time so the popup can run its override dialogs:
  // no override flag + duplicate -> {status:"dup"}; caller re-sends with
  // override:true (replace) or just skips.
  "accounts.importOne": async (msg) => {
    const acc = normalizeAccount(msg.account);
    if (!acc) return { status: "invalid", error: "Invalid account" };
    const v = validateAccount(acc);
    if (v.error) {
      return {
        status: (acc.type || "totp") !== "totp" ? "hotp" : "invalid",
        error: v.error,
      };
    }
    acc.secret = validateBase32(acc.secret).normalized;
    const st = await getAccountsSecure();
    if (st.locked) return { locked: true };
    const accounts = st.accounts;
    const idx = accounts.findIndex((a) => sameIdentity(a, acc));
    if (idx >= 0 && !msg.override) {
      return { status: "dup", sameSecret: accounts[idx].secret === acc.secret };
    }
    if (idx >= 0) {
      acc.id = accounts[idx].id; // keep the same slot
      acc.domains = accounts[idx].domains || [];
      accounts[idx] = acc;
    } else {
      accounts.push(acc);
    }
    const res = await saveAccountsSecure(accounts);
    if (res.locked) return { locked: true };
    return { status: idx >= 0 ? "overridden" : "added" };
  },

  // plaintext export — popup shows it only behind an explicit warning
  "accounts.export": async (msg) => {
    const st = await getAccountsSecure();
    if (st.locked) return { locked: true };
    if (msg.format === "json") {
      return { text: JSON.stringify({ version: 1, accounts: st.accounts }, null, 2) };
    }
    return { text: st.accounts.map(toOtpauth).join("\n") };
  },

  "accounts.exportEncrypted": async (msg) => {
    if (!msg.passphrase) return { error: "empty-passphrase" };
    const st = await getAccountsSecure();
    if (st.locked) return { locked: true };
    const payload = JSON.stringify({ version: 1, accounts: st.accounts });
    return { envelope: await encryptEnvelope(msg.passphrase, payload) };
  },

  // turn an encrypted backup back into importable otpauth URIs
  "accounts.decryptImport": async (msg) => {
    const res = await decryptEnvelope(msg.passphrase, msg.envelope);
    if (res.error) return res;
    try {
      const data = JSON.parse(res.payload);
      const list = Array.isArray(data) ? data : data.accounts || [];
      return { text: list.map(toOtpauth).join("\n") };
    } catch (e) {
      return { error: "corrupt" };
    }
  },

  "clipboard.scheduleClear": async (msg) => {
    const settings = await getSettings();
    if (settings.clearClipboard && msg.text) {
      await scheduleClipboardClear(String(msg.text));
    }
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.target === "offscreen") return; // for the offscreen document

  let handler = null;
  if (contentHandlers[msg.type]) {
    handler = contentHandlers[msg.type];
  } else if (popupHandlers[msg.type]) {
    if (!isExtensionSender(sender)) return; // privileged: extension pages only
    handler = popupHandlers[msg.type];
  }
  if (!handler) return;

  Promise.resolve(handler(msg, sender)).then(
    (result) => sendResponse(result),
    (err) => sendResponse({ error: String((err && err.message) || err) })
  );
  return true; // async response
});
