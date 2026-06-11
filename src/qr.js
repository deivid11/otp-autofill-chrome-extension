// src/qr.js
// QR decoding for both the popup (DOM canvas) and the background service worker
// (OffscreenCanvas). Uses the vendored jsQR — Chrome's native BarcodeDetector is
// unavailable on Linux/Windows desktop, so we don't rely on it.
// Exposed as globalThis.OTP.qr.

(function () {
  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function toImageData(bitmap, scale) {
    const w = Math.max(1, Math.round(bitmap.width * (scale || 1)));
    const h = Math.max(1, Math.round(bitmap.height * (scale || 1)));
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  function decodeImageData(imageData) {
    const jsQR = globalThis.jsQR;
    if (!jsQR) throw new Error("jsQR not loaded");
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "attemptBoth",
    });
    return code && code.data ? code.data : null;
  }

  // Try a few scales: native size is best for a sharp QR, a downscale helps when
  // the QR is a small part of a large screenshot.
  async function decodeFromBitmap(bitmap) {
    for (const scale of [1, 0.5, 0.75]) {
      try {
        const res = decodeImageData(toImageData(bitmap, scale));
        if (res) return res;
      } catch (e) {
        /* try next scale */
      }
    }
    return null;
  }

  async function decodeFromBlob(blob) {
    const bitmap = await createImageBitmap(blob);
    try {
      return await decodeFromBitmap(bitmap);
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  async function decodeFromDataUrl(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    return decodeFromBlob(blob);
  }

  // Fetch an image by URL (used by the right-click context menu in the
  // background worker; extension host permissions bypass page CORS).
  // credentials:"omit" so the extension never attaches the user's cookies to
  // an arbitrary image URL.
  async function decodeFromUrl(url) {
    const blob = await (await fetch(url, { credentials: "omit" })).blob();
    return decodeFromBlob(blob);
  }

  globalThis.OTP = Object.assign(globalThis.OTP || {}, {
    qr: {
      decodeImageData,
      decodeFromBitmap,
      decodeFromBlob,
      decodeFromDataUrl,
      decodeFromUrl,
    },
  });
})();
