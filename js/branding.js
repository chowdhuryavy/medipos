import { db, doc, getDoc } from "./firebase.js";
import { esc } from "./core.js";

// Public branding (app name, shop name, logo) readable before sign-in.
export const branding = { appName: "MediPOS", shopName: "", logoUrl: "" };

export async function loadBranding() {
  try {
    const snap = await getDoc(doc(db, "branding", "public"));
    if (snap.exists()) Object.assign(branding, snap.data());
  } catch (err) {
    console.warn("Branding unavailable:", err.message);
  }
  document.title = branding.appName || "MediPOS";
  return branding;
}

/** The logo image, or the default icon tile when no logo has been uploaded. */
export const logoHtml = (fallbackIcon, cls = "brand-mark big") =>
  branding.logoUrl
    ? `<img class="brand-logo" src="${branding.logoUrl}" alt="${esc(branding.appName)} logo" />`
    : `<div class="${cls}">${fallbackIcon}</div>`;
