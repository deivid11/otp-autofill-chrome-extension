// E2E: verify QR decoding works in BOTH the popup (DOM canvas) and the
// background service worker (OffscreenCanvas), and that the background
// add-from-QR flow persists the account.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, "..", "..");

const QR_PNG = "/tmp/otp-qr.png";
const EXPECT =
  "otpauth://totp/OPM%20SPEI:jaime+1@osmos.mx?secret=MFRGGZDFMZTWQ2LK&issuer=OPM%20SPEI";

function chromePath() {
  const home = process.env.HOME || "";
  for (const c of [
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux/chrome`,
  ]) {
    try { readFileSync(c); return c; } catch (e) {}
  }
  return undefined;
}

const dataUrl =
  "data:image/png;base64," + readFileSync(QR_PNG).toString("base64");

const context = await chromium.launchPersistentContext(join(__dirname, ".profile-qr"), {
  headless: false,
  executablePath: chromePath(),
  args: ["--headless=new", "--disable-gpu", "--no-sandbox",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

// page to wake the SW
const page = await context.newPage();
await page.goto("about:blank");
let sw = context.serviceWorkers()[0];
for (let i = 0; i < 20 && !sw; i++) { await page.waitForTimeout(300); sw = context.serviceWorkers()[0]; }
if (!sw) { console.log("NO SW"); await context.close(); process.exit(2); }

const extId = new URL(sw.url()).host;

// 1) popup (DOM) decode
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded" });
const popupDecoded = await popup.evaluate((d) => globalThis.OTP.qr.decodeFromDataUrl(d), dataUrl);
console.log("POPUP decode:", popupDecoded === EXPECT ? "PASS" : `FAIL (${popupDecoded})`);

// 2) background (OffscreenCanvas) decode + add flow
const swResult = await sw.evaluate(async (d) => {
  const decoded = await globalThis.OTP.qr.decodeFromDataUrl(d);
  const res = await addFromDecoded(decoded); // top-level fn in background.js
  const accounts = await globalThis.OTP.getAccounts();
  return { decoded, res, count: accounts.length, acct: accounts[0] && accounts[0].account };
}, dataUrl);
console.log("SW decode:", swResult.decoded === EXPECT ? "PASS" : `FAIL (${swResult.decoded})`);
console.log("SW add flow:", swResult.res.added === 1 && swResult.acct === "jaime+1@osmos.mx"
  ? `PASS (saved ${swResult.count})` : `FAIL (${JSON.stringify(swResult.res)})`);

await context.close();
process.exit(0);
