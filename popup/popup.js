// popup/popup.js
const {
  generateTOTP,
  secondsRemaining,
  parseOtpauth,
  toOtpauth,
  parseImport,
  normalizeAccount,
  displayName,
  getAccounts,
  saveAccounts,
  getSettings,
  saveSettings,
  getAllDomainEmails,
  removeDomainEmail,
  clearDomainEmails,
} = globalThis.OTP;

const $ = (id) => document.getElementById(id);
const views = [
  "accountsView",
  "addView",
  "importView",
  "exportView",
  "settingsView",
];

const VIEW_TO_FOOT = {
  accountsView: "navAccounts",
  addView: "navAdd",
  importView: "navImport",
  exportView: "navImport",
  settingsView: "navSettings",
};

function showView(id) {
  for (const v of views) $(v).classList.toggle("hidden", v !== id);
  const activeFoot = VIEW_TO_FOOT[id];
  for (const fb of ["navAccounts", "navAdd", "navImport", "navSettings"]) {
    $(fb).classList.toggle("active", fb === activeFoot);
  }
}

let editingId = null;
let tickTimer = null;

// ---- toast ----------------------------------------------------------------
function toast(msg, type) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden", "warn");
  if (type === "warn") t.classList.add("warn");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), type === "warn" ? 2400 : 1700);
}

// ---- account list rendering -----------------------------------------------
let searchQuery = "";

function matchesQuery(acc, q) {
  if (!q) return true;
  return (
    (acc.issuer || "").toLowerCase().includes(q) ||
    (acc.account || "").toLowerCase().includes(q)
  );
}

async function renderAccounts() {
  const all = await getAccounts();
  const q = searchQuery.trim().toLowerCase();
  const accounts = all.filter((a) => matchesQuery(a, q));
  const list = $("accountList");
  list.innerHTML = "";
  $("emptyState").classList.toggle("hidden", all.length > 0);

  if (all.length > 0 && accounts.length === 0) {
    list.innerHTML = `<p class="muted" style="text-align:center;padding:16px;">No accounts match “${escapeHtml(searchQuery)}”.</p>`;
    return;
  }

  for (const acc of accounts) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = acc.id;
    card.innerHTML = `
      <div class="top">
        <div>
          <div class="issuer">${escapeHtml(acc.issuer || "—")}</div>
          <div class="account">${escapeHtml(acc.account || "")}</div>
        </div>
        <div class="actions">
          <button class="iconbtn edit">Edit</button>
          <button class="iconbtn del">Del</button>
        </div>
      </div>
      <div class="codeRow">
        <div class="ring"><span class="secs">30</span></div>
        <div class="code" title="Click to copy">······</div>
        <button class="iconbtn copy">Copy</button>
      </div>`;
    list.appendChild(card);

    card.querySelector(".edit").onclick = () => startEdit(acc.id);
    card.querySelector(".del").onclick = () => deleteAccount(acc.id);
    const codeEl = card.querySelector(".code");
    const copy = () => copyCode(acc);
    codeEl.onclick = copy;
    card.querySelector(".copy").onclick = copy;
  }
  tick(); // immediate first paint of codes
}

async function tick() {
  const accounts = await getAccounts();
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  for (const card of document.querySelectorAll(".card")) {
    const acc = byId[card.dataset.id];
    if (!acc) continue;
    try {
      const code = await generateTOTP(acc);
      const codeEl = card.querySelector(".code");
      codeEl.textContent = spaced(code);
      const remaining = secondsRemaining(acc.period);
      const pct = (remaining / (acc.period || 30)) * 100;
      const ring = card.querySelector(".ring");
      ring.style.setProperty("--p", pct.toFixed(0));
      card.querySelector(".secs").textContent = remaining;
      codeEl.classList.toggle("dim", remaining <= 5);
    } catch (e) {
      card.querySelector(".code").textContent = "error";
    }
  }
}

function spaced(code) {
  if (code.length === 6) return code.slice(0, 3) + " " + code.slice(3);
  if (code.length === 8) return code.slice(0, 4) + " " + code.slice(4);
  return code;
}

