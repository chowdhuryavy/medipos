// Signs the person out after a set time with no activity. The time comes from Settings (sessionTimeoutMinutes); 0 turns it off.
import { auth, signOut } from "./firebase.js";
import { settings } from "./core.js";

const EVENTS = ["pointerdown", "keydown", "touchstart", "wheel", "scroll"];
let timer = null;
let last = Date.now();
const bump = () => { last = Date.now(); };

export function stopIdleLogout() {
  if (timer) clearInterval(timer);
  timer = null;
  EVENTS.forEach((ev) => window.removeEventListener(ev, bump, true));
}

/** Starts the timer for the signed-in person. onSignedOut(message) is called before the sign-out takes effect. */
export function startIdleLogout(onSignedOut) {
  stopIdleLogout();
  const minutes = Math.round(Number(settings.sessionTimeoutMinutes) || 0);
  if (minutes < 1) return;
  const limit = minutes * 60_000;
  last = Date.now();
  EVENTS.forEach((ev) => window.addEventListener(ev, bump, { capture: true, passive: true }));
  // Checked every 15 seconds against the clock, so it still works when the browser slows timers in the background.
  timer = setInterval(() => {
    if (Date.now() - last < limit) return;
    stopIdleLogout();
    onSignedOut(`You were signed out after ${minutes} minute${minutes === 1 ? "" : "s"} without activity.`);
    signOut(auth);
  }, 15_000);
}
