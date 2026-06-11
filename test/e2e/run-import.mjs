// E2E: duplicate import shows a warning + override prompt; Add-form QR fill;
// Export lives in Settings; popup loads with no errors after button removal.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, "..", "..");
const SAME = "otpauth://totp/OPM%20SPEI:jaime+1@osmos.mx?secret=MFRGGZDFMZTWQ2LK&issuer=OPM%20SPEI";
const DIFF = "otpauth://totp/OPM%20SPEI:jaime+1@osmos.mx?secret=JBSWY3DPEHPK3PXP&issuer=OPM%20SPEI";

function chromePath() {
  const home = process.env.HOME || "";
  for (const c of [
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux/chrome`,
  ]) { try { readFileSync(c); return c; } catch (e) {} }
  return undefined;
}

const context = await chromium.launchPersistentContext(join(__dirname, ".profile-imp"), {
  headless: false, executablePath: chromePath(),
  args: ["--headless=new", "--disable-gpu", "--no-sandbox",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const warm = await context.newPage();
await warm.goto("about:blank");
let sw = context.serviceWorkers()[0];
for (let i = 0; i < 20 && !sw; i++) { await warm.waitForTimeout(300); sw = context.serviceWorkers()[0]; }
const extId = new URL(sw.url()).host;

// seed one account
await sw.evaluate(() => chrome.storage.local.set({ accounts: [{
  id: "a1", type: "totp", issuer: "OPM SPEI", account: "jaime+1@osmos.mx",
  secret: "MFRGGZDFMZTWQ2LK", algorithm: "SHA1", digits: 6, period: 30, counter: 0,
}] }));

const errors = [];
const popup = await context.newPage();
popup.on("pageerror", (e) => errors.push(e.message));
let dialogAction = "dismiss";
popup.on("dialog", async (d) => { try { dialogAction === "accept" ? await d.accept() : await d.dismiss(); } catch (e) {} });
await popup.setViewportSize({ width: 360, height: 600 });
await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded" });
await popup.waitForTimeout(300);

console.log("popup loaded w/o errors:", errors.length === 0 ? "PASS" : `FAIL (${errors[0]})`);

// Test A: duplicate, user declines override -> skipped + warning
dialogAction = "dismiss";
await popup.evaluate((v) => { document.getElementById("importText").value = v; }, SAME);
await popup.evaluate(() => window.doImport());
await popup.waitForTimeout(300);
let result = await popup.locator("#importResult").textContent();
let cards = await popup.locator(".card").count();
console.log("A decline override:", /skipped 1 duplicate/i.test(result) && cards === 1 ? `PASS ("${result}")` : `FAIL ("${result}", cards=${cards})`);

// Test B: same identity, different secret, user accepts override -> overridden
dialogAction = "accept";
await popup.evaluate((v) => { document.getElementById("importText").value = v; }, DIFF);
await popup.evaluate(() => window.doImport());
await popup.waitForTimeout(300);
result = await popup.locator("#importResult").textContent();
const stored = await sw.evaluate(() => globalThis.OTP.getAccounts());
console.log("B accept override:", /overrode 1/i.test(result) && stored.length === 1 && stored[0].secret === "JBSWY3DPEHPK3PXP"
  ? `PASS ("${result}")` : `FAIL ("${result}", secret=${stored[0] && stored[0].secret})`);

// Test C: Add-form QR fill
await popup.evaluate(() => window.startAdd());
await popup.setInputFiles("#addQrFile", "/tmp/otp-qr.png");
await popup.waitForTimeout(600);
const secret = await popup.inputValue("#f_secret");
const account = await popup.inputValue("#f_account");
console.log("C add-form QR fill:", secret === "MFRGGZDFMZTWQ2LK" && account === "jaime+1@osmos.mx"
  ? "PASS" : `FAIL (secret=${secret}, account=${account})`);

// Test D: Export now lives in Settings
await popup.evaluate(() => window.openSettings());
const hasExportBtn = await popup.locator("#exportFromSettingsBtn").isVisible();
const noOldRow = (await popup.locator("#addBtn").count()) === 0 && (await popup.locator("#exportBtn").count()) === 0;
console.log("D export in settings + old buttons gone:", hasExportBtn && noOldRow ? "PASS" : `FAIL (export=${hasExportBtn}, gone=${noOldRow})`);

await context.close();
process.exit(0);
