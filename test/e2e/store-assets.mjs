// Generate Chrome Web Store listing assets into dist/store/:
//   screenshot-1..4  1280x800 JPEG (store requires 1280x800/640x400, no alpha)
//   tile-440x280     small promo tile JPEG
//   marquee-1400x560 marquee promo tile JPEG
//   icon-128.png     store icon (PNG, transparent rounded corners)
// Screenshots are rendered at 640x400 CSS with deviceScaleFactor 2 so the
// output is exactly 1280x800. Tiles/icon use a plain context at DSF 1.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, "..", "..");
const OUT = resolve(EXT, "dist", "store");
mkdirSync(OUT, { recursive: true });

const LOGIN_PAGE = `<!doctype html><meta charset=utf8><title>Sign in · Northwind</title>
<body style="margin:0;background:linear-gradient(160deg,#101218,#1b2030);color:#e7e9ee;font-family:system-ui;min-height:100vh;display:grid;place-items:center;overflow:hidden">
<div style="background:#1e2230;border:1px solid #2c3245;border-radius:14px;padding:26px 34px;width:330px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.45)">
  <div style="font-size:20px;font-weight:800;letter-spacing:.5px">⚡ Northwind</div>
  <h2 style="font-weight:600;color:#c7cbd6;margin:12px 0 4px;font-size:15px">Two-step verification</h2>
  <p style="color:#8b91a1;margin:0 0 16px;font-size:11px">Enter the 6-digit code to finish signing in as<br><b style="color:#aeb4c4">alex.rivera@example.com</b></p>
  <div id="otpRow" style="display:flex;gap:8px;justify-content:center;margin-bottom:18px">
    ${Array.from({ length: 6 }).map((_, i) => `<input maxlength="1" inputmode="numeric"${i === 0 ? ' autocomplete="one-time-code"' : ""} style="width:36px;height:44px;text-align:center;font-size:18px;font-weight:600;background:#141826;border:1px solid #2c3245;border-radius:8px;color:#fff">`).join("")}
  </div>
  <button style="width:100%;padding:10px;background:#2f6fed;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600">Verify &amp; sign in</button>
</div></body>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(LOGIN_PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/login.html`;

