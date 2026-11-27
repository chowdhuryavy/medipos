// Tells people when a newer release is live, so they can reload at a time that suits them.
import { VERSION } from "./version.js";
import { esc } from "./core.js";

const CHECK_EVERY = 10 * 60 * 1000;

async function liveVersion() {
  const res = await fetch(`/js/version.js?check=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return "";
  return (((await res.text()).match(/VERSION = "([^"]+)"/)) || [])[1] || "";
}

function showBanner(latest) {
  let bar = document.getElementById("update-banner");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "update-banner";
    bar.className = "update-banner";
    bar.setAttribute("role", "status");
    document.body.appendChild(bar);
  }
  bar.innerHTML = `
    <div class="ub-text"><strong>New version ${esc(latest)} is ready</strong><small>You are on ${esc(VERSION)}. Save your work, then reload.</small></div>
    <button type="button" class="btn primary sm" id="ub-reload">Reload</button>`;
  bar.querySelector("#ub-reload").addEventListener("click", () => location.reload());
}

/** Checks now and then every 10 minutes, and whenever the person comes back to the app. */
export function checkForUpdate() {
  return liveVersion().then((latest) => {
    if (latest && latest !== VERSION) showBanner(latest);
  }).catch(() => { /* offline: the next check will try again */ });
}

export function startUpdateWatch() {
  checkForUpdate();
  setInterval(checkForUpdate, CHECK_EVERY);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });
}
