// New releases. Admins see when a newer build is live and push it to everyone.
// Staff see the reload prompt only after an admin has pushed it (settings/release).
import { VERSION } from "./version.js";
import { esc, session, toast } from "./core.js";
import { db, doc, onSnapshot, setDoc, serverTimestamp } from "./firebase.js";

const CHECK_EVERY = 10 * 60 * 1000;
let latest = "";   // newest build live on the server (admins only check)
let pushed = "";   // version an admin has pushed to everyone
let unsubRelease = null;
let timersOn = false;

async function liveVersion() {
  const res = await fetch(`/js/version.js?check=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return "";
  return (((await res.text()).match(/VERSION = "([^"]+)"/)) || [])[1] || "";
}

function bar() {
  let el = document.getElementById("update-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "update-banner";
    el.className = "update-banner";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  return el;
}

function hideBanner() {
  document.getElementById("update-banner")?.remove();
}

function reloadButton(el) {
  el.querySelector("#ub-reload").addEventListener("click", () => location.reload());
}

async function pushToEveryone(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await setDoc(doc(db, "settings", "release"), { version: latest, pushedAt: serverTimestamp(), pushedBy: session.uid });
    toast("Pushed. Everyone will see the reload prompt.", "success");
  } catch (err) {
    toast(err.message, "error");
    btn.disabled = false;
  }
}

function paint() {
  if (session.role === "admin") {
    if (!latest || latest === VERSION) return hideBanner();
    const sent = pushed === latest;
    const el = bar();
    el.innerHTML = `
      <div class="ub-text"><strong>New version ${esc(latest)} is ready</strong><small>${sent ? "Everyone has been asked to reload." : `You are on ${esc(VERSION)}. Push it to everyone when you are ready.`}</small></div>
      <div class="ub-actions">
        ${sent ? "" : `<button type="button" class="btn primary sm" id="ub-push">Push to everyone</button>`}
        <button type="button" class="btn ghost sm" id="ub-reload">Reload</button>
      </div>`;
    reloadButton(el);
    el.querySelector("#ub-push")?.addEventListener("click", pushToEveryone);
    return;
  }
  // Staff: only what an admin has pushed.
  if (!pushed || pushed === VERSION) return hideBanner();
  const el = bar();
  el.innerHTML = `
    <div class="ub-text"><strong>New version ${esc(pushed)} is ready</strong><small>You are on ${esc(VERSION)}. Save your work, then reload.</small></div>
    <div class="ub-actions"><button type="button" class="btn primary sm" id="ub-reload">Reload</button></div>`;
  reloadButton(el);
}

/** Admins only: checks the server now. Other people get nothing from this check. */
export function checkForUpdate() {
  if (session.role !== "admin") return Promise.resolve();
  return liveVersion().then((v) => { latest = v; paint(); }).catch(() => { /* offline: the next check will try again */ });
}

/** Called after sign-in. Listens for pushes, and (for admins) checks for new builds. */
export function startUpdateWatch() {
  unsubRelease?.();
  unsubRelease = onSnapshot(doc(db, "settings", "release"), (snap) => {
    pushed = snap.exists() ? snap.data().version || "" : "";
    paint();
  }, (err) => console.warn("Update notice unavailable:", err.message));
  checkForUpdate();
  if (!timersOn) {
    timersOn = true;
    setInterval(checkForUpdate, CHECK_EVERY);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });
  }
}

/** Called on sign-out: removes the banner and stops listening. */
export function stopUpdateWatch() {
  unsubRelease?.();
  unsubRelease = null;
  latest = "";
  pushed = "";
  hideBanner();
}
