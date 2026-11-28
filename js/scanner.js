// Barcode scanning with the phone or laptop camera. Uses the browser's built-in reader where it exists (Chrome on Android and desktop).
// Everywhere else (iPhone Safari and Chrome, Firefox, older phones) the bundled html5-qrcode library reads the camera.
// A USB or Bluetooth scanner also works on any device: it types the code and presses Enter.
import { openModal, toast } from "./core.js";

const LIB_URL = "js/vendor/html5-qrcode.min.js";
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"];

export const cameraScanSupported = () =>
  typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

let libPromise = null;
function loadLibrary() {
  if (window.Html5Qrcode) return Promise.resolve(window.Html5Qrcode);
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LIB_URL;
      s.onload = () => (window.Html5Qrcode ? resolve(window.Html5Qrcode) : reject(new Error("Scanner library did not load")));
      s.onerror = () => { libPromise = null; reject(new Error("Scanner library could not be loaded")); };
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

export function scanCode(onCode) {
  if (!cameraScanSupported()) {
    toast("Camera scanning is not available in this browser. Use a barcode scanner or type the code.", "error");
    return;
  }
  openModal("Scan barcode", `
    <div class="scan-box">
      <div class="scan-view" id="scan-view"></div>
      <p class="muted small center">Hold the barcode inside the frame. It is read automatically.</p>
    </div>
    <div class="form-actions"><button type="button" class="btn ghost" data-stop>Close</button></div>`, (body, close) => {
    let done = false;
    let reader = null;       // html5-qrcode instance
    let detectTimer = null;  // built-in BarcodeDetector loop
    let stream = null;
    const stop = async () => {
      if (done) return;
      done = true;
      clearInterval(detectTimer);
      stream?.getTracks().forEach((t) => t.stop());
      if (reader) {
        try { if (reader.isScanning) await reader.stop(); reader.clear(); } catch { /* already stopped */ }
      }
    };
    const found = (code) => {
      if (done) return;
      stop();
      close();
      onCode(code);
    };
    body.querySelector("[data-stop]").addEventListener("click", () => { stop(); close(); });

    (async () => {
      try {
        if ("BarcodeDetector" in window) {
          // Built-in reader: fastest where it exists.
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
          const video = document.createElement("video");
          video.setAttribute("playsinline", "");
          video.muted = true;
          video.srcObject = stream;
          document.getElementById("scan-view").appendChild(video);
          await video.play();
          const detector = new BarcodeDetector({ formats: FORMATS });
          detectTimer = setInterval(async () => {
            // Stop when the dialog has been closed another way (backdrop or Escape).
            if (done || !document.body.contains(video)) return stop();
            const hits = await detector.detect(video);
            if (hits.length) found(hits[0].rawValue);
          }, 350);
        } else {
          // iPhone, Firefox and other browsers: the bundled library reads the camera.
          const Html5Qrcode = await loadLibrary();
          if (done || !document.body.contains(document.getElementById("scan-view"))) return;
          reader = new Html5Qrcode("scan-view", { verbose: false });
          await reader.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: (w, h) => ({ width: Math.round(Math.min(w, h) * 0.8), height: Math.round(Math.min(w, h) * 0.5) }) },
            (text) => found(text),
            () => {}
          );
        }
      } catch (err) {
        stop();
        close();
        toast(`Camera is not available: ${err.message}`, "error");
      }
    })();
  });
}

// Any button with data-scan-into="selector" fills that field with the scanned code.
// data-scan-enter presses Enter afterwards (used by the sale screen to add the product).
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-scan-into]");
  if (!b) return;
  const scope = b.closest("form") || document;
  const input = scope.querySelector(b.dataset.scanInto) || document.querySelector(b.dataset.scanInto);
  scanCode((code) => {
    if (!input) return;
    input.value = code;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (b.hasAttribute("data-scan-enter")) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
  });
});
