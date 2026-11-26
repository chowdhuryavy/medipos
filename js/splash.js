import { APP_VERSION, APP_NAME } from "./config.js";
import { branding, logoHtml } from "./branding.js";
import { icon, esc } from "./core.js";

/** Loading screen: animated backdrop, orbiting rings around the logo, progress bar and status text. */
export function splashHtml(message = "Loading…") {
  const name = branding.appName || APP_NAME;
  return `
    <section class="splash" role="status" aria-live="polite">
      <div class="splash-bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span></div>
      <div class="splash-core">
        <div class="splash-logo"><div class="splash-orbit" aria-hidden="true"><span class="ring r1"></span><span class="ring r2"></span><span class="arm a1"><span class="dot d1"></span></span><span class="arm a2"><span class="dot d2"></span></span></div>${logoHtml(icon("pos"), "brand-mark big")}</div>
        <h1 class="splash-name">${esc(name)}</h1>
        <p class="splash-msg" id="splash-msg">${esc(message)}</p>
        <div class="splash-bar" aria-hidden="true"><i></i></div>
      </div>
      <p class="splash-ver">Version ${esc(APP_VERSION)}</p>
    </section>`;
}

export function showSplash(root, message) {
  document.body.dataset.state = "boot";
  root.innerHTML = splashHtml(message);
}
