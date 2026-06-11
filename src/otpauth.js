// src/otpauth.js
// Parse / serialize otpauth:// URIs and normalize account records.
// Shared via globalThis.OTP.

(function () {
  function randomId() {
    // crypto.randomUUID is available in both worker and content contexts.
    try {
      return crypto.randomUUID();
    } catch (e) {
      return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }

  function normalizeEmail(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  // Parse a single otpauth://totp/... (or hotp) URI into an account record.
  function parseOtpauth(uri) {
    const raw = String(uri || "").trim();
    if (!/^otpauth:\/\//i.test(raw)) {
      throw new Error("Not an otpauth:// URI");
    }
    const url = new URL(raw);
    const type = (url.host || "totp").toLowerCase(); // totp | hotp

    // The label is the path: "Issuer:account" or just "account".
    let label = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    let issuer = url.searchParams.get("issuer") || "";
    let account = label;
    const colon = label.indexOf(":");
    if (colon !== -1) {
      const labelIssuer = label.slice(0, colon).trim();
      account = label.slice(colon + 1).trim();
      if (!issuer) issuer = labelIssuer;
    }

    const secret = (url.searchParams.get("secret") || "").replace(/\s/g, "");
    if (!secret) throw new Error("otpauth URI is missing a secret");

    return {
      id: randomId(),
      type,
      issuer: issuer.trim(),
      account: account.trim(),
      secret,
      algorithm: (url.searchParams.get("algorithm") || "SHA1").toUpperCase(),
      digits: parseInt(url.searchParams.get("digits") || "6", 10) || 6,
      period: parseInt(url.searchParams.get("period") || "30", 10) || 30,
      counter: parseInt(url.searchParams.get("counter") || "0", 10) || 0,
    };
  }

  // Serialize an account record back into an otpauth:// URI (for export).
  function toOtpauth(acc) {
    const type = acc.type || "totp";
    const label = acc.issuer
      ? `${encodeURIComponent(acc.issuer)}:${encodeURIComponent(acc.account || "")}`
      : encodeURIComponent(acc.account || "");
    const params = new URLSearchParams();
    params.set("secret", acc.secret);
    if (acc.issuer) params.set("issuer", acc.issuer);
    if (acc.algorithm && acc.algorithm !== "SHA1")
      params.set("algorithm", acc.algorithm);
    if (acc.digits && acc.digits !== 6) params.set("digits", String(acc.digits));
    if (acc.period && acc.period !== 30) params.set("period", String(acc.period));
    if (type === "hotp") params.set("counter", String(acc.counter || 0));
    return `otpauth://${type}/${label}?${params.toString()}`;
  }

  // Accept a blob of text and pull out every otpauth URI / JSON account it can.
  function parseImport(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return [];

    // Try JSON first (our own export format, or a raw array of accounts).
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const data = JSON.parse(trimmed);
        const list = Array.isArray(data) ? data : data.accounts || [];
        return list
          .map((a) => normalizeAccount(a))
          .filter((a) => a && a.secret);
      } catch (e) {
        // fall through to line parsing
      }
    }

    // Otherwise treat each non-empty line as an otpauth URI.
    const out = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || !/^otpauth:\/\//i.test(l)) continue;
      try {
        out.push(parseOtpauth(l));
      } catch (e) {
        // skip malformed lines, keep importing the rest
      }
    }
    return out;
  }

  // Coerce a loose object (manual form / imported JSON) into a clean record.
  function normalizeAccount(a) {
    if (!a) return null;
    return {
      id: a.id || randomId(),
      type: (a.type || "totp").toLowerCase(),
      issuer: (a.issuer || "").trim(),
      account: (a.account || a.label || "").trim(),
      secret: (a.secret || "").replace(/\s/g, "").toUpperCase(),
      algorithm: (a.algorithm || "SHA1").toUpperCase(),
      digits: parseInt(a.digits, 10) || 6,
      period: parseInt(a.period, 10) || 30,
      counter: parseInt(a.counter, 10) || 0,
      // per-site autofill approvals — kept so JSON backups restore them
      domains: Array.isArray(a.domains)
        ? a.domains.filter((d) => typeof d === "string")
        : [],
    };
  }

  function displayName(acc) {
    if (acc.issuer && acc.account) return `${acc.issuer} (${acc.account})`;
    return acc.issuer || acc.account || "Unnamed";
  }

  globalThis.OTP = Object.assign(globalThis.OTP || {}, {
    randomId,
    normalizeEmail,
    parseOtpauth,
    toOtpauth,
    parseImport,
    normalizeAccount,
    displayName,
  });
})();