async function copyCode(acc) {
  const code = await generateTOTP(acc);
  await navigator.clipboard.writeText(code);
  toast("Code copied");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---- add / edit -----------------------------------------------------------
function clearForm() {
  editingId = null;
  $("otpauthInput").value = "";
  $("f_issuer").value = "";
  $("f_account").value = "";
  $("f_secret").value = "";
  $("f_algorithm").value = "SHA1";
  $("f_digits").value = "6";
  $("f_period").value = "30";
}

function startAdd() {
  clearForm();
  $("addTitle").textContent = "Add account";
  showView("addView");
}

async function startEdit(id) {
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  editingId = id;
  $("addTitle").textContent = "Edit account";
  $("otpauthInput").value = "";
  $("f_issuer").value = acc.issuer || "";
  $("f_account").value = acc.account || "";
  $("f_secret").value = acc.secret || "";
  $("f_algorithm").value = acc.algorithm || "SHA1";
  $("f_digits").value = acc.digits || 6;
  $("f_period").value = acc.period || 30;
  showView("addView");
}

function fillAddForm(a) {
  $("f_issuer").value = a.issuer;
  $("f_account").value = a.account;
  $("f_secret").value = a.secret;
  $("f_algorithm").value = a.algorithm;
  $("f_digits").value = a.digits;
  $("f_period").value = a.period;
}

// when a full otpauth URI is pasted, hydrate the individual fields
$("otpauthInput").addEventListener("input", (e) => {
  const v = e.target.value.trim();
  if (!/^otpauth:\/\//i.test(v)) return;
  try {
    fillAddForm(parseOtpauth(v));
  } catch (err) {
    /* keep typing */
  }
});

// pick a QR image to fill the Add form (without saving — lets you review first)
$("addQrFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  toast("Scanning QR…");
  try {
    const decoded = await globalThis.OTP.qr.decodeFromBlob(file);
    if (!decoded) return toast("No QR found", "warn");
    if (/^otpauth-migration:\/\//i.test(decoded)) return toast("Export QR not supported", "warn");
    if (!/^otpauth:\/\//i.test(decoded)) return toast("Not an otpauth QR", "warn");
    $("otpauthInput").value = decoded;
    fillAddForm(parseOtpauth(decoded));
    toast("Form filled from QR");
  } catch (err) {
    toast("Scan failed", "warn");
  }
});

async function saveAccount() {
  const acc = normalizeAccount({
    id: editingId || undefined,
    issuer: $("f_issuer").value,
    account: $("f_account").value,
    secret: $("f_secret").value,
    algorithm: $("f_algorithm").value,
    digits: $("f_digits").value,
    period: $("f_period").value,
  });
  if (!acc.secret) {
    toast("Secret is required");
    return;
  }
  try {
    await generateTOTP(acc); // validate the secret decodes
  } catch (e) {
    toast("Invalid base32 secret");
    return;
  }
  const accounts = await getAccounts();
  const idx = accounts.findIndex((a) => a.id === acc.id);
  if (idx >= 0) accounts[idx] = acc;
  else accounts.push(acc);
  await saveAccounts(accounts);
  showView("accountsView");
  await renderAccounts();
  toast(idx >= 0 ? "Updated" : "Added");
}

async function deleteAccount(id) {
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!confirm(`Delete ${displayName(acc)}?`)) return;
  await saveAccounts(accounts.filter((a) => a.id !== id));
  await renderAccounts();
}

// ---- import ---------------------------------------------------------------
// Two accounts are "the same" if they share issuer + account label.
function sameIdentity(a, b) {
  const norm = (s) => (s || "").trim().toLowerCase();
  return norm(a.account) === norm(b.account) && norm(a.issuer) === norm(b.issuer);
}

async function doImport() {
  const text = $("importText").value;
  const parsed = parseImport(text);
  if (!parsed.length) {
    $("importResult").textContent = "No valid otpauth URIs or JSON found.";
    toast("Nothing to import", "warn");
    return;
  }
  const accounts = await getAccounts();
  let added = 0,
    overridden = 0,
    skipped = 0;

  for (const p of parsed) {
    const idx = accounts.findIndex((a) => sameIdentity(a, p));
    if (idx >= 0) {
      const existing = accounts[idx];
      const identical = existing.secret === p.secret;
      const prompt = identical
        ? `“${displayName(p)}” is already in your list.\n\nOverride it anyway?`
        : `“${displayName(p)}” already exists, but with a DIFFERENT secret.\n\nOverride it with the imported one?`;
      if (confirm(prompt)) {
        p.id = existing.id; // keep the same slot
        accounts[idx] = p;
        overridden++;
      } else {
        skipped++;
      }
    } else {
      accounts.push(p);
      added++;
    }
  }

  await saveAccounts(accounts);
  await renderAccounts();

  const parts = [];
  if (added) parts.push(`imported ${added}`);
  if (overridden) parts.push(`overrode ${overridden}`);
  if (skipped) parts.push(`skipped ${skipped} duplicate${skipped > 1 ? "s" : ""}`);
  const summary = (parts.length ? parts.join(", ") : "nothing imported");
  const sentence = summary.charAt(0).toUpperCase() + summary.slice(1) + ".";
  $("importResult").textContent = sentence;
  const warn = added === 0 && overridden === 0; // only duplicates were skipped
  toast(summary.charAt(0).toUpperCase() + summary.slice(1), warn ? "warn" : undefined);
}

$("importFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $("importText").value = reader.result;
  };
  reader.readAsText(file);
});

