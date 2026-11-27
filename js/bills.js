// Bills and invoices attached to expenses and purchases. A bill is a photo (compressed here) or a PDF,
// stored as a small data string in a subcollection under its expense or purchase. Bills are written once,
// with the posting they belong to, and are never changed or deleted.
import { collection, getDocs, serverTimestamp } from "./firebase.js";
import { session, esc, openModal, toast } from "./core.js";

export const BILL_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
// Firestore documents are capped at 1 MiB, so the stored text stays under this many characters.
export const BILL_MAX_CHARS = 900000;
const MAX_PDF_BYTES = 600000;
const MAX_IMAGE_SIDE = 1600;

/** The file input shown on a posting form. */
export const billInputHtml = () => `
  <label class="span-2">Bill or invoice (photo or PDF, optional)
    <input name="bill" type="file" accept="image/*,application/pdf" />
  </label>`;

const cleanName = (name, fallbackExt) => String(name || `bill.${fallbackExt}`).replace(/[^\w.\- ]/g, "_").slice(0, 120);

function readAsDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("The file could not be read."));
    r.readAsDataURL(file);
  });
}

// Shrinks a photo until it fits the stored size. Photos of bills stay readable at this size.
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("That picture could not be read. Try another photo."));
      i.src = url;
    });
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.8, 0.65, 0.5, 0.4]) {
      const data = canvas.toDataURL("image/jpeg", q);
      if (data.length <= BILL_MAX_CHARS) return { type: "image/jpeg", data };
    }
    throw new Error("That picture is too detailed to store. Take a closer photo of the bill.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Reads the chosen file into a bill ready to save. Returns null when no file was chosen. Throws a readable message when it cannot be used. */
export async function readBillFrom(file) {
  if (!file || !file.size) return null;
  if (file.type.startsWith("image/")) {
    const img = await compressImage(file);
    return { name: cleanName(file.name, "jpg").replace(/\.[^.]+$/, "") + ".jpg", type: img.type, size: file.size, data: img.data };
  }
  if (file.type === "application/pdf") {
    if (file.size > MAX_PDF_BYTES) throw new Error("The PDF is larger than 600 KB. Save a smaller copy, or photograph the bill instead.");
    const data = await readAsDataUrl(file);
    if (data.length > BILL_MAX_CHARS) throw new Error("The PDF is too large to store. Save a smaller copy, or photograph the bill instead.");
    return { name: cleanName(file.name, "pdf"), type: "application/pdf", size: file.size, data };
  }
  throw new Error("Attach a photo (JPG, PNG or WebP) or a PDF of the bill.");
}

/** The document written to the bills subcollection. */
export function billRecord(bill) {
  return { ...bill, uploadedBy: session.name || "", uploadedByUid: session.uid || "", uploadedAt: serverTimestamp() };
}

function blobFromDataUrl(dataUrl) {
  const [head, b64] = String(dataUrl).split(",");
  const type = head.match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
  const bin = atob(b64 || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Lists the bills of one expense or purchase, and opens each in a new tab. */
export async function viewBills(parentRef, title) {
  let bills;
  try {
    const snap = await getDocs(collection(parentRef, "bills"));
    bills = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch {
    return toast("You do not have access to these bills.", "error");
  }
  const list = bills.length
    ? `<ul class="bill-list">${bills.map((b) => `
        <li><span>${esc(b.name)}</span>
          <small class="muted">${esc(b.uploadedBy || "")}</small>
          <button class="btn ghost" type="button" data-open="${esc(b.id)}">Open</button></li>`).join("")}</ul>`
    : `<p class="muted">No bill attached.</p>`;
  openModal(`Bills · ${title}`, list, (body, close) => {
    body.querySelectorAll("[data-open]").forEach((btn) => btn.addEventListener("click", () => {
      const b = bills.find((x) => x.id === btn.dataset.open);
      if (!b) return;
      // The blob is made from data already on screen, so the tab opens straight from the click.
      window.open(URL.createObjectURL(blobFromDataUrl(b.data)), "_blank");
    }));
  });
}
