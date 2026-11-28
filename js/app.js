import { effectivePages, onSubmit, onAction, withBusy, reloadKeepingPage, takeReturnPage } from "./core.js";
import { initLang, getLang, setLang } from "./i18n.js";
import { auth, db, onAuthStateChanged, signInWithEmailAndPassword, signOut, updatePassword, reauthenticateWithCredential, EmailAuthProvider, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "./firebase.js";
import { loadBranding, branding, logoHtml } from "./branding.js";
import { passwordFields } from "./password-ui.js";
import { post } from "./api.js";
import { showSplash, showRouteLoader, hideRouteLoader } from "./splash.js";
import { startUpdateWatch } from "./updates.js";
import { firebaseConfig, APP_NAME, APP_VERSION } from "./config.js";
import { startIdleLogout, stopIdleLogout } from "./idle.js";
import { session, roles, settings, icon, esc, can, loadSettings, DEFAULT_ROLES, openModal, toast, confirmBox, alertBox, withTimeout } from "./core.js";
import { startNotifications, toggleNotifications, runStockChecks } from "./notifications.js";
import "./scanner.js";

// Email + password only. No third-party (Google) sign-in is offered anywhere.

const PAGES = {
  dashboard: "Dashboard",
  pos: "Sell",
  shift: "Cash shift",
  import: "Import products",
  activity: "Staff activity",
  prescriptions: "Prescriptions",
  inventory: "Inventory",
  purchasing: "Purchasing",
  partners: "Customers",
  accounting: "Accounting",
  reports: "Reports",
  returns: "Returns",
  admin: "Admin",
};
const PAGE_TITLE = { ...PAGES, pos: "Point of Sale", partners: "Customers & Suppliers", admin: "Administration" };
const PAGE_ICON = {
  dashboard: "dashboard", pos: "cart", inventory: "inventory", purchasing: "purchase",
  partners: "partners", accounting: "accounting", reports: "reports", returns: "cart", admin: "admin",
  shift: "accounting", import: "inventory", prescriptions: "reports", activity: "partners",
};
const MOBILE_MAX_TABS = 4;

const root = document.getElementById("app");
initLang(root);
let pendingMessage = "";
let routeToken = 0;
let clockTimer = null;

const isConfigured = () => !String(firebaseConfig.apiKey).startsWith("YOUR_");
const setState = (s) => { document.body.dataset.state = s; };

/* ───────── theme ───────── */

function restoreTheme() {
  let theme = "light";
  try {
    theme = localStorage.getItem("medipos-theme")
      || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch { /* storage blocked: keep default */ }
  document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("medipos-theme", next); } catch { /* ignore */ }
  const btn = document.getElementById("theme-btn");
  if (btn) btn.innerHTML = icon(next === "dark" ? "sun" : "moon");
}

/* ───────── screens ───────── */

function showSetup() {
  setState("setup");
  root.innerHTML = `
    <section class="login-screen">
      <div class="login-card">
        <div class="brand-mark">${icon("admin")}</div>
        <h1>Setup required</h1>
        <p class="muted">Open <code>js/config.js</code>, paste your Firebase web-app config, then reload. README.md lists every step.</p>
      </div>
    </section>`;
}

// Counts a wrong password on the server. After 5, the account is locked until an administrator unlocks it.
async function countWrongPassword(email) {
  try {
    const out = await post("/api/auth/login-lock", { action: "failed", email });
    if (out.locked) return "This account is locked after too many wrong passwords. Ask an administrator to unlock it.";
  } catch { /* offline: show the normal message */ }
  return "Wrong email or password.";
}

function friendlyError(err) {
  const map = {
    "auth/invalid-credential": "Wrong email or password.",
    "auth/user-not-found": "Wrong email or password.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
    "auth/network-request-failed": "No connection. Check your internet and try again.",
    "auth/user-disabled": "This account has been disabled. Contact the administrator.",
  };
  return map[err?.code] || err?.message || "Sign-in failed.";
}

// Desktop side picture on the sign-in screen. Inline SVG, so no image file and no change to the Content-Security-Policy.
const LOGIN_SIDE = `
  <aside class="login-side" aria-hidden="true">
    <svg viewBox="0 0 480 400" xmlns="http://www.w3.org/2000/svg">
      <rect x="20" y="20" width="440" height="360" rx="36" fill="#ffffff" fill-opacity=".14" stroke="#ffffff" stroke-opacity=".3"/>
      <circle cx="404" cy="92" r="11" fill="#f59e0b"><animate attributeName="r" values="11;15;11" dur="2.2s" repeatCount="indefinite"/></circle>
      <circle cx="72" cy="112" r="7" fill="#a7f3d0"><animate attributeName="opacity" values="1;.25;1" dur="1.8s" repeatCount="indefinite"/></circle>
      <circle cx="444" cy="172" r="6" fill="#5eead4"><animate attributeName="opacity" values=".3;1;.3" dur="2.6s" repeatCount="indefinite"/></circle>
      <g transform="translate(240 118)"><animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;0 -12;0 0" dur="3.2s" begin="0s" repeatCount="indefinite"/>
        <path d="M0 -70 L56 -50 V0 C56 40 28 64 0 76 C-28 64 -56 40 -56 0 V-50 Z" fill="#ffffff"/>
        <path d="M-12 -28 H12 V-12 H28 V12 H12 V28 H-12 V12 H-28 V-12 H-12 Z" fill="#0f766e"/>
      </g>
      <rect x="60" y="290" width="360" height="12" rx="6" fill="#ffffff" fill-opacity=".4"/>
      <g>
        <animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;0 -5;0 0" dur="2.4s" repeatCount="indefinite"/>
        <path d="M332 290 L336 212 Q340 196 356 192 L372 202 L388 192 Q404 196 408 212 L412 290 Z" fill="#ffffff"/>
        <path d="M372 202 L366 224 L372 290 L378 224 Z" fill="#14b8a6"/>
        <path d="M355 198 Q355 226 372 226 Q389 226 389 198" fill="none" stroke="#334155" stroke-width="3"/>
        <rect x="398" y="226" width="4" height="14" fill="#ef4444"/><rect x="395" y="229" width="10" height="4" fill="#ef4444"/>
        <circle cx="372" cy="168" r="20" fill="#fde4cf"/>
        <path d="M352 164 Q354 146 372 146 Q390 146 392 164 Q384 156 372 156 Q360 156 352 164 Z" fill="#1f2937"/>
        <circle cx="365" cy="170" r="2.2" fill="#1f2937"/><circle cx="379" cy="170" r="2.2" fill="#1f2937"/>
        <path d="M365 178 Q372 183 379 178" fill="none" stroke="#1f2937" stroke-width="2" stroke-linecap="round"/>
      </g>
      
      <rect x="90" y="222" width="54" height="68" rx="10" fill="#f8fafc"><animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;0 -8;0 0" dur="2.6s" begin="0s" repeatCount="indefinite"/></rect>
      <rect x="90" y="202" width="54" height="24" rx="6" fill="#f59e0b"><animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;0 -8;0 0" dur="2.6s" begin="0s" repeatCount="indefinite"/></rect>
      <rect x="100" y="242" width="34" height="22" rx="4" fill="#5eead4"><animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;0 -8;0 0" dur="2.6s" begin="0s" repeatCount="indefinite"/></rect>
      <rect x="160" y="192" width="60" height="98" rx="12" fill="#f8fafc"><animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;0 -8;0 0" dur="2.6s" begin="0.4s" repeatCount="indefinite"/></rect>
      <rect x="160" y="170" width="60" height="28" rx="8" fill="#0f766e"><animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;0 -8;0 0" dur="2.6s" begin="0.4s" repeatCount="indefinite"/></rect>
      <rect x="172" y="236" width="36" height="28" rx="6" fill="#a7f3d0"><animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;0 -8;0 0" dur="2.6s" begin="0.4s" repeatCount="indefinite"/></rect>
      <rect x="240" y="236" width="48" height="52" rx="10" fill="#f8fafc"><animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;0 -8;0 0" dur="2.6s" begin="0.8s" repeatCount="indefinite"/></rect>
      <rect x="240" y="218" width="48" height="22" rx="6" fill="#f59e0b"><animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;0 -8;0 0" dur="2.6s" begin="0.8s" repeatCount="indefinite"/></rect>
      <g transform="translate(330 186) rotate(-30)"><animateTransform attributeName="transform" type="rotate" additive="sum" values="0;35;0" dur="2.4s" repeatCount="indefinite"/>
        <rect x="-34" y="-14" width="68" height="28" rx="14" fill="#5eead4"/>
        <path d="M0 -14 H20 A14 14 0 0 1 20 14 H0 Z" fill="#f8fafc"/>
      </g>
    </svg>
    <p class="login-eyebrow">Pharmacy point of sale</p>
    <h2>Sell, stock and accounts in one place.</h2>
    <p>Fast sales, clear stock and books you can trust.</p>
    <ul class="login-chips"><li>Sales</li><li>Stock</li><li>Accounts</li><li>Reports</li></ul>
    <div class="login-status"><span class="status-dot"></span>Secure staff sign-in</div>
  </aside>`;

function showLogin(message = "", tone = "error") {
  setState("login");
  root.innerHTML = `
    <section class="login-screen has-side">
      <div class="login-art" aria-hidden="true"><span class="orb o1"></span><span class="orb o2"></span><span class="orb o3"></span></div>
      ${LOGIN_SIDE}
      <div class="login-card">
        ${logoHtml(icon("pos"))}
        <h1>${esc(branding.appName || APP_NAME)}</h1>
        <p class="muted">Staff sign-in</p>
        ${message ? `<div class="alert ${tone === "ok" ? "ok" : ""}" role="alert">${esc(message)}</div>` : ""}
        <form id="login-form" novalidate class="login-form">
          <label class="field"><span class="field-label">Email</span>
            <span class="input-wrap">${icon("mail")}<input type="email" name="email" inputmode="email" autocomplete="username" placeholder="Email" required /></span></label>
          <label class="field"><span class="field-label">Password</span>
            <span class="input-wrap">${icon("lock")}<input type="password" name="password" autocomplete="current-password" placeholder="Password" required />
              <button type="button" class="eye" id="eye-login" aria-label="Show password">${icon("eye")}</button></span></label>
          <button class="btn primary block xl" type="submit" id="login-btn">${icon("key")}<span>Sign in</span></button>
        </form>
        <button class="link-btn" type="button" id="forgot-btn">Forgot password?</button>
        <p class="version ver-stack"><span class="ver-by">Designed by Avy</span><span class="ver-num">Version ${esc(APP_VERSION)}</span></p>
        <p class="login-rights">© ${new Date().getFullYear()} Perfection. All rights reserved.</p>
      </div>
    </section>`;

  const form = document.getElementById("login-form");
  document.getElementById("eye-login").addEventListener("click", (e) => {
    const input = form.password;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    e.currentTarget.innerHTML = icon(show ? "eyeOff" : "eye");
    e.currentTarget.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
  document.getElementById("forgot-btn").addEventListener("click", () => openForgotPassword(form.email.value.trim()));

  onSubmit(form, async (e) => {
    e.preventDefault();
    const email = String(form.email.value || "").trim();
    const password = String(form.password.value || "");
    if (!email || !password) return showLogin("Enter your email and password.");
    const btn = document.getElementById("login-btn");
    btn.disabled = true;
    btn.classList.add("loading");
    btn.querySelector("span").textContent = "Signing in…";
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      const wrong = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(err?.code);
      showLogin(wrong ? await countWrongPassword(email) : friendlyError(err));
    }
  });
}

/* ───────── forgot password: email → 6-digit code → new password ───────── */

function openForgotPassword(prefillEmail = "") {
  openModal("Reset password", `
    <div class="reset">
      <div class="reset-head">
        <div class="reset-icon" aria-hidden="true">${branding.logoUrl ? `<img class="reset-logo" src="${esc(branding.logoUrl)}" alt="" />` : icon("shield")}</div>
        <p class="muted small" id="fp-help">Enter your staff email. If an account exists, we'll send a 6-digit code.</p>
      </div>
      <form id="fp-form" class="stack" novalidate>
        <div id="fp-step1">
          <label class="field"><span class="field-label">Email</span>
            <span class="input-wrap">${icon("mail")}<input type="email" name="email" inputmode="email" autocomplete="username" value="${esc(prefillEmail)}" placeholder="Email" required /></span></label>
        </div>
        <div id="fp-step2" hidden class="stack">
          <label class="field"><span class="field-label">6-digit code</span>
            <span class="input-wrap">${icon("key")}<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="6-digit code" required /></span></label>
        </div>
        <div id="fp-step3" hidden class="stack">
          <div id="fp-pw"></div>
        </div>
        <button class="btn primary block xl" type="submit" id="fp-submit"><span>Send code</span></button>
        <button class="link-btn" type="button" id="fp-resend" hidden>Resend code</button>
      </form>
    </div>`, (body, close) => {
    const form = body.querySelector("#fp-form");
    const step1 = body.querySelector("#fp-step1");
    const step2 = body.querySelector("#fp-step2");
    const submit = body.querySelector("#fp-submit");
    const help = body.querySelector("#fp-help");
    const resend = body.querySelector("#fp-resend");
    const step3 = body.querySelector("#fp-step3");
    let pw = null;
    let stage = 1;
    let cooldownTimer = null;

    const busy = (on, text) => {
      submit.disabled = on;
      submit.classList.toggle("loading", on);
      if (text) submit.querySelector("span").textContent = text;
    };
    const setStep = (n) => body.querySelectorAll(".step").forEach((el) => el.classList.toggle("on", Number(el.dataset.step) <= n));

    const startCooldown = () => {
      let left = 60;
      resend.hidden = false;
      resend.disabled = true;
      resend.textContent = `Resend code in ${left}s`;
      clearInterval(cooldownTimer);
      cooldownTimer = setInterval(() => {
        left -= 1;
        resend.textContent = left > 0 ? `Resend code in ${left}s` : "Resend code";
        if (left <= 0) { resend.disabled = false; clearInterval(cooldownTimer); }
      }, 1000);
    };

    // Three screens in order: email, then the code, then the new password with its confirmation.
    // The code is checked by the server when the password is reset (the OTP logic itself is unchanged).
    onSubmit(form, async (e) => {
      e.preventDefault();
      try {
        if (stage === 1) {
          const email = form.email.value.trim();
          if (!email) throw new Error("Enter your email.");
          busy(true, "Sending…");
          await post("/api/otp/request", { email });
          stage = 2;
          setStep(2);
          help.textContent = "Enter the 6-digit code we emailed you.";
          step1.hidden = true;
          step2.hidden = false;
          busy(false, "Continue");
          startCooldown();
          form.code.focus();
        } else if (stage === 2) {
          if (!/^\d{6}$/.test(form.code.value.trim())) throw new Error("Enter the 6-digit code.");
          stage = 3;
          setStep(3);
          help.textContent = "Choose a new password and confirm it.";
          step2.hidden = true;
          step3.hidden = false;
          resend.hidden = true;
          clearInterval(cooldownTimer);
          if (!pw) pw = passwordFields(body.querySelector("#fp-pw"));
          busy(false, "Reset password");
        } else {
          if (!/^\d{6}$/.test(form.code.value.trim())) throw new Error("Enter the 6-digit code.");
          if (!pw.valid()) throw new Error("Check the new password rules and make sure both passwords match.");
          busy(true, "Updating…");
          await post("/api/otp/reset", { email: form.email.value.trim(), code: form.code.value.trim(), password: pw.value() });
          close();
          showLogin("Password updated. Sign in with your new password.", "ok");
        }
      } catch (err) {
        toast(err.message, "error");
        busy(false, stage === 1 ? "Send code" : stage === 2 ? "Continue" : "Reset password");
      }
    });

    onAction(resend, async () => {
      resend.disabled = true;
      try {
        await post("/api/otp/request", { email: form.email.value.trim() });
        toast("New code sent", "success");
        startCooldown();
      } catch (err) {
        toast(err.message, "error");
        resend.disabled = false;
      }
    });
  }, { dialog: true });
}

/* ───────── forced password change (new users and administrator resets) ───────── */

function showForcePasswordChange(user) {
  setState("login");
  root.innerHTML = `
    <section class="login-screen">
      <div class="login-art" aria-hidden="true"><span class="orb o1"></span><span class="orb o2"></span><span class="orb o3"></span></div>
      <div class="login-card">
        ${logoHtml(icon("key"))}
        <h1>Choose a new password</h1>
        <p class="muted">Your administrator gave you a temporary password. Set your own password to continue.</p>
        <form id="fc-form" class="stack" novalidate>
          <div id="fc-pw"></div>
          <button class="btn primary block xl" type="submit" id="fc-btn">${icon("check")}<span>Update password</span></button>
        </form>
        <button class="link-btn" type="button" id="fc-out">Sign out</button>
      </div>
    </section>`;
  const fields = passwordFields(document.getElementById("fc-pw"));
  const btn = document.getElementById("fc-btn");
  document.getElementById("fc-out").addEventListener("click", () => signOut(auth));
  onSubmit(document.getElementById("fc-form"), async (e) => {
    e.preventDefault();
    if (!fields.valid()) return toast("Check the password rules and make sure both passwords match.", "error");
    btn.disabled = true;
    try {
      await updatePassword(user, fields.value());
      await updateDoc(doc(db, "users", user.uid), { mustChangePassword: false, passwordChangedAt: serverTimestamp() });
      reloadKeepingPage(0);
    } catch (err) {
      btn.disabled = false;
      if (err.code === "auth/requires-recent-login") {
        pendingMessage = "For security, sign in again and then change your password.";
        return signOut(auth);
      }
      toast(err.message || "Could not update the password.", "error");
    }
  });
}

/* The loading and sign-in screens read the public branding record, so keep its shop name in step with Settings. */
async function syncPublicBranding() {
  if (!settings.shopName || branding.shopName === settings.shopName) return;
  try {
    await setDoc(doc(db, "branding", "public"), { shopName: settings.shopName, appName: settings.shopName }, { merge: true });
    Object.assign(branding, { shopName: settings.shopName, appName: settings.shopName });
  } catch (err) {
    console.warn("Could not sync the shop name:", err.message);
  }
}

/* ───────── account menu (tap the avatar) ───────── */

function openAccountMenu(anchor) {
  const email = auth.currentUser?.email || "";
  // On desktop the panel opens beside the sidebar or under the top-bar avatar; on phones it stays a bottom sheet.
  const desktopAnchor = anchor && window.matchMedia("(min-width: 901px)").matches ? anchor : null;
  openModal("Your account", `
    <div class="account-menu">
      <div class="account-who">
        <div class="avatar lg">${esc((session.name || "?").charAt(0).toUpperCase())}</div>
        <div><strong>${esc(session.name || "")}</strong><small class="muted">${esc(email)}${email ? " · " : ""}${esc(roles[session.role]?.label || "")}</small></div>
      </div>
      <div class="account-actions">
        <button class="account-action" type="button" data-act="lang">
          ${icon("sync")}<span><strong>${getLang() === "bn" ? "ভাষা: বাংলা" : "Language: English"}</strong><small>${getLang() === "bn" ? "English-এ পরিবর্তন করুন" : "বাংলায় পরিবর্তন করুন"}</small></span>
        </button>
        <button class="account-action" type="button" data-act="password">
          ${icon("key")}<span><strong>Change password</strong><small>Confirm your current password, then choose a new one</small></span>
        </button>
        <button class="account-action danger" type="button" data-act="signout">
          ${icon("logout")}<span><strong>Sign out</strong><small>Leave MediPOS on this device</small></span>
        </button>
      </div>
    </div>`, (body, close) => {
    body.querySelector('[data-act="password"]').addEventListener("click", () => { close(); openChangePassword(); });
    body.querySelector('[data-act="lang"]').addEventListener("click", () => {
      setLang(getLang() === "bn" ? "en" : "bn");
      close();
      openAccountMenu();
    });
    body.querySelector('[data-act="signout"]').addEventListener("click", async () => {
      if (!(await confirmBox("Sign out of MediPOS on this device?"))) return;
      close();
      await signOut(auth);
    });
  }, desktopAnchor ? { anchor: desktopAnchor } : {});
}

function openChangePassword() {
  openModal("Change password", `
    <form id="cp-form" class="stack" novalidate>
      <label class="field"><span class="field-label">Current password</span>
        <span class="input-wrap">${icon("lock")}<input type="password" name="current" autocomplete="current-password" required /></span>
      </label>
      <div id="cp-pw"></div>
      <div class="form-actions">
        <button class="btn ghost" type="button" data-cancel>Cancel</button>
        <button class="btn primary" type="submit">${icon("check")}<span>Update password</span></button>
      </div>
    </form>`, (body, close) => {
    const fields = passwordFields(body.querySelector("#cp-pw"));
    body.querySelector("[data-cancel]").addEventListener("click", close);
    onSubmit(body.querySelector("#cp-form"), async (e) => {
      const current = String(new FormData(e.target).get("current") || "");
      if (!current) throw new Error("Enter your current password.");
      if (!fields.valid()) throw new Error("Check the password rules and make sure both new passwords match.");
      const user = auth.currentUser;
      if (!user?.email) throw new Error("Please sign in again to change your password.");
      try {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
      } catch {
        throw new Error("Your current password is not correct.");
      }
      await updatePassword(user, fields.value());
      await updateDoc(doc(db, "users", user.uid), { passwordChangedAt: serverTimestamp() });
      close();
      alertBox({ title: "Password changed", message: "Your new password is saved. Use it the next time you sign in.", tone: "success" });
    });
  });
}

/* ───────── shell (responsive: sidebar on desktop, bottom bar on phones) ───────── */

// The phone menu button styles an admin can choose (Administration > Button style).
const MENU_STYLE_KEYS = ["classic", "orbit", "pulse", "flip", "neon"];

function navItems() {
  return effectivePages().map((p) => ({ key: p, label: PAGES[p], icon: PAGE_ICON[p] }));
}

// Sidebar sections: pages are grouped by what people do with them. Pages not listed here go under "More".
const NAV_GROUPS = [
  ["Sell", ["dashboard", "pos", "shift", "prescriptions"]],
  ["Stock & parties", ["inventory", "import", "purchasing", "partners"]],
  ["Money & reports", ["accounting", "reports"]],
  ["Administration", ["activity", "admin"]],
];
// Groups kept at the bottom of the sidebar, under the other pages.
const PINNED_GROUPS = ["Administration"];
function navLinks(groups, withHeader = true) {
  return groups.map((g) => `
    ${withHeader ? `<p class="nav-group">${esc(g.label)}</p>` : ""}
    ${g.items.map((p) => `
      <a class="nav-link" href="#/${p.key}" data-page="${p.key}">
        <span class="nav-ico">${icon(p.icon)}</span><span class="nav-text">${esc(PAGE_TITLE[p.key])}</span>
      </a>`).join("")}`).join("");
}
function navGroups(items) {
  const left = new Map(items.map((p) => [p.key, p]));
  const groups = NAV_GROUPS.map(([label, keys]) => ({ label, items: keys.filter((k) => left.has(k)).map((k) => left.get(k)) }));
  groups.forEach((g) => g.items.forEach((p) => left.delete(p.key)));
  if (left.size) groups.push({ label: "More", items: [...left.values()] });
  return groups.filter((g) => g.items.length);
}

function buildShell() {
  setState("app");
  const menuStyle = MENU_STYLE_KEYS.includes(settings.menuStyle) ? settings.menuStyle : "classic";
  const items = navItems();
  const tabs = items.length > MOBILE_MAX_TABS + 1 ? items.slice(0, MOBILE_MAX_TABS) : items;
  const more = items.length > MOBILE_MAX_TABS + 1;

  root.innerHTML = `
    <div class="shell">
      <div class="scrim" id="scrim"></div>
      <aside class="sidebar" id="sidebar">
        <div class="brand-card">
          <div class="brand-logo-wrap">${branding.logoUrl ? `<img class="brand-logo-sm" src="${esc(branding.logoUrl)}" alt="" />` : `<div class="brand-mark">${icon("pos")}</div>`}</div>
          <div class="brand-text"><strong>${esc(settings.shopName)}</strong><small>POS &amp; Accounts</small></div>
        </div>
        <nav class="nav">
          ${navLinks(navGroups(items).filter((g) => !PINNED_GROUPS.includes(g.label)))}
        </nav>
        ${navGroups(items).some((g) => PINNED_GROUPS.includes(g.label)) ? `<nav class="nav nav-pinned" aria-label="Administration">
          ${navLinks(navGroups(items).filter((g) => PINNED_GROUPS.includes(g.label)), false)}
        </nav>` : ""}
        <div class="sidebar-foot avatar-trigger" id="avatar-side" role="button" tabindex="0" aria-label="Your account">
          <div class="avatar-ring"><div class="avatar">${esc((session.name || "?").charAt(0).toUpperCase())}</div></div>
          <div class="who"><strong>${esc(session.name)}</strong><span class="role-pill">${esc(roles[session.role].label)}</span></div>
          <span class="foot-chev" aria-hidden="true">›</span>
        </div>
        <p class="sidebar-ver"><span class="ver-by">Designed by Avy</span><b>v${esc(APP_VERSION)}</b></p>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="menu-btn menu-style-${menuStyle}" id="menu-btn" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="sidebar">
            <span class="menu-grid" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          </button>
          ${branding.logoUrl ? `<img class="topbar-logo" src="${branding.logoUrl}" alt="${esc(settings.shopName || "")} logo" />` : ""}
          <div class="topbar-title"><strong class="topbar-shop">${esc(settings.shopName || "MediPOS")}</strong><small id="page-title"></small></div>
          <div class="grow"></div>
          <span class="clock" id="clock"></span>
          <button class="icon-btn bell-btn" id="bell-btn" type="button" aria-label="Notifications" title="Notifications">${icon("bell")}<span class="bell-count" id="bell-count" hidden></span></button>
          <button class="icon-btn" id="theme-btn" aria-label="Toggle dark mode">${icon(document.documentElement.dataset.theme === "dark" ? "sun" : "moon")}</button>
          <button class="avatar-top" id="avatar-top" type="button" aria-label="Your account" title="${esc(session.name || "Account")}">${esc((session.name || "?").charAt(0).toUpperCase())}</button>
        </header>
        <main id="view" class="view"></main>
      </div>
      <nav class="tabbar" aria-label="Main">
        ${tabs.map((p) => `<a class="tab-link" href="#/${p.key}" data-page="${p.key}">${icon(p.icon)}<span>${esc(PAGE_TITLE[p.key])}</span></a>`).join("")}
        ${more ? `<button class="tab-link" id="more-btn" type="button">${icon("menu")}<span>More</span></button>` : ""}
      </nav>
    </div>`;

  const sidebar = document.getElementById("sidebar");
  const scrim = document.getElementById("scrim");
  const menuBtn = document.getElementById("menu-btn");
  const setDrawer = (open) => {
    sidebar.classList.toggle("open", open);
    scrim.classList.toggle("show", open);
    menuBtn.classList.toggle("is-open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
  };
  document.getElementById("menu-btn").addEventListener("click", () => setDrawer(!sidebar.classList.contains("open")));
  document.getElementById("more-btn")?.addEventListener("click", () => setDrawer(true));
  scrim.addEventListener("click", () => setDrawer(false));
  sidebar.querySelectorAll(".nav-link").forEach((a) => a.addEventListener("click", () => setDrawer(false)));
  document.getElementById("theme-btn").addEventListener("click", toggleTheme);
  document.getElementById("bell-btn").addEventListener("click", toggleNotifications);
  const avatarTop = document.getElementById("avatar-top");
  avatarTop.addEventListener("click", () => openAccountMenu(avatarTop));
  const side = document.getElementById("avatar-side");
  side.addEventListener("click", () => openAccountMenu(side));
  side.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAccountMenu(side); } });

  // The clock follows the shop's time zone (Admin → Shop & rules). Without one, it uses the device's time zone.
  const shopZone = (() => {
    const z = String(settings.timezone || "").trim();
    try { if (z) new Intl.DateTimeFormat([], { timeZone: z }); return z || undefined; } catch { return undefined; }
  })();
  const clockFmt = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: shopZone });
  const tick = () => {
    const el = document.getElementById("clock");
    if (el) {
      el.textContent = clockFmt.format(new Date());
      el.title = shopZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    }
  };
  clearInterval(clockTimer);
  tick();
  // Once a second, so the time is always live.
  clockTimer = setInterval(tick, 1000);
  startNotifications();
  runStockChecks();
}