// ---- QR scan import -------------------------------------------------------
// Sets the inline message AND toasts, so it works whether or not the Import
// view is on screen (the footer "Scan QR" can fire from anywhere).
function qrFeedback(msg, toastMsg) {
  $("qrResult").textContent = msg;
  if (toastMsg) toast(toastMsg);
}

// Handle a decoded QR string (a QR WAS found). Returns true once handled.
async function processDecoded(decoded) {
  if (/^otpauth-migration:\/\//i.test(decoded)) {
    qrFeedback(
      "That's a Google Authenticator export QR (multiple accounts) — not supported yet. Use a per-account QR.",
      "Export QR not supported"
    );
    return true;
  }
  if (!/^otpauth:\/\//i.test(decoded)) {
    qrFeedback("QR found, but it isn't an otpauth code: " + decoded.slice(0, 40), "Not an otpauth QR");
    return true;
  }
  $("importText").value = decoded;
  $("qrResult").textContent = "QR decoded ✓";
  await doImport(); // toasts "Imported N" and refreshes the list
  return true;
}

async function importDecoded(getDecoded) {
  $("qrResult").textContent = "Scanning…";
  toast("Scanning QR…");
  try {
    const decoded = await getDecoded();
    if (!decoded) {
      qrFeedback("No QR code found in the image.", "No QR found");
      return;
    }
    await processDecoded(decoded);
  } catch (e) {
    qrFeedback("Could not scan: " + (e && e.message ? e.message : e), "Scan failed");
  }
}

// Footer "Scan QR": first look for a QR on the visible page; if none is found
// (or the page can't be captured), fall back to the image file picker.
async function scanPageThenFile() {
  $("qrResult").textContent = "Scanning page…";
  toast("Scanning page…");
  let decoded = null;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
    decoded = await globalThis.OTP.qr.decodeFromDataUrl(dataUrl);
  } catch (e) {
    decoded = null; // chrome:// page, no permission, etc. — just fall back
  }
  if (decoded) {
    await processDecoded(decoded);
    return;
  }
  $("qrResult").textContent = "No QR on the page — pick an image…";
  toast("No QR on page — choose image");
  $("qrFileGlobal").click();
}

$("qrFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) importDecoded(() => globalThis.OTP.qr.decodeFromBlob(file));
});

$("qrPageBtn").onclick = () =>
  importDecoded(async () => {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, {
      format: "png",
    });
    return globalThis.OTP.qr.decodeFromDataUrl(dataUrl);
  });

