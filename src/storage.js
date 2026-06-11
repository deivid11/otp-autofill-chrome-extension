// src/storage.js
// Thin async wrapper over chrome.storage for accounts, settings and the
// short-lived captured email. Shared via globalThis.OTP.

(function () {
  const ACCOUNTS_KEY = "accounts";
  const SETTINGS_KEY = "settings";

  const DEFAULT_SETTINGS = {
    autoFill: true, // fill OTP boxes automatically when a match is found
    autoSubmit: false, // click the submit button after filling
    fallbackSingle: true, // if exactly one account exists, use it when no email match
    matchByIssuer: true, // also try to match the page hostname against the issuer
    showButton: true, // show the floating "Fill OTP" helper button
    rememberDomainEmail: true, // durably remember the last login email per domain
    debug: false, // verbose [OTP-AF] console logging for troubleshooting
  };

  const DOMAIN_EMAIL_PREFIX = "domainEmail:";

  // Reduce a hostname to its registrable domain so the login email captured on
  // auth.example.com is still found on app.example.com. Handles common
  // country second-level TLDs (com.mx, co.uk, ...).
  function registrableDomain(hostname) {
    const h = String(hostname || "")
      .toLowerCase()
      .replace(/\.$/, "");
    if (!h || h === "localhost" || /^\d+(\.\d+){3}$/.test(h)) return h;
    const parts = h.split(".");
    if (parts.length <= 2) return h;
    const secondLevel = new Set([
      "com", "net", "org", "gob", "gov", "edu", "co", "mil", "ac",
    ]);
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    if (tld.length === 2 && secondLevel.has(sld)) {
      return parts.slice(-3).join(".");
    }
    return parts.slice(-2).join(".");
  }

  async function getAccounts() {
    const r = await chrome.storage.local.get(ACCOUNTS_KEY);
    return Array.isArray(r[ACCOUNTS_KEY]) ? r[ACCOUNTS_KEY] : [];
  }

  async function saveAccounts(list) {
    await chrome.storage.local.set({ [ACCOUNTS_KEY]: list });
  }

  async function getSettings() {
    const r = await chrome.storage.local.get(SETTINGS_KEY);
    return Object.assign({}, DEFAULT_SETTINGS, r[SETTINGS_KEY] || {});
  }

  async function saveSettings(patch) {
    const current = await getSettings();
    const next = Object.assign({}, current, patch);
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  // Captured login email is kept per-origin in session storage so it survives
  // the SPA navigation from step 1 -> step 2 but clears when the browser closes.
  // session storage falls back to local if it is not reachable.
  function emailKey(origin) {
    return "email:" + origin;
  }

  async function setCapturedEmail(origin, email) {
    const payload = { email, ts: Date.now() };
    try {
      await chrome.storage.session.set({ [emailKey(origin)]: payload });
    } catch (e) {
      await chrome.storage.local.set({ [emailKey(origin)]: payload });
    }
  }

  async function getCapturedEmail(origin) {
    const key = emailKey(origin);
    try {
      const r = await chrome.storage.session.get(key);
      if (r[key]) return r[key].email;
    } catch (e) {
      /* fall through */
    }
    const r2 = await chrome.storage.local.get(key);
    return r2[key] ? r2[key].email : "";
  }

  // ---- durable per-domain "last login email" -------------------------------
  // Persisted in local storage so it survives browser restarts and is available
  // on later visits where the page never shows an email field (e.g. an OTP
  // modal that confirms a transaction in an already-logged-in app).

  function domainEmailKey(domain) {
    return DOMAIN_EMAIL_PREFIX + domain;
  }

  async function setDomainEmail(domain, email) {
    if (!domain || !email) return;
    await chrome.storage.local.set({
      [domainEmailKey(domain)]: { email, ts: Date.now() },
    });
  }

  async function getDomainEmail(domain) {
    if (!domain) return "";
    const key = domainEmailKey(domain);
    const r = await chrome.storage.local.get(key);
    return r[key] ? r[key].email : "";
  }

  async function getAllDomainEmails() {
    const all = await chrome.storage.local.get(null);
    const out = [];
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(DOMAIN_EMAIL_PREFIX) && v && v.email) {
        out.push({
          domain: k.slice(DOMAIN_EMAIL_PREFIX.length),
          email: v.email,
          ts: v.ts || 0,
        });
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }

  async function removeDomainEmail(domain) {
    await chrome.storage.local.remove(domainEmailKey(domain));
  }

  async function clearDomainEmails() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) =>
      k.startsWith(DOMAIN_EMAIL_PREFIX)
    );
    if (keys.length) await chrome.storage.local.remove(keys);
  }

  globalThis.OTP = Object.assign(globalThis.OTP || {}, {
    DEFAULT_SETTINGS,
    registrableDomain,
    getAccounts,
    saveAccounts,
    getSettings,
    saveSettings,
    setCapturedEmail,
    getCapturedEmail,
    setDomainEmail,
    getDomainEmail,
    getAllDomainEmails,
    removeDomainEmail,
    clearDomainEmails,
  });
})();
