// Keeps the sign-in across tabs, but signs the person out once the browser has been closed.
// Sign-in is stored for the browser (so a new tab opens already signed in). Each open page counts itself in
// localStorage; when the count is zero and this tab is new, no MediPOS page was open, so the browser was closed.
import { auth, onAuthStateChanged, signOut } from "./firebase.js";

const COUNT_KEY = "medipos.openPages";
const TAB_KEY = "medipos.pageLive";

// A tab that already had this flag is the same tab after a reload or a link to another page of the app.
const sameTab = (() => { try { return sessionStorage.getItem(TAB_KEY) === "1"; } catch { return false; } })();
const openBefore = Number(localStorage.getItem(COUNT_KEY) || 0);
const browserWasClosed = !sameTab && openBefore === 0;

localStorage.setItem(COUNT_KEY, String(openBefore + 1));
try { sessionStorage.setItem(TAB_KEY, "1"); } catch { /* storage unavailable: treated as a new tab each time */ }

window.addEventListener("pagehide", () => {
  const n = Math.max(0, Number(localStorage.getItem(COUNT_KEY) || 1) - 1);
  localStorage.setItem(COUNT_KEY, String(n));
});

onAuthStateChanged(auth, (user) => {
  if (user && browserWasClosed) signOut(auth);
});
