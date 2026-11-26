import { auth, db, onAuthStateChanged, signInWithEmailAndPassword, signOut, updatePassword, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "./firebase.js";
import { loadBranding, branding, logoHtml } from "./branding.js";
import { passwordFields } from "./password-ui.js";
import { post } from "./api.js";
import { showSplash } from "./splash.js";
import { firebaseConfig, APP_NAME, APP_VERSION } from "./config.js";
import { session, roles, settings, icon, esc, can, loadSettings, DEFAULT_ROLES, openModal, toast } from "./core.js";

// Email + password only. No third-party (Google) sign-in is offered anywhere.

const PAGES = {
  dashboard: "Dashboard",
  pos: "Sell",
  inventory: "Inventory",
  purchasing: "Purchasing",
  partners: "Customers",
  accounting: "Accounting",
  reports: "Reports",
  admin: "Admin",
};
const PAGE_TITLE = { ...PAGES, pos: "Point of Sale", partners: "Customers & Suppliers", admin: "Administration" };
const PAGE_ICON = {
  dashboard: "dashboard", pos: "cart", inventory: "inventory", purchasing: "purchase",
  partners: "partners", accounting: "accounting", reports: "reports", admin: "admin",
};
const MOBILE_MAX_TABS = 4;

const root = document.getElementById("app");
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

function showLogin(message = "", tone = "error") {
  setState("login");
  root.innerHTML = `
    <section class="login-screen">
      <div class="login-art" aria-hidden="true"><span class="orb o1"></span><span class="orb o2"></span><span class="orb o3"></span></div>
      <div class="login-card">
        ${logoHtml(icon("pos"))}
        <h1>${esc(branding.appName || APP_NAME)}</h1>
        <p class="muted">${esc(branding.shopName || settings.shopName)} · Staff sign-in</p>
        ${message ? `<div class="alert ${tone === "ok" ? "ok" : ""}" role="alert">${esc(message)}</div>` : ""}
        <form id="login-form" novalidate class="login-form">
          <label class="field"><span class="field-label">Email</span>
            <span class="input-wrap">${icon("mail")}<input type="email" name="email" inputmode="email" autocomplete="username" required /></span></label>
          <label class="field"><span class="field-label">Password</span>
            <span class="input-wrap">${icon("lock")}<input type="password" name="password" autocomplete="current-password" required />
              <button type="button" class="eye" id="eye-login" aria-label="Show password">${icon("eye")}</button></span></label>
          <button class="btn primary block xl" type="submit" id="login-btn">${icon("key")}<span>Sign in</span></button>
        </form>
        <button class="link-btn" type="button" id="forgot-btn">Forgot password?</button>
        <p class="version">Version ${esc(APP_VERSION)}</p>
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

  form.addEventListener("submit", async (e) => {
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
      showLogin(friendlyError(err));
    }
  });
}

/* ───────── forgot password: email → 6-digit code → new password ───────── */

function openForgotPassword(prefillEmail = "") {
  openModal("Reset your password", `
    <form id="fp-form" class="stack" novalidate>
      <p class="muted small" id="fp-help">Enter your staff email. If an account exists, we will send a 6-digit code.</p>
      <label class="field"><span class="field-label">Email</span>
        <span class="input-wrap">${icon("mail")}<input type="email" name="email" inputmode="email" autocomplete="username" value="${esc(prefillEmail)}" required /></span></label>
      <div id="fp-step2" hidden>
        <label class="field"><span class="field-label">6-digit code</span>
          <span class="input-wrap">${icon("shield")}<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required /></span></label>
        <div id="fp-pw"></div>
      </div>
      <div class="form-actions">
        <button class="btn primary" type="submit" id="fp-submit">${icon("send")}<span>Send code</span></button>
      </div>
      <p class="small center"><button type="button" class="link-btn" id="fp-resend" hidden>Resend code</button></p>
    </form>`, (body, close) => {
    const form = body.querySelector("#fp-form");
    const step2 = body.querySelector("#fp-step2");
    const submit = body.querySelector("#fp-submit");
    const help = body.querySelector("#fp-help");
    const resend = body.querySelector("#fp-resend");
    let pw = null;
    let stage = 1;
    let cooldownTimer = null;

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

    const sendCode = async () => {
      const email = form.email.value.trim();
      await post("/api/otp/request", { email });
      help.textContent = "We sent a 6-digit code to your email. It expires in 10 minutes.";
      stage = 2;
      step2.hidden = false;
      form.email.readOnly = true;
      submit.querySelector("span").textContent = "Reset password";
      if (!pw) pw = passwordFields(body.querySelector("#fp-pw"));
      startCooldown();
      form.code.focus();
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        if (stage === 1) {
          if (!form.email.value.trim()) throw new Error("Enter your email.");
          await sendCode();
        } else {
          if (!/^\d{6}$/.test(form.code.value.trim())) throw new Error("Enter the 6-digit code.");
          if (!pw.valid()) throw new Error("Check the new password rules and make sure both passwords match.");
          await post("/api/otp/reset", { email: form.email.value.trim(), code: form.code.value.trim(), password: pw.value() });
          close();
          showLogin("Password updated. Sign in with your new password.", "ok");
          return;
        }
      } catch (err) {
        toast(err.message, "error");
      } finally {
        submit.disabled = false;
      }
    });

    resend.addEventListener("click", async () => {
      resend.disabled = true;
      try { await post("/api/otp/request", { email: form.email.value.trim() }); toast("New code sent", "success"); startCooldown(); }
      catch (err) { toast(err.message, "error"); resend.disabled = false; }
    });
  });
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
  document.getElementById("fc-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!fields.valid()) return toast("Check the password rules and make sure both passwords match.", "error");
    btn.disabled = true;
    try {
      await updatePassword(user, fields.value());
      await updateDoc(doc(db, "users", user.uid), { mustChangePassword: false, passwordChangedAt: serverTimestamp() });
      location.reload();
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

/* ───────── shell (responsive: sidebar on desktop, bottom bar on phones) ───────── */

function navItems() {
  return roles[session.role].pages.map((p) => ({ key: p, label: PAGES[p], icon: PAGE_ICON[p] }));
}

function buildShell() {
  setState("app");
  const items = navItems();
  const tabs = items.length > MOBILE_MAX_TABS + 1 ? items.slice(0, MOBILE_MAX_TABS) : items;
  const more = items.length > MOBILE_MAX_TABS + 1;

  root.innerHTML = `
    <div class="shell">
      <div class="scrim" id="scrim"></div>
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          ${branding.logoUrl ? `<img class="brand-logo-sm" src="${branding.logoUrl}" alt="" />` : `<div class="brand-mark">${icon("pos")}</div>`}
          <div><strong>${esc(settings.shopName)}</strong><small>${esc(branding.appName || APP_NAME)} · POS & Accounts</small></div>
        </div>
        <nav class="nav">
          ${items.map((p, i) => `
            <a class="nav-link" href="#/${p.key}" data-page="${p.key}" style="--i:${i}">
              ${icon(p.icon)}<span>${esc(PAGE_TITLE[p.key])}</span>
            </a>`).join("")}
        </nav>
        <div class="sidebar-foot">
          <div class="avatar">${esc((session.name || "?").charAt(0).toUpperCase())}</div>
          <div class="who"><strong>${esc(session.name)}</strong><small>${esc(roles[session.role].label)}</small></div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn menu-btn" id="menu-btn" aria-label="Open menu">${icon("menu")}</button>
          <h2 id="page-title"></h2>
          <div class="grow"></div>
          <span class="clock" id="clock"></span>
          <button class="icon-btn" id="theme-btn" aria-label="Toggle dark mode">${icon(document.documentElement.dataset.theme === "dark" ? "sun" : "moon")}</button>
          <button class="icon-btn hover-danger" id="logout-btn" aria-label="Sign out">${icon("logout")}</button>
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
  const setDrawer = (open) => { sidebar.classList.toggle("open", open); scrim.classList.toggle("show", open); };
  document.getElementById("menu-btn").addEventListener("click", () => setDrawer(!sidebar.classList.contains("open")));
  document.getElementById("more-btn")?.addEventListener("click", () => setDrawer(true));
  scrim.addEventListener("click", () => setDrawer(false));
  sidebar.querySelectorAll(".nav-link").forEach((a) => a.addEventListener("click", () => setDrawer(false)));
  document.getElementById("theme-btn").addEventListener("click", toggleTheme);
  document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

  const tick = () => {
    const el = document.getElementById("clock");
    if (el) el.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  clearInterval(clockTimer);
  tick();
  clockTimer = setInterval(tick, 15000);
}

/* ───────── router ───────── */

async function route() {
  const allowed = roles[session.role].pages;
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

  el.innerHTML = `<div class="skeleton-grid"><div class="skeleton"></div><div class="skeleton"></div></div>`;
  try {
    const mod = await import(`./pages/${page}.js`);
    if (token !== routeToken) return;
    el.innerHTML = "";
    await mod.render(el);
    el.classList.remove("enter");
    void el.offsetWidth; // restart the enter animation
    el.classList.add("enter");
  } catch (err) {
    console.error(err);
    if (token === routeToken) {
      const denied = /permission|insufficient/i.test(err.message || "");
      el.innerHTML = `
        <div class="empty-state card">${icon("alert")}<h3>${denied ? "Not allowed by the database" : "Something went wrong"}</h3>
        <p class="muted">${esc(err.message)}</p></div>`;
    }
  }
}

window.addEventListener("hashchange", route);

/* ───────── boot & auth state ───────── */

restoreTheme();
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
      <p class="splash-ver">Version ${esc(APP_VERSION)}</p>
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

async function handleAuthChange(user) {
  if (!isConfigured()) return showSetup();
  showSplash(root, "Checking your session…");
  await brandingReady;
  if (!user) {
    showLogin(pendingMessage);
    pendingMessage = "";
    return;
  }
  try {
    // Read the staff profile first: settings are only readable by active staff.
    const snap = await getDoc(doc(db, "users", user.uid));
    const p = snap.exists() ? snap.data() : null;
    if (!p) {
      pendingMessage = `No staff profile found for this login. Create users/${user.uid} in Firestore (see README).`;
      await signOut(auth);
      return;
    }
    if (p.active !== true || !roles[p.role]) {
      pendingMessage = `Profile is inactive or has an unknown role ("${p.role ?? "none"}"). Check active = true and role = admin in Firestore.`;
      await signOut(auth);
      return;
    }
    // Temporary password: nothing else is available until the user sets their own.
    if (p.mustChangePassword === true) {
      showForcePasswordChange(user);
      return;
    }
    showSplash(root, "Loading your workspace…");
    const rolesExist = await loadSettings();
    // First sign-in after setup: create the role matrix from the defaults so it can be edited.
    if (!rolesExist && p.role === "admin") {
      await setDoc(doc(db, "settings", "roles"), structuredClone(DEFAULT_ROLES));
      await loadSettings();
    }
    Object.assign(session, { uid: user.uid, name: p.name || user.email, email: user.email, role: p.role });
    buildShell();
    route();
  } catch (err) {
    console.error(err);
    pendingMessage = `Could not load your profile: ${err.message}`;
    await signOut(auth);
  }
}
