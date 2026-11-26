// Barcode scanning with the phone or laptop camera. Works where the browser has BarcodeDetector (Chrome on Android and desktop).
// Elsewhere, use a USB or Bluetooth scanner, which types the code and presses Enter.
import { openModal, toast } from "./core.js";

export const cameraScanSupported = () =>
  typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;

export function scanCode(onCode) {
  if (!cameraScanSupported()) {
    toast("Camera scanning is not available in this browser. Use a barcode scanner or type the code.", "error");
    return;
  }
  openModal("Scan barcode", `
    <div class="scan-box">
      <video playsinline muted></video>
      <p class="muted small center">Hold the barcode inside the frame. It is read automatically.</p>
    </div>
    <div class="form-actions"><button type="button" class="btn ghost" data-stop>Close</button></div>`, (body, close) => {
    const video = body.querySelector("video");
    let stream = null, timer = null, done = false;
    const stop = () => {
      done = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    body.querySelector("[data-stop]").addEventListener("click", () => { stop(); close(); });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
        await video.play();
        const detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"] });
        timer = setInterval(async () => {
          // Stop when the dialog has been closed another way (backdrop or Escape).
          if (done || !document.body.contains(video)) return stop();
          const found = await detector.detect(video);
          if (found.length && !done) {
            const code = found[0].rawValue;
            stop();
            close();
            onCode(code);
          }
        }, 350);
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
