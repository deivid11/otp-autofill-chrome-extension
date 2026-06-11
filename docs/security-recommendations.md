# Security & Crypto Recommendations — OTP Autofill Authenticator

Date: 2026-06-10. Based on a review of manifest.json, src/storage.js, src/totp.js,
src/otpauth.js, src/background.js, src/content.js, src/qr.js and popup/popup.js.

> **Status (2026-06-10, v1.7.0): all items below are IMPLEMENTED.**
> #1 master-password vault (src/vault.js, opt-in, once-per-session unlock) ·
> #2 secrets background-only (content script holds no crypto/storage code) ·
> #3 domain binding + exact issuer match (strict by default; legacy substring
> mode is an opt-in setting) + cross-origin-iframe block + isTrusted clicks · #4 encrypted export envelope (plaintext behind warning) ·
> #5 clipboard auto-clear via alarms + offscreen doc · #6 strict base32 at
> add/import · #7 dropped tabs/scripting permissions, cookie-less QR fetch ·
> #8 session storage restricted to TRUSTED_CONTEXTS · #9 jsQR pinned
> (vendor/CHECKSUMS.sha256 + test/verify-vendor.sh) · #10 HOTP rejected at
> add/import. Covered by test/e2e/run.mjs (binding) and test/e2e/run-vault.mjs.

**Summary:** The TOTP crypto itself is implemented correctly (RFC 4226/6238 via
Web Crypto). The real gaps: (1) all 2FA seeds are stored unencrypted in
`chrome.storage.local`, (2) the code holding those seeds is injected into every
web page, (3) default settings can auto-fill a live OTP into any page —
including a malicious one — with no user gesture, and (4) export is plaintext.
Top additions: encryption-at-rest behind a master password, moving secrets into
the background worker only, origin-binding for autofill, and encrypted backups.

---

## P0 — Critical

### 1. Encrypt secrets at rest
src/storage.js:47-49 writes account seeds as plaintext JSON into
`chrome.storage.local`, which lives unencrypted in the Chrome profile on disk.
Any malware, backup tool, or person with file access gets every 2FA seed.

Add a vault:
- Master password → KDF: PBKDF2-SHA256 (≥600k iterations) or Argon2id (small WASM lib).
- Encrypt the accounts blob with AES-256-GCM via `crypto.subtle`.
- Cache the unlocked key in `chrome.storage.session` (memory-only, cleared when
  the browser closes) so the user isn't re-prompted on every popup open.
- Auto-lock timeout; popup shows no codes until unlocked.

### 2. Get secrets out of the content scripts
manifest.json:20-26 injects src/storage.js and src/totp.js into `<all_urls>`
with `all_frames: true`, so code with direct read access to all seeds runs in
every page's isolated world. The isolated world protects against the page
itself, but this is the maximum possible blast radius for any content-script
bug or browser sandbox escape.

Restructure so only src/background.js touches seeds: the content script sends
"give me the code for this tab" via `chrome.runtime.sendMessage`, the
background validates the sender's origin and returns only the 6-digit code —
the seed never enters a tab context. Also makes #1 simpler (one decrypt point).

### 3. Fix the autofill trust model — silently phishable today
Three combined issues in src/content.js:

- `fallbackSingle` + `autoFill` are on by default (src/storage.js:11-13). With
  one account saved, ANY page that renders an OTP-looking input gets a valid
  live code auto-filled with zero interaction (src/content.js:403-405) — and
  with `autoSubmit` it gets submitted too. A malicious page can harvest codes
  invisibly. `all_frames: true` extends this to third-party iframes.
- `issuerMatchesHost` (src/content.js:370-375) is a substring check: issuer
  "GitHub" matches `github.evil.com` or `login-github.attacker.io`.
- The registrable-domain heuristic (src/storage.js:24-40) is a hand-rolled
  approximation; consider the Public Suffix List.

Recommended model (similar to passkeys' RP ID): bind each account to the
registrable domain where it was first used or explicitly confirmed; auto-fill
only on bound domains; on unknown domains require an explicit user gesture
(floating button or keyboard command) and then offer to remember the binding.
Never auto-fill into cross-origin iframes.

## P1 — High

### 4. Encrypted export
popup/popup.js:438-442 dumps every seed as plaintext otpauth URIs into a
textarea and the clipboard. Add a passphrase-encrypted export format — a
versioned JSON envelope `{version, kdf, kdfParams, salt, iv, ciphertext}` using
the same KDF + AES-GCM as the vault — and put the plaintext option behind an
explicit warning.

### 5. Clipboard hygiene
`copyCode` (popup/popup.js:173-177) and the export copy button leave data on
the clipboard indefinitely. Auto-clear after ~30-60 s (only if the clipboard
still contains what you wrote, to avoid clobbering the user).

### 6. Strict base32 validation
`base32Decode` (src/totp.js:10-29) silently skips invalid characters, so a
typo'd secret (`1`, `0`, `8`, `9` aren't valid base32) still "works" and
generates wrong codes with no error — the user finds out when locked out.
Reject invalid secrets at add/import time instead.

## P2 — Medium

### 7. Permission minimization
The `tabs` permission in manifest.json:6 appears unnecessary (active-tab
`query` + `sendMessage` don't need it). `<all_urls>` host permissions are only
needed for the context-menu QR fetch — at minimum do that fetch with
`credentials: "omit"` in src/qr.js so the extension doesn't attach cookies to
arbitrary image URLs (src/background.js:81).

### 8. Session-storage access level
`TRUSTED_AND_UNTRUSTED_CONTEXTS` (src/background.js:15-24) lets the content
script on any page read the captured emails of all origins. Becomes moot once
#2 routes everything through the background worker.

### 9. Supply chain
vendor/jsQR.js is vendored unpinned — record the version and a checksum,
verify it in CI.

### 10. Crypto-adjacent correctness bug: HOTP
HOTP accounts are parsed (src/otpauth.js:28) but codes are generated with
`generateTOTP` for every account (popup/popup.js:152), so HOTP produces wrong
codes. Either implement counter increment + persistence or reject HOTP at
import.

## Already solid (don't touch)

- HOTP/TOTP core in src/totp.js is RFC-correct: proper dynamic truncation,
  big-endian 8-byte counter, SHA-1/256/512 support, non-extractable HMAC keys
  via Web Crypto.
- The popup escapes all user/imported strings with `escapeHtml` before
  `innerHTML`; no eval/remote code.
- Transient captured emails already prefer `chrome.storage.session`.

## Suggested order of work

1. **#1 + #2 together** — they share the vault/messaging refactor.
2. **#3** — autofill origin-binding.
3. The rest are incremental (#4-#10).
