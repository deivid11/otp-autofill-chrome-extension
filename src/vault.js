// src/vault.js
// Encryption-at-rest for the account seeds, loaded ONLY by the background
// service worker (the single context allowed to touch secrets).
//
// Storage layout:
//   chrome.storage.local.accounts  — plaintext accounts (only while no master
//                                    password is set)
//   chrome.storage.local.vault    — {version, kdf, iterations, salt, iv, data}
//                                    AES-256-GCM blob of the accounts array
//   chrome.storage.session        — vaultKey (raw key bits, base64) +
//                                    vaultLastUsed. Session storage is
//                                    memory-only, cleared when the browser
//                                    closes, and NOT readable from content
//                                    scripts (TRUSTED_CONTEXTS only).
//
// The unlocked key is cached in session storage so the user types the master
// password once per browser session, not on every popup open. An optional
// auto-lock (settings.autoLockMinutes) drops the cached key after inactivity.

(function () {
  const VAULT_KEY = "vault";
  const ACCOUNTS_KEY = "accounts";
  const SESSION_KEY_BITS = "vaultKey";
  const SESSION_LAST_USED = "vaultLastUsed";
  const KDF_ITERATIONS = 600000; // OWASP-recommended floor for PBKDF2-SHA256

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function b64(bytes) {
    let s = "";
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s);
  }

  function unb64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveBits(password, salt, iterations) {
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      keyMaterial,
      256
    );
    return new Uint8Array(bits);
  }

  async function aesKey(bits) {
    return crypto.subtle.importKey("raw", bits, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }

  async function encryptString(bits, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await aesKey(bits);
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      enc.encode(plaintext)
    );
    return { iv: b64(iv), data: b64(data) };
  }

  // Throws on a wrong key — AES-GCM authentication doubles as the password check.
  async function decryptString(bits, ivB64, dataB64) {
    const key = await aesKey(bits);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(ivB64) },
      key,
      unb64(dataB64)
    );
    return dec.decode(plain);
  }

  async function getVaultBlob() {
    const r = await chrome.storage.local.get(VAULT_KEY);
    return r[VAULT_KEY] || null;
  }

  // Cached key bits, honoring the auto-lock timeout. Returns null when locked.
  async function getSessionBits() {
    const r = await chrome.storage.session.get([
      SESSION_KEY_BITS,
      SESSION_LAST_USED,
    ]);
    if (!r[SESSION_KEY_BITS]) return null;
    const settings = await globalThis.OTP.getSettings();
    const mins = parseInt(settings.autoLockMinutes, 10) || 0;
    if (mins > 0 && Date.now() - (r[SESSION_LAST_USED] || 0) > mins * 60000) {
      await vaultLock();
      return null;
    }
    await chrome.storage.session.set({ [SESSION_LAST_USED]: Date.now() });
    return unb64(r[SESSION_KEY_BITS]);
  }

  async function setSessionBits(bits) {
    await chrome.storage.session.set({
      [SESSION_KEY_BITS]: b64(bits),
      [SESSION_LAST_USED]: Date.now(),
    });
  }

  // ---- public state -----------------------------------------------------

  // "plain" (no master password) | "locked" | "unlocked"
  async function vaultState() {
    if (!(await getVaultBlob())) return "plain";
    const bits = await getSessionBits();
    return bits ? "unlocked" : "locked";
  }

  async function vaultLock() {
    await chrome.storage.session.remove([SESSION_KEY_BITS, SESSION_LAST_USED]);
  }

  async function vaultUnlock(password) {
    const blob = await getVaultBlob();
    if (!blob) return { error: "no-vault" };
    const bits = await deriveBits(
      password,
      unb64(blob.salt),
      blob.iterations || KDF_ITERATIONS
    );
    try {
      await decryptString(bits, blob.iv, blob.data);
    } catch (e) {
      return { error: "wrong-password" };
    }
    await setSessionBits(bits);
    return { ok: true };
  }

  async function vaultEnable(password) {
    if (await getVaultBlob()) return { error: "already-enabled" };
    if (!password) return { error: "empty-password" };
    const accounts = await globalThis.OTP.getAccounts();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const bits = await deriveBits(password, salt, KDF_ITERATIONS);
    const { iv, data } = await encryptString(bits, JSON.stringify(accounts));
    await chrome.storage.local.set({
      [VAULT_KEY]: {
        version: 1,
        kdf: "PBKDF2-SHA256",
        iterations: KDF_ITERATIONS,
        salt: b64(salt),
        iv,
        data,
      },
    });
    await chrome.storage.local.remove(ACCOUNTS_KEY); // plaintext copy gone
    await setSessionBits(bits);
    return { ok: true };
  }

  async function vaultDisable(password) {
    const blob = await getVaultBlob();
    if (!blob) return { error: "no-vault" };
    const bits = await deriveBits(
      password,
      unb64(blob.salt),
      blob.iterations || KDF_ITERATIONS
    );
    let accounts;
    try {
      accounts = JSON.parse(await decryptString(bits, blob.iv, blob.data));
    } catch (e) {
      return { error: "wrong-password" };
    }
    await chrome.storage.local.set({ [ACCOUNTS_KEY]: accounts });
    await chrome.storage.local.remove(VAULT_KEY);
    await vaultLock();
    return { ok: true };
  }

  async function vaultChangePassword(current, next) {
    const blob = await getVaultBlob();
    if (!blob) return { error: "no-vault" };
    if (!next) return { error: "empty-password" };
    const oldBits = await deriveBits(
      current,
      unb64(blob.salt),
      blob.iterations || KDF_ITERATIONS
    );
    let accounts;
    try {
      accounts = JSON.parse(await decryptString(oldBits, blob.iv, blob.data));
    } catch (e) {
      return { error: "wrong-password" };
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const bits = await deriveBits(next, salt, KDF_ITERATIONS);
    const { iv, data } = await encryptString(bits, JSON.stringify(accounts));
    await chrome.storage.local.set({
      [VAULT_KEY]: {
        version: 1,
        kdf: "PBKDF2-SHA256",
        iterations: KDF_ITERATIONS,
        salt: b64(salt),
        iv,
        data,
      },
    });
    await setSessionBits(bits);
    return { ok: true };
  }

  // ---- vault-aware account access ----------------------------------------
  // The ONLY way the rest of the background reads/writes accounts.

  async function getAccountsSecure() {
    const blob = await getVaultBlob();
    if (!blob) {
      return { ok: true, accounts: await globalThis.OTP.getAccounts() };
    }
    const bits = await getSessionBits();
    if (!bits) return { locked: true };
    try {
      return {
        ok: true,
        accounts: JSON.parse(await decryptString(bits, blob.iv, blob.data)),
      };
    } catch (e) {
      // session key no longer matches the blob (should not happen) — relock
      await vaultLock();
      return { locked: true };
    }
  }

  async function saveAccountsSecure(accounts) {
    const blob = await getVaultBlob();
    if (!blob) {
      await globalThis.OTP.saveAccounts(accounts);
      return { ok: true };
    }
    const bits = await getSessionBits();
    if (!bits) return { locked: true };
    const { iv, data } = await encryptString(bits, JSON.stringify(accounts));
    await chrome.storage.local.set({
      [VAULT_KEY]: Object.assign({}, blob, { iv, data }),
    });
    return { ok: true };
  }

  // ---- encrypted export/backup envelope -----------------------------------
  // Same KDF + cipher as the vault, standalone file format.

  async function encryptEnvelope(passphrase, payload) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const bits = await deriveBits(passphrase, salt, KDF_ITERATIONS);
    const { iv, data } = await encryptString(bits, payload);
    return {
      type: "otp-export-encrypted",
      version: 1,
      kdf: "PBKDF2-SHA256",
      iterations: KDF_ITERATIONS,
      salt: b64(salt),
      iv,
      data,
    };
  }

  async function decryptEnvelope(passphrase, envelope) {
    if (!envelope || envelope.type !== "otp-export-encrypted") {
      return { error: "not-envelope" };
    }
    const bits = await deriveBits(
      passphrase,
      unb64(envelope.salt),
      envelope.iterations || KDF_ITERATIONS
    );
    try {
      return { ok: true, payload: await decryptString(bits, envelope.iv, envelope.data) };
    } catch (e) {
      return { error: "wrong-passphrase" };
    }
  }

  globalThis.OTP = Object.assign(globalThis.OTP || {}, {
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
  });
})();
