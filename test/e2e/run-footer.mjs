// E2E: verify the always-visible footer renders and that the footer's global
// QR file input imports an account. Saves a screenshot for visual confirmation.
import { chromium } from "playwright-core";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, "..", "..");

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

// start clean: a reused profile caches the previous service worker
rmSync(join(__dirname, ".profile-foot"), { recursive: true, force: true });
const context = await chromium.launchPersistentContext(join(__dirname, ".profile-foot"), {
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

// footer present + visible with 5 buttons
const footVisible = await popup.locator(".footbar").isVisible();
const footCount = await popup.locator(".footbar .footbtn").count();
console.log("footer visible:", footVisible, "buttons:", footCount, footVisible && footCount === 5 ? "PASS" : "FAIL");

// footer "Scan QR" -> global file input -> import
await popup.setInputFiles("#qrFileGlobal", "/tmp/otp-qr.png");
await popup.waitForTimeout(900);
const cards = await popup.locator(".card").count();
const issuer = await popup.locator(".card .issuer").first().textContent().catch(() => "");
console.log("imported via footer scan:", cards, `(${issuer})`, cards === 1 ? "PASS" : "FAIL");

await popup.screenshot({ path: "/tmp/popup-footer.png" });
console.log("screenshot -> /tmp/popup-footer.png");

await context.close();
process.exit(0);
