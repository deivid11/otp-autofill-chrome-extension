// popup/popup.js
// UI only. Account secrets, code generation, the vault and exports live in the
// background worker; this page asks for them over messages. parseOtpauth /
// parseImport run here only on text the user already pasted into this page.
const {
  parseOtpauth,
  parseImport,
  displayName,
  getSettings,
  saveSettings,
  getAllDomainEmails,
  removeDomainEmail,
  clearDomainEmails,
} = globalThis.OTP;

// promise wrapper over sendMessage to the background worker
function bg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      void chrome.runtime.lastError;
      resolve(resp || null);
    });
  });
}

const $ = (id) => document.getElementById(id);
const views = [
  "lockView",
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
let accountById = new Map(); // id -> sanitized account, refreshed by renderAccounts

// ---- toast ----------------------------------------------------------------
function toast(msg, type) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden", "warn");
  if (type === "warn") t.classList.add("warn");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), type === "warn" ? 2400 : 1700);
}

// ---- in-frame confirm / prompt (replaces native confirm/alert/prompt) ------
function confirmDialog(message, opts = {}) {
  const { okText = "OK", cancelText = "Cancel", danger = false } = opts;
  return new Promise((resolve) => {
    const modal = $("modal");
    const ok = $("modalOk");
    const cancel = $("modalCancel");
    $("modalMsg").textContent = message;
    ok.textContent = okText;
    cancel.textContent = cancelText;
    ok.className = danger ? "danger" : "primary";
    modal.classList.remove("hidden");
    ok.focus();

    const close = (val) => {
      modal.classList.add("hidden");
      ok.onclick = cancel.onclick = null;
      document.removeEventListener("keydown", onKey, true);
      modal.onclick = null;
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); close(true); }
    };
    ok.onclick = () => close(true);
    cancel.onclick = () => close(false);
    modal.onclick = (e) => { if (e.target === modal) close(false); }; // click backdrop
    document.addEventListener("keydown", onKey, true);
  });
}

// Same modal with a (password) input. Resolves the string, or null on cancel.
function promptDialog(message, opts = {}) {
  const { okText = "OK", cancelText = "Cancel", type = "password" } = opts;
  return new Promise((resolve) => {
    const modal = $("modal");
    const ok = $("modalOk");
    const cancel = $("modalCancel");
    const input = $("modalInput");
    $("modalMsg").textContent = message;
    ok.textContent = okText;
    cancel.textContent = cancelText;
    ok.className = "primary";
    input.type = type;
    input.value = "";
    input.classList.remove("hidden");
    modal.classList.remove("hidden");
    input.focus();

    const close = (val) => {
      modal.classList.add("hidden");
      input.classList.add("hidden");
      input.value = "";
      ok.onclick = cancel.onclick = null;
      document.removeEventListener("keydown", onKey, true);
      modal.onclick = null;
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      else if (e.key === "Enter") { e.preventDefault(); close(input.value); }
    };
    ok.onclick = () => close(input.value);
    cancel.onclick = () => close(null);
    modal.onclick = (e) => { if (e.target === modal) close(null); };
    document.addEventListener("keydown", onKey, true);
  });
}

// ---- vault lock screen ------------------------------------------------------

function showLock() {
  showView("lockView");
  $("unlockError").classList.add("hidden");
  $("unlockPassword").value = "";
  $("unlockPassword").focus();
}

async function tryUnlock() {
  const password = $("unlockPassword").value;
  if (!password) return;
  const resp = await bg({ type: "vault.unlock", password });
  if (resp && resp.ok) {
    $("unlockError").classList.add("hidden");
    await renderAccounts();
    showView("accountsView");
  } else {
    $("unlockError").classList.remove("hidden");
    $("unlockPassword").select();
  }
}

$("unlockBtn").onclick = tryUnlock;
$("unlockPassword").addEventListener("keydown", (e) => {
  if (e.key === "Enter") tryUnlock();
});

// ---- "set a master password" nudge ------------------------------------------

