// Generate documentation screenshots into docs/images/.
//  - popup views: accounts, add, import, settings
//  - autofill in action on the transfercld-style hidden-input OTP page
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, "..", "..");
const OUT = resolve(EXT, "docs", "images");

const TRANSFER_PAGE = `<!doctype html><meta charset=utf8><title>Confirmar transacción</title>
<body style="margin:0;background:#1f1f23;color:#cfd2d8;font-family:system-ui;min-height:100vh;display:grid;place-items:center">
<div style="background:#26262b;border:1px solid #34343c;border-radius:14px;padding:34px 44px;width:380px;text-align:center">
  <h2 style="color:#b8bcc6;font-weight:600">Confirmar transacción</h2>
  <p style="color:#9aa0ab;margin-top:-6px">Ingresa tu código de autenticación de 6 dígitos</p>
  <div class="OTPInput"><div class="blocks" style="display:flex;gap:10px;justify-content:center;margin:22px 0">
    ${Array.from({length:6}).map(()=>'<div class="otp-block" style="width:46px;height:54px;border:1px solid #3a3a44;border-radius:8px;display:grid;place-items:center;font-size:22px;color:#fff"><div class="otp-inner"><span class="number"></span></div></div>').join("")}
    <input class="hidden-input" value="" style="position:absolute;opacity:0;width:2px;height:2px">
  </div></div>
  <button class="submit-btn" type="submit" style="padding:11px 36px;background:#2f6fed;color:#fff;border:none;border-radius:8px;font-size:15px">Confirmar</button>
</div>
<script>
  const inp=document.querySelector('.hidden-input'),spans=[...document.querySelectorAll('.number')];
  inp.addEventListener('input',()=>{const v=(inp.value||'').slice(0,6);spans.forEach((s,i)=>s.textContent=v[i]||'');});
</script></body>`;

const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(TRANSFER_PAGE); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/otp.html`;

function chromePath() {
  const home = process.env.HOME || "";
  for (const c of [
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux/chrome`,
  ]) { try { readFileSync(c); return c; } catch (e) {} }
  return undefined;
}

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

// seed a few accounts + a remembered login + sensible settings
await sw.evaluate(() => chrome.storage.local.set({
  accounts: [
    { id: "1", type: "totp", issuer: "OPM SPEI", account: "jaime+1@osmos.mx", secret: "MFRGGZDFMZTWQ2LK", algorithm: "SHA1", digits: 6, period: 30 },
    { id: "2", type: "totp", issuer: "SCORE_UAT", account: "", secret: "KRSXG5CTMVRXEZLU", algorithm: "SHA1", digits: 6, period: 30 },
    { id: "3", type: "totp", issuer: "OpmSpei", account: "davidalcala+2@transfer.com", secret: "MFRGGZDFMZTWQ2LK", algorithm: "SHA1", digits: 6, period: 30 },
  ],
  settings: { autoFill: true, autoSubmit: false, fallbackSingle: true, matchByIssuer: true, rememberDomainEmail: true, showButton: true, debug: false },
  "domainEmail:transfercld.com": { email: "jaime+1@osmos.mx", ts: 1 },
  "domainEmail:osmos.mx": { email: "jaime+1@osmos.mx", ts: 1 },
}));

const popup = await context.newPage();
const base = `chrome-extension://${extId}/popup/popup.html`;

async function shot(name, w, h, action) {
  await popup.setViewportSize({ width: w, height: h });
  await popup.goto(base, { waitUntil: "domcontentloaded" });
  await popup.waitForTimeout(400);
  if (action) { await action(); await popup.waitForTimeout(400); }
  await popup.screenshot({ path: join(OUT, name) });
  console.log("saved", name);
}

await shot("accounts.png", 360, 470);
await shot("add.png", 360, 545, () => popup.evaluate(() => window.startAdd()));
await shot("import.png", 360, 430, () => popup.click("#navImport"));
await shot("settings.png", 360, 600, () => popup.evaluate(() => window.openSettings()));

// autofill in action
await sw.evaluate(() => chrome.storage.local.set({ "domainEmail:127.0.0.1": { email: "jaime+1@osmos.mx", ts: 1 } }));
const demo = await context.newPage();
await demo.setViewportSize({ width: 520, height: 360 });
await demo.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await demo.waitForTimeout(1600);
await demo.screenshot({ path: join(OUT, "autofill.png") });
console.log("saved autofill.png");

await context.close();
server.close();
process.exit(0);