// ---- export ---------------------------------------------------------------
async function openExport() {
  const accounts = await getAccounts();
  $("exportText").value = accounts.map(toOtpauth).join("\n");
  showView("exportView");
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadJson() {
  const accounts = await getAccounts();
  download(
    "otp-accounts.json",
    JSON.stringify({ version: 1, accounts }, null, 2),
    "application/json"
  );
}

async function downloadUris() {
  const accounts = await getAccounts();
  download("otp-accounts.txt", accounts.map(toOtpauth).join("\n"), "text/plain");
}

// ---- settings -------------------------------------------------------------
async function openSettings() {
  const s = await getSettings();
  $("s_autoFill").checked = s.autoFill;
  $("s_autoSubmit").checked = s.autoSubmit;
  $("s_fallbackSingle").checked = s.fallbackSingle;
  $("s_matchByIssuer").checked = s.matchByIssuer;
  $("s_rememberDomainEmail").checked = s.rememberDomainEmail;
  $("s_showButton").checked = s.showButton;
  $("s_debug").checked = s.debug;
  await renderRemembered();
  showView("settingsView");
}

async function persistSettings() {
  await saveSettings({
    autoFill: $("s_autoFill").checked,
    autoSubmit: $("s_autoSubmit").checked,
    fallbackSingle: $("s_fallbackSingle").checked,
    matchByIssuer: $("s_matchByIssuer").checked,
    rememberDomainEmail: $("s_rememberDomainEmail").checked,
    showButton: $("s_showButton").checked,
    debug: $("s_debug").checked,
  });
}

async function renderRemembered() {
  const rows = await getAllDomainEmails();
  const box = $("rememberedList");
  box.innerHTML = "";
  if (!rows.length) {
    box.innerHTML = '<p class="muted">Nothing remembered yet.</p>';
    return;
  }
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "remembered-row";
    row.innerHTML = `
      <div class="rem-info">
        <div class="rem-domain">${escapeHtml(r.domain)}</div>
        <div class="rem-email">${escapeHtml(r.email)}</div>
      </div>
      <button class="iconbtn rem-del">Forget</button>`;
    row.querySelector(".rem-del").onclick = async () => {
      await removeDomainEmail(r.domain);
      await renderRemembered();
      toast("Forgotten");
    };
    box.appendChild(row);
  }
}

// ---- fill active tab ------------------------------------------------------
async function fillActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: "FILL_NOW" }, (resp) => {
    if (chrome.runtime.lastError) {
      toast("No fillable form on this page");
      return;
    }
    toast(resp && resp.ok ? "Filled" : "No matching account");
  });
}

// ---- wiring ---------------------------------------------------------------
$("saveBtn").onclick = saveAccount;
$("cancelAddBtn").onclick = () => showView("accountsView");

$("doImportBtn").onclick = doImport;
$("cancelImportBtn").onclick = () => showView("accountsView");

$("exportFromSettingsBtn").onclick = openExport;
$("copyExportBtn").onclick = async () => {
  await navigator.clipboard.writeText($("exportText").value);
  toast("Copied");
};
$("downloadJsonBtn").onclick = downloadJson;
$("downloadUriBtn").onclick = downloadUris;
$("cancelExportBtn").onclick = () => showView("settingsView");

$("settingsBtn").onclick = openSettings;
$("closeSettingsBtn").onclick = async () => {
  await persistSettings();
  showView("accountsView");
};
for (const id of [
  "s_autoFill",
  "s_autoSubmit",
  "s_fallbackSingle",
  "s_matchByIssuer",
  "s_rememberDomainEmail",
  "s_showButton",
  "s_debug",
]) {
  $(id).addEventListener("change", persistSettings);
}
$("clearRememberedBtn").onclick = async () => {
  if (!confirm("Forget all remembered logins?")) return;
  await clearDomainEmails();
  await renderRemembered();
  toast("Cleared");
};

$("fillBtn").onclick = fillActiveTab;

// ---- footer quick actions -------------------------------------------------
$("navAccounts").onclick = () => showView("accountsView");
$("navAdd").onclick = startAdd;
$("navSettings").onclick = openSettings;
$("navImport").onclick = () => {
  $("importText").value = "";
  $("importResult").textContent = "";
  $("qrResult").textContent = "";
  showView("importView");
};
// one tap: detect a QR on the page, otherwise open the image picker
$("navScan").onclick = scanPageThenFile;
$("qrFileGlobal").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) importDecoded(() => globalThis.OTP.qr.decodeFromBlob(file));
});

// ---- search/filter --------------------------------------------------------
$("searchInput").addEventListener("input", (e) => {
  searchQuery = e.target.value;
  renderAccounts();
});

// ---- boot -----------------------------------------------------------------
(async function init() {
  await renderAccounts();
  tickTimer = setInterval(tick, 1000);
})();
