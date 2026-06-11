# Security Policy

## Reporting a vulnerability

If you believe you've found a security issue, please report it privately via
GitHub's **"Report a vulnerability"** (Security tab of this repository) or by
opening an issue that says only "security report — requesting private contact"
without technical details. Please don't publish exploit details before a fix
is available. Reports are handled on a best-effort basis — this is a free,
volunteer-maintained project.

Only the latest published version is supported with fixes.

## Security model (what this extension does and doesn't protect against)

**Protections in place**

- Account secrets are handled only by the background service worker; web
  pages receive at most a single 6-digit code, and only on sites the user
  explicitly approved. Cross-origin iframes never receive codes.
- Optional master password encrypts all seeds at rest (PBKDF2-SHA256 600k →
  AES-256-GCM); the unlocked key lives in memory-only session storage.
- Exports are passphrase-encrypted by default; copied codes are wiped from
  the clipboard after ~45 seconds; strict base32 validation; pinned vendored
  dependencies (`vendor/CHECKSUMS.sha256`).

**Out of scope — no browser extension can protect against these**

- A compromised device or browser profile (malware, an attacker with local
  or physical access, a malicious extension with debugging access).
- A user explicitly approving autofill on, or manually copying a code into,
  a phishing site.
- Forgotten master passwords or backup passphrases — the encryption has no
  backdoor, so that data is unrecoverable **by design**.

## Recommendations for users

1. Set a master password (Settings → Security).
2. Keep an encrypted backup of your accounts somewhere safe — losing your
   secrets can lock you out of your online accounts.
3. Keep your operating system and browser updated and free of malware.
