import { APP_VERSION, APP_NAME } from "./config.js";
import { branding, logoHtml } from "./branding.js";
import { icon, esc } from "./core.js";

/** Loading screen styles an administrator chooses in Branding & email. */
export const LOADING_STYLES = {
  orbit: { name: "Orbit", desc: "A ring turns around the logo, with a glowing dot." },
  pulse: { name: "Pulse", desc: "The logo breathes inside a soft ring." },
  ripple: { name: "Ripple", desc: "Rings spread out from the logo, like a sound wave." },
  flip: { name: "Flip", desc: "The logo turns in 3D, like a coin." },
  wave: { name: "Wave", desc: "Bars rise and fall in rhythm under the logo." },
  dots: { name: "Dots", desc: "Three dots bounce under the logo." },
  aurora: { name: "Aurora", desc: "A slow colour glow moves behind the logo." },
  bar: { name: "Progress", desc: "A bright bar slides under the logo." },
};
export const normalizeStyle = (s) => (LOADING_STYLES[s] ? s : "orbit");

/** The loading screen: the logo in a round badge, with the chosen animation around it. */
export function splashHtml(message, style) {
  const name = branding.shopName || APP_NAME;
  const msg = message || branding.loadingMessage || "Loading…";
  const s = normalizeStyle(style || branding.loadingStyle);
  return `
    <section class="splash style-${s}" role="status" aria-live="polite">
      <div class="splash-bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span></div>
      <span class="sparkle s1" aria-hidden="true"></span><span class="sparkle s2" aria-hidden="true"></span><span class="sparkle s3" aria-hidden="true"></span><span class="sparkle s4" aria-hidden="true"></span>
      <div class="splash-core">
        <div class="round-stage" aria-hidden="true">
          <span class="ripple"></span><span class="ripple r2"></span><span class="ripple r3"></span>
          <div class="round-ring"></div>
          <div class="round-orbit"><span class="round-dot"></span></div>
          <div class="round-logo">${logoHtml(icon("pos"), "brand-mark big")}</div>
        </div>
        <div class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="dots3" aria-hidden="true"><i></i><i></i><i></i></div>
        <h1 class="splash-name">${esc(name)}</h1>
        <p class="splash-sub">POS &amp; Accounts</p>
        <p class="splash-msg" id="splash-msg">${esc(msg)}</p>
        <div class="splash-bar" aria-hidden="true"><i></i></div>
      </div>
      <p class="splash-ver ver-stack"><span class="ver-by">Designed by Avy</span><span class="ver-num">Version ${esc(APP_VERSION)}</span></p>
    </section>`;
}

/** Full-screen loader used at start-up. */
export function showSplash(root, message) {
  document.body.dataset.state = "boot";
  const existing = root.querySelector(".splash");
  // Same style already on screen: only the message changes, so the animation does not restart.
  if (existing && existing.classList.contains(`style-${normalizeStyle(branding.loadingStyle)}`)) {
    const msg = existing.querySelector(".splash-msg");
    if (msg && message) msg.textContent = message;
    return;
  }
  root.innerHTML = splashHtml(message);
}

/** Full-screen loader shown while another screen is opening. Returns a handle for hideRouteLoader. */
export function showRouteLoader(message, style) {
  // Only one page loader is ever on screen: a new one replaces any that is still showing.
  document.querySelectorAll(".route-loader").forEach((w) => w.remove());
  const wrap = document.createElement("div");
  wrap.className = "route-loader";
  wrap.innerHTML = splashHtml(message, style);
  document.body.appendChild(wrap);
  return { wrap, started: performance.now() };
}

/** Removes the loader. It stays on screen at least 0.7 s, so it is always seen and fully faded in. */
export async function hideRouteLoader(loader, minMs = 700) {
  if (!loader) return;
  const wait = minMs - (performance.now() - loader.started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  loader.wrap.remove();
}