async function updateNudge(accountCount) {
  const s = await getSettings();
  const vs = await bg({ type: "vault.status" });
  const show =
    accountCount > 0 && vs && vs.state === "plain" && !s.vaultNudgeDismissed;
  $("vaultNudge").classList.toggle("hidden", !show);
}

$("nudgeSetBtn").onclick = async () => {
  await setMasterPassword();
  await renderAccounts();
};
$("nudgeDismissBtn").onclick = async () => {
  await saveSettings({ vaultNudgeDismissed: true });
  $("vaultNudge").classList.add("hidden");
};

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
  const resp = await bg({ type: "accounts.list" });
  if (!resp) return;
  if (resp.locked) {
    showLock();
    return;
  }
  const all = resp.accounts;
  accountById = new Map(all.map((a) => [a.id, a]));
  const q = searchQuery.trim().toLowerCase();
  const accounts = all.filter((a) => matchesQuery(a, q));
  const list = $("accountList");
  list.innerHTML = "";
  $("emptyState").classList.toggle("hidden", all.length > 0);
  await updateNudge(all.length);

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
    const copy = () => copyCode(acc.id);
    codeEl.onclick = copy;
    card.querySelector(".copy").onclick = copy;
  }
  tick(); // immediate first paint of codes
}

// Codes change only when a TOTP window rolls over, and the countdown is pure
// clock math — so the per-second tick renders locally and asks the background
// for fresh codes once per window instead of every second (which decrypted
// the vault and re-computed every HMAC each time).
let codesById = new Map(); // id -> {code, period, error, win}

function windowIndex(period) {
  return Math.floor(Date.now() / 1000 / (period || 30));
}

function remainingFor(period) {
  const p = period || 30;
  return p - (Math.floor(Date.now() / 1000) % p);
}

async function fetchCodes() {
  const resp = await bg({ type: "accounts.codes" });
  if (!resp) return false;
  if (resp.locked) {
    // auto-lock fired while the popup is open
    if (!$("accountsView").classList.contains("hidden")) showLock();
    return false;
  }
  codesById = new Map(
    resp.codes.map((c) => [c.id, Object.assign({ win: windowIndex(c.period) }, c)])
  );
  return true;
}

async function tick() {
  const cards = document.querySelectorAll(".card");
  if (!cards.length) return;
  const stale = [...cards].some((card) => {
    const c = codesById.get(card.dataset.id);
    return !c || (!c.error && c.win !== windowIndex(c.period));
  });
  if (stale && !(await fetchCodes())) return;
  for (const card of cards) {
    const c = codesById.get(card.dataset.id);
    if (!c) continue;
    const codeEl = card.querySelector(".code");
    if (c.error) {
      codeEl.textContent = "error";
      continue;
    }
    codeEl.textContent = spaced(c.code);
    const remaining = remainingFor(c.period);
    const pct = (remaining / (c.period || 30)) * 100;
    const ring = card.querySelector(".ring");
    ring.style.setProperty("--p", pct.toFixed(0));
    card.querySelector(".secs").textContent = remaining;
    codeEl.classList.toggle("dim", remaining <= 5);
  }
}

function spaced(code) {
  if (code.length === 6) return code.slice(0, 3) + " " + code.slice(3);
  if (code.length === 8) return code.slice(0, 4) + " " + code.slice(4);
  return code;
}

async function copyCode(id) {
  const resp = await bg({ type: "accounts.code", id });
  if (!resp || resp.error) {
    toast("Code unavailable", "warn");
    return;
  }
  if (resp.locked) {
    showLock();
    return;
  }
  await navigator.clipboard.writeText(resp.code);
  bg({ type: "clipboard.scheduleClear", text: resp.code });
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
  $("domainsBox").classList.add("hidden");
}

function startAdd() {
  clearForm();
  $("addTitle").textContent = "Add account";
  showView("addView");
}

