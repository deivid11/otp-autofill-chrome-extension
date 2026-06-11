# Privacy Policy — OTP Autofill Authenticator

Last updated: 2026-06-10

## Summary

OTP Autofill Authenticator does **not** collect, transmit, sell, or share any
user data. There is no server, no account, no analytics, and no telemetry.
Everything the extension stores stays on your device.

## Data stored locally on your device

- **Authenticator accounts** — issuer, account label (often an email address),
  and the TOTP secret you add. Stored in Chrome's local extension storage
  (`chrome.storage.local`). If you set a master password, secrets are
  encrypted at rest with AES-256-GCM using a key derived with PBKDF2-SHA256
  (600,000 iterations). This data is never synced or transmitted.
- **Settings**, the per-site login email you chose to remember, and the list
  of sites you approved for autofill.
- A login email captured during a two-step sign-in flow, kept in memory-only
  session storage and cleared when the browser closes.

## What never happens

- No data ever leaves your device. The extension makes no requests to any
  server of ours — there is none.
- The only network request the extension can make is fetching an image when
  you right-click a QR code to import it; that request is made **without
  cookies or credentials**.
- No analytics, no telemetry, no ads, no third-party services, no remote code.

## Clipboard

When you copy a code, the extension can (optionally, on by default) clear it
from the clipboard about 45 seconds later. The clipboard is read only at that
moment and only to check that it still contains the code that was copied; if
you copied something else in the meantime, it is left untouched. Clipboard
content is never stored or transmitted.

## Page access

A content script runs on web pages to detect login and 2FA forms. It contains
no secrets and reads no page content beyond locating those input fields. It
receives at most a single 6-digit code from the extension's background worker,
and only on sites you explicitly approved. Cross-origin iframes never receive
codes.

## Backups

Exports are encrypted with a passphrase you choose (PBKDF2 + AES-256-GCM) by
default; a plaintext export exists behind an explicit warning. Either way the
file is generated locally and saved only where you choose.

## Changes & contact

Changes to this policy will be published in this repository. Questions or
concerns: open an issue at
<https://github.com/deivid11/otp-autofill-chrome-extension/issues>.
