// Live check against https://authenticationtest.com/totpChallenge/ — the page
// we point Chrome Web Store reviewers at in the test instructions. Verifies
// the OTP field is detected, the floating button appears (unbound domain),
// and a real click fills a 6-digit code.
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
  ]) { try { readFileSync(c); return c; } catch (e) {} }
  return undefined;
}

rmSync(join(__dirname, ".profile-live"), { recursive: true, force: true });
const context = await chromium.launchPersistentContext(join(__dirname, ".profile-live"), {
  headless: false, executablePath: chromePath(),
  args: ["--headless=new", "--disable-gpu", "--no-sandbox",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const warm = await context.newPage();
await warm.goto("about:blank");
let sw = context.serviceWorkers()[0];
for (let i = 0; i < 20 && !sw; i++) { await warm.waitForTimeout(300); sw = context.serviceWorkers()[0]; }

await sw.evaluate(() => chrome.storage.local.set({
  accounts: [{ id: "t", type: "totp", issuer: "AuthenticationTest",
    account: "totp@authenticationtest.com", secret: "I65VU7K5ZQL7WB4E",
    algorithm: "SHA1", digits: 6, period: 30, domains: [] }],
}));

const page = await context.newPage();
await page.goto("https://authenticationtest.com/totpChallenge/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);

const inputs = await page.$$eval("input", (els) => els.map((e) => ({
  type: e.type, name: e.name, id: e.id, ml: e.getAttribute("maxlength"),
  ac: e.getAttribute("autocomplete"), ph: e.placeholder,
})));
console.log("PAGE inputs:", JSON.stringify(inputs));

const btn = await page.$eval("#otp-autofill-helper", (el) => el.textContent).catch(() => null);
console.log("FLOATING button:", btn ? `SHOWN ("${btn}")` : "NOT SHOWN");

if (btn) {
  await page.click("#otp-autofill-helper");
  await page.waitForTimeout(1200);
  const vals = await page.$$eval("input", (els) =>
    els.filter((e) => !["email", "password", "hidden", "submit", "checkbox"].includes(e.type))
       .map((e) => ({ name: e.name, value: e.value })));
  console.log("AFTER click:", JSON.stringify(vals));
}

// QR on the page: decode it with the extension's own scanner pipeline
const popup = await context.newPage();
await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`, { waitUntil: "domcontentloaded" });
const qrDecoded = await popup.evaluate(async () => {
  const blob = await (await fetch("https://authenticationtest.com/assets/I65VU7K5ZQL7WB4E.png", { credentials: "omit" })).blob();
  return globalThis.OTP.qr.decodeFromBlob(blob);
});
console.log("QR decodes:", qrDecoded && /^otpauth:\/\/totp/i.test(qrDecoded) ? `PASS (${qrDecoded})` : `FAIL (${qrDecoded})`);

await context.close();
process.exit(0);
