import { auth, db, onAuthStateChanged, signInWithEmailAndPassword, signOut, doc, getDoc, setDoc } from "./firebase.js";
import { firebaseConfig, APP_NAME } from "./config.js";
import { session, roles, settings, icon, esc, can, loadSettings, DEFAULT_ROLES } from "./core.js";

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

function showLogin(message = "") {
  setState("login");
  root.innerHTML = `
    <section class="login-screen">
      <div class="login-art" aria-hidden="true"><span class="orb o1"></span><span class="orb o2"></span><span class="orb o3"></span></div>
      <form class="login-card" id="login-form" novalidate>
        <div class="brand-mark big">${icon("pos")}</div>
        <h1>${esc(settings.shopName || APP_NAME)}</h1>
        <p class="muted">Sign in with your staff email and password</p>
        ${message ? `<div class="alert" role="alert">${esc(message)}</div>` : ""}
        <label>Email<input type="email" name="email" inputmode="email" required autocomplete="username" /></label>
        <label>Password<input type="password" name="password" required autocomplete="current-password" /></label>
        <button class="btn primary block xl" type="submit" id="login-btn">Sign in</button>
        <p class="muted small">Forgot your password? Ask your administrator to send a reset email.</p>
      </form>
    </section>`;

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const email = String(fd.get("email") || "").trim();
    const password = String(fd.get("password") || "");
    if (!email || !password) return showLogin("Enter your email and password.");
    const btn = document.getElementById("login-btn");
    btn.disabled = true;
    btn.classList.add("loading");
    btn.textContent = "Signing in…";
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      showLogin(friendlyError(err));
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
          <div class="brand-mark">${icon("pos")}</div>
          <div><strong>${esc(settings.shopName)}</strong><small>${esc(APP_NAME)} · POS & Accounts</small></div>
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

onAuthStateChanged(auth, async (user) => {
  if (!isConfigured()) return showSetup();
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
});
