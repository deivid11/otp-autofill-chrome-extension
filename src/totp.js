// src/totp.js
// Dependency-free TOTP/HOTP generator using the Web Crypto API.
// Exposes everything on globalThis.OTP so it can be shared by the content
// script (isolated world) and the popup (regular page) without ES modules.

(function () {
  const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  // RFC 4648 base32 -> Uint8Array. Tolerates spaces, lowercase and padding.
  function base32Decode(input) {
    const clean = String(input || "")
      .toUpperCase()
      .replace(/=+$/, "")
      .replace(/[\s-]/g, "");
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
      const idx = B32_ALPHABET.indexOf(ch);
      if (idx === -1) continue; // skip anything that is not valid base32
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out.push((value >>> bits) & 0xff);
      }
    }
    return new Uint8Array(out);
  }

  function hashName(algorithm) {
    switch (String(algorithm || "SHA1").toUpperCase()) {
      case "SHA256":
      case "SHA-256":
        return "SHA-256";
      case "SHA512":
      case "SHA-512":
        return "SHA-512";
      default:
        return "SHA-1";
    }
  }

  // 8-byte big-endian counter for the HMAC input.
  function counterToBytes(counter) {
    const bytes = new Uint8Array(8);
    let tmp = counter;
    for (let i = 7; i >= 0; i--) {
      bytes[i] = tmp & 0xff;
      tmp = Math.floor(tmp / 256);
    }
    return bytes;
  }

  async function generateHOTP(secret, counter, algorithm, digits) {
    const keyBytes = base32Decode(secret);
    if (!keyBytes.length) throw new Error("Invalid or empty secret");
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: hashName(algorithm) },
      false,
      ["sign"]
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", cryptoKey, counterToBytes(counter))
    );
    const offset = sig[sig.length - 1] & 0x0f;
    const binary =
      ((sig[offset] & 0x7f) << 24) |
      ((sig[offset + 1] & 0xff) << 16) |
      ((sig[offset + 2] & 0xff) << 8) |
      (sig[offset + 3] & 0xff);
    const mod = 10 ** (digits || 6);
    return (binary % mod).toString().padStart(digits || 6, "0");
  }

  // Generate a TOTP code for the given account config at a point in time.
  async function generateTOTP(account, atMs) {
    const {
      secret,
      algorithm = "SHA1",
      digits = 6,
      period = 30,
    } = account || {};
    const now = typeof atMs === "number" ? atMs : Date.now();
    const counter = Math.floor(now / 1000 / period);
    return generateHOTP(secret, counter, algorithm, digits);
  }

  // Seconds remaining in the current TOTP window (for countdown UI).
  function secondsRemaining(period, atMs) {
    const p = period || 30;
    const now = typeof atMs === "number" ? atMs : Date.now();
    return p - (Math.floor(now / 1000) % p);
  }

  globalThis.OTP = Object.assign(globalThis.OTP || {}, {
    base32Decode,
    generateHOTP,
    generateTOTP,
    secondsRemaining,
  });
})();
