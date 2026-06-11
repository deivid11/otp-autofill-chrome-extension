// src/content.js
// Detects login (step 1) and OTP (step 2) forms, captures the email entered on
// step 1, and autofills the matching TOTP code on step 2. Works on SPA flows
// where both steps live on the same origin without a full page reload.
//
// This script holds NO secrets and loads no crypto/storage code: it asks the
// background worker for at most a ready-made 6-digit code. The background
// decides per sender origin whether the page may receive one (domain binding,
// cross-origin-iframe block, vault lock).

(function () {
  let settings = { autoFill: false, autoSubmit: false, showButton: true, debug: false };
  let ctx = null; // last ctx.get response from the background
  let scanScheduled = false;
  let lastFilledKey = null; // guards against auto-refilling the same OTP screen

  let DEBUG = false; // toggled by the "debug logging" setting
  const dbg = (...a) => {
    if (DEBUG) console.log("[OTP-AF]", ...a);
  };

  // promise wrapper over sendMessage; null when the background is unreachable
  function sendBg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function ensureCtx() {
    if (!ctx) {
      ctx = await sendBg({ type: "ctx.get" });
      if (ctx && ctx.settings) {
        settings = ctx.settings;
        DEBUG = !!settings.debug;
      }
    }
    return ctx;
  }

  // Remember an email for the immediate two-step flow and (if enabled) durably
  // per domain. The background validates and keys it by this frame's origin.
  // Debounced + deduped: input events fire per keystroke and the periodic
  // scan re-sees the same value, which used to mean a message + storage
  // writes each time. flush=true (change/blur) sends immediately so the email
  // isn't lost when submitting navigates to a new document.
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  let emailTimer = null;
  let lastSentEmail = "";
  function captureEmail(value, flush) {
    const v = (value || "").trim();
    if (!v || v === lastSentEmail || !EMAIL_RE.test(v)) return;
    clearTimeout(emailTimer);
    const send = () => {
      lastSentEmail = v;
      sendBg({ type: "email.captured", email: v });
    };
    if (flush) send();
    else emailTimer = setTimeout(send, 350);
  }

  // ---- field detection -----------------------------------------------------

  // Collect <input>s from the document AND any open shadow roots — modern apps
  // (and OTP widgets) often live inside web components that a plain
  // querySelectorAll cannot see.
  function deepQueryAllInputs(root) {
    root = root || document;
    const out = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      let all;
      try {
        all = node.querySelectorAll("*");
      } catch (e) {
        return;
      }
      for (const el of all) {
        if (el.tagName === "INPUT") out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out;
  }

  // Compact description of an input, for the debug dump.
  function describeInput(el) {
    let w = 0;
    try { w = Math.round(el.getBoundingClientRect().width); } catch (e) {}
    return {
      type: el.type,
      ml: el.getAttribute("maxlength"),
      im: el.getAttribute("inputmode"),
      ac: el.getAttribute("autocomplete"),
      id: el.id || el.name || "",
      cls: (el.className || "").toString().slice(0, 40),
      vis: isVisible(el),
      w,
    };
  }

  // document + every open shadow root, for deep scans.
  function collectRoots() {
    const roots = [document];
    const seen = new Set();
    const walk = (node) => {
      let els;
      try {
        els = node.querySelectorAll("*");
      } catch (e) {
        return;
      }
      for (const el of els) {
        if (el.shadowRoot && !seen.has(el.shadowRoot)) {
          seen.add(el.shadowRoot);
          roots.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    return roots;
  }

  // Some apps render the OTP as N decorative cells (divs/spans) driven by a
  // single, often visually-hidden, <input> (e.g. transfercld: 6 .otp-block divs
  // + one input.hidden-input). Detect that input by its OTP-ish container class.
  const OTP_CONTAINER_RE =
    /otp[-_]?(input|block|inner|field|box|cell|code|wrapper|container|row)|(^|[-_ ])otp([-_ ]|$)|one[-_]?time[-_]?code|passcode|verification[-_]?code|two[-_]?factor|(^|[-_ ])2fa([-_ ]|$)|(^|[-_ ])mfa([-_ ]|$)/i;

  function findOtpContainerInput() {
    for (const root of collectRoots()) {
      let els;
      try {
        els = root.querySelectorAll("*");
      } catch (e) {
        continue;
      }
      for (const el of els) {
        const cls = el.getAttribute && el.getAttribute("class");
        if (!cls || !OTP_CONTAINER_RE.test(cls)) continue;
        const inp = deepQueryAllInputs(el).find(
          (i) => !i.disabled && i.type !== "hidden" && i.type !== "checkbox"
        );
        if (inp) return inp;
      }
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.type === "hidden") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function looksLikeEmail(el) {
    if (el.type === "email") return true;
    const hay = [
      el.name,
      el.id,
      el.placeholder,
      el.getAttribute("autocomplete") || "",
      el.getAttribute("aria-label") || "",
    ]
      .join(" ")
      .toLowerCase();
    if (/e-?mail|correo|user(name)?|usuario|login|account/.test(hay)) return true;
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((el.value || "").trim())) return true;
    return false;
  }

  function findEmailInput(allInputs) {
    const inputs = (allInputs || deepQueryAllInputs()).filter(isVisible);
    // prefer type=email, then anything that looks like an email/username field
    return (
      inputs.find((el) => el.type === "email") ||
      inputs.find((el) => el.type !== "password" && looksLikeEmail(el)) ||
      null
    );
  }

  function findPasswordInput(allInputs) {
    return (allInputs || deepQueryAllInputs())
      .filter((el) => el.type === "password")
      .find(isVisible);
  }

  // Locate OTP inputs: either a single one-time-code field or a row of
  // single-character boxes (the most common 2FA pattern).
  function findOtpInputs(allInputs) {
    const all = (allInputs || deepQueryAllInputs()).filter(isVisible);

    // Single field meant to hold the whole code. A maxlength of 1 means the
    // field is actually one cell of a box grid, so it is excluded here even if
    // it carries autocomplete="one-time-code".
    const single = all.find((el) => {
      if (!["text", "tel", "number", ""].includes(el.type)) return false;
      const ml = parseInt(el.getAttribute("maxlength") || "0", 10);
      if (ml === 1) return false; // part of a grid, handled below
      const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
      const hay = [el.name, el.id, el.placeholder, el.getAttribute("aria-label")]
        .join(" ")
        .toLowerCase();
      const named = /otp|token|2fa|mfa|verif|c[oó]digo|\bcode\b/.test(hay);
      if (ac.includes("one-time-code") && (ml === 0 || ml >= 4)) return true;
      return named && ml >= 4 && ml <= 10;
    });
    if (single) return { mode: "single", inputs: [single] };

    // Grid of single-character boxes. Primary signal is maxlength=1 (used by
    // almost every OTP-box component). As a fallback, accept a row of small
    // numeric inputs that share a parent — for modals that don't set maxlength.
    const typeOk = (el) =>
      ["text", "tel", "number", "password", ""].includes(el.type);

    let boxes = all.filter((el) => {
      if (!typeOk(el)) return false;
      return parseInt(el.getAttribute("maxlength") || "0", 10) === 1;
    });

    if (boxes.length < 4) {
      const fallback = all.filter((el) => {
        if (!typeOk(el)) return false;
        const ml = parseInt(el.getAttribute("maxlength") || "0", 10);
        if (ml > 1) return false; // a real multi-char field, not a cell
        const im = (el.getAttribute("inputmode") || "").toLowerCase();
        const numeric =
          im === "numeric" ||
          im === "tel" ||
          /^[0-9]?$/.test((el.value || "").trim());
        if (!numeric) return false;
        const w = el.getBoundingClientRect().width;
        return w > 0 && w <= 64; // OTP cells are visually small
      });
      // require them to live under a common parent to avoid grabbing unrelated
      // small inputs scattered around the page
      const byParent = new Map();
      for (const el of fallback) {
        const p = el.parentElement;
        if (!p) continue;
        (byParent.get(p) || byParent.set(p, []).get(p)).push(el);
      }
      let best = [];
      for (const group of byParent.values()) {
        if (group.length > best.length) best = group;
      }
      if (best.length >= 4) boxes = best;
    }

    if (boxes.length >= 4) {
      // sort by document position so digits land in the right order
      // (cache each rect so the comparator doesn't force a reflow per compare)
      const rects = new Map(boxes.map((el) => [el, el.getBoundingClientRect()]));
      boxes.sort((a, b) => {
        const ra = rects.get(a);
        const rb = rects.get(b);
        return ra.top - rb.top || ra.left - rb.left;
      });
      return { mode: "grid", inputs: boxes };
    }

    // Single hidden input behind decorative cells.
    const proxy = findOtpContainerInput();
    if (proxy) return { mode: "single", inputs: [proxy] };

    return null;
  }

  // True when the OTP inputs already hold a complete code — used to stop the
  // autofill from looping when our own input events make the SPA re-render.
  function otpAlreadyFilled(target) {
    if (!target) return false;
    if (target.mode === "single") {
      return (target.inputs[0].value || "").trim().length >= 4;
    }
    return target.inputs.every((el) => (el.value || "").trim().length >= 1);
  }

  function otpKey(otp) {
    return otp.mode + ":" + otp.inputs.length + ":" + location.pathname;
  }

  // ---- value setting (React/Vue friendly) ----------------------------------

  function setNativeValue(el, value) {
    const last = el.value;
    const proto = Object.getPrototypeOf(el);
    const protoSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const ownSetter = Object.getOwnPropertyDescriptor(el, "value")?.set;
    if (ownSetter && protoSetter && ownSetter !== protoSetter) {
      protoSetter.call(el, value);
    } else if (protoSetter) {
      protoSetter.call(el, value);
    } else {
      el.value = value;
    }
    // Make React's value tracker believe the value changed so onChange fires.
    if (el._valueTracker && typeof el._valueTracker.setValue === "function") {
      el._valueTracker.setValue(last);
    }
  }

  function typeInto(el, char) {
    el.focus();
    el.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: char })
    );
    try {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: char,
          inputType: "insertText",
        })
      );
    } catch (e) {
      /* older browsers */
    }
    setNativeValue(el, char);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: char,
        inputType: "insertText",
      })
    );
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: char }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Type a whole code into one field, digit by digit, accumulating the value.
  // This drives components that read each keystroke (incl. the "hidden input
  // behind N cells" pattern) far more reliably than a single bulk assignment.
  function typeWholeInto(el, code) {
    el.focus();
    let cur = "";
    for (const ch of code) {
      cur += ch;
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ch }));
      try {
        el.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            data: ch,
            inputType: "insertText",
          })
        );
      } catch (e) {
        /* older browsers */
      }
      setNativeValue(el, cur);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          data: ch,
          inputType: "insertText",
        })
      );
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: ch }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillOtpInputs(target, code) {
    if (target.mode === "single") {
      typeWholeInto(target.inputs[0], code);
      return;
    }
    // grid: one digit per box, advancing focus like a real user
    const inputs = target.inputs;
    for (let i = 0; i < inputs.length && i < code.length; i++) {
      typeInto(inputs[i], code[i]);
    }
    // nudge focus to the last box so auto-submit components are happy
    const last = inputs[Math.min(code.length, inputs.length) - 1];
    if (last) last.focus();
  }

  // ---- floating helper button ----------------------------------------------

  let buttonEl = null;
  function showButton(label, onClick) {
    if (!settings.showButton) return;
    if (!buttonEl) {
      buttonEl = document.createElement("button");
      buttonEl.id = "otp-autofill-helper";
      buttonEl.style.cssText = [
        "position:fixed",
        "z-index:2147483647",
        "right:18px",
        "bottom:18px",
        "padding:10px 14px",
        "border:none",
        "border-radius:10px",
        "background:#2f6fed",
        "color:#fff",
        "font:600 13px/1 system-ui,sans-serif",
        "box-shadow:0 4px 14px rgba(0,0,0,.35)",
        "cursor:pointer",
      ].join(";");
      (document.body || document.documentElement).appendChild(buttonEl);
    }
    buttonEl.textContent = label;
    // a page can synthesize click events on our button — only obey real ones
    buttonEl.onclick = (e) => {
      if (!e || !e.isTrusted) return;
      onClick(e);
    };
    buttonEl.style.display = "block";
  }

  function hideButton() {
    if (buttonEl) buttonEl.style.display = "none";
  }

  // ---- submit --------------------------------------------------------------

  function trySubmit() {
    const labels = /continuar|continue|verify|verificar|enviar|submit|next|siguiente|aceptar|ingresar|login|entrar/i;
    const candidates = Array.from(
      document.querySelectorAll(
        'button, input[type="submit"], [role="button"]'
      )
    ).filter(isVisible);
    const btn =
      candidates.find((b) =>
        labels.test((b.textContent || b.value || "").trim())
      ) || candidates.find((b) => b.type === "submit");
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  // ---- main scan -----------------------------------------------------------

  function fillAndFinish(otp, code) {
    fillOtpInputs(otp, code);
    lastFilledKey = otpKey(otp);
    if (settings.autoSubmit) {
      setTimeout(trySubmit, 250);
    }
    hideButton();
  }

  function openPopupForUnlock() {
    sendBg({ type: "popup.open" });
  }

  // gesture=true marks an explicit user action (button click, popup "Fill
  // tab", keyboard command) — required the first time a domain is used, and
  // it makes the background remember the domain for next time.
  async function doFill(reason, opts) {
    const otp = (opts && opts.otp) || findOtpInputs();
    if (!otp) return false;
    const resp = await sendBg({
      type: "code.request",
      gesture: !!(opts && opts.gesture),
    });
    dbg("doFill", { reason, resp: resp && Object.keys(resp), mode: otp.mode });
    if (!resp) return false;
    if (resp.locked) {
      showButton("Unlock OTP Autofill…", openPopupForUnlock);
      return false;
    }
    if (!resp.ok) return false;
    fillAndFinish(otp, resp.code);
    return true;
  }

  async function scan() {
    scanScheduled = false;
    if (!(await ensureCtx())) return; // background not ready yet — next scan retries
    if (ctx.blocked) return; // cross-site frame: never fills, so never scan

    // One DOM/shadow-DOM walk per scan, shared by all three field detectors.
    const allInputs = deepQueryAllInputs();
    const otp = findOtpInputs(allInputs);
    const passwordInput = findPasswordInput(allInputs);
    const emailInput = findEmailInput(allInputs);

    // Feed the adaptive backoff: a page with no auth-related field is "idle",
    // so the safety-net re-scan can slow down instead of running forever.
    if (otp || passwordInput || emailInput) idleScans = 0;
    else idleScans++;

    dbg("scan", {
      otp: otp ? otp.mode + ":" + otp.inputs.length : null,
      hasPassword: !!passwordInput,
      hasEmail: !!emailInput,
      origin: location.origin,
    });
    // When nothing was detected, dump every input so we can see why.
    if (DEBUG && !otp && !passwordInput) {
      dbg("all inputs (" + allInputs.length + "):", allInputs.map(describeInput));
    }

    // Step 1: capture the email so step 2 can match the right account.
    if (emailInput && passwordInput && !otp) {
      captureEmail(emailInput.value);
      hideButton();
      return;
    }

    // Step 2: OTP screen.
    if (otp) {
      const key = otpKey(otp);
      // Already populated (likely by us) — don't fight the SPA's re-renders.
      if (otpAlreadyFilled(otp)) {
        hideButton();
        return;
      }
      const resp = await sendBg({ type: "code.request", gesture: false });
      dbg("otp branch", { resp, autoFill: settings.autoFill, key });
      if (!resp || resp.blocked) {
        hideButton();
        return;
      }
      if (resp.locked) {
        showButton("Unlock OTP Autofill…", openPopupForUnlock);
        return;
      }
      if (resp.needsGesture) {
        // first use on this domain: one explicit click binds it for next time
        showButton("Fill OTP — " + (resp.label || "").slice(0, 40), () =>
          doFill("bind-domain", { otp, gesture: true })
        );
        return;
      }
      if (resp.ok) {
        if (settings.autoFill) {
          // Auto-fill a given OTP screen only once: some widgets clear the
          // hidden input after reading it, which would otherwise loop forever.
          if (lastFilledKey !== key) {
            fillAndFinish(otp, resp.code);
          }
        } else {
          showButton("Fill OTP code", () => doFill("manual", { otp }));
        }
        return;
      }
      if (resp.none && resp.hasAccounts) {
        showButton("No matching account", () => {});
      }
    } else {
      lastFilledKey = null; // left the OTP screen; allow the next one to fill
      hideButton();
    }
  }

  function scheduleScan() {
    if (scanScheduled || document.hidden) return;
    scanScheduled = true;
    setTimeout(scan, 200);
  }

  // Safety-net re-scan for SPA screen swaps the MutationObserver can't see
  // (shadow-root changes, visibility toggles). It runs fast while an auth flow
  // is on the page and backs off hard on ordinary pages, so the extension is
  // not walking the DOM of every open tab every 1.2s forever — the main source
  // of idle CPU drain.
  let idleScans = 0;
  let periodicTimer = null;

  function periodicDelay() {
    if (idleScans < 3) return 1200; // active auth flow: stay responsive
    if (idleScans < 6) return 4000;
    return 10000; // ordinary page: just an occasional safety check
  }

  function schedulePeriodic() {
    clearTimeout(periodicTimer);
    if (document.hidden) return; // never scan a background tab
    periodicTimer = setTimeout(() => {
      scheduleScan();
      schedulePeriodic();
    }, periodicDelay());
  }

  function resetPeriodic() {
    idleScans = 0;
    schedulePeriodic();
  }

  // ---- capture email on the fly --------------------------------------------

  function onUserInput(e) {
    const el = e.target;
    if (!el || el.tagName !== "INPUT") return;
    if (el.type !== "password" && looksLikeEmail(el)) {
      captureEmail(el.value, e.type === "change");
    }
  }

  // ---- wiring --------------------------------------------------------------

  async function init() {
    const initialCtx = await ensureCtx();
    dbg("init", { href: location.href, origin: location.origin });

    // A frame whose site differs from the top page can never receive a code,
    // so don't burn CPU scanning it (ad-heavy pages embed dozens of frames).
    // No listeners, observers or timers — this frame stays fully idle.
    if (initialCtx && initialCtx.blocked) {
      dbg("cross-site frame — scanner disabled");
      return;
    }

    document.addEventListener("input", onUserInput, true);
    document.addEventListener("change", onUserInput, true);

    // Only react to mutations that actually add input-bearing nodes. Most SPA
    // churn (chat apps, mail, feeds) adds no inputs and previously triggered a
    // full DOM walk on every change for nothing.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue; // elements only
          if (
            node.tagName === "INPUT" ||
            node.shadowRoot ||
            (node.querySelector && node.querySelector("input"))
          ) {
            resetPeriodic(); // a form just changed — scan eagerly again
            scheduleScan();
            return;
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Light-DOM mutations don't fire for changes inside shadow roots, and some
    // SPAs swap screens without a mutation the observer catches. The adaptive
    // safety-net re-scan still notices the OTP screen appearing.
    schedulePeriodic();

    // Don't scan background tabs at all; resume eagerly when shown again.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearTimeout(periodicTimer);
      } else {
        resetPeriodic();
        scheduleScan();
      }
    });

    // react to settings changes from the popup without a reload (settings are
    // not secret; accounts never transit this listener)
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) {
        ctx = null; // re-fetch on the next scan
        ensureCtx();
      }
    });

    // popup / keyboard command can force a fill — these are explicit user
    // actions, so they count as a gesture (and bind the domain)
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "FILL_NOW") {
        doFill("forced", { gesture: true }).then((ok) => sendResponse({ ok }));
        return true; // async response
      }
      if (msg && msg.type === "PING") {
        sendResponse({ ok: true, hasOtp: !!findOtpInputs() });
        return true;
      }
    });

    scheduleScan();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