/* ───────── router ───────── */

let firstRoute = true;
async function route() {
  const allowed = effectivePages();
  const key = location.hash.replace(/^#\/?/, "") || allowed[0];
  const page = PAGES[key] ? key : allowed[0];
  const el = document.getElementById("view");
  if (!el) return;
  const token = ++routeToken;

  document.querySelectorAll("[data-page]").forEach((a) => a.classList.toggle("active", a.dataset.page === page));
  document.getElementById("page-title").textContent = PAGE_TITLE[page];
  document.title = `${PAGE_TITLE[page]} · ${settings.shopName}`;

  if (!can(page)) {
    el.innerHTML = `
      <div class="empty-state card">${icon("alert")}<h3>Access denied</h3>
      <p class="muted">Your role (${esc(roles[session.role].label)}) cannot open this page. Ask an administrator if you need it.</p></div>`;
    return;
  }

  // The first page after sign-in is already covered by the start-up loader, so it does not get a second one.
  const loader = firstRoute ? null : showRouteLoader(`Opening ${PAGE_TITLE[page]}…`);
  firstRoute = false;
  el.innerHTML = `<div class="skeleton-grid"><div class="skeleton"></div><div class="skeleton"></div></div>`;
  try {
    const mod = await import(`./pages/${page}.js`);
    if (token !== routeToken) return;
    el.innerHTML = "";
    await withTimeout(mod.render(el), 25000);
    el.classList.remove("enter");
    void el.offsetWidth; // restart the enter animation
    el.classList.add("enter");
  } catch (err) {
    console.error(err);
    if (token === routeToken) {
      const denied = /permission|insufficient/i.test(err.message || "");
      el.innerHTML = `
        <div class="empty-state card">${icon("alert")}<h3>${err.timeout ? "Connection is slow" : denied ? "Not allowed by the database" : "Something went wrong"}</h3>
        <p class="muted">${esc(err.message)}</p>
        <button class="btn primary sm" type="button" id="route-retry">${icon("sync")}<span>Try again</span></button></div>`;
      el.querySelector("#route-retry")?.addEventListener("click", () => route());
    }
  } finally {
    await hideRouteLoader(loader);
  }
}

window.addEventListener("hashchange", route);
startUpdateWatch();

/* ───────── boot & auth state ───────── */

restoreTheme();
// Never leave the page blank: if this device has the saved loading style cached, draw it right away.
// First visits with no cache keep a blank page for the moment it takes to read the saved style.
if (localStorage.getItem("medipos.branding")) showSplash(root, "Loading…");
// Branding must never hold up the sign-in page: wait at most 4 seconds for it.
const brandingReady = Promise.race([
  loadBranding(),
  new Promise((resolve) => setTimeout(resolve, 4000)),
]);

// Shows a startup error on the loading screen so it can be reported.
function showStartupError(err) {
  console.error(err);
  setState("boot");
  root.innerHTML = `
    <section class="splash" role="alert">
      <div class="splash-bg" aria-hidden="true"></div>
      <div class="splash-core">
        <h1 class="splash-name">MediPOS could not start</h1>
        <p class="splash-msg">${esc(err?.message || String(err))}</p>
        <button class="btn primary" type="button" id="retry-btn">Try again</button>
      </div>
      <p class="splash-ver ver-stack"><span class="ver-by">Designed by Avy</span><span class="ver-num">Version ${esc(APP_VERSION)}</span></p>
    </section>`;
  document.getElementById("retry-btn")?.addEventListener("click", () => location.reload());
}

onAuthStateChanged(auth, async (user) => {
  try {
    await handleAuthChange(user);
  } catch (err) {
    showStartupError(err);
  }
});

/* ───────── sign-in code: for staff whose account asks for one at every sign-in ───────── */

const OTP_KEY = "medipos.otp";

// True when this tab already confirmed the code for this same sign-in (a page reload does not ask again).
async function codePassed(user) {
  const claims = (await user.getIdTokenResult()).claims;
  return claims.otp === true && sessionStorage.getItem(OTP_KEY) === user.uid;
}

function showSignInCode(user) {
  setState("login");
  root.innerHTML = `
    <section class="login-screen">
      <div class="login-art" aria-hidden="true"><span class="orb o1"></span><span class="orb o2"></span><span class="orb o3"></span></div>
      <div class="login-card code-card">
        ${logoHtml(icon("shield"))}
        <div class="code-badge" aria-hidden="true">${icon("shield")}</div>
        <h1>Confirm it is you</h1>
        <p class="muted small code-help" id="code-help">Sending a 6-digit code to your email…</p>
        <form id="code-form" autocomplete="one-time-code">
          <input id="code-input" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" aria-label="6-digit code" required />
          <button class="btn primary block xl" type="submit" id="code-btn">${icon("check")}<span>Continue</span></button>
        </form>
        <p class="error-text" id="code-msg" role="status"></p>
        <div class="code-row">
          <button class="link-btn" type="button" id="code-resend">Send a new code</button>
          <button class="link-btn" type="button" id="code-out">Back to sign in</button>
        </div>
      </div>
    </section>`;
  const help = root.querySelector("#code-help");
  const msg = root.querySelector("#code-msg");
  const resendBtn = root.querySelector("#code-resend");
  let resendTimer = null;
  // Counts down before a new code can be asked for, so an older code is not replaced by accident.
  const startResendTimer = (seconds) => {
    clearInterval(resendTimer);
    let left = seconds;
    const paint = () => {
      if (!resendBtn.isConnected) return clearInterval(resendTimer);
      resendBtn.disabled = left > 0;
      resendBtn.textContent = left > 0 ? `Send a new code in ${left}s` : "Send a new code";
      if (left <= 0) clearInterval(resendTimer);
    };
    paint();
    resendTimer = setInterval(() => { left -= 1; paint(); }, 1000);
  };
  const send = async () => {
    msg.textContent = "";
    resendBtn.disabled = true;
    try {
      const out = await post("/api/auth/login-otp-request", {}, { secure: true });
      help.textContent = `We sent a 6-digit code to ${out.sentTo}. Only the newest code works.`;
      startResendTimer(60);
    } catch (err) {
      help.textContent = "Check your email for the code.";
      msg.textContent = err.message;
      startResendTimer(0);
    }
  };
  root.querySelector("#code-resend").addEventListener("click", send);
  root.querySelector("#code-out").addEventListener("click", () => signOut(auth));
  root.querySelector("#code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.textContent = "";
    try {
      // The button spins while the code is checked, so a press is never silent.
      await withBusy(root.querySelector("#code-btn"), async () => {
        await post("/api/auth/login-otp-verify", { code: root.querySelector("#code-input").value.trim() }, { secure: true });
        // Refresh the token so the database rules see the confirmed state at once.
        await user.getIdToken(true);
        sessionStorage.setItem(OTP_KEY, user.uid);
        await handleAuthChange(user);
      });
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  send();
}

async function handleAuthChange(user) {
  if (!isConfigured()) return showSetup();
  if (!user) {
    stopIdleLogout();
    sessionStorage.removeItem(OTP_KEY);
    // Logging out clears the page address, so the next sign-in starts at the dashboard.
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }
  // Wait for the saved loading style and shop name before the first loader is drawn, so only the one chosen in Branding is ever shown.
  await brandingReady;
  showSplash(root, "Checking your session…");
  if (!user) {
    showLogin(pendingMessage);
    pendingMessage = "";
    return;
  }
  try {
    // Read the staff profile first: settings are only readable by active staff.
    const snap = await withTimeout(getDoc(doc(db, "users", user.uid)));
    const p = snap.exists() ? snap.data() : null;
    if (!p) {
      pendingMessage = `No staff profile found for this login. Create users/${user.uid} in Firestore (see README).`;
      await signOut(auth);
      return;
    }
    if (p.lockedAt) {
      pendingMessage = "This account is locked after too many wrong passwords. Ask an administrator to unlock it.";
      await signOut(auth);
      return;
    }
    // Load the saved role list first, so roles the admin created (not only the built-in ones) are recognised.
    await withTimeout(loadSettings()).catch((err) => {
      if (err.timeout) throw err; // a slow connection is not a permissions problem
      /* an inactive profile cannot read settings; the check below still applies */
    });
    if (p.active !== true || !roles[p.role]) {
      pendingMessage = `Profile is inactive or has an unknown role ("${p.role ?? "none"}"). Check active = true and role = admin in Firestore.`;
      await signOut(auth);
      return;
    }
    // A correct sign-in clears any wrong-password count from earlier attempts.
    if ((p.failedLogins || 0) > 0) post("/api/auth/login-lock", { action: "ok" }, { secure: true }).catch(() => { /* try again next sign-in */ });
    // Temporary password: nothing else is available until the user sets their own.
    if (p.mustChangePassword === true) {
      showForcePasswordChange(user);
      return;
    }
    if (p.requireOtp === true && !(await withTimeout(codePassed(user)))) return showSignInCode(user);
    const splashShownAt = Date.now();
    showSplash(root, "Loading your workspace…");
    const rolesExist = await withTimeout(loadSettings());
    if (session.role === "admin") await syncPublicBranding();
    // First sign-in after setup: create the role matrix from the defaults so it can be edited.
    if (!rolesExist && p.role === "admin") {
      await setDoc(doc(db, "settings", "roles"), structuredClone(DEFAULT_ROLES));
      await loadSettings();
    }
    Object.assign(session, { uid: user.uid, name: p.name || user.email, email: user.email, role: p.role, access: p.access || null });
    // Keep the loading scene on screen long enough to be seen, even on a fast connection.
    await new Promise((r) => setTimeout(r, Math.max(0, 2200 - (Date.now() - splashShownAt))));
    buildShell();
    startIdleLogout((message) => { pendingMessage = message; });
    // A reload returns to the same page. Any other sign-in opens the dashboard.
    const back = takeReturnPage().replace(/^#\/?/, "");
    const home = back && effectivePages().includes(back) ? back : (can("dashboard") ? "dashboard" : effectivePages()[0]);
    if (location.hash !== `#/${home}`) location.hash = `#/${home}`;
    else route();
  } catch (err) {
    console.error(err);
    // A slow connection shows a retry screen and keeps the session, so the person is not signed out by mistake.
    if (err.timeout) return showStartupError(err);
    pendingMessage = `Could not load your profile: ${err.message}`;
    await signOut(auth);
  }
}
