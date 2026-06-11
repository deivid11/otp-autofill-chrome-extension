// Generate documentation screenshots into docs/images/.
//  - login-autofill.png : hero — a sign-in 2FA screen being autofilled
//  - accounts / add / import / settings : popup views (no scrollbars)
// All sample data is generic (example.com), never real accounts.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, "..", "..");
const OUT = resolve(EXT, "docs", "images");

// A polished sign-in 2FA page (a real <input maxlength=1> box grid the
// extension fills). Generic brand + sample email.
const LOGIN_PAGE = `<!doctype html><meta charset=utf8><title>Sign in · Northwind</title>
<body style="margin:0;background:linear-gradient(160deg,#101218,#1b2030);color:#e7e9ee;font-family:system-ui;min-height:100vh;display:grid;place-items:center">
<div style="background:#1e2230;border:1px solid #2c3245;border-radius:16px;padding:38px 46px;width:400px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.45)">
  <div style="font-size:26px;font-weight:800;letter-spacing:.5px">⚡ Northwind</div>
  <h2 style="font-weight:600;color:#c7cbd6;margin:18px 0 4px">Two-step verification</h2>
  <p style="color:#8b91a1;margin:0 0 22px;font-size:14px">Enter the 6-digit code to finish signing in as<br><b style="color:#aeb4c4">alex.rivera@example.com</b></p>
  <div id="otpRow" style="display:flex;gap:11px;justify-content:center;margin-bottom:26px">
    ${Array.from({length:6}).map((_,i)=>`<input maxlength="1" inputmode="numeric"${i===0?' autocomplete="one-time-code"':''} style="width:48px;height:58px;text-align:center;font-size:23px;font-weight:600;background:#141826;border:1px solid #2c3245;border-radius:10px;color:#fff">`).join("")}
  </div>
  <button style="width:100%;padding:13px;background:#2f6fed;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer">Verify &amp; sign in</button>
  <p style="color:#6b7080;margin:18px 0 0;font-size:12px">Didn't get a code? Resend</p>
</div></body>`;

const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(LOGIN_PAGE); });
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

// start clean: a reused profile caches the previous service worker
rmSync(join(__dirname, ".profile-shots"), { recursive: true, force: true });
const context = await chromium.launchPersistentContext(join(__dirname, ".profile-shots"), {
  headless: false, executablePath: chromePath(),
  args: ["--headless=new", "--disable-gpu", "--no-sandbox", "--force-device-scale-factor=2",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const warm = await context.newPage();
await warm.goto("about:blank");
let sw = context.serviceWorkers()[0];
for (let i = 0; i < 20 && !sw; i++) { await warm.waitForTimeout(300); sw = context.serviceWorkers()[0]; }
const extId = new URL(sw.url()).host;

// generic sample accounts + remembered login for the hero page's host
await sw.evaluate(() => chrome.storage.local.set({
  accounts: [
    { id: "1", type: "totp", issuer: "Northwind", account: "alex.rivera@example.com", secret: "MFRGGZDFMZTWQ2LK", algorithm: "SHA1", digits: 6, period: 30, domains: ["127.0.0.1", "example.com"] },
    { id: "2", type: "totp", issuer: "Globex VPN", account: "", secret: "KRSXG5CTMVRXEZLU", algorithm: "SHA1", digits: 6, period: 30 },
    { id: "3", type: "totp", issuer: "Initech", account: "jordan.kim@example.com", secret: "NB2W45DFOIZA====", algorithm: "SHA1", digits: 6, period: 30 },
  ],
  settings: { autoFill: true, autoSubmit: false, fallbackSingle: true, matchByIssuer: true, rememberDomainEmail: true, showButton: true, debug: false },
  "domainEmail:example.com": { email: "alex.rivera@example.com", ts: 1 },
  "domainEmail:127.0.0.1": { email: "alex.rivera@example.com", ts: 1 },
}));

const popup = await context.newPage();
const base = `chrome-extension://${extId}/popup/popup.html`;

// Size the viewport to the real content height so there's no scrollbar and no
// empty space. Measure from a small viewport (scrollHeight floors at the
// viewport height otherwise) and un-stick the footer so it doesn't pin.
async function shot(name, action) {
  await popup.setViewportSize({ width: 360, height: 200 });
  await popup.goto(base, { waitUntil: "domcontentloaded" });
  await popup.waitForTimeout(300);
  if (action) { await action(); await popup.waitForTimeout(350); }
  await popup.addStyleTag({ content: "::-webkit-scrollbar{width:0!important;height:0!important;display:none} .footbar{position:static!important}" });
  await popup.waitForTimeout(60);
  const h = await popup.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  await popup.setViewportSize({ width: 360, height: h });
  await popup.waitForTimeout(120);
  await popup.screenshot({ path: join(OUT, name) });
  console.log("saved", name, `360x${h}`);
}

await shot("accounts.png");
await shot("add.png", () => popup.evaluate(() => window.startAdd()));
await shot("import.png", () => popup.click("#navImport"));
await shot("settings.png", () => popup.evaluate(() => window.openSettings()));

// hero: sign-in 2FA page autofilled by the extension
const demo = await context.newPage();
await demo.setViewportSize({ width: 560, height: 480 });
await demo.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await demo.waitForTimeout(1700);
await demo.addStyleTag({ content: "::-webkit-scrollbar{width:0!important;height:0!important;display:none} html,body{overflow:hidden!important}" });
await demo.screenshot({ path: join(OUT, "login-autofill.png") });
console.log("saved login-autofill.png");

await context.close();
server.close();
process.exit(0);
