import { APP_VERSION, APP_NAME } from "./config.js";
import { branding, logoHtml } from "./branding.js";
import { icon, esc } from "./core.js";

/** Loading screen styles an administrator can choose in Branding. */
export const LOADING_STYLES = { orbit: "Orbit (rotating ring)", pulse: "Pulse (breathing ring)", bar: "Progress bar" };

/** The loading screen: the logo in a round badge, with the chosen animation around it. */
export function splashHtml(message, style) {
  const name = branding.shopName || APP_NAME;
  const msg = message || branding.loadingMessage || "Loading…";
  const s = LOADING_STYLES[style] ? style : LOADING_STYLES[branding.loadingStyle] ? branding.loadingStyle : "orbit";
  return `
    <section class="splash style-${s}" role="status" aria-live="polite">
      <div class="splash-bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span></div>
      <span class="sparkle s1" aria-hidden="true"></span><span class="sparkle s2" aria-hidden="true"></span><span class="sparkle s3" aria-hidden="true"></span><span class="sparkle s4" aria-hidden="true"></span>
      <div class="splash-core">
        <div class="round-stage" aria-hidden="true">
          <div class="round-ring"></div>
          <div class="round-orbit"><span class="round-dot"></span></div>
          <div class="round-logo">${logoHtml(icon("pos"), "brand-mark big")}</div>
        </div>
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
