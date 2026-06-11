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

## Disclaimer — no warranty, use at your own risk

This extension is free, open-source software distributed under the
[MIT License](LICENSE). It is provided **"as is" and "as available", without
warranty of any kind**, express or implied, including but not limited to
merchantability, fitness for a particular purpose, accuracy, or
non-infringement.

By installing or using the extension you acknowledge and accept that:

- **You are responsible for backups.** Two-factor secrets exist only on your
  device. If you lose them — including by forgetting your master password or
  a backup passphrase, for which there is **no recovery mechanism by
  design** — you may be permanently locked out of your online accounts.
- **You are responsible for your device.** No extension can protect secrets
  on a device or browser profile that is already compromised (malware, an
  attacker with local access, other malicious software).
- **You decide where codes are filled.** The first autofill on every site
  requires your explicit approval; approving or manually entering a code on a
  fraudulent site is outside the extension's control.
- The extension is an independent project, not affiliated with or endorsed by
  any website or service it generates codes for.

**Limitation of liability:** to the maximum extent permitted by applicable
law, the author shall not be liable for any direct, indirect, incidental,
consequential, exemplary, or special damages — including but not limited to
account lockouts, data loss, unauthorized access to accounts, lost profits,
or any other loss — arising from or related to the use of, or inability to
use, this software, even if advised of the possibility of such damages. Your
sole and exclusive remedy is to stop using the extension.

## Reporting security issues

Please see [SECURITY.md](SECURITY.md) for the responsible-disclosure process.

## Changes & contact

Changes to this policy will be published in this repository. Questions or
concerns: open an issue at
<https://github.com/deivid11/otp-autofill-chrome-extension/issues>.
