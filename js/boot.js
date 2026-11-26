// Starts the app. Kept in its own file because the page security policy blocks inline scripts.
const splashMsg = () => document.getElementById("splash-msg");
const stillBooting = () => document.body.dataset.state === "boot";

function showBootError(err) {
  const m = splashMsg();
  const text = err && err.message ? err.message : String(err);
  if (m && stillBooting()) m.textContent = "Startup error: " + text;
  const n = document.querySelector(".splash-name");
  if (n && stillBooting()) n.textContent = "Could not start";
  console.error(err);
}

// Errors that happen before or outside the app code.
window.addEventListener("error", (e) => showBootError(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => showBootError(e.reason));

// If nothing has started after 12 seconds, say so.
setTimeout(() => {
  const m = splashMsg();
  if (stillBooting() && m) m.textContent = "This is taking longer than usual. Check your internet, then close and reopen the page.";
}, 12000);

// Load the app. A failure to load it shows its real message on this screen.
import("./app.js").catch(showBootError);
