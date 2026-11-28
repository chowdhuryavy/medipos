import { APP_VERSION, APP_NAME } from "./config.js";
import { branding, logoHtml } from "./branding.js";
import { icon, esc } from "./core.js";

/** Loading screen styles an administrator chooses in Branding & email. Each one is a medical scene with its own motion. */
export const LOADING_STYLES = {
  orbit: { name: "Capsule", desc: "Two capsules orbit the pharmacy logo." },
  pulse: { name: "Heartbeat", desc: "A heartbeat line draws under the logo tile." },
  ripple: { name: "Ripple", desc: "Rings spread out from the logo." },
  flip: { name: "Pill", desc: "A pill turns in 3D beside the name." },
  wave: { name: "Drip", desc: "A drop falls and ripples, like an IV drip." },
  dots: { name: "Stethoscope", desc: "A stethoscope sways on a glass card." },
  aurora: { name: "Doctor", desc: "A doctor bobs under a colour-shifting name." },
  bar: { name: "Medicine", desc: "A medicine bottle fills as the bar moves." },
  clinic: { name: "Clinic", desc: "A doctor with a stethoscope, a medicine bottle and pills, all moving together." },
  care: { name: "Care Orbit", desc: "A doctor at the centre with a swinging stethoscope; medicines orbit around." },
};
export const normalizeStyle = (s) => (LOADING_STYLES[s] ? s : "orbit");

/** The medicines that orbit the doctor, placed around a circle; each one stays upright as it turns. */
const CARE_ICONS = [
  `<svg viewBox="0 0 36 18" width="30" height="15"><rect width="36" height="18" rx="9" fill="#fff"/><path d="M18 0 H9 A9 9 0 0 0 9 18 H18 Z" fill="#14b8a6"/></svg>`,
  `<svg viewBox="0 0 80 100" width="26" height="32"><rect x="26" y="2" width="28" height="12" rx="3" fill="#0f766e"/><rect x="14" y="14" width="52" height="82" rx="12" fill="#e0f2f1" stroke="#0f766e" stroke-width="4"/><rect x="18" y="40" width="44" height="52" rx="9" fill="#5eead4"/><path d="M40 52 V76 M28 64 H52" stroke="#fff" stroke-width="7" stroke-linecap="round"/></svg>`,
  `<svg viewBox="0 0 40 40" width="28" height="28"><path d="M16 4 H24 V16 H36 V24 H24 V36 H16 V24 H4 V16 H16 Z" fill="#ef4444"/></svg>`,
  `<svg viewBox="0 0 40 40" width="28" height="28"><circle cx="20" cy="20" r="16" fill="#f59e0b"/><path d="M20 4 V36" stroke="#fff" stroke-width="3"/></svg>`,
];
const CARE_RADIUS = 104;
const careItems = CARE_ICONS.map((svg, i) => {
  const r = (i * 90) * Math.PI / 180;
  const x = 130 + CARE_RADIUS * Math.sin(r) - 25;
  const y = 130 - CARE_RADIUS * Math.cos(r) - 25;
  return `<span class="care-item" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px">${svg}</span>`;
}).join("");

const logoDisc = () => `<div class="logo-disc">${logoHtml(icon("pos"), "brand-mark big")}</div>`;