function renderDomains(acc) {
  const box = $("domainsBox");
  const list = $("domainsList");
  box.classList.remove("hidden");
  list.innerHTML = "";
  const domains = acc.domains || [];
  if (!domains.length) {
    list.innerHTML =
      '<p class="muted" style="margin:0;">None yet — a site is allowed the first time you click “Fill OTP” on it.</p>';
    return;
  }
  for (const d of domains) {
    const chip = document.createElement("span");
    chip.className = "domain-chip";
    chip.innerHTML = `${escapeHtml(d)}<button title="Forget this site">✕</button>`;
    chip.querySelector("button").onclick = async () => {
      await bg({ type: "accounts.removeDomain", id: acc.id, domain: d });
      const fresh = await bg({ type: "accounts.get", id: acc.id });
      if (fresh && fresh.account) renderDomains(fresh.account);
      toast("Site forgotten");
    };
    list.appendChild(chip);
  }
}

async function startEdit(id) {
  const resp = await bg({ type: "accounts.get", id });
  if (!resp) return;
  if (resp.locked) {
    showLock();
    return;
  }
  const acc = resp.account;
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
  renderDomains(acc);
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
  if (!$("f_secret").value.trim()) {
    toast("Secret is required");
    return;
  }
  const resp = await bg({
    type: "accounts.save",
    account: {
      id: editingId || undefined,
      issuer: $("f_issuer").value,
      account: $("f_account").value,
      secret: $("f_secret").value,
      algorithm: $("f_algorithm").value,
      digits: $("f_digits").value,
      period: $("f_period").value,
    },
  });
  if (!resp) return;
  if (resp.locked) {
    showLock();
    return;
  }
  if (resp.error) {
    toast(resp.error, "warn");
    return;
  }
  showView("accountsView");
  await renderAccounts();
  toast(resp.updated ? "Updated" : "Added");
}

async function deleteAccount(id) {
  const acc = accountById.get(id);
  if (!(await confirmDialog(`Delete “${displayName(acc || {})}”?`, { okText: "Delete", danger: true }))) return;
  const resp = await bg({ type: "accounts.remove", id });
  if (resp && resp.locked) {
    showLock();
    return;
  }
  await renderAccounts();
}

// ---- import ---------------------------------------------------------------

// Detect our passphrase-encrypted backup format.
function tryParseEnvelope(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed);
    return obj && obj.type === "otp-export-encrypted" ? obj : null;
  } catch (e) {
    return null;
  }
}

