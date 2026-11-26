import { APP_VERSION, APP_NAME } from "./config.js";
import { branding, logoHtml } from "./branding.js";
import { icon, esc } from "./core.js";

// Animations an administrator can choose for the loading screen (Settings → Branding).
export const LOADING_STYLES = [
  ["orbit", "Orbit: rings spin around the logo"],
  ["ripple", "Ripple: rings expand from the logo"],
  ["wave", "Wave: bars rise and fall"],
  ["dots", "Dots: three dots bounce"],
];
export const loadingStyle = (k = branding.loadingStyle) => (LOADING_STYLES.some(([v]) => v === k) ? k : "orbit");

/** Loading screen: animated backdrop, the chosen animation, progress bar and status text. */
export function splashHtml(message, style = loadingStyle()) {
  const name = branding.shopName || APP_NAME;
  const msg = message || branding.loadingMessage || "Loading…";
  return `
    <section class="splash style-${style}" role="status" aria-live="polite">
      <div class="splash-bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span></div>
      <span class="sparkle s1" aria-hidden="true"></span><span class="sparkle s2" aria-hidden="true"></span><span class="sparkle s3" aria-hidden="true"></span><span class="sparkle s4" aria-hidden="true"></span>
      <div class="splash-core">
        <div class="splash-logo">
          <div class="anim anim-orbit" aria-hidden="true"><span class="ring r1"></span><span class="ring r2"></span><span class="arm a1"><span class="dot d1"></span></span><span class="arm a2"><span class="dot d2"></span></span></div>
          <div class="anim anim-ripple" aria-hidden="true"><i></i><i></i><i></i></div>
          ${logoHtml(icon("pos"), "brand-mark big")}
        </div>
        <div class="anim anim-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="anim anim-dots" aria-hidden="true"><i></i><i></i><i></i></div>
        <h1 class="splash-name">${esc(name)}</h1>
        <p class="splash-sub">POS &amp; Accounts</p>
        <p class="splash-msg" id="splash-msg">${esc(msg)}</p>
        <div class="splash-bar" aria-hidden="true"><i></i></div>
      </div>
      <p class="splash-ver">Version ${esc(APP_VERSION)}</p>
    </section>`;
}

/** Full-screen loader used at start-up. */
export function showSplash(root, message) {
  document.body.dataset.state = "boot";
  root.innerHTML = splashHtml(message);
}

/** Full-screen loader shown while another screen is opening. Returns a handle for hideRouteLoader. */
export function showRouteLoader(message, style) {
  const wrap = document.createElement("div");
  wrap.className = "route-loader";
  wrap.innerHTML = splashHtml(message, style);
  document.body.appendChild(wrap);
  return { wrap, started: performance.now() };
}

/** Removes the loader, keeping it on screen long enough to be seen (no flicker on fast screens). */
export async function hideRouteLoader(loader, minMs = 450) {
  if (!loader) return;
  const wait = minMs - (performance.now() - loader.started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  loader.wrap.remove();
}