/** The picture for each style. Everything is drawn upright; the name always sits below it. */
const HERO = {
  orbit: () => `<div class="scene hero-orbit">${logoDisc()}
    <span class="cap-track" aria-hidden="true">
      <svg class="cap" viewBox="0 0 36 18"><rect width="36" height="18" rx="9" fill="#fff"/><path d="M18 0 H9 A9 9 0 0 0 9 18 H18 Z" fill="#14b8a6"/></svg>
      <svg class="cap cap2" viewBox="0 0 36 18"><rect width="36" height="18" rx="9" fill="#fff"/><path d="M18 0 H9 A9 9 0 0 0 9 18 H18 Z" fill="#f59e0b"/></svg>
    </span></div>`,
  pulse: () => `<div class="scene hero-pulse"><div class="tile">${logoHtml(icon("pos"), "brand-mark big")}</div>
    <svg class="ecg" viewBox="0 0 240 64" aria-hidden="true"><path d="M0 34 H64 L74 34 L82 12 L92 56 L102 24 L110 34 H240"/></svg></div>`,
  ripple: () => `<div class="scene hero-ripple"><span class="ripple"></span><span class="ripple r2"></span><span class="ripple r3"></span>${logoDisc()}</div>`,
  flip: () => `<div class="scene hero-flip"><svg class="pill3d" viewBox="0 0 120 56" aria-hidden="true"><rect x="2" y="2" width="116" height="52" rx="26" fill="#fff"/><path d="M60 2 H28 A26 26 0 0 0 28 54 H60 Z" fill="#14b8a6"/></svg></div>`,
  wave: () => `<div class="scene hero-drip"><svg class="drop" viewBox="0 0 80 100" aria-hidden="true"><path d="M40 6 C40 6 18 36 18 56 A22 22 0 0 0 62 56 C62 36 40 6 40 6 Z" fill="#5eead4"/></svg><span class="pool" aria-hidden="true"></span></div>`,
  dots: () => `<div class="scene hero-steth"><svg class="steth" viewBox="0 0 80 80" aria-hidden="true">
      <path d="M22 6 V34 A18 18 0 0 0 58 34 V6" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
      <circle cx="22" cy="6" r="4" fill="#fff"/><circle cx="58" cy="6" r="4" fill="#fff"/>
      <path d="M58 34 C58 56 78 56 78 41" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
      <circle cx="78" cy="34" r="7" fill="#5eead4" stroke="#fff" stroke-width="3"/></svg></div>`,
  aurora: () => `<div class="scene hero-doctor"><svg class="doctor" viewBox="0 0 120 130" aria-hidden="true">
      <path d="M18 130 L22 84 Q24 72 40 68 L60 80 L80 68 Q96 72 98 84 L102 130 Z" fill="#fff"/>
      <path d="M60 80 L54 100 L60 130 L66 100 Z" fill="#14b8a6"/>
      <path d="M42 70 Q42 96 60 96 Q78 96 78 70" fill="none" stroke="#334155" stroke-width="3"/>
      <rect x="75" y="84" width="4" height="14" fill="#ef4444"/><rect x="72" y="87" width="10" height="4" fill="#ef4444"/>
      <circle cx="60" cy="40" r="22" fill="#fde4cf"/>
      <path d="M38 36 Q40 14 60 14 Q80 14 82 36 Q74 26 60 26 Q46 26 38 36 Z" fill="#1f2937"/>
      <circle cx="52" cy="40" r="2.5" fill="#1f2937"/><circle cx="68" cy="40" r="2.5" fill="#1f2937"/>
      <path d="M52 50 Q60 56 68 50" fill="none" stroke="#1f2937" stroke-width="2.5" stroke-linecap="round"/></svg></div>`,
  bar: () => `<div class="scene hero-bottle"><svg class="bottle" viewBox="0 0 80 100" aria-hidden="true">
      <rect x="26" y="2" width="28" height="12" rx="3" fill="#0f766e"/>
      <rect x="14" y="14" width="52" height="82" rx="12" fill="rgba(255,255,255,.12)" stroke="#fff" stroke-width="3"/>
      <rect class="liquid" x="18" y="40" width="44" height="52" rx="9" fill="#5eead4"/>
      <rect x="24" y="52" width="32" height="24" rx="4" fill="#fff"/>
      <path d="M40 56 V72 M32 64 H48" stroke="#0f766e" stroke-width="4" stroke-linecap="round"/></svg></div>`,
  clinic: () => `<div class="scene scene-clinic" aria-hidden="true">
      <div class="cl-logo">${logoHtml(icon("pos"), "brand-mark")}</div>
      <svg class="cl-doc" viewBox="0 0 120 130"><path d="M18 130 L22 84 Q24 72 40 68 L60 80 L80 68 Q96 72 98 84 L102 130 Z" fill="#fff"/><path d="M60 80 L54 100 L60 130 L66 100 Z" fill="#14b8a6"/><circle cx="60" cy="40" r="22" fill="#fde4cf"/><path d="M38 36 Q40 14 60 14 Q80 14 82 36 Q74 26 60 26 Q46 26 38 36 Z" fill="#1f2937"/><circle cx="52" cy="40" r="2.5" fill="#1f2937"/><circle cx="68" cy="40" r="2.5" fill="#1f2937"/><path d="M52 50 Q60 56 68 50" fill="none" stroke="#1f2937" stroke-width="2.5" stroke-linecap="round"/></svg>
      <svg class="cl-steth" viewBox="0 0 80 80"><path d="M22 6 V34 A18 18 0 0 0 58 34 V6" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><circle cx="22" cy="6" r="4" fill="#fff"/><circle cx="58" cy="6" r="4" fill="#fff"/><path d="M58 34 C58 56 78 56 78 41" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><circle cx="78" cy="34" r="7" fill="#5eead4" stroke="#fff" stroke-width="3"/></svg>
      <div class="cl-bottle"><svg viewBox="0 0 80 100"><rect x="26" y="2" width="28" height="12" rx="3" fill="#0f766e"/><rect x="14" y="14" width="52" height="82" rx="12" fill="rgba(255,255,255,.12)" stroke="#fff" stroke-width="3"/><rect class="liquid" x="18" y="40" width="44" height="52" rx="9" fill="#5eead4"/><rect x="24" y="52" width="32" height="24" rx="4" fill="#fff"/><path d="M40 56 V72 M32 64 H48" stroke="#0f766e" stroke-width="4" stroke-linecap="round"/></svg></div>
      <svg class="cl-pill p1" viewBox="0 0 36 18"><rect width="36" height="18" rx="9" fill="#fff"/><path d="M18 0 H9 A9 9 0 0 0 9 18 H18 Z" fill="#14b8a6"/></svg>
      <svg class="cl-pill p2" viewBox="0 0 36 18"><rect width="36" height="18" rx="9" fill="#fff"/><path d="M18 0 H9 A9 9 0 0 0 9 18 H18 Z" fill="#f59e0b"/></svg>
      <svg class="cl-ecg" viewBox="0 0 300 30"><path d="M0 15 H90 L100 15 L108 3 L118 27 L128 9 L136 15 H300"/></svg>
    </div>`,
  care: () => `<div class="scene scene-care" aria-hidden="true">
      <span class="care-pulse"></span><span class="care-pulse p2"></span>
      <div class="care-orbit">${careItems}</div>
      <div class="care-core">
        <svg class="care-doc" viewBox="0 0 120 130" aria-hidden="true"><path d="M18 130 L22 84 Q24 72 40 68 L60 80 L80 68 Q96 72 98 84 L102 130 Z" fill="#fff"/><path d="M60 80 L54 100 L60 130 L66 100 Z" fill="#14b8a6"/><circle cx="60" cy="40" r="22" fill="#fde4cf"/><path d="M38 36 Q40 14 60 14 Q80 14 82 36 Q74 26 60 26 Q46 26 38 36 Z" fill="#1f2937"/><circle cx="52" cy="40" r="2.5" fill="#1f2937"/><circle cx="68" cy="40" r="2.5" fill="#1f2937"/><path d="M52 50 Q60 56 68 50" fill="none" stroke="#1f2937" stroke-width="2.5" stroke-linecap="round"/><rect x="75" y="84" width="4" height="14" fill="#ef4444"/><rect x="72" y="87" width="10" height="4" fill="#ef4444"/></svg>
        <svg class="care-steth" viewBox="0 0 80 80" aria-hidden="true"><path d="M22 6 V34 A18 18 0 0 0 58 34 V6" fill="none" stroke="#334155" stroke-width="4" stroke-linecap="round"/><circle cx="22" cy="6" r="4" fill="#334155"/><circle cx="58" cy="6" r="4" fill="#334155"/><path d="M58 34 C58 56 78 56 78 41" fill="none" stroke="#334155" stroke-width="4" stroke-linecap="round"/><circle cx="78" cy="34" r="7" fill="#14b8a6" stroke="#334155" stroke-width="3"/></svg>
      </div>
    </div>`,
};

/** The loading screen: a medical scene for the chosen style, with the shop name below it. */
export function splashHtml(message, style) {
  const name = branding.shopName || APP_NAME;
  const msg = message || branding.loadingMessage || "Loading…";
  const s = normalizeStyle(style || branding.loadingStyle);
  const extra = s === "dots" ? `<div class="dots3" aria-hidden="true"><i></i><i></i><i></i></div>`
    : s === "bar" ? `<div class="splash-bar" aria-hidden="true"><i></i></div>` : "";
  return `
    <section class="splash style-${s}" role="status" aria-live="polite">
      <div class="splash-bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span></div>
      <span class="sparkle s1" aria-hidden="true"></span><span class="sparkle s2" aria-hidden="true"></span><span class="sparkle s3" aria-hidden="true"></span><span class="sparkle s4" aria-hidden="true"></span>
      <div class="splash-core">
        ${HERO[s]()}
        <div class="splash-text">
          <h1 class="splash-name">${esc(name)}</h1>
          <p class="splash-sub">POS &amp; Accounts</p>
          <p class="splash-msg" id="splash-msg">${esc(msg)}</p>
        </div>
        ${extra}
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