function chromePath() {
  const home = process.env.HOME || "";
  for (const c of [
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux/chrome`,
  ]) { try { readFileSync(c); return c; } catch (e) {} }
  return undefined;
}

// ---- pass 1: extension context (hero + popup captures) ---------------------

rmSync(join(__dirname, ".profile-store"), { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(join(__dirname, ".profile-store"), {
  headless: false, executablePath: chromePath(),
  viewport: { width: 640, height: 400 }, deviceScaleFactor: 2,
  args: ["--headless=new", "--disable-gpu", "--no-sandbox",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const warm = await ctx.newPage();
await warm.goto("about:blank");
let sw = ctx.serviceWorkers()[0];
for (let i = 0; i < 20 && !sw; i++) { await warm.waitForTimeout(300); sw = ctx.serviceWorkers()[0]; }
const extId = new URL(sw.url()).host;

await sw.evaluate(() => chrome.storage.local.set({
  accounts: [
    { id: "1", type: "totp", issuer: "Northwind", account: "alex.rivera@example.com", secret: "MFRGGZDFMZTWQ2LK", algorithm: "SHA1", digits: 6, period: 30, domains: ["127.0.0.1", "example.com"] },
    { id: "2", type: "totp", issuer: "Globex VPN", account: "", secret: "KRSXG5CTMVRXEZLU", algorithm: "SHA1", digits: 6, period: 30, domains: [] },
    { id: "3", type: "totp", issuer: "Initech", account: "jordan.kim@example.com", secret: "NB2W45DFOIZA====", algorithm: "SHA1", digits: 6, period: 30, domains: [] },
  ],
  settings: { vaultNudgeDismissed: true },
  "domainEmail:127.0.0.1": { email: "alex.rivera@example.com", ts: 1 },
}));

// hero: the demo 2FA page, autofilled (1280x800 via DSF 2)
const hero = await ctx.newPage();
await hero.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await hero.waitForTimeout(1800);
await hero.addStyleTag({ content: "::-webkit-scrollbar{display:none}" });
await hero.screenshot({ path: join(OUT, "screenshot-1-autofill.jpg"), type: "jpeg", quality: 92 });
console.log("saved screenshot-1-autofill.jpg (1280x800)");

// popup views captured as PNG buffers for compositing
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 360, height: 560 });
const base = `chrome-extension://${extId}/popup/popup.html`;
async function popupShot(action) {
  await popup.goto(base, { waitUntil: "domcontentloaded" });
  await popup.waitForTimeout(400);
  if (action) { await action(); await popup.waitForTimeout(400); }
  await popup.addStyleTag({ content: "::-webkit-scrollbar{display:none}" });
  const buf = await popup.screenshot({ type: "png" });
  return "data:image/png;base64," + buf.toString("base64");
}
const shotAccounts = await popupShot();
const shotSecurity = await popupShot(() => popup.evaluate(() => window.openSettings()));
const shotImport = await popupShot(() => popup.click("#navImport"));
await ctx.close();

// ---- pass 2: plain browser (composites, tiles, icon) -----------------------

const browser = await chromium.launch({
  headless: true, executablePath: chromePath(),
  args: ["--disable-gpu", "--no-sandbox"],
});

const BRAND = "linear-gradient(135deg,#101218 0%,#161d2e 55%,#1d2840 100%)";
function composerHtml(title, sub, img) {
  return `<!doctype html><meta charset=utf8><body style="margin:0;width:640px;height:400px;background:${BRAND};display:flex;align-items:center;font-family:system-ui;color:#fff;overflow:hidden">
  <div style="flex:1;padding:0 14px 0 42px;min-width:0">
    <div style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700;color:#8fb1ff;margin-bottom:14px">🔐 OTP Autofill Authenticator</div>
    <div style="font-size:27px;font-weight:800;line-height:1.16;letter-spacing:-.3px">${title}</div>
    <div style="font-size:13px;color:#aeb4c4;margin-top:12px;line-height:1.5">${sub}</div>
  </div>
  <img src="${img}" style="height:356px;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.6);margin-right:38px;flex:0 0 auto">
</body>`;
}

const shots = await browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });
const comp = await shots.newPage();
const composites = [
  ["screenshot-2-accounts.jpg", "All your codes, one click away",
    "Live TOTP codes with countdown rings, search and one-click copy — codes are wiped from your clipboard after 45 seconds.", shotAccounts],
  ["screenshot-3-security.jpg", "Encrypted with a master password",
    "Seeds are encrypted at rest (AES-256-GCM, PBKDF2). Unlock once per browser session — and codes only fill on sites you approved.", shotSecurity],
  ["screenshot-4-import.jpg", "Add accounts in seconds",
    "Scan a QR on any page or image, paste otpauth:// links, or restore a passphrase-encrypted backup.", shotImport],
];
for (const [file, title, sub, img] of composites) {
  await comp.setContent(composerHtml(title, sub, img));
  await comp.waitForTimeout(150);
  await comp.screenshot({ path: join(OUT, file), type: "jpeg", quality: 92 });
  console.log(`saved ${file} (1280x800)`);
}
await shots.close();

// promo tiles (exact canvas sizes -> DSF 1)
const tiles = await browser.newContext({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
const tile = await tiles.newPage();
function tileHtml(big) {
  return `<!doctype html><meta charset=utf8><body style="margin:0;width:100%;height:100vh;background:${BRAND};display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui;color:#fff;overflow:hidden">
  <div style="font-size:${big ? 64 : 44}px;line-height:1">🔐</div>
  <div style="font-size:${big ? 40 : 26}px;font-weight:800;margin-top:${big ? 18 : 12}px;letter-spacing:-.4px">OTP Autofill Authenticator</div>
  <div style="font-size:${big ? 19 : 13}px;color:#aeb4c4;margin-top:${big ? 12 : 8}px">2FA codes, generated locally and filled for you — encrypted at rest.</div>
</body>`;
}
await tile.setContent(tileHtml(false));
await tile.screenshot({ path: join(OUT, "tile-440x280.jpg"), type: "jpeg", quality: 92 });
console.log("saved tile-440x280.jpg");
await tile.setViewportSize({ width: 1400, height: 560 });
await tile.setContent(tileHtml(true));
await tile.screenshot({ path: join(OUT, "marquee-1400x560.jpg"), type: "jpeg", quality: 92 });
console.log("saved marquee-1400x560.jpg");

// store icon 128x128 (PNG, transparent rounded corners)
await tile.setViewportSize({ width: 128, height: 128 });
await tile.setContent(`<!doctype html><body style="margin:0">
<div style="width:128px;height:128px;border-radius:27px;background:linear-gradient(145deg,#4a90ff 0%,#2f6fed 48%,#1c47c2 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:inset 0 -10px 24px rgba(0,0,0,.18),inset 0 6px 14px rgba(255,255,255,.14)">
  <div style="width:38px;height:30px;border:9px solid #fff;border-bottom:none;border-radius:19px 19px 0 0;margin-bottom:-5px"></div>
  <div style="width:60px;height:42px;background:#fff;border-radius:9px;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 8px rgba(0,0,0,.25)">
    <div style="width:13px;height:13px;background:#2558d6;border-radius:50%;position:relative">
      <div style="position:absolute;left:4.5px;top:10px;width:4px;height:9px;background:#2558d6;border-radius:2px"></div>
    </div>
  </div>
  <div style="display:flex;gap:5px;margin-top:9px">${'<i style="width:7px;height:7px;background:rgba(255,255,255,.95);border-radius:50%;display:block"></i>'.repeat(6)}</div>
</div></body>`);
await tile.screenshot({ path: join(OUT, "icon-128.png"), type: "png", omitBackground: true });
console.log("saved icon-128.png");

await tiles.close();
await browser.close();
server.close();
process.exit(0);
