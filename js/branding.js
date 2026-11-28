import { db, doc, getDoc } from "./firebase.js";
import { esc } from "./core.js";

// Public branding (app name, shop name, logo) readable before sign-in.
// Last known name and logo on this device, so the loading screen is right even when the network is slow.
const CACHE_KEY = "medipos.branding";
export const branding = { appName: "MediPOS", shopName: "", logoUrl: "", brandColor: "", loadingStyle: "orbit", loadingMessage: "" };
try {
  Object.assign(branding, JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"));
} catch {
  /* storage unavailable or corrupt: use defaults */
}
// Show the cached shop name and logo on the tab straight away, before the network answers.
document.title = branding.shopName || branding.appName || "MediPOS";

export async function loadBranding() {
  try {
    const snap = await getDoc(doc(db, "branding", "public"));
    if (snap.exists()) {
      Object.assign(branding, snap.data());
      const { shopName, appName, logoUrl, brandColor, loadingStyle, loadingMessage } = branding;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ shopName, appName, logoUrl, brandColor, loadingStyle, loadingMessage }));
      } catch {
        /* the logo may be too large to cache: the name still works */
      }
    }
  } catch (err) {
    console.warn("Branding unavailable:", err.message);
  }
  // The shop name from Settings is the name shown everywhere.
  if (branding.shopName) branding.appName = branding.shopName;
  document.title = branding.appName || "MediPOS";
  applyBrandIcons();
  return branding;
}

/** The logo image, or the default icon tile when no logo has been uploaded. */
applyBrandIcons();

export const logoHtml = (fallbackIcon, cls = "brand-mark big") =>
  branding.logoUrl
    ? `<img class="brand-logo" src="${branding.logoUrl}" alt="${esc(branding.appName)} logo" />`
    : `<div class="${cls}">${fallbackIcon}</div>`;

/**
 * The saved logo is the browser tab icon, the phone home-screen icon and the installed app icon.
 * Without a logo the default icon stays.
 */
export function applyBrandIcons() {
  const head = document.head;
  const setLink = (rel, href, type) => {
    let link = head.querySelector(`link[rel="${rel}"]`);
    if (!link) {
      link = document.createElement("link");
      link.rel = rel;
      head.appendChild(link);
    }
    link.href = href;
    if (type) link.type = type;
  };
  const setMeta = (name, content) => {
    let m = head.querySelector(`meta[name="${name}"]`);
    if (!m) {
      m = document.createElement("meta");
      m.name = name;
      head.appendChild(m);
    }
    m.content = content;
  };
  if (branding.logoUrl) {
    const type = branding.logoUrl.match(/^data:([^;,]+)/)?.[1] || "image/png";
    setLink("icon", branding.logoUrl, type);
    setLink("apple-touch-icon", "/api/logo");
  }
  setMeta("apple-mobile-web-app-title", branding.appName || "MediPOS");
  setMeta("application-name", branding.appName || "MediPOS");
}
