// E2E: master-password vault — enable encrypts at rest (no plaintext left),
// lock/unlock flow, wrong password rejected, popup lock screen, HOTP +
// invalid-base32 rejection, encrypted export/import round trip.
import { chromium } from "playwright-core";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, "..", "..");
const PASSWORD = "correct-horse-battery";

function chromePath() {
  const home = process.env.HOME || "";
  for (const c of [
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux/chrome`,
  ]) { try { readFileSync(c); return c; } catch (e) {} }
  return undefined;
}

// start clean: a reused profile caches the previous service worker
rmSync(join(__dirname, ".profile-vault"), { recursive: true, force: true });
const context = await chromium.launchPersistentContext(join(__dirname, ".profile-vault"), {
  headless: false, executablePath: chromePath(),
  args: ["--headless=new", "--disable-gpu", "--no-sandbox",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const warm = await context.newPage();
await warm.goto("about:blank");
let sw = context.serviceWorkers()[0];
for (let i = 0; i < 20 && !sw; i++) { await warm.waitForTimeout(300); sw = context.serviceWorkers()[0]; }
const extId = new URL(sw.url()).host;

// seed one plaintext account
await sw.evaluate(() => chrome.storage.local.set({ accounts: [{
  id: "v1", type: "totp", issuer: "OPM SPEI", account: "jaime+1@osmos.mx",
  secret: "MFRGGZDFMZTWQ2LK", algorithm: "SHA1", digits: 6, period: 30, counter: 0,
}] }));

// 1) enable: ciphertext written, plaintext gone, state unlocked
const enabled = await sw.evaluate(async (pw) => {
  const res = await globalThis.OTP.vaultEnable(pw);
  const local = await chrome.storage.local.get(null);
  return {
    res,
    state: await globalThis.OTP.vaultState(),
    hasVault: !!local.vault,
    hasPlain: "accounts" in local,
    blobLooksEncrypted: local.vault && !JSON.stringify(local.vault).includes("MFRGGZDFMZTWQ2LK"),
  };
}, PASSWORD);
console.log("VAULT enable:", enabled.res.ok && enabled.state === "unlocked" && enabled.hasVault &&
  !enabled.hasPlain && enabled.blobLooksEncrypted ? "PASS" : `FAIL ${JSON.stringify(enabled)}`);

// 2) accounts still readable while unlocked
const read = await sw.evaluate(() => globalThis.OTP.getAccountsSecure());
console.log("VAULT unlocked read:", read.ok && read.accounts[0].secret === "MFRGGZDFMZTWQ2LK"
  ? "PASS" : `FAIL ${JSON.stringify(read)}`);

// 3) lock -> reads refuse; wrong password rejected; right password unlocks
const lockFlow = await sw.evaluate(async (pw) => {
  await globalThis.OTP.vaultLock();
  const lockedRead = await globalThis.OTP.getAccountsSecure();
  const bad = await globalThis.OTP.vaultUnlock("not-the-password");
  const stillLocked = await globalThis.OTP.vaultState();
  const good = await globalThis.OTP.vaultUnlock(pw);
  const after = await globalThis.OTP.vaultState();
  return { lockedRead, bad, stillLocked, good, after };
}, PASSWORD);
console.log("VAULT lock blocks reads:", lockFlow.lockedRead.locked ? "PASS" : "FAIL");
console.log("VAULT wrong password:", lockFlow.bad.error === "wrong-password" && lockFlow.stillLocked === "locked" ? "PASS" : "FAIL");
console.log("VAULT unlock:", lockFlow.good.ok && lockFlow.after === "unlocked" ? "PASS" : "FAIL");

// 4) popup shows the lock screen when locked, unlocks with the password
await sw.evaluate(() => globalThis.OTP.vaultLock());
const popup = await context.newPage();
await popup.setViewportSize({ width: 360, height: 600 });
await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded" });
await popup.waitForTimeout(400);
const lockVisible = await popup.locator("#lockView").isVisible();
console.log("POPUP lock screen shown:", lockVisible ? "PASS" : "FAIL");
await popup.fill("#unlockPassword", PASSWORD);
await popup.click("#unlockBtn");
await popup.waitForTimeout(1500); // PBKDF2 600k takes a moment
const cards = await popup.locator(".card").count();
const code = await popup.locator(".card .code").first().textContent();
console.log("POPUP unlock renders codes:", cards === 1 && /^\d{3} \d{3}$/.test(code.trim())
  ? `PASS (${code.trim()})` : `FAIL (cards=${cards}, code="${code}")`);

// 5) HOTP and invalid-base32 secrets are rejected at import
const rejects = await sw.evaluate(async () => {
  const hotp = await addFromDecoded("otpauth://hotp/X:a@b.co?secret=MFRGGZDFMZTWQ2LK&counter=0");
  const bad = await addFromDecoded("otpauth://totp/X:a@b.co?secret=AB0189&issuer=X");
  return { hotp, bad };
});
console.log("IMPORT rejects HOTP:", rejects.hotp.rejected === 1 && !rejects.hotp.added ? "PASS" : `FAIL ${JSON.stringify(rejects.hotp)}`);
console.log("IMPORT rejects bad base32:", rejects.bad.rejected === 1 && !rejects.bad.added ? "PASS" : `FAIL ${JSON.stringify(rejects.bad)}`);

// 6) encrypted export round trip
const roundTrip = await sw.evaluate(async () => {
  const env = await globalThis.OTP.encryptEnvelope("backup-pass-1", JSON.stringify({ hello: "world" }));
  const wrong = await globalThis.OTP.decryptEnvelope("nope", env);
  const right = await globalThis.OTP.decryptEnvelope("backup-pass-1", env);
  return {
    encrypted: env.type === "otp-export-encrypted" && !!env.salt && !!env.iv && !!env.data,
    wrongRejected: wrong.error === "wrong-passphrase",
    payloadBack: right.ok && JSON.parse(right.payload).hello === "world",
  };
});
console.log("EXPORT envelope:", roundTrip.encrypted ? "PASS" : "FAIL");
console.log("EXPORT wrong passphrase:", roundTrip.wrongRejected ? "PASS" : "FAIL");
console.log("EXPORT round trip:", roundTrip.payloadBack ? "PASS" : "FAIL");

await context.close();
process.exit(0);
