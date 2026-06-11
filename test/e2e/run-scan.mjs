// E2E: the footer "Scan QR" should detect a QR on the page first, and only open
// the file picker when none is found. We stub captureVisibleTab/decode to drive
// both branches (the real capture+jsQR path is covered by run-qr.mjs).
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, "..", "..");
const OTPAUTH =
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

const context = await chromium.launchPersistentContext(join(__dirname, ".profile-scan"), {
  headless: false,
  executablePath: chromePath(),
  args: ["--headless=new", "--disable-gpu", "--no-sandbox",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const warm = await context.newPage();
await warm.goto("about:blank");
let sw = context.serviceWorkers()[0];
for (let i = 0; i < 20 && !sw; i++) { await warm.waitForTimeout(300); sw = context.serviceWorkers()[0]; }
const extId = new URL(sw.url()).host;

const popup = await context.newPage();
await popup.setViewportSize({ width: 360, height: 600 });
await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded" });
await popup.waitForTimeout(300);

let fileChooserOpened = false;
popup.on("filechooser", async (fc) => { fileChooserOpened = true; try { await fc.setFiles([]); } catch (e) {} });

// ---- Case A: no QR on the page -> file picker should open ----
await popup.evaluate(() => {
  chrome.tabs.captureVisibleTab = async () => "data:image/png;base64,iVBORw0KGgo=";
  globalThis.OTP.qr.decodeFromDataUrl = async () => null; // page has no QR
});
fileChooserOpened = false;
const before = await popup.locator(".card").count();
await popup.evaluate(() => window.scanPageThenFile());
await popup.waitForTimeout(500);
const afterA = await popup.locator(".card").count();
console.log("Case A no-page-QR -> picker opens:", fileChooserOpened ? "PASS" : "FAIL");
console.log("Case A no accidental import:", afterA === before ? "PASS" : "FAIL");

// ---- Case B: QR present on the page -> import, no file picker ----
await popup.evaluate((uri) => {
  globalThis.OTP.qr.decodeFromDataUrl = async () => uri; // page has a QR
}, OTPAUTH);
fileChooserOpened = false;
await popup.evaluate(() => window.scanPageThenFile());
await popup.waitForTimeout(800);
const afterB = await popup.locator(".card").count();
console.log("Case B page-QR -> imported:", afterB >= 1 ? `PASS (${afterB} card)` : "FAIL");
console.log("Case B page-QR -> no picker:", !fileChooserOpened ? "PASS" : "FAIL");

await context.close();
process.exit(0);
