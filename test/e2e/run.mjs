// E2E: load the extension in Chromium (Google Chrome ignores --load-extension),
// seed an account + remembered domain email, open a minimal OTP page, and check
// whether the boxes autofill. Dumps the content-script [OTP-AF] logs.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, "..", "..");

const OTP_PAGE = `<!doctype html><meta charset=utf8><title>otp</title>
<body style="background:#222;color:#eee;font-family:sans-serif">
<h2>Confirmar transacción</h2>
<div id="otpRow">
  <input maxlength="1" inputmode="numeric" autocomplete="one-time-code">
  <input maxlength="1" inputmode="numeric">
  <input maxlength="1" inputmode="numeric">
  <input maxlength="1" inputmode="numeric">
  <input maxlength="1" inputmode="numeric">
  <input maxlength="1" inputmode="numeric">
</div>
<button id="go">Confirmar</button>
</body>`;

// Same boxes, but mounted inside a closed-over open shadow root to prove the
// shadow-DOM-piercing detection works.
const SHADOW_PAGE = `<!doctype html><meta charset=utf8><title>otp-shadow</title>
<body style="background:#222;color:#eee"><div id="host"></div>
<script>
  const root = document.getElementById('host').attachShadow({mode:'open'});
  root.innerHTML = '<div id="otpRow">' +
    Array.from({length:6}).map((_,i)=>'<input maxlength="1" inputmode="numeric"'+(i===0?' autocomplete="one-time-code"':'')+'>').join('') +
    '</div>';
</script></body>`;

// Replica of the real transfercld.com OTP DOM: 6 decorative .otp-block divs and
// one visually-hidden <input class="hidden-input"> that drives them. A tiny
// script mirrors the input value into the .number spans, like the real React app.
const TRANSFER_PAGE = `<!doctype html><meta charset=utf8><title>otp-transfer</title>
<body style="background:#222;color:#eee">
<div class="OTPInput"><div class="blocks">
  <div class="otp-block"><div class="otp-inner"><span class="number"></span></div></div>
  <div class="otp-block"><div class="otp-inner"><span class="number"></span></div></div>
  <div class="otp-block"><div class="otp-inner"><span class="number"></span></div></div>
  <div class="otp-block"><div class="otp-inner"><span class="number"></span></div></div>
  <div class="otp-block"><div class="otp-inner"><span class="number"></span></div></div>
  <div class="otp-block"><div class="otp-inner"><span class="number"></span></div></div>
  <input class="hidden-input" value="" style="position:absolute;opacity:0;width:2px;height:2px">
</div></div>
<button class="submit-btn" type="submit">Continuar</button>
<script>
  const inp = document.querySelector('.hidden-input');
  const spans = [...document.querySelectorAll('.number')];
  inp.addEventListener('input', () => {
    const v = (inp.value || '').slice(0, 6);
    spans.forEach((s, i) => { s.textContent = v[i] || ''; });
  });
</script></body>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  const page = req.url.includes("shadow")
    ? SHADOW_PAGE
    : req.url.includes("transfer")
    ? TRANSFER_PAGE
    : OTP_PAGE;
  res.end(page);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const URL = `http://127.0.0.1:${PORT}/otp.html`;

function chromePath() {
  const home = process.env.HOME || "";
  const candidates = [
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux/chrome`,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  for (const c of candidates) {
    try { readFileSync(c); return c; } catch (e) {}
  }
  return undefined;
}

const userDataDir = join(__dirname, ".profile");
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  executablePath: chromePath(),
  args: [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
});

const logs = [];
function wire(page) {
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push("PAGEERROR: " + e.message));
}

// open a page to trigger SW + content script
const page = await context.newPage();
wire(page);
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(700);

// wait for the MV3 service worker
let sw = context.serviceWorkers()[0];
for (let i = 0; i < 20 && !sw; i++) {
  await page.waitForTimeout(300);
  sw = context.serviceWorkers()[0];
}
if (!sw) {
  console.log("NO SERVICE WORKER. logs:\n" + logs.join("\n"));
  await context.close(); server.close(); process.exit(2);
}

// seed account + settings + remembered domain email for 127.0.0.1
await sw.evaluate(() => {
  return chrome.storage.local.set({
    accounts: [{
      id: "test-1", type: "totp", issuer: "OPM SPEI",
      account: "jaime+1@osmos.mx",
      secret: "MFRGGZDFMZTWQ2LK",
      algorithm: "SHA1", digits: 6, period: 30, counter: 0,
    }],
    settings: {
      autoFill: true, autoSubmit: false, fallbackSingle: true,
      matchByIssuer: true, rememberDomainEmail: true, showButton: true,
    },
    "domainEmail:127.0.0.1": { email: "jaime+1@osmos.mx", ts: 1 },
  });
});

// test 1: plain page
logs.length = 0;
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
let values = await page.$$eval("#otpRow input", (els) => els.map((e) => e.value));
let filled = values.join("");
console.log("PLAIN page:", filled.length === 6 ? `FILLED -> ${filled}` : `NOT FILLED ("${filled}")`);

// test 2: shadow-DOM page
await page.goto(URL.replace("otp.html", "shadow.html"), { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
values = await page.evaluate(() => {
  const root = document.getElementById("host").shadowRoot;
  return [...root.querySelectorAll("#otpRow input")].map((e) => e.value);
});
filled = values.join("");
console.log("SHADOW page:", filled.length === 6 ? `FILLED -> ${filled}` : `NOT FILLED ("${filled}")`);

// test 3: transfercld replica (hidden input + decorative cells)
await page.goto(URL.replace("otp.html", "transfer.html"), { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1800);
const hidden = await page.$eval(".hidden-input", (e) => e.value);
const cells = await page.$$eval(".number", (els) => els.map((e) => e.textContent).join(""));
console.log("TRANSFER hidden input:", hidden.length === 6 ? `FILLED -> ${hidden}` : `NOT FILLED ("${hidden}")`);
console.log("TRANSFER visible cells:", cells.length === 6 ? `RENDERED -> ${cells}` : `NOT RENDERED ("${cells}")`);

await context.close();
server.close();
process.exit(0);