async function doImport() {
  const text = $("importText").value;

  // Encrypted backup: ask for the passphrase, decrypt in the background, then
  // run the normal import over the recovered otpauth URIs.
  const envelope = tryParseEnvelope(text);
  if (envelope) {
    const pass = await promptDialog("This is an encrypted backup. Enter its passphrase:", { okText: "Decrypt" });
    if (pass == null) return;
    const dec = await bg({ type: "accounts.decryptImport", envelope, passphrase: pass });
    if (!dec || dec.error) {
      $("importResult").textContent = "Could not decrypt the backup — wrong passphrase?";
      toast("Wrong passphrase", "warn");
      return;
    }
    $("importText").value = dec.text;
    return doImport();
  }

  const parsed = parseImport(text);
  if (!parsed.length) {
    $("importResult").textContent = "No valid otpauth URIs or JSON found.";
    toast("Nothing to import", "warn");
    return;
  }
  let added = 0,
    overridden = 0,
    skipped = 0,
    rejected = 0;
  let rejectReason = "";

  for (const p of parsed) {
    let resp = await bg({ type: "accounts.importOne", account: p });
    if (!resp) continue;
    if (resp.locked) {
      showLock();
      return;
    }
    if (resp.status === "hotp" || resp.status === "invalid") {
      rejected++;
      rejectReason = resp.error || "";
      continue;
    }
    if (resp.status === "dup") {
      const message = resp.sameSecret
        ? `“${displayName(p)}” is already in your list.\n\nOverride it anyway?`
        : `“${displayName(p)}” already exists, but with a DIFFERENT secret.\n\nOverride it with the imported one?`;
      if (await confirmDialog(message, { okText: "Override", cancelText: "Skip" })) {
        resp = await bg({ type: "accounts.importOne", account: p, override: true });
        if (resp && resp.status === "overridden") overridden++;
      } else {
        skipped++;
      }
      continue;
    }
    if (resp.status === "added") added++;
  }

  await renderAccounts();

  const parts = [];
  if (added) parts.push(`imported ${added}`);
  if (overridden) parts.push(`overrode ${overridden}`);
  if (skipped) parts.push(`skipped ${skipped} duplicate${skipped > 1 ? "s" : ""}`);
  if (rejected) parts.push(`rejected ${rejected}${rejectReason ? ` (${rejectReason})` : ""}`);
  const summary = (parts.length ? parts.join(", ") : "nothing imported");
  const sentence = summary.charAt(0).toUpperCase() + summary.slice(1) + ".";
  $("importResult").textContent = sentence;
  const warn = added === 0 && overridden === 0; // only duplicates/rejects
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
  $("exportPass").value = "";
  $("exportPass2").value = "";
  $("exportText").value = "";
  $("plainExportBox").classList.add("hidden");
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

async function downloadEncrypted() {
  const p1 = $("exportPass").value;
  const p2 = $("exportPass2").value;
  if (p1.length < 8) {
    toast("Use a passphrase of at least 8 characters", "warn");
    return;
  }
  if (p1 !== p2) {
    toast("Passphrases don't match", "warn");
    return;
  }
  const resp = await bg({ type: "accounts.exportEncrypted", passphrase: p1 });
  if (!resp) return;
  if (resp.locked) {
    showLock();
    return;
  }
  download(
    "otp-backup.json",
    JSON.stringify(resp.envelope, null, 2),
    "application/json"
  );
  toast("Encrypted backup downloaded");
}

async function revealPlainExport() {
  const ok = await confirmDialog(
    "Plaintext export shows every 2FA seed unprotected. Anyone who reads the file or your clipboard gets your codes.\n\nShow it anyway?",
    { okText: "Show plaintext", danger: true }
  );
  if (!ok) return;
  const resp = await bg({ type: "accounts.export", format: "uri" });
  if (!resp) return;
  if (resp.locked) {
    showLock();
    return;
  }
  $("exportText").value = resp.text;
  $("plainExportBox").classList.remove("hidden");
}

// ---- settings -------------------------------------------------------------

async function renderVaultSection() {
  const vs = await bg({ type: "vault.status" });
  const state = vs ? vs.state : "plain";
  $("vaultStateLine").textContent =
    state === "plain"
      ? "No master password — codes are stored unencrypted on this device."
      : state === "unlocked"
      ? "Accounts are encrypted with your master password (unlocked)."
      : "Accounts are encrypted with your master password (locked).";
  $("vaultPlainRow").classList.toggle("hidden", state !== "plain");
  $("vaultOnBox").classList.toggle("hidden", state === "plain");
}

async function setMasterPassword() {
  const p1 = await promptDialog(
    "Choose a master password (at least 8 characters).\n\nYou'll type it once per browser session; codes stay encrypted on disk.",
    { okText: "Next" }
  );
  if (p1 == null) return;
  if (p1.length < 8) {
    toast("Use at least 8 characters", "warn");
    return;
  }
  const p2 = await promptDialog("Repeat the master password:", { okText: "Encrypt" });
  if (p2 == null) return;
  if (p1 !== p2) {
    toast("Passwords don't match", "warn");
    return;
  }
  const resp = await bg({ type: "vault.enable", password: p1 });
  if (resp && resp.ok) {
    await saveSettings({ vaultNudgeDismissed: true });
    await renderVaultSection();
    toast("Accounts encrypted ✓");
  } else {
    toast("Could not enable encryption", "warn");
  }
}

async function changeMasterPassword() {
  const current = await promptDialog("Current master password:", { okText: "Next" });
  if (current == null) return;
  const p1 = await promptDialog("New master password (at least 8 characters):", { okText: "Next" });
  if (p1 == null) return;
  if (p1.length < 8) {
    toast("Use at least 8 characters", "warn");
    return;
  }
  const p2 = await promptDialog("Repeat the new master password:", { okText: "Change" });
  if (p2 == null) return;
  if (p1 !== p2) {
    toast("Passwords don't match", "warn");
    return;
  }
  const resp = await bg({ type: "vault.changePassword", current, next: p1 });
  if (resp && resp.ok) toast("Password changed ✓");
  else toast(resp && resp.error === "wrong-password" ? "Wrong current password" : "Failed", "warn");
}

async function removeMasterPassword() {
  const ok = await confirmDialog(
    "Remove the master password? Your 2FA seeds will be stored unencrypted again.",
    { okText: "Remove", danger: true }
  );
  if (!ok) return;
  const password = await promptDialog("Master password:", { okText: "Decrypt & remove" });
  if (password == null) return;
  const resp = await bg({ type: "vault.disable", password });
  if (resp && resp.ok) {
    await renderVaultSection();
    toast("Encryption removed");
  } else {
    toast(resp && resp.error === "wrong-password" ? "Wrong password" : "Failed", "warn");
  }
}

async function openSettings() {
  const s = await getSettings();
  $("s_autoFill").checked = s.autoFill;
  $("s_autoSubmit").checked = s.autoSubmit;
  $("s_fallbackSingle").checked = s.fallbackSingle;
  $("s_matchByIssuer").checked = s.matchByIssuer;
  $("s_issuerExactMatch").checked = s.issuerExactMatch;
  $("s_rememberDomainEmail").checked = s.rememberDomainEmail;
  $("s_showButton").checked = s.showButton;
  $("s_debug").checked = s.debug;
  $("s_clearClipboard").checked = s.clearClipboard;
  $("s_autoLockMinutes").value = String(s.autoLockMinutes || 0);
  await renderVaultSection();
  await renderRemembered();
  showView("settingsView");
}

async function persistSettings() {
  await saveSettings({
    autoFill: $("s_autoFill").checked,
    autoSubmit: $("s_autoSubmit").checked,
    fallbackSingle: $("s_fallbackSingle").checked,
    matchByIssuer: $("s_matchByIssuer").checked,
    issuerExactMatch: $("s_issuerExactMatch").checked,
    rememberDomainEmail: $("s_rememberDomainEmail").checked,
    showButton: $("s_showButton").checked,
    debug: $("s_debug").checked,
    clearClipboard: $("s_clearClipboard").checked,
    autoLockMinutes: parseInt($("s_autoLockMinutes").value, 10) || 0,
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
$("downloadEncryptedBtn").onclick = downloadEncrypted;
$("showPlainExportBtn").onclick = revealPlainExport;
$("copyExportBtn").onclick = async () => {
  const text = $("exportText").value;
  await navigator.clipboard.writeText(text);
  bg({ type: "clipboard.scheduleClear", text });
  toast("Copied");
};
$("downloadJsonBtn").onclick = async () => {
  const resp = await bg({ type: "accounts.export", format: "json" });
  if (resp && resp.text) download("otp-accounts.json", resp.text, "application/json");
};
$("downloadUriBtn").onclick = async () => {
  const resp = await bg({ type: "accounts.export", format: "uri" });
  if (resp && resp.text) download("otp-accounts.txt", resp.text, "text/plain");
};
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
  "s_issuerExactMatch",
  "s_rememberDomainEmail",
  "s_showButton",
  "s_debug",
  "s_clearClipboard",
  "s_autoLockMinutes",
]) {
  $(id).addEventListener("change", persistSettings);
}
$("setPasswordBtn").onclick = setMasterPassword;
$("changePasswordBtn").onclick = changeMasterPassword;
$("removePasswordBtn").onclick = removeMasterPassword;
$("lockNowBtn").onclick = async () => {
  await bg({ type: "vault.lock" });
  showLock();
};
$("clearRememberedBtn").onclick = async () => {
  if (!(await confirmDialog("Forget all remembered logins?", { okText: "Forget all", danger: true }))) return;
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
  const vs = await bg({ type: "vault.status" });
  if (vs && vs.state === "locked") {
    showLock();
  } else {
    await renderAccounts();
  }
  tickTimer = setInterval(tick, 1000);
})();
