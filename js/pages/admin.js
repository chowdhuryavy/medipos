import { onSubmit, onAction, onDelegated, withBusy, APP_FONTS, reloadKeepingPage } from "../core.js";
import { VERSION } from "../version.js";
import { checkForUpdate } from "../updates.js";

import {
  auth, db, initializeApp, deleteApp, getAuth, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail, collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, query, where, orderBy, limit, serverTimestamp, writeBatch,
} from "../firebase.js";
import { firebaseConfig } from "../config.js";
import { nextExpenseCode, expenseCategories } from "../expense-categories.js";
import { showRouteLoader, hideRouteLoader, LOADING_STYLES } from "../splash.js";
import {
  session, roles, DEFAULT_ROLES, WRITE_AREAS, settings, DEFAULT_SETTINGS, esc, icon, toast, openModal, confirmBox, alertBox,
  audit, ensureChartOfAccounts, fmtDateTime, money,
} from "../core.js";

const WRITE_LABEL = {
  pos: "Sales & receipts", inventory: "Products & stock", purchasing: "Purchases",
  partners: "Customers & suppliers", accounting: "Journal, expenses & accounts",
};
import { pushToSheets } from "../sheets.js";
import { post } from "../api.js";
import { DEFAULT_TEMPLATES, EMAIL_PLACEHOLDERS, DEFAULT_BRAND_COLOR } from "../email-defaults.js";
import { DEFAULT_SERVICE_FEES, SERVICE_TYPES, floatKey } from "../services.js";
import { REPORTS } from "../report-tables.js";

const TABS = [
  ["users", "Staff", "userPlus"],
  ["settings", "Shop & rules", "building"],
  ["versions", "App version", "sync"],
  ["lists", "Lists & payments", "accounting"],
  ["roles", "Role access", "shield"],
  ["branding", "Branding & email", "image"],
  ["reports", "Scheduled reports", "reports"],
  ["backup", "Daily backup", "download"],
  ["integrations", "Integrations", "send"],
  ["buttons", "Button style", "menu"],
  ["audit", "Activity log", "search"],
];
const PAGE_NAMES = {
  dashboard: "Dashboard", pos: "Sell", shift: "Cash shift", inventory: "Inventory", purchasing: "Purchasing", partners: "Customers & suppliers",
  accounting: "Accounting", reports: "Reports", returns: "Returns & voids", admin: "Administration",
};

export async function render(el) {
  el.innerHTML = `
    <div class="tabs" role="tablist">
      ${TABS.map(([k, l, ic], i) => `<button class="tab ${i === 0 ? "active" : ""}" data-tab="${k}" role="tab">${icon(ic)}<span>${l}</span></button>`).join("")}
    </div>
    <div id="adm-body"></div>`;
  const body = el.querySelector("#adm-body");
  const views = { users: viewUsers, settings: viewSettings, versions: viewVersions, lists: viewLists, roles: viewRoles, branding: viewBranding, reports: viewScheduledReports, backup: viewBackup, integrations: viewIntegrations, audit: viewAudit, buttons: viewButtonStyle };
  const go = async (tab) => {
    el.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    body.innerHTML = `<div class="skeleton"></div>`;
    try {
      await views[tab](body);
    } catch (err) {
      // Shown on screen so a missing deployment or rule is visible, not a blank page.
      console.error(err);
      body.innerHTML = `<section class="card"><h3>This screen could not load</h3>
        <p class="muted">${esc(err.message || "Unknown error")}</p>
        <p class="muted small">If this says permission denied, the security rules have not been deployed yet. Deploy firestore.rules (firebase deploy --only firestore:rules), then reload.</p></section>`;
    }
  };
  el.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (b) go(b.dataset.tab);
  });
  go("users");
}

/* ───────── Staff ───────── */

async function loadStaff() {
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((x, y) => (x.name || "").localeCompare(y.name || ""));
}

// One list of staff with Edit, Reset password and Delete on every person. Edit opens their access in a modal.
async function renderStaffCard(host, reload) {
  const users = await loadStaff();
  host.innerHTML = `
    <section class="card">
      <div class="toolbar">
        <h3>Staff accounts</h3>
        <div class="grow"></div>
        <button class="btn primary" id="u-new">${icon("plus")}<span>Add staff</span></button>
      </div>
      <div class="table-wrap"><table class="stack-mobile">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${users.map((u, i) => `<tr class="row-in" style="--i:${i}">
            <td data-label="Name"><strong>${esc(u.name)}</strong></td>
            <td data-label="Email">${esc(u.email)}</td>
            <td data-label="Role"><span class="badge">${esc(roles[u.role]?.label || u.role)}</span>${u.requireOtp ? ' <span class="badge warn">Email code</span>' : ""}</td>
            <td data-label="Status"><span class="badge ${u.active ? "ok" : "danger"}">${u.active ? "Active" : "Disabled"}</span></td>
            <td class="actions">
              <button class="icon-btn sm" data-edit="${esc(u.id)}" aria-label="Edit access for ${esc(u.name)}" title="Edit access">${icon("edit")}</button>
              <button class="icon-btn sm" data-reset="${esc(u.id)}" aria-label="Send password reset email" title="Send password reset email">${icon("sync")}</button>
              ${u.id !== session.uid ? `<button class="icon-btn sm hover-danger" data-delete-user="${esc(u.id)}" aria-label="Delete ${esc(u.name)}" title="Delete staff account">${icon("trash")}</button>` : ""}
            </td></tr>`).join("") || `<tr><td colspan="5" class="muted center">No staff yet</td></tr>`}
        </tbody>
      </table></div>
    </section>`;

  host.querySelector("#u-new").addEventListener("click", () => openUserForm(null, reload));
  onDelegated(host, async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.edit) return openStaffAccess(b.dataset.edit, reload);
    if (b.dataset.deleteUser) {
      const u = users.find((x) => x.id === b.dataset.deleteUser);
      if (!(await confirmBox(`Delete ${u.name}? Their sign-in is removed and they can no longer use MediPOS. Past sales keep their name.`))) return;
      await post("/api/admin/users", { action: "delete", uid: u.id }, { secure: true });
      toast("Staff account deleted", "success");
      return reload();
    }
    if (b.dataset.reset) {
      const u = users.find((x) => x.id === b.dataset.reset);
      if (!(await confirmBox(`Reset ${u.name}'s password? A temporary password will be emailed to ${u.email}, and they must change it at sign-in.`))) return;
      await post("/api/admin/users", { action: "reset", uid: u.id }, { secure: true });
      toast("Temporary password emailed", "success");
      reload();
    }
  });
}

async function viewUsers(body) {
  const host = document.createElement("div");
  body.replaceChildren(host);
  const reload = () => viewUsers(body);
  await renderStaffCard(host, reload);
}

function roleOptions(selected) {
  return Object.entries(roles).map(([k, r]) => `<option value="${k}" ${k === selected ? "selected" : ""}>${esc(r.label)}</option>`).join("");
}

function openUserForm(u, reload) {
  const isNew = !u;
  openModal(isNew ? "Add staff member" : `Edit ${u.name}`, `
    <form id="uf" class="form-grid">
      <label class="span-2">Full name<input name="name" required value="${esc(u?.name || "")}" /></label>
      ${isNew ? `
        <label class="span-2">Email<input name="email" type="email" inputmode="email" required autocomplete="off" /></label>
        <p class="span-2 muted small">A temporary password is generated and emailed to the staff member. They must choose their own password at first sign-in.</p>` : ""}
      <label>Role<select name="role">${roleOptions(u?.role || "cashier")}</select></label>
      <label class="check"><input type="checkbox" name="active" ${!u || u.active ? "checked" : ""} /> <span>Account active</span></label>
      <label class="check span-2"><input type="checkbox" name="requireOtp" ${u?.requireOtp ? "checked" : ""} /> <span>Ask for an email code at every sign-in</span></label>
      <div class="form-actions span-2">
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" type="submit">${isNew ? "Create account" : "Save"}</button>
      </div>
    </form>`, (body, close) => {
    body.querySelector("[data-cancel]").addEventListener("click", close);
    onSubmit(body.querySelector("#uf"), async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const name = String(f.get("name") || "").trim();
      const role = String(f.get("role"));
      const active = f.get("active") === "on";
      const requireOtp = f.get("requireOtp") === "on";
      if (u && u.id === session.uid && (!active || role !== "admin")) {
        return toast("You cannot remove your own admin access", "error");
      }
      try {
        if (isNew) {
          const email = String(f.get("email") || "").trim();
          const created = await post("/api/admin/users", { action: "create", name, email, role }, { secure: true });
          const extra = {};
          if (!active) extra.active = false;
          if (requireOtp) extra.requireOtp = true;
          if (Object.keys(extra).length) await updateDoc(doc(db, "users", created.uid), extra);
        } else {
          await updateDoc(doc(db, "users", u.id), { name, role, active, requireOtp, updatedAt: serverTimestamp() });
          await audit("user.update", { id: u.id, role, active, requireOtp });
        }
        toast("Saved", "success");
        close();
        reload();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

// Creates the sign-in account on a separate Auth instance, so the admin stays signed in here.
async function createAuthUser(email, password) {
  const secondary = initializeApp(firebaseConfig, `staff-${Date.now()}`);
  try {
    const sAuth = getAuth(secondary);
    const cred = await createUserWithEmailAndPassword(sAuth, email, password);
    const uid = cred.user.uid;
    await signOut(sAuth);
    return uid;
  } finally {
    await deleteApp(secondary);
  }
}

/* ───────── Shop & rules ───────── */

const FIELDS = [
  ["Shop profile", [
    ["shopName", "Shop name", "text"],
    ["shopAddress", "Address", "text"],
    ["shopPhone", "Phone", "tel"],
    ["taxNumber", "Tax / licence number", "text"],
    ["receiptFooter", "Receipt footer message", "text"],
    ["emailFooter", "Footer line in emails", "text"],
  ]],
  ["Money & tax", [
    ["currency", "Currency code (e.g. QAR, SAR, USD, AED)", "text"],
    ["defaultVatRate", "Default VAT %", "number"],
    ["maxDiscountPct", "Maximum discount % cashiers can give", "number"],
    ["allowCreditSales", "Allow sales on account (credit)", "bool"],
    ["allowPriceChange", "Let cashiers raise prices (lowest price is always enforced)", "bool"],
  ]],
  ["POS buttons", [
    ["posServiceButtons", "Show the mobile recharge and wallet buttons on the sale screen", "bool"],
    ["posTab1Active", "Show the first sale-screen button", "bool"],
    ["posTab1Label", "First button name", "text"],
    ["posTab1Categories", "Product categories for the first button (comma separated, e.g. Medicine, Syrup)", "text"],
    ["posTab2Active", "Show the second sale-screen button", "bool"],
    ["posTab2Label", "Second button name", "text"],
    ["posTab2Categories", "Product categories for the second button (comma separated). Empty = all other categories", "text"],
  ]],
  ["Appearance", [
    ["appFont", "App font", "font"],
  ]],
  ["Numbering", [
    ["invoicePrefix", "Invoice prefix", "text"],
    ["purchasePrefix", "Purchase prefix", "text"],
  ]],
  ["Password reset", [
    ["otpExpiryMinutes", "Reset code is valid for (minutes, 1–60)", "number"],
  ]],
  ["Security", [
    ["sessionTimeoutMinutes", "Sign staff out after this many minutes with no activity (0 = never)", "number"],
  ]],
  ["Inventory rules", [
    ["expiryWarnDays", "Warn this many days before expiry", "number"],
    ["floatWarnAmount", "Warn when a wallet or operator float falls below", "number"],
    ["defaultReorderLevel", "Default reorder level for new products", "number"],
  ]],
];

// App version: its own tab. Lists recent releases; "Go back" asks first, then makes that release live.
async function viewVersions(body) {
  body.innerHTML = `
    <section class="card">
      <h3>App version</h3>
      <p class="muted small">You are running version ${esc(VERSION)}. If the app misbehaves after an update, go back to an earlier release. Going back changes the app code only. Your data and Firestore rules are not changed.</p>
      <div class="vs-list" id="vs-list"><p class="muted">Loading recent releases…</p></div>
    </section>`;
  const list = body.querySelector("#vs-list");
  let deployments;
  try {
    ({ deployments } = await post("/api/admin/app", { action: "versions" }, { secure: true }));
  } catch (err) {
    list.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    return;
  }
  list.innerHTML = deployments.length ? deployments.map((d, i) => {
    const live = d.version === VERSION;
    return `
      <article class="vs-row ${live ? "is-live" : ""}">
        <div class="vs-info">
          <strong>${d.version ? `Version ${esc(d.version)}` : "Version not recorded"} ${live ? `<span class="badge ok">Running now</span>` : i === 0 ? `<span class="badge">Newest</span>` : ""}</strong>
          <small>${esc(fmtDateTime(d.created))}</small>
          <small>${esc(d.commit)}</small>
        </div>
        ${live ? "" : `<button type="button" class="btn ghost sm" data-go="${esc(d.id)}" data-ver="${esc(d.version ? "version " + d.version : "this release")}">${icon("sync")}<span>Go back</span></button>`}
      </article>`;
  }).join("") : `<p class="muted">No earlier releases found.</p>`;

  list.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-go]");
    if (!b) return;
    const ok = await confirmBox(`Go back to ${b.dataset.ver}? Everyone gets it the next time they reload. Your data and Firestore rules stay as they are.`, { title: "Go back to an earlier version", tone: "warn", confirmText: "Go back" });
    if (!ok) return;
    try {
      await post("/api/admin/app", { action: "rollback", deploymentId: b.dataset.go }, { secure: true });
      toast("Done. A banner will ask everyone to reload.", "success");
      setTimeout(checkForUpdate, 4000);
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function viewSettings(body) {
  const bSnap = await getDoc(doc(db, "branding", "public"));
  const logoNow = (bSnap.exists() && bSnap.data().logoUrl) || "";
  const GROUP_HELP = {
    "Shop profile": "Name, address, phone and the footer text on receipts and emails.",
    "Money & tax": "Currency, VAT rate, discount and credit rules.",
    "Numbering": "Prefixes for invoice and purchase numbers.",
    "Password reset": "How long a reset code stays valid.",
    "Security": "Automatic sign-out after a period of inactivity.",
    "Appearance": "The font used across the app. Applies after the next reload.",
  };
  // Every section opens in its own window with its own save. The logo is one of them.
  const GROUPS = [
    { key: "logo", title: "Shop logo", help: "Shown on the sign-in page, the sidebar, receipts, every email and as the app icon." },
    ...FIELDS.map(([title], i) => ({ key: `g${i}`, title, help: GROUP_HELP[title] || "" })),
  ];

  body.innerHTML = `
    <section class="card">
      <h3>Shop settings</h3>
      <p class="muted small">Open a section to change it. Each section has its own window and its own save.</p>
      <div class="list-index">${GROUPS.map((g) => `
        <button type="button" class="list-row" data-group="${g.key}">
          <span class="list-row-main"><strong>${esc(g.title)}</strong><small class="muted">${esc(g.help)}</small></span>
          ${icon("edit")}
        </button>`).join("")}</div>
    </section>
    <section class="card">
      <h3>Restore defaults</h3>
      <p class="muted small">Puts the shop settings back to the built-in defaults. Lists and payment methods are kept.</p>
      <div class="form-actions"><button type="button" class="btn ghost" id="s-reset">${icon("sync")}<span>Restore defaults</span></button></div>
    </section>`;

  // Shop logo window: choose or remove, then save the logo only.
  const openLogo = () => {
    let logoUrl = logoNow;
    let changed = false;
    openModal("Shop logo", `
      <form id="lg" class="settings-form">
        <p class="muted small">PNG with a transparent background works best.</p>
        <div class="logo-editor">
          <div class="logo-preview" id="logo-preview">${logoUrl ? `<img src="${esc(logoUrl)}" alt="Current logo" />` : `<span class="muted small">No logo yet</span>`}</div>
          <div class="logo-actions">
            <label class="btn ghost sm file-btn">${icon("upload")}<span>Choose logo</span>
              <input type="file" id="logo-file" accept="image/*" hidden /></label>
            <button type="button" class="btn ghost sm" id="logo-remove">${icon("trash")}<span>Remove</span></button>
          </div>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">${icon("check")}<span>Save logo</span></button></div>
      </form>`, (host, close) => {
        const lg = host.querySelector("#lg");
        lg.querySelector("#logo-file").addEventListener("change", async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            logoUrl = await readLogo(file);
            changed = true;
            lg.querySelector("#logo-preview").innerHTML = `<img src="${esc(logoUrl)}" alt="New logo" />`;
          } catch (err) {
            toast(err.message, "error");
          }
          e.target.value = "";
        });
        lg.querySelector("#logo-remove").addEventListener("click", () => {
          logoUrl = "";
          changed = true;
          lg.querySelector("#logo-preview").innerHTML = `<span class="muted small">No logo (the default icon is used)</span>`;
        });
        onSubmit(lg, async (e) => {
          e.preventDefault();
          if (!changed) return close();
          await setDoc(doc(db, "branding", "public"), { logoUrl, updatedAt: serverTimestamp() }, { merge: true });
          await audit("branding.logo", { changed: true });
          toast("Logo saved", "success");
          close();
          viewSettings(body);
        });
      });
  };

  // One group of settings: its fields, saved on their own.
  const openGroup = (idx) => {
    const [title, fields] = FIELDS[idx];
    openModal(title, `
      <form id="gf" class="settings-form">
        <div class="form-grid">
          ${fields.map(([k, label, type]) => type === "bool"
            ? `<label class="check span-2"><input type="checkbox" name="${k}" ${settings[k] ? "checked" : ""} /> <span>${esc(label)}</span></label>`
            : type === "font"
              ? `<label class="span-2">${esc(label)}
                <select name="${k}">${Object.entries(APP_FONTS).map(([key, f]) => `<option value="${key}" ${settings[k] === key ? "selected" : ""}>${esc(f.label)}</option>`).join("")}</select></label>`
            : `<label class="${k === "receiptFooter" || k === "shopAddress" ? "span-2" : ""}">${esc(label)}
                <input name="${k}" type="${type}" ${type === "number" ? 'inputmode="decimal" step="any"' : ""} value="${esc(settings[k] ?? "")}" /></label>`).join("")}
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">${icon("check")}<span>Save ${esc(title)}</span></button></div>
      </form>`, (host, close) => {
        const gf = host.querySelector("#gf");
        onSubmit(gf, async (e) => {
          e.preventDefault();
          const f = new FormData(gf);
          const patch = {};
          for (const [k, , type] of fields) {
            if (type === "bool") patch[k] = f.get(k) === "on";
            else if (type === "number") patch[k] = Number(f.get(k)) || 0;
            else patch[k] = String(f.get(k) || "").trim();
          }
          if ("currency" in patch && !patch.currency) throw new Error("Currency code is required");
          close();
          await saveGeneral(patch, `${title} saved. Reloading to apply it.`);
        });
      });
  };

  body.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.group;
    if (key === "logo") return openLogo();
    openGroup(Number(key.slice(1)));
  }));

  onAction(body.querySelector("#s-reset"), async () => {
    if (!(await confirmBox("Restore the default shop settings? Your lists and payment methods are kept."))) return;
    const { categories, units, paymentMethods, writeOffReasons, ...rest } = DEFAULT_SETTINGS;
    await saveGeneral(rest, "Defaults restored.");
  });
}

async function saveGeneral(patch, message) {
  await setDoc(doc(db, "settings", "general"), { ...patch, updatedAt: serverTimestamp() }, { merge: true });
  // The loading screen and sign-in page read branding/public before anyone is signed in.
  if (patch.shopName) await setDoc(doc(db, "branding", "public"), { shopName: patch.shopName, appName: patch.shopName }, { merge: true });
  await audit("settings.update", { keys: Object.keys(patch) });
  toast(message, "success");
  reloadKeepingPage(900);
}

/* ───────── Lists & payment methods ───────── */

/* ───────── Lists & payment methods ───────── */

const clean = (arr) => [...new Set(arr.map((v) => String(v).trim()).filter(Boolean))];

/**
 * Applies renames and removals from the lists to the records that use them:
 * products keep their category or unit name, and a wallet or operator keeps its float balance under the new name.
 */
async function applyListChanges({ orig, state, ids }) {
  const changed = (key) => state[key]
    .map((name, i) => ({ name, old: ids[key][i] === null ? null : orig[key][ids[key][i]] }))
    .filter((x) => x.old !== null && x.old !== x.name);
  const removed = (key) => {
    const kept = new Set(ids[key].filter((x) => x !== null));
    return orig[key].filter((_, i) => !kept.has(i));
  };
  const ops = [];

  for (const [key, field] of [["categories", "category"], ["units", "unit"]]) {
    for (const { old, name } of changed(key)) {
      const snap = await getDocs(query(collection(db, "products"), where(field, "==", old)));
      snap.docs.forEach((d) => ops.push(["update", d.ref, { [field]: name }]));
    }
  }

  for (const [key, keyOf] of [["walletProviders", (n) => floatKey("cashin", n)], ["rechargeOperators", (n) => floatKey("recharge", n)]]) {
    for (const { old, name } of changed(key)) {
      const from = keyOf(old), to = keyOf(name);
      if (from === to) continue;
      const snap = await getDoc(doc(db, "floats", from));
      if (snap.exists()) {
        ops.push(["set", doc(db, "floats", to), { ...snap.data(), updatedAt: serverTimestamp() }]);
        ops.push(["delete", doc(db, "floats", from)]);
      }
    }
    for (const old of removed(key)) {
      const ref = doc(db, "floats", keyOf(old));
      const snap = await getDoc(ref);
      if (snap.exists() && Number(snap.data().balance)) {
        throw new Error(`"${old}" still holds ${Number(snap.data().balance)} in its float. Cash it out before removing it.`);
      }
      if (snap.exists()) ops.push(["delete", ref]);
    }
  }

  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    for (const [op, ref, data] of ops.slice(i, i + 400)) {
      if (op === "update") batch.update(ref, data);
      else if (op === "set") batch.set(ref, data);
      else batch.delete(ref);
    }
    await batch.commit();
  }
  return ops.length;
}

async function viewLists(body) {
  const [accSnap, prodSnap, floatSnap] = await Promise.all([
    getDocs(collection(db, "accounts")), getDocs(collection(db, "products")), getDocs(collection(db, "floats")),
  ]);
  const products = prodSnap.docs.map((d) => d.data());
  // Float balance by key (wallet_bKash, operator_Robi). A wallet or operator with money in it cannot be deleted.
  const floatBal = Object.fromEntries(floatSnap.docs.map((d) => [d.id, Number(d.data().balance) || 0]));
  // Ledger accounts a till payment can post to: every asset account, plus any already in use.
  const allAccounts = accSnap.docs.map((d) => ({ code: d.id, ...d.data() }));
  const expenseAccounts = allAccounts.filter((a) => a.type === "expense");
  // Expense categories: name plus the ledger account each one posts to. New ones have no account yet.
  const ecState = expenseCategories(expenseAccounts).map((c) => ({ name: c.name, account: c.account || null }));
  const accounts = allAccounts.filter((a) => a.type === "asset");
  const accountChoices = [...new Map([
    ...accounts.map((a) => [a.code, a.name]),
    ...settings.paymentMethods.map((m) => [m.account, m.account]),
  ]).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const accountName = (code) => accountChoices.find(([c]) => c === code)?.[1] || "";

  // orig: the saved lists. ids: for each entry, its position in orig (null when it was just added).
  const orig = {
    categories: [...settings.categories],
    units: [...settings.units],
    writeOffReasons: [...settings.writeOffReasons],
    walletProviders: [...(settings.walletProviders || [])],
    rechargeOperators: [...(settings.rechargeOperators || [])],
    expiryDayOptions: (settings.expiryDayOptions || [30, 60, 90, 180]).map(String),
  };
  const ids = Object.fromEntries(Object.keys(orig).map((k) => [k, orig[k].map((_, i) => i)]));
  const state = {
    categories: [...settings.categories],
    units: [...settings.units],
    writeOffReasons: [...settings.writeOffReasons],
    walletProviders: [...(settings.walletProviders || [])],
    serviceFees: JSON.parse(JSON.stringify({ ...DEFAULT_SERVICE_FEES, ...(settings.serviceFees || {}) })),
    rechargeOperators: [...(settings.rechargeOperators || [])],
    methods: settings.paymentMethods.map((m) => ({ ...m, active: m.active !== false })),
    expiryDayOptions: (settings.expiryDayOptions || [30, 60, 90, 180]).map(String),
  };
  const walletKey = (name) => floatKey("cashin", name);
  const operatorKey = (name) => floatKey("recharge", name);

  // What uses an entry: products for categories and units, float money for wallets and operators.
  const usageOf = (listKey, value) => {
    if (listKey === "categories") return products.filter((p) => p.category === value).length;
    if (listKey === "units") return products.filter((p) => p.unit === value).length;
    return null;
  };
  const floatOf = (listKey, value) => {
    if (listKey === "walletProviders") return floatBal[walletKey(value)] || 0;
    if (listKey === "rechargeOperators") return floatBal[operatorKey(value)] || 0;
    return null;
  };
  const noteOf = (key, v) => {
    const u = usageOf(key, v);
    if (u !== null) return `${u} product${u === 1 ? "" : "s"}`;
    const f = floatOf(key, v);
    return f !== null ? `float ${money(f)}` : "";
  };
  // Why an entry cannot be deleted right now. Empty text means it can.
  const blockReason = (key, v) => {
    const n = usageOf(key, v);
    if (n) return `${n} product${n === 1 ? " uses" : "s use"} "${v}". Change ${n === 1 ? "it" : "them"} to another ${key === "units" ? "unit" : "category"} first.`;
    const f = floatOf(key, v);
    if (f) return `"${v}" still holds ${money(f)} in its float. Cash it out or send it first.`;
    return "";
  };

  // Each list has its own window with Edit, Delete and Add. Nothing is saved until "Save lists".
  const SECTIONS = {
    methods: { title: "Payment methods", help: "What staff see at the till, and the ledger account each one posts to.", noun: "payment method" },
    expense: { title: "Expense categories", help: "Each one has its own ledger account.", noun: "expense category" },
    categories: { title: "Product categories", help: "Used when adding products.", noun: "category" },
    units: { title: "Units of measure", help: "e.g. Pack, Strip, Bottle.", noun: "unit" },
    writeOffReasons: { title: "Write-off reasons", help: "Used when recording stock lost, damaged or expired.", noun: "reason" },
    fees: { title: "Service fees", help: "How the till works out each service fee.", noun: "fee" },
    walletProviders: { title: "Mobile wallets", help: "e.g. bKash, Nagad, Rocket.", noun: "wallet" },
    rechargeOperators: { title: "Mobile operators", help: "e.g. Grameenphone, Robi.", noun: "operator" },
    expiryDayOptions: { title: "Expiry report options", help: "Day choices in the expiry report, e.g. 30, 60, 90.", noun: "day option" },
  };
  const countOf = (key) => {
    if (key === "methods") return state.methods.length;
    if (key === "expense") return ecState.length;
    if (key === "fees") return Object.keys(SERVICE_TYPES).length;
    return state[key].length;
  };

  const root = document.createElement("div");
  body.innerHTML = "";
  body.appendChild(root);
  root.innerHTML = `
    <form id="lf" class="settings-form">
      <section class="card">
        <header class="card-head"><h3>Lists & payments</h3></header>
        <p class="muted small">Open a list to add, edit or delete its entries. Nothing changes until you press Save lists.</p>
        <div class="list-index" id="lf-index"></div>
      </section>
      <div class="sticky-actions">
        <button class="btn primary" type="submit">${icon("check")}<span>Save lists</span></button>
      </div>
    </form>`;

  const paintIndex = () => {
    root.querySelector("#lf-index").innerHTML = Object.keys(SECTIONS).map((key) => `
      <button type="button" class="list-row" data-open="${key}">
        <span class="list-row-main"><strong>${esc(SECTIONS[key].title)}</strong><small class="muted">${esc(SECTIONS[key].help)}</small></span>
        <span class="badge">${countOf(key)}</span>
      </button>`).join("");
  };
  paintIndex();

  // One window per list. The window is a modal; its views are the list, a form, a delete confirmation, or the fee rules.
  function openSection(key) {
    const sec = SECTIONS[key];
    openModal(sec.title, `<div class="ls-win"></div>`, (host, close) => {
      const win = host.querySelector(".ls-win");

      const rowHtml = (name, note, i, extraActions = "") => `
        <div class="li-row">
          <div class="li-main"><strong>${esc(name)}</strong>${note ? `<small class="muted">${esc(note)}</small>` : ""}</div>
          <div class="li-actions">
            ${extraActions}
            <button type="button" class="btn ghost sm" data-edit="${i}">${icon("edit")}<span>Edit</span></button>
            <button type="button" class="icon-btn sm hover-danger" data-del="${i}" aria-label="Delete ${esc(name)}">${icon("trash")}</button>
          </div>
        </div>`;

      const listView = () => {
        if (key === "fees") return feesView();
        const items = key === "methods" ? state.methods : key === "expense" ? ecState : state[key];
        const rows = items.map((it, i) => {
          if (key === "methods") {
            const top = i > 0 ? `<button type="button" class="btn ghost sm" data-top="${i}">Make default</button>` : "";
            const flags = [i === 0 ? "Default" : "", it.credit ? "On account" : "", it.active ? "" : "Hidden at till"].filter(Boolean).join(" · ");
            return rowHtml(it.label || "(no name)", `${it.account} · ${accountName(it.account)}${flags ? ` · ${flags}` : ""}`, i, top);
          }
          if (key === "expense") return rowHtml(it.name, it.account ? `ledger ${it.account}` : "new ledger account", i);
          return rowHtml(it, noteOf(key, it), i);
        }).join("");
        win.innerHTML = `
          <div class="li-head"><span class="badge">${items.length}</span><button type="button" class="btn primary sm" data-add>${icon("plus")}<span>Add ${esc(sec.noun)}</span></button></div>
          <div class="li-list">${rows || `<p class="muted small">Nothing here yet. Press Add to create one.</p>`}</div>
          <div class="form-actions"><button type="button" class="btn ghost" data-done>Done</button></div>`;
      };

      const formView = (i) => {
        const adding = i < 0;
        let fields;
        if (key === "methods") {
          const m = adding ? { label: "", account: accountChoices[0]?.[0] || "1000", credit: false, active: true } : state.methods[i];
          fields = `
            <label>Name<input name="name" maxlength="30" value="${esc(m.label)}" placeholder="Name shown to staff" required /></label>
            <label>Posts to ledger account<select name="account">${accountChoices.map(([code, name]) => `<option value="${esc(code)}" ${code === m.account ? "selected" : ""}>${esc(code)} · ${esc(name)}</option>`).join("")}</select></label>
            <label class="switch"><input type="checkbox" name="credit" ${m.credit ? "checked" : ""} /><span>Sale on account (customer pays later)</span></label>
            <label class="switch"><input type="checkbox" name="active" ${m.active ? "checked" : ""} /><span>Shown at the till</span></label>`;
        } else {
          const current = adding ? "" : key === "expense" ? ecState[i].name : state[key][i];
          fields = `<label>Name<input name="name" maxlength="40" value="${esc(current)}" required /></label>`;
        }
        win.innerHTML = `
          <form class="ls-form settings-form" data-kind="item" data-i="${i}">
            <h4>${adding ? "Add" : "Edit"} ${esc(sec.noun)}</h4>
            <div class="form-grid">${fields}</div>
            <div class="form-actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit">${icon("check")}<span>${adding ? "Add" : "Save"}</span></button></div>
          </form>`;
        win.querySelector('[name="name"]')?.focus();
      };

      // What the delete confirmation says. A blocked entry only shows why it cannot go.
      const deleteInfo = (i) => {
        if (key === "expense") return { msg: `Remove "${ecState[i].name}" from the list? Past expenses keep this category, and its ledger account is kept.` };
        if (key === "methods") {
          const m = state.methods[i];
          const others = state.methods.filter((x, j) => j !== i && x.active && !x.credit);
          if (!others.length && m.active && !m.credit) return { msg: "Keep at least one active cash-type payment method.", blocked: true };
          return { msg: `Delete "${m.label || "this payment method"}"? Past sales keep their payment record. It just stops being offered at the till.` };
        }
        const name = state[key][i];
        const why = blockReason(key, name);
        if (why) return { msg: why, blocked: true };
        return { msg: `Remove "${name}" from the list? Existing records keep their text.` };
      };
      const confirmView = (i) => {
        const { msg, blocked } = deleteInfo(i);
        win.innerHTML = `
          <div class="ls-confirm">
            <p>${esc(msg)}</p>
            <div class="form-actions">
              <button type="button" class="btn ghost" data-cancel>${blocked ? "Back" : "Cancel"}</button>
              ${blocked ? "" : `<button type="button" class="btn primary" data-yes="${i}">Delete</button>`}
            </div>
          </div>`;
      };

      const feesView = () => {
        win.innerHTML = `
          <form class="ls-form settings-form" data-kind="fees">
            <p class="muted small">The till works out the fee from these rules. Percent is a share of the amount. Min and max limit the fee; leave 0 for no limit.</p>
            <div class="fee-rules">
              ${Object.keys(SERVICE_TYPES).map((t) => { const r = state.serviceFees[t]; return `
                <div class="fee-row" data-fee="${t}">
                  <strong>${esc(SERVICE_TYPES[t].label)}</strong>
                  <select data-k="mode" aria-label="Fee type"><option value="percent" ${r.mode === "percent" ? "selected" : ""}>Percent of amount</option><option value="flat" ${r.mode === "flat" ? "selected" : ""}>Fixed amount</option></select>
                  <input data-k="value" type="number" step="0.01" min="0" value="${r.value}" aria-label="Fee value" />
                  <input data-k="min" type="number" step="0.01" min="0" value="${r.min}" aria-label="Minimum fee" placeholder="Min" />
                  <input data-k="max" type="number" step="0.01" min="0" value="${r.max}" aria-label="Maximum fee" placeholder="Max" />
                </div>`; }).join("")}
            </div>
            <div class="form-actions"><button type="button" class="btn ghost" data-done>Cancel</button><button class="btn primary" type="submit">${icon("check")}<span>Save fees</span></button></div>
          </form>`;
      };

      const go = (view, i) => {
        if (view === "form") return formView(i);
        if (view === "confirm") return confirmView(i);
        if (key === "fees") return feesView();
        return listView();
      };

      const performDelete = (i) => {
        if (key === "expense") ecState.splice(i, 1);
        else if (key === "methods") state.methods.splice(i, 1);
        else { state[key].splice(i, 1); ids[key].splice(i, 1); }
        paintIndex();
        go("list");
      };

      const saveItem = (f) => {
        const i = Number(f.dataset.i), adding = i < 0;
        const name = (f.querySelector('[name="name"]')?.value || "").trim();
        if (!name) return toast("Type a name first", "error");
        const taken = (list) => list.some((x, j) => j !== i && String(x).toLowerCase() === name.toLowerCase());
        if (key === "methods") {
          if (taken(state.methods.map((m) => m.label))) return toast("Another payment method has this name", "error");
          const data = {
            label: name,
            account: f.querySelector('[name="account"]').value,
            credit: f.querySelector('[name="credit"]').checked,
            active: f.querySelector('[name="active"]').checked,
          };
          if (adding) state.methods.push({ key: `m${Date.now().toString(36)}`, ...data });
          else state.methods[i] = { ...state.methods[i], ...data };
        } else if (key === "expense") {
          if (taken(ecState.map((c) => c.name))) return toast("That category already exists", "error");
          if (adding) ecState.push({ name, account: null });
          else ecState[i].name = name;
        } else {
          if (taken(state[key])) return toast("That is already in the list", "error");
          if (adding) { state[key].push(name); ids[key].push(null); }
          else state[key][i] = name;
        }
        paintIndex();
        go("list");
      };

      const saveFees = (f) => {
        f.querySelectorAll("[data-fee]").forEach((r) => {
          const t = r.dataset.fee, g = (k) => r.querySelector(`[data-k="${k}"]`);
          state.serviceFees[t] = { mode: g("mode").value, value: Number(g("value").value) || 0, min: Number(g("min").value) || 0, max: Number(g("max").value) || 0 };
        });
        paintIndex();
        close();
      };

      win.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.hasAttribute("data-done")) return close();
        if (b.hasAttribute("data-add")) return go("form", -1);
        if (b.hasAttribute("data-edit")) return go("form", Number(b.dataset.edit));
        if (b.hasAttribute("data-del")) return go("confirm", Number(b.dataset.del));
        if (b.hasAttribute("data-yes")) return performDelete(Number(b.dataset.yes));
        if (b.hasAttribute("data-cancel")) return go("list");
        if (b.hasAttribute("data-top")) {
          const i = Number(b.dataset.top);
          const [m] = state.methods.splice(i, 1);
          state.methods.unshift(m);
          paintIndex();
          go("list");
        }
      });
      win.addEventListener("submit", (e) => {
        e.preventDefault();
        const f = e.target;
        if (f.dataset.kind === "fees") return saveFees(f);
        saveItem(f);
      });

      go("list");
    });
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-open]");
    if (b) openSection(b.dataset.open);
  });

  onSubmit(root.querySelector("#lf"), async () => {
    for (const key of Object.keys(orig)) {
      if (state[key].some((v) => !v)) throw new Error("A list entry cannot be empty. Type a name or remove it.");
      const lower = state[key].map((v) => v.toLowerCase());
      if (new Set(lower).size !== lower.length) throw new Error("Two entries in one list have the same name.");
    }
    // Renames and removals reach the data they point to (products, wallet and operator floats) before the lists are saved.
    await applyListChanges({ orig, state, ids });
    const categories = clean(state.categories), units = clean(state.units), writeOffReasons = clean(state.writeOffReasons);
    const walletProviders = clean(state.walletProviders), rechargeOperators = clean(state.rechargeOperators);
    if (!categories.length || !units.length) throw new Error("Keep at least one category and one unit.");
    if (state.methods.some((m) => !m.label.trim())) throw new Error("Every payment method needs a name.");
    const names = state.methods.map((m) => m.label.trim().toLowerCase());
    if (new Set(names).size !== names.length) throw new Error("Two payment methods have the same name.");
    if (!state.methods.some((m) => m.active && !m.credit)) throw new Error("Keep at least one active payment method that is not on account.");
    const paymentMethods = state.methods.map((m) => ({
      key: m.key, label: m.label.trim(), account: m.account, credit: !!m.credit, active: !!m.active,
    }));
    const serviceFees = state.serviceFees;
    // Expense categories: a new one gets its own ledger account; a renamed one renames its account.
    if (ecState.some((c) => !c.name.trim())) throw new Error("An expense category cannot be empty.");
    const ecNames = ecState.map((c) => c.name.trim().toLowerCase());
    if (new Set(ecNames).size !== ecNames.length) throw new Error("Two expense categories have the same name.");
    const working = [...allAccounts];
    const expenseCategoriesOut = [];
    for (const c of ecState) {
      const name = c.name.trim();
      if (!c.account) {
        const code = nextExpenseCode(working);
        const account = { code, name, type: "expense", createdAt: serverTimestamp() };
        await setDoc(doc(db, "accounts", code), account);
        working.push(account);
        expenseCategoriesOut.push({ name, account: code });
      } else {
        const acc = working.find((a) => a.code === c.account);
        if (acc && acc.name !== name) await updateDoc(doc(db, "accounts", c.account), { name });
        if (acc) acc.name = name;
        expenseCategoriesOut.push({ name, account: c.account });
      }
    }
    const expiryDayOptions = clean(state.expiryDayOptions).map(Number);
    if (!expiryDayOptions.length || expiryDayOptions.some((d) => !Number.isInteger(d) || d < 1 || d > 3650)) {
      throw new Error("Expiry options must be whole numbers of days, from 1 to 3650.");
    }
    await saveGeneral({ categories, units, writeOffReasons, paymentMethods, walletProviders, rechargeOperators, serviceFees, expenseCategories: expenseCategoriesOut, expiryDayOptions }, "Lists saved. Reloading to apply them.");
  });
}

/* ───────── Button style: how the phone menu button looks ───────── */

const MENU_STYLES = [
  { key: "classic", label: "Classic", note: "Teal grid that turns a quarter when touched and opens into an X." },
  { key: "orbit", label: "Orbit", note: "A dashed ring turns slowly around the grid." },
  { key: "pulse", label: "Pulse", note: "A soft halo breathes out from the grid." },
  { key: "flip", label: "Flip", note: "Each square turns over, one after another, when opened." },
  { key: "neon", label: "Neon", note: "A teal glow lights up the grid when touched." },
];

async function viewButtonStyle(body) {
  const current = MENU_STYLES.some((s) => s.key === settings.menuStyle) ? settings.menuStyle : "classic";
  let chosen = current;
  const card = (s) => `
    <button type="button" class="style-card ${s.key === chosen ? "is-selected" : ""}" data-style="${s.key}">
      <span class="style-preview"><span class="menu-btn menu-style-${s.key}"><span class="menu-grid"><i></i><i></i><i></i><i></i></span></span></span>
      <strong>${esc(s.label)}</strong>
      <small class="muted">${esc(s.note)}</small>
      ${s.key === current ? `<span class="badge ok">In use</span>` : ""}
    </button>`;
  body.innerHTML = `
    <section class="card">
      <div class="toolbar">
        <div>
          <h3>Menu button style</h3>
          <p class="muted small">How the menu button looks on phones. Tap a style to see it open. Save to use it for everyone; the app reloads.</p>
        </div>
        <div class="grow"></div>
        <button class="btn primary" type="button" id="bs-save" ${chosen === current ? "disabled" : ""}>${icon("check")}<span>Save style</span></button>
      </div>
      <div class="style-grid">${MENU_STYLES.map(card).join("")}</div>
    </section>`;
  body.querySelectorAll(".style-card").forEach((c) => c.addEventListener("click", () => {
    chosen = c.dataset.style;
    body.querySelectorAll(".style-card").forEach((x) => x.classList.toggle("is-selected", x === c));
    c.querySelector(".menu-btn").classList.toggle("is-open");
    body.querySelector("#bs-save").disabled = chosen === current;
  }));
  body.querySelector("#bs-save").addEventListener("click", (e) => withBusy(e.currentTarget, () => saveGeneral({ menuStyle: chosen }, "Button style saved.")));
}

/* ───────── Role access ───────── */

const PAGE_KEYS = Object.keys(PAGE_NAMES);
const slugRole = (name) => String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);

function viewRoles(body) {
  // Working copy of every role. Each role is saved from its own permissions window.
  const working = structuredClone(roles);
  const drafts = new Set(); // new roles that are not saved yet

  const roleHost = document.createElement("div");
  const staffHost = document.createElement("div");
  body.replaceChildren(roleHost, staffHost);
  renderStaffCard(staffHost, () => viewRoles(body)).catch((err) => toast(err.message, "error"));

  const permBox = (name, label, checked, disabled) => `
    <label class="perm-box">
      <input type="checkbox" name="${name}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
      <span>${esc(label)}</span>
    </label>`;

  const draw = () => {
    roleHost.innerHTML = `
      <section class="card">
        <div class="toolbar">
          <div>
            <h3>Roles</h3>
            <p class="muted small">Open a role to tick the screens and data areas it can use. Staff get the change the next time they sign in. The database enforces it, not just the menu.</p>
          </div>
          <div class="grow"></div>
          <button class="btn primary" type="button" id="role-new">${icon("plus")}<span>New role</span></button>
        </div>
        <div class="role-list">
          ${Object.keys(working).map((k) => {
            const locked = k === "admin";
            const pages = locked ? PAGE_KEYS.length : (working[k].pages || []).length;
            const areas = locked ? WRITE_AREAS.length : (working[k].write || []).length;
            return `
            <article class="role-card ${locked ? "is-locked" : ""}">
              <div class="role-card-head">
                <div><strong>${esc(working[k].label)}</strong><small class="muted mono">${esc(k)}</small></div>
                ${locked ? `<span class="badge">Locked</span>` : drafts.has(k) ? `<span class="badge warn">Not saved</span>` : ""}
              </div>
              <div class="role-stats">
                <span><strong>${pages}</strong> of ${PAGE_KEYS.length} screens</span>
                <span><strong>${areas}</strong> of ${WRITE_AREAS.length} areas</span>
              </div>
              <div class="role-card-actions">
                <button class="btn primary sm" type="button" data-edit-role="${esc(k)}">${icon("edit")}<span>${locked ? "View" : "Permissions"}</span></button>
                ${locked ? "" : `<button class="icon-btn sm hover-danger" type="button" data-del-role="${esc(k)}" aria-label="Delete role ${esc(working[k].label)}" title="Delete role">${icon("trash")}</button>`}
              </div>
            </article>`;
          }).join("")}
        </div>
        <p class="muted small">Administrator always has every screen and every change area, so it cannot be locked out. A role that still has staff assigned cannot be deleted.</p>
      </section>`;
    bind();
  };

  function bind() {
    roleHost.querySelector("#role-new").addEventListener("click", openRoleName);
    roleHost.querySelectorAll("[data-edit-role]").forEach((b) => b.addEventListener("click", () => openRoleEditor(b.dataset.editRole)));
    roleHost.querySelectorAll("[data-del-role]").forEach((b) => b.addEventListener("click", () => deleteRole(b.dataset.delRole, b)));
  }

  function openRoleName() {
    openModal("New role", `
      <form id="nr" class="stack">
        <label class="field"><span class="field-label">Role name</span>
          <span class="input-wrap"><input name="name" maxlength="40" placeholder="e.g. Senior cashier" required /></span></label>
        <p class="muted small">Next you choose what this role can open and change.</p>
        <div class="form-actions"><button class="btn ghost" type="button" data-cancel>Cancel</button><button class="btn primary" type="submit"><span>Continue</span></button></div>
      </form>`, (m, close) => {
      m.querySelector("[data-cancel]").addEventListener("click", close);
      onSubmit(m.querySelector("#nr"), async (e) => {
        const name = String(new FormData(e.target).get("name") || "").trim();
        const key = slugRole(name);
        if (!key) throw new Error("Enter a name with letters or numbers.");
        if (key === "admin" || key in working) throw new Error("A role with this name already exists.");
        working[key] = { label: name, pages: ["dashboard"], write: [] };
        drafts.add(key);
        close();
        draw();
        openRoleEditor(key);
      });
    });
  }

  // One role's permissions in a modal: tick screens and data areas, then Save role.
  function openRoleEditor(key) {
    const r = working[key];
    const locked = key === "admin";
    openModal(`${locked ? "View" : "Permissions for"} ${r.label}`, `
      <form id="re" class="stack role-editor">
        ${locked ? "" : `<label class="field"><span class="field-label">Role name</span>
          <span class="input-wrap"><input name="label" maxlength="40" value="${esc(r.label)}" required /></span></label>`}
        <h4 class="perm-h">Screens they can open</h4>
        <div class="perm-grid">
          ${PAGE_KEYS.map((p) => permBox(`page__${p}`, PAGE_NAMES[p], locked || (r.pages || []).includes(p), locked)).join("")}
        </div>
        <h4 class="perm-h">Data they can change</h4>
        <div class="perm-grid">
          ${WRITE_AREAS.map((w) => permBox(`write__${w}`, WRITE_LABEL[w], locked || (r.write || []).includes(w), locked)).join("")}
        </div>
        <p class="muted small">${locked ? "Administrator always has every screen and every change area." : "Everyone with this role gets exactly the ticked screens and areas."}</p>
        <div class="form-actions">
          <button class="btn ghost" type="button" data-cancel>${locked ? "Close" : "Cancel"}</button>
          ${locked ? "" : `<button class="btn primary" type="submit">${icon("check")}<span>Save role</span></button>`}
        </div>
      </form>`, (m, close) => {
      m.querySelector("[data-cancel]").addEventListener("click", () => {
        if (drafts.has(key)) { delete working[key]; drafts.delete(key); draw(); }
        close();
      });
      if (locked) return;
      onSubmit(m.querySelector("#re"), async (e) => {
        const f = new FormData(e.target);
        working[key] = {
          label: String(f.get("label") || "").trim() || key,
          pages: PAGE_KEYS.filter((p) => f.get(`page__${p}`) === "on"),
          write: WRITE_AREAS.filter((w) => f.get(`write__${w}`) === "on"),
        };
        drafts.delete(key);
        close();
        await persistRoles();
      });
    });
  }

  // Saves every saved role (drafts are left out) and reloads so the new access applies.
  async function persistRoles() {
    const out = {};
    for (const k of Object.keys(working)) {
      if (drafts.has(k)) continue;
      const r = working[k];
      if (k === "admin") { out.admin = { label: r.label || "Administrator", pages: [...PAGE_KEYS], write: [...WRITE_AREAS] }; continue; }
      out[k] = { label: r.label, pages: r.pages, write: r.write };
    }
    if (!out.admin) throw new Error("The administrator role is required.");
    await setDoc(doc(db, "settings", "roles"), out);
    await audit("roles.update", { roles: Object.keys(out) });
    toast("Saved. Applying the new access…", "success");
    reloadKeepingPage(900);
  }

  const deleteRole = async (key, btn) => {
    if (key === "admin") return;
    await withBusy(btn, async () => {
      const snap = await getDocs(query(collection(db, "users"), where("role", "==", key)));
      if (snap.size > 0) return alertBox({ title: "Role is in use", tone: "warn", message: `${snap.size} staff member${snap.size === 1 ? " uses" : "s use"} this role. Move them to another role first.` });
      if (!(await confirmBox(`Delete the role "${working[key].label}"? Its permissions are removed.`))) return;
      delete working[key];
      if (drafts.has(key)) { drafts.delete(key); return draw(); }
      await persistRoles();
    });
  };

  draw();
}

/* ───────── Google Sheets ───────── */

async function viewIntegrations(body) {
  const snap = await getDoc(doc(db, "settings", "integrations"));
  const cfg = snap.exists() ? snap.data() : {};
  // Each connection opens in its own window with its own save.
  const WINDOWS = [
    { key: "sheets", title: "Google Sheets reporting", help: "A reporting copy of your sales, in a Google Sheet." },
    { key: "email", title: "Email sending", help: "Provider, sender address and the keys used to send emails." },
    { key: "coa", title: "Chart of accounts", help: "Adds any missing default ledger accounts." },
  ];
  body.innerHTML = `
    <section class="card">
      <h3>Connections</h3>
      <p class="muted small">Open a connection to change it. Each one has its own window and its own save.</p>
      <div class="list-index">${WINDOWS.map((w) => `
        <button type="button" class="list-row" data-int="${w.key}">
          <span class="list-row-main"><strong>${esc(w.title)}</strong><small class="muted">${esc(w.help)}</small></span>
          ${icon("edit")}
        </button>`).join("")}</div>
    </section>`;

  const openSheets = () => openModal("Google Sheets reporting", `
    <p class="muted small">Sheets is a reporting copy, not the live database. Set up the Apps Script described in the README, then paste its web-app URL here. Sign-in is not needed: the shared secret protects the link.</p>
    <form id="if" class="form-grid">
      <label class="span-2">Apps Script web-app URL<input name="sheetsUrl" type="url" inputmode="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg.sheetsUrl || "")}" /></label>
      <label class="span-2">Shared secret<input name="sheetsSecret" type="password" autocomplete="off" placeholder="${cfg.sheetsSecret ? "Saved. Type a new secret to replace it." : "Paste the secret from the script"}" /></label>
      <div class="form-actions span-2">
        <button type="button" class="btn ghost" id="if-test">${icon("sync")}<span>Test connection</span></button>
        <button class="btn primary" type="submit">${icon("check")}<span>Save</span></button>
      </div>
    </form>`, (host, close) => {
    const form = host.querySelector("#if");
    onSubmit(form, async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      await setDoc(doc(db, "settings", "integrations"), {
        sheetsUrl: String(f.get("sheetsUrl") || "").trim(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      // The secret is only written when a new one is typed, so saving the form never blanks it.
      if (String(f.get("sheetsSecret") || "")) {
        await setDoc(doc(db, "settings", "integrations"), { sheetsSecret: String(f.get("sheetsSecret")), updatedAt: serverTimestamp() }, { merge: true });
      }
      await audit("integrations.update", { sheets: true });
      toast("Google Sheets saved", "success");
      close();
    });
    onAction(host.querySelector("#if-test"), async () => {
      try {
        await pushToSheets("Connection test", ["Check", "Time"], [["Connected", new Date().toLocaleString()]]);
        toast("Connected. Check the “Connection test” tab.", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });

  const openEmail = () => openModal("Email sending", `
    <p class="muted small">Sends password reset codes, sign-in codes, new staff logins, admin resets and scheduled reports. Choose one provider and save. Secrets are stored for administrators only and are never shown again. Leave a secret field empty to keep the saved one.</p>
    <form id="ef" class="form-grid">
      <label class="span-2">Provider
        <select name="emailProvider">
          <option value="" ${!cfg.emailProvider ? "selected" : ""}>Automatic (saved key, else server settings)</option>
          <option value="resend" ${cfg.emailProvider === "resend" ? "selected" : ""}>Resend (API)</option>
          <option value="smtp" ${cfg.emailProvider === "smtp" ? "selected" : ""}>SMTP (Gmail or another mail server)</option>
        </select></label>
      <label class="span-2">Sender address (From)<input name="mailFrom" type="email" placeholder="noreply@yourdomain.com" value="${esc(cfg.mailFrom || "")}" /></label>
      <p class="span-2 muted small">Resend: the sender must be on a domain you verified in Resend. Gmail SMTP: use your Gmail address with an app password.</p>
      <fieldset class="span-2 packs-box">
        <legend>Resend</legend>
        <label class="span-2">API key<input name="resendApiKey" type="password" autocomplete="off" placeholder="${cfg.resendApiKey ? "Saved. Type a new key to replace it." : "re_…"}" /></label>
      </fieldset>
      <fieldset class="span-2 packs-box">
        <legend>SMTP</legend>
        <label>Host<input name="smtpHost" placeholder="smtp.gmail.com" value="${esc(cfg.smtpHost || "")}" /></label>
        <label>Port<input name="smtpPort" type="number" inputmode="numeric" placeholder="465" value="${esc(cfg.smtpPort || "")}" /></label>
        <label>Username<input name="smtpUser" autocomplete="off" value="${esc(cfg.smtpUser || "")}" /></label>
        <label>Password<input name="smtpPass" type="password" autocomplete="new-password" placeholder="${cfg.smtpPass ? "Saved. Type a new one to replace it." : ""}" /></label>
      </fieldset>
      <div class="form-actions span-2">
        <button type="button" class="btn ghost" id="ef-test">${icon("mail")}<span>Send test email to me</span></button>
        <button class="btn primary" type="submit">${icon("check")}<span>Save email settings</span></button>
      </div>
    </form>`, (host, close) => {
    const form = host.querySelector("#ef");
    onSubmit(form, async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const patch = {
        emailProvider: String(f.get("emailProvider") || ""),
        mailFrom: String(f.get("mailFrom") || "").trim(),
        smtpHost: String(f.get("smtpHost") || "").trim(),
        smtpPort: Number(f.get("smtpPort")) || 0,
        smtpUser: String(f.get("smtpUser") || "").trim(),
      };
      // Email secrets go to settings/secrets, which no browser can read back. Only typed values are written.
      const resendApiKey = String(f.get("resendApiKey") || "").trim();
      const smtpPass = String(f.get("smtpPass") || "");
      const secrets = {};
      if (resendApiKey) secrets.resendApiKey = resendApiKey;
      if (smtpPass) secrets.smtpPass = smtpPass;
      if (Object.keys(secrets).length) await setDoc(doc(db, "settings", "secrets"), { ...secrets, updatedAt: serverTimestamp() }, { merge: true });
      // Remove any secret that an older version stored in the readable integrations document.
      await setDoc(doc(db, "settings", "integrations"), { ...patch, resendApiKey: deleteField(), smtpPass: deleteField(), updatedAt: serverTimestamp() }, { merge: true });
      await audit("integrations.email", { provider: patch.emailProvider, from: patch.mailFrom });
      toast("Email settings saved", "success");
      close();
    });
    onAction(host.querySelector("#ef-test"), async () => {
      try {
        await post("/api/admin/mail", { action: "test" }, { secure: true });
        toast("Test email sent. Check your inbox and spam folder.", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });

  const openCoa = () => openModal("Chart of accounts", `
    <p class="muted small">Adds any missing default accounts. Existing accounts are not changed.</p>
    <div class="form-actions"><button class="btn primary" id="coa">${icon("accounting")}<span>Add missing default accounts</span></button></div>`, (host, close) => {
    onAction(host.querySelector("#coa"), async () => {
      await ensureChartOfAccounts();
      toast("Chart of accounts is up to date", "success");
      close();
    });
  });

  const OPEN = { sheets: openSheets, email: openEmail, coa: openCoa };
  body.querySelectorAll("[data-int]").forEach((b) => b.addEventListener("click", () => OPEN[b.dataset.int]()));
}

/* ───────── Audit log ───────── */

/* ───────── Permissions: pick a person, see every role's access side by side ───────── */

/* ───────── Staff page: one person's profile, role and screens/areas they can use ───────── */

const ACCESS_ICON = {
  dashboard: "dashboard", pos: "cart", shift: "accounting", inventory: "inventory", purchasing: "purchase",
  partners: "partners", accounting: "accounting", reports: "reports", admin: "admin",
};
const AREA_ICON = { pos: "cart", inventory: "inventory", purchasing: "purchase", partners: "partners", accounting: "accounting" };

// Opens one person's page. Everything about them is changed here and saved together.
// Opens one person's access in a modal: profile, role, and every screen and data area they may use.
async function openStaffAccess(uid, reload) {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return toast("This staff member no longer exists.", "error");
  const u = { id: uid, ...snap.data() };
  openModal(`Access · ${u.name || "staff"}`, `<div class="sa-modal" id="sa-root"></div>`, (mount, close) => {
    renderStaffAccess(mount.querySelector("#sa-root"), u, { close, reload });
  });
}

function renderStaffAccess(root, u, { close, reload }) {
  const uid = u.id;
  const roleKeys = Object.keys(roles);
  const isSelf = uid === session.uid;
  const roleDefaults = (role) => ({ pages: [...(roles[role]?.pages || [])], write: [...(roles[role]?.write || [])] });
  const hasOwn = !!u.access;

  // Working copy. Nothing is saved until "Save changes".
  const st = {
    name: u.name || "",
    active: u.active !== false,
    requireOtp: !!u.requireOtp,
    role: u.role || roleKeys[0],
    custom: hasOwn,
    ...(hasOwn ? { pages: [...(u.access.pages || [])], write: [...(u.access.write || [])] } : roleDefaults(u.role)),
  };
  const isAdminRole = () => st.role === "admin";
  const hasPage = (p) => isAdminRole() || st.pages.includes(p);
  const hasArea = (a) => isAdminRole() || st.write.includes(a);

  const summaryHtml = () => {
    const pages = isAdminRole() ? PAGE_KEYS.length : st.pages.length;
    const areas = isAdminRole() ? WRITE_AREAS.length : st.write.length;
    return `<div class="sa-stat"><strong>${pages}</strong><small>of ${PAGE_KEYS.length} screens</small></div>
            <div class="sa-stat"><strong>${areas}</strong><small>of ${WRITE_AREAS.length} data areas</small></div>`;
  };

  // Permission matrix: one row per screen or data area. Columns: each role's access, this person's access, and what changed.
  const matrixHtml = () => {
    const base = (kind, key) => (kind === "page" ? roles[st.role]?.pages || [] : roles[st.role]?.write || []).includes(key);
    const mine = (kind, key) => (kind === "page" ? hasPage(key) : hasArea(key));
    const rowHtml = (kind, key, label, ico) => {
      const m = mine(kind, key), d = base(kind, key);
      const change = m === d ? `<span class="mx-same">Same as role</span>` : m ? `<span class="mx-add">Added</span>` : `<span class="mx-rm">Removed</span>`;
      return `
        <tr>
          <th scope="row"><span class="mx-name">${icon(ico)}<span>${esc(label)}</span></span></th>
          ${roleKeys.map((k) => {
            const on = k === "admin" || (kind === "page" ? (roles[k]?.pages || []).includes(key) : (roles[k]?.write || []).includes(key));
            return `<td class="c"><span class="mx-dot ${on ? "on" : ""}">${on ? "✓" : ""}</span></td>`;
          }).join("")}
          <td class="c mx-me"><label class="mx-toggle"><input type="checkbox" data-${kind}="${key}" ${m ? "checked" : ""} ${isAdminRole() ? "disabled" : ""} aria-label="${esc(label)} for this person" /><span></span></label></td>
          <td class="c">${isAdminRole() ? `<span class="mx-same">Always</span>` : change}</td>
        </tr>`;
    };
    const head = `<tr><th>Screen or data</th>${roleKeys.map((k) => `<th class="c">${esc(roles[k]?.label || k)}</th>`).join("")}<th class="c mx-me">This person</th><th class="c">Compared to role</th></tr>`;
    const group = (t) => `<tr class="mx-group"><th colspan="${roleKeys.length + 3}">${esc(t)}</th></tr>`;
    return `
      <div class="table-wrap"><table class="mx-table">
        <thead>${head}</thead>
        <tbody>
          ${group("Screens they can open")}
          ${PAGE_KEYS.map((p) => rowHtml("page", p, PAGE_NAMES[p], ACCESS_ICON[p] || "dashboard")).join("")}
          ${group("Data they can change")}
          ${WRITE_AREAS.map((a) => rowHtml("area", a, WRITE_LABEL[a], AREA_ICON[a] || "inventory")).join("")}
        </tbody>
      </table></div>`;
  };
  const matrixCard = () => `
    <section class="card">
      <header class="card-head"><h3>Permission matrix</h3><span class="muted small">Switch the last column to give or take away access for this person. The role columns show what each role allows.</span></header>
      <div id="sa-matrix">${matrixHtml()}</div>
    </section>`;

  const roleCardsHtml = () => `
    <div class="sa-roles">
      ${roleKeys.map((k) => `
        <label class="sa-role ${st.role === k ? "on" : ""}">
          <input type="radio" name="role" value="${esc(k)}" ${st.role === k ? "checked" : ""} />
          <strong>${esc(roles[k].label)}</strong>
          <small>${k === "admin" ? "Everything, always" : `${(roles[k].pages || []).length} screens · ${(roles[k].write || []).length} areas`}</small>
        </label>`).join("")}
    </div>`;

  const paint = () => {
    root.innerHTML = `
      <div class="sa-page">
        <div class="sa-top">
          <span class="muted small">Changes apply the next time this person signs in.</span>
        </div>

        <section class="card sa-hero">
          <div class="avatar-ring big"><div class="avatar">${esc((st.name || "?").trim().charAt(0).toUpperCase())}</div></div>
          <div class="sa-hero-text">
            <h2>${esc(st.name || "Unnamed")}</h2>
            <small class="muted">${esc(u.email || "")}</small>
            <div class="sa-chips">
              <span class="role-pill">${esc(roles[st.role]?.label || st.role)}</span>
              <span class="badge ${st.active ? "ok" : "danger"}">${st.active ? "Active" : "Disabled"}</span>
              ${st.requireOtp ? `<span class="badge warn">Email code at sign-in</span>` : ""}
              ${st.custom && !isAdminRole() ? `<span class="badge">Custom access</span>` : ""}
            </div>
          </div>
          <div class="sa-stats" id="sa-stats">${summaryHtml()}</div>
        </section>

        <div class="sa-grid">
          <section class="card">
            <header class="card-head"><h3>Profile</h3></header>
            <label class="sa-field">Full name<input id="sa-name" value="${esc(st.name)}" maxlength="60" /></label>
            <label class="sa-switch-row"><input type="checkbox" id="sa-active" ${st.active ? "checked" : ""} ${isSelf ? "disabled" : ""} />
              <span><strong>Account active</strong><small>${isSelf ? "You cannot disable your own account." : "A disabled person cannot sign in."}</small></span></label>
            <label class="sa-switch-row"><input type="checkbox" id="sa-otp" ${st.requireOtp ? "checked" : ""} />
              <span><strong>Email code at every sign-in</strong><small>They enter a 6-digit code sent to their email each time they sign in.</small></span></label>
          </section>

          <section class="card">
            <header class="card-head"><h3>Role</h3></header>
            <p class="muted small">A role is a starting point. Change the screens and areas below to give this person more or less.</p>
            <div id="sa-roles">${roleCardsHtml()}</div>
            <label class="sa-switch-row"><input type="checkbox" id="sa-standard" ${st.custom ? "" : "checked"} ${isAdminRole() ? "disabled" : ""} />
              <span><strong>Use the role's standard access</strong><small>Untick to choose screens and areas for this person.</small></span></label>
          </section>
        </div>

        ${matrixCard()}

        ${isAdminRole() ? `<p class="muted small center">Administrators always have every screen and area. Change their role to limit them.</p>` : ""}

        <div class="form-actions sa-actions">
          <button class="btn ghost" data-back>Cancel</button>
          <button class="btn primary" id="sa-save">${icon("check")}<span>Save changes</span></button>
        </div>
      </div>`;
    bind();
  };

  const refreshTiles = () => {
    root.querySelector("#sa-stats").innerHTML = summaryHtml();
    root.querySelector("#sa-matrix").innerHTML = matrixHtml();
    root.querySelector("#sa-roles").innerHTML = roleCardsHtml();
    bind();
  };

  function bind() {
    root.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => close()));
    root.querySelector("#sa-name").addEventListener("input", (e) => { st.name = e.target.value; });
    root.querySelector("#sa-active").addEventListener("change", (e) => { st.active = e.target.checked; });
    root.querySelector("#sa-otp").addEventListener("change", (e) => { st.requireOtp = e.target.checked; });
    root.querySelector("#sa-standard").addEventListener("change", (e) => {
      st.custom = !e.target.checked;
      if (!st.custom) Object.assign(st, roleDefaults(st.role));
      refreshTiles();
    });
    root.querySelectorAll("[name=role]").forEach((r) => r.addEventListener("change", () => {
      st.role = r.value;
      if (!st.custom) Object.assign(st, roleDefaults(st.role));
      refreshTiles();
    }));
    root.querySelectorAll("[data-page]").forEach((c) => c.addEventListener("change", (e) => {
      st.custom = true;
      const p = e.target.dataset.page;
      st.pages = e.target.checked ? [...new Set([...st.pages, p])] : st.pages.filter((x) => x !== p);
      refreshTiles();
    }));
    root.querySelectorAll("[data-area]").forEach((c) => c.addEventListener("change", (e) => {
      st.custom = true;
      const a = e.target.dataset.area;
      st.write = e.target.checked ? [...new Set([...st.write, a])] : st.write.filter((x) => x !== a);
      refreshTiles();
    }));
    onAction(root.querySelector("#sa-save"), async () => {
      const name = st.name.trim();
      if (!name) throw new Error("Give them a name.");
      if (isSelf && st.role !== "admin") throw new Error("You cannot remove your own admin access.");
      if (isSelf && !st.active) throw new Error("You cannot disable your own account.");
      if (!isAdminRole() && st.custom && !st.pages.length) throw new Error("Give them at least one screen.");
      const access = st.custom && !isAdminRole() ? { pages: [...st.pages], write: [...st.write] } : null;
      await updateDoc(doc(db, "users", uid), {
        name, active: st.active, requireOtp: st.requireOtp, role: st.role, access, updatedAt: serverTimestamp(),
      });
      await audit("user.access", { id: uid, role: st.role, custom: !!access, requireOtp: st.requireOtp });
      toast("Saved. The change applies the next time they sign in.", "success");
      close();
      reload();
    });
  }

  paint();
}

/* ───────── Scheduled reports: send chosen reports by email at a set time each day ───────── */

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const localTime = (tz) => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const g = (t) => parts.find((p) => p.type === t).value;
    return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: Number(g("hour")) * 60 + Number(g("minute")) };
  } catch { return null; }
};

async function viewScheduledReports(body) {
  const ref = doc(db, "settings", "reportSchedules");
  const snap = await getDoc(ref);
  let items = (snap.data()?.items || []).map((s) => ({ ...s }));
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const card = (s, i) => `
    <article class="sched-card" data-i="${i}">
      <header class="sched-head">
        <input class="sched-name" data-k="name" value="${esc(s.name || "")}" maxlength="50" aria-label="Schedule name" />
        <label class="switch"><input type="checkbox" data-k="enabled" ${s.enabled ? "checked" : ""} /><span>On</span></label>
        <button type="button" class="icon-btn sm hover-danger" data-remove aria-label="Remove schedule">${icon("trash")}</button>
      </header>
      <div class="sched-grid">
        <label>Send at<input type="time" data-k="time" value="${esc(s.time || "02:00")}" /></label>
        <label>Shop time zone<input data-k="timezone" value="${esc(s.timezone || browserTz)}" /></label>
        <fieldset class="sched-fmt"><legend>File type</legend>
          <label class="check"><input type="checkbox" data-fmt="pdf" ${(s.formats || ["pdf"]).includes("pdf") ? "checked" : ""} /> PDF</label>
          <label class="check"><input type="checkbox" data-fmt="xlsx" ${(s.formats || []).includes("xlsx") ? "checked" : ""} /> Excel</label>
        </fieldset>
        <fieldset class="span-2 sched-recip"><legend>Send to</legend>
          ${(s.recipients?.length ? s.recipients : [""]).map((r, j) => `
          <div class="recip-row" data-j="${j}">
            <input type="email" data-rec value="${esc(r)}" placeholder="name@shop.com" aria-label="Recipient email" />
            <button type="button" class="icon-btn sm hover-danger" data-rec-remove aria-label="Remove this email">${icon("trash")}</button>
          </div>`).join("")}
          <button type="button" class="btn ghost sm" data-rec-add>${icon("plus")}<span>Add email</span></button>
        </fieldset>
      </div>
      <fieldset class="sched-reports"><legend>Reports to include</legend>
        ${REPORTS.map(([k, l]) => `<label class="check"><input type="checkbox" data-rep="${k}" ${(s.reports || []).includes(k) ? "checked" : ""} /> ${esc(l)}</label>`).join("")}
      </fieldset>
      <footer class="sched-foot">
        <small class="muted">${s.lastRunStatus ? esc(s.lastRunStatus) : "Not sent yet"}</small>
        <button type="button" class="btn ghost sm" data-now>${icon("mail")}<span>Send yesterday now</span></button>
      </footer>
    </article>`;

  const paint = () => {
    body.innerHTML = `
      <section class="card sched-intro">
        <div class="toolbar wrap">
          <div>
            <h3>Scheduled reports by email</h3>
            <p class="muted small">Each schedule emails the reports you tick for <strong>yesterday</strong>, at the time you set, in the shop's time zone. Sent as PDF and/or Excel files.</p>
          </div>
          <div class="grow"></div>
          <button class="btn ghost" id="sc-add">${icon("plus")}<span>Add schedule</span></button>
          <button class="btn primary" id="sc-save">${icon("check")}<span>Save schedules</span></button>
        </div>
      </section>
      ${items.map(card).join("") || `<section class="card"><p class="muted center">No schedules yet. Add one to start sending reports by email.</p></section>`}`;
    bind();
  };

  // Reads everything typed on screen into items before any change.
  const read = () => {
    body.querySelectorAll(".sched-card").forEach((c) => {
      const i = Number(c.dataset.i);
      const s = items[i];
      if (!s) return;
      s.name = c.querySelector('[data-k="name"]').value.trim();
      s.enabled = c.querySelector('[data-k="enabled"]').checked;
      s.time = c.querySelector('[data-k="time"]').value;
      s.timezone = c.querySelector('[data-k="timezone"]').value.trim();
      s.formats = [...c.querySelectorAll("[data-fmt]")].filter((x) => x.checked).map((x) => x.dataset.fmt);
      s.reports = [...c.querySelectorAll("[data-rep]")].filter((x) => x.checked).map((x) => x.dataset.rep);
      s.recipients = [...c.querySelectorAll("[data-rec]")].map((x) => x.value.trim());
    });
  };

  const validate = () => {
    for (const s of items) {
      s.recipients = (s.recipients || []).map((v) => (v || "").trim()).filter(Boolean);
      if (!s.name) throw new Error("Give every schedule a name.");
      if (!/^\d{2}:\d{2}$/.test(s.time || "")) throw new Error(`Set the send time for "${s.name}".`);
      if (!localTime(s.timezone)) throw new Error(`"${s.timezone}" is not a valid time zone, for example Asia/Qatar.`);
      if (!s.recipients.length) throw new Error(`Add at least one email for "${s.name}".`);
      const bad = s.recipients.find((e) => !isEmail(e));
      if (bad) throw new Error(`"${bad}" is not a valid email address.`);
      if (!s.reports.length) throw new Error(`Tick at least one report for "${s.name}".`);
      if (!s.formats.length) throw new Error(`Choose PDF or Excel for "${s.name}".`);
    }
  };

  const save = async () => {
    read();
    validate();
    // A schedule whose time has already passed today starts from tomorrow, so saving does not send a report straight away.
    items.forEach((s) => {
      const now = localTime(s.timezone);
      const at = Number(s.time.slice(0, 2)) * 60 + Number(s.time.slice(3, 5));
      if (s.enabled && now && now.minutes >= at && s.lastRunDate !== now.date) s.lastRunDate = now.date;
    });
    await setDoc(ref, { items, updatedAt: serverTimestamp() }, { merge: true });
    await audit("reports.schedule", { count: items.length });
  };

  function bind() {
    body.querySelector("#sc-add").addEventListener("click", () => {
      read();
      items.push({ id: `s${Date.now().toString(36)}`, name: "Daily reports", enabled: true, time: "02:00", timezone: browserTz, formats: ["pdf", "xlsx"], reports: ["sales", "daily", "pl", "expenses", "services"], recipients: [] });
      paint();
    });
    onAction(body.querySelector("#sc-save"), async () => {
      try { await save(); toast("Schedules saved", "success"); paint(); } catch (err) { toast(err.message, "error"); }
    });
    body.querySelectorAll("[data-rec-add]").forEach((b) => b.addEventListener("click", () => {
      read();
      const i = Number(b.closest(".sched-card").dataset.i);
      if (!items[i]) return;
      items[i].recipients = [...(items[i].recipients || []), ""];
      paint();
    }));
    body.querySelectorAll("[data-rec-remove]").forEach((b) => b.addEventListener("click", () => {
      read();
      const i = Number(b.closest(".sched-card").dataset.i);
      const j = Number(b.closest(".recip-row").dataset.j);
      if (!items[i]) return;
      items[i].recipients.splice(j, 1);
      paint();
    }));
    body.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => {
      read();
      const i = Number(b.closest(".sched-card").dataset.i);
      confirmBox(`Remove "${items[i].name}"? It will not send again.`).then((ok) => { if (ok) { items.splice(i, 1); paint(); } });
    }));
    body.querySelectorAll("[data-now]").forEach((b) => b.addEventListener("click", async () => {
      const i = Number(b.closest(".sched-card").dataset.i);
      try {
        // The button spins until the reports are sent, so a press is never silent.
        await withBusy(b, async () => {
          await save();
          const out = await post("/api/admin/mail", { action: "report", scheduleId: items[i].id }, { secure: true });
          toast(`Sent the reports for ${out.reportDate} to ${out.to.join ? out.to.join(", ") : out.to}`, "success");
        });
      } catch (err) {
        toast(err.message, "error");
      }
    }));
  }

  paint();
}

const AUDIT_LABELS = {
  "user.update": "Changed a user's role or status",
  "user.access": "Changed a user's access",
  "settings.update": "Changed shop settings",
  "roles.update": "Changed role permissions",
  "integrations.update": "Updated Google Sheets reporting",
  "integrations.email": "Updated email sending",
  "reports.schedule": "Changed scheduled reports",
  "branding.logo": "Changed the shop logo",
  "branding.update": "Changed the app name or colour",
  "emails.update": "Edited an email template",
  "app.rollback": "Rolled back the app version",
};
const AUDIT_AREAS = { user: "Users & access", settings: "Shop settings", roles: "Roles & access", integrations: "Integrations", reports: "Reports", branding: "Branding & email", emails: "Branding & email", app: "App version" };
const AUDIT_DETAIL = { role: "Role", active: "Active", requireOtp: "Sign-in code", keys: "Changed", roles: "Roles", count: "Items", provider: "Provider", from: "Sender", template: "Email", changed: "Logo changed", appName: "App name", brandColor: "Brand colour", sheets: "Google Sheets", custom: "Custom access" };
const humanize = (s) => {
  const t = String(s || "").replace(/[._]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : "Change";
};
// Turns one stored detail into readable text. Ids and nested objects are left out.
const detailText = (k, v) => {
  if (k === "id" || v === null || v === undefined || v === "") return "";
  if (typeof v === "object" && !Array.isArray(v)) return "";
  const label = AUDIT_DETAIL[k] || humanize(k);
  if (typeof v === "boolean") return `${label}: ${v ? "Yes" : "No"}`;
  if (Array.isArray(v)) return `${label}: ${v.length ? v.map((x) => humanize(x)).join(", ") : "None"}`;
  return `${label}: ${v}`;
};
const dayKey = (d) => d.toLocaleDateString("en-CA");
const dayName = (d) => {
  if (dayKey(d) === dayKey(new Date())) return "Today";
  if (dayKey(d) === dayKey(new Date(Date.now() - 864e5))) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
};

/* ───────── Daily backup ───────── */

const BK_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function viewBackup(body) {
  const ref = doc(db, "settings", "backupSchedule");
  const s = (await getDoc(ref)).data() || {};
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const recipRow = (v = "") => `
    <div class="recip-row">
      <input type="email" data-rec value="${esc(v)}" placeholder="name@shop.com" aria-label="Recipient email" />
      <button type="button" class="icon-btn sm hover-danger" data-rec-remove aria-label="Remove this email">${icon("trash")}</button>
    </div>`;
  body.innerHTML = `
    <section class="card">
      <h3>Daily backup</h3>
      <p class="muted small">Once a day, at the time you choose, the app emails a zip file of all shop data (sales, stock, customers, accounts, journal, users and settings) to the addresses below. Passwords and keys are never included. The backup holds customer and staff information, so only send it to trusted addresses.</p>
      <form id="bk-form" class="form-grid">
        <label class="check span-2"><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""} /> Send a backup every day</label>
        <label>Send at<input type="time" name="time" value="${esc(s.time || "03:00")}" /></label>
        <label>Shop time zone<input name="timezone" value="${esc(s.timezone || browserTz)}" /></label>
        <fieldset class="span-2 sched-recip"><legend>Send to</legend>
          <div id="bk-recip">${(s.recipients?.length ? s.recipients : [""]).map((r) => recipRow(r)).join("")}</div>
          <button type="button" class="btn ghost sm" id="bk-add">${icon("plus")}<span>Add email</span></button>
        </fieldset>
        <p class="span-2 muted small">Last run: ${esc(s.lastRunStatus || "Not run yet")}</p>
        <div class="form-actions span-2">
          <button type="button" class="btn ghost" id="bk-now">${icon("mail")}<span>Send backup now</span></button>
          <button class="btn primary" type="submit">${icon("check")}<span>Save backup settings</span></button>
        </div>
        <p class="span-2 muted small">"Send backup now" uses the saved settings, so save first.</p>
      </form>
    </section>`;

  const list = body.querySelector("#bk-recip");
  body.querySelector("#bk-add").addEventListener("click", () => list.insertAdjacentHTML("beforeend", recipRow()));
  list.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rec-remove]");
    if (!btn) return;
    btn.closest(".recip-row").remove();
    if (!list.querySelector(".recip-row")) list.insertAdjacentHTML("beforeend", recipRow());
  });

  const form = body.querySelector("#bk-form");
  const emails = () => [...body.querySelectorAll("[data-rec]")].map((i) => i.value.trim().toLowerCase()).filter(Boolean);
  onSubmit(form, async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const addresses = [...new Set(emails())];
    const bad = addresses.filter((v) => !BK_EMAIL_RE.test(v));
    if (bad.length) { toast(`Check these addresses: ${bad.join(", ")}`, "error"); return; }
    await setDoc(ref, {
      enabled: f.get("enabled") === "on",
      time: String(f.get("time") || "03:00"),
      timezone: String(f.get("timezone") || "").trim() || browserTz,
      recipients: addresses,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    await audit("backup.update", { enabled: f.get("enabled") === "on", recipients: addresses.length });
    toast("Backup settings saved", "success");
  });

  const now = body.querySelector("#bk-now");
  onAction(now, () => withBusy(now, async () => {
    const r = await post("/api/admin/mail", { action: "backup" }, { secure: true });
    toast(`Backup sent to ${r.to.join(", ")} (${r.sizeMb} MB)`, "success");
  }));
}

async function viewAudit(body) {
  const snap = await getDocs(query(collection(db, "audit"), orderBy("at", "desc"), limit(200)));
  const entries = snap.docs.map((d) => {
    const a = d.data();
    const when = a.at?.toDate ? a.at.toDate() : a.at ? new Date(a.at) : new Date();
    const action = String(a.action || "");
    return {
      when,
      area: AUDIT_AREAS[action.split(".")[0]] || "Other",
      label: AUDIT_LABELS[action] || humanize(action),
      who: a.by || "Unknown user",
      details: Object.entries(a.details || {}).map(([k, v]) => detailText(k, v)).filter(Boolean),
    };
  });
  const areas = [...new Set(entries.map((e) => e.area))].sort();
  const groups = [];
  for (const e of entries) {
    const key = dayKey(e.when);
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, name: dayName(e.when), rows: [] }));
    g.rows.push(e);
  }
  const time = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  body.innerHTML = `
    <section class="card">
      <h3>Activity log</h3>
      <p class="muted small">Every change made in the admin screens, newest first. Showing the latest ${entries.length} entries.</p>
      <div class="al-tools">
        <input type="search" id="al-q" placeholder="Search by person, change or detail" aria-label="Search activity" />
        <select id="al-area" aria-label="Filter by area"><option value="">All areas</option>${areas.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("")}</select>
      </div>
      <div id="al-list">
        ${groups.map((g) => `
          <div class="al-group">
            <h4 class="al-day">${esc(g.name)}</h4>
            ${g.rows.map((e) => `
              <div class="al-row" data-area="${esc(e.area)}" data-text="${esc(`${e.label} ${e.who} ${e.details.join(" ")} ${e.area}`.toLowerCase())}">
                <div class="al-main">
                  <strong>${esc(e.label)}</strong>
                  <span class="muted small">${esc(e.who)} · ${esc(time(e.when))}</span>
                  ${e.details.length ? `<span class="al-details">${e.details.map((t) => esc(t)).join(" · ")}</span>` : ""}
                </div>
                <span class="badge">${esc(e.area)}</span>
              </div>`).join("")}
          </div>`).join("") || `<p class="muted center">No activity yet</p>`}
      </div>
      <p class="muted small center" id="al-empty" hidden>No activity matches your search.</p>
    </section>`;

  const q = body.querySelector("#al-q"), area = body.querySelector("#al-area");
  const apply = () => {
    const term = q.value.trim().toLowerCase(), pick = area.value;
    let shown = 0;
    body.querySelectorAll(".al-group").forEach((g) => {
      let n = 0;
      g.querySelectorAll(".al-row").forEach((r) => {
        const ok = (!pick || r.dataset.area === pick) && (!term || r.dataset.text.includes(term));
        r.hidden = !ok;
        if (ok) n++;
      });
      g.hidden = n === 0;
      shown += n;
    });
    body.querySelector("#al-empty").hidden = shown > 0 || !entries.length;
  };
  q.addEventListener("input", apply);
  area.addEventListener("change", apply);
}

/* ───────── Branding & email ───────── */

const LOGO_MAX_CHARS = 350_000;

const LOGO_TYPES = /\.(png|jpe?g|webp|heic|heif|gif|bmp)$/i;

// Decodes the picked file (including iPhone HEIC and large camera photos), scales it down and returns a PNG data URL.
async function readLogo(file) {
  const looksLikeImage = file.type?.startsWith("image/") || LOGO_TYPES.test(file.name || "");
  if (!looksLikeImage) throw new Error("Choose an image file (PNG, JPG, WebP or HEIC).");

  let source;
  try {
    // createImageBitmap handles EXIF rotation and large photos without loading the full image into the page.
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    source = await loadImageElement(file);
  }
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  if (!w || !h) throw new Error("This image could not be read. Try a PNG or JPG screenshot.");

  const scale = Math.min(1, 480 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  source.close?.();
  // PNG keeps transparency. Photos can be too big as PNG, so fall back to WebP, which is smaller and still transparent.
  let url = c.toDataURL("image/png");
  for (const q of [0.9, 0.7, 0.5]) {
    if (url.length <= LOGO_MAX_CHARS) break;
    url = c.toDataURL("image/webp", q);
  }
  if (url.length > LOGO_MAX_CHARS) throw new Error("That logo is still too large. Use a smaller image.");
  return url;
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(src); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error("This image format is not supported on this device. Choose a PNG or JPG, or take a screenshot of the logo."));
    };
    img.src = src;
  });
}

async function viewBranding(body) {
  const [bSnap, eSnap] = await Promise.all([getDoc(doc(db, "branding", "public")), getDoc(doc(db, "settings", "emails"))]);
  const brand = bSnap.exists() ? bSnap.data() : {};
  const stored = eSnap.exists() ? eSnap.data() : {};
  const tpl = (k) => ({ ...DEFAULT_TEMPLATES[k], ...(stored[k] || {}) });
  // Every text field a template uses (not its name or description) is editable here and saved.
  const tplFields = (k) => Object.keys(DEFAULT_TEMPLATES[k]).filter((x) => x !== "label" && x !== "help");
  const EMAIL_FIELD_LABELS = {
    subject: "Subject", eyebrow: "Small heading above the title", heading: "Title", greeting: "Greeting",
    intro: "Opening text", codeLabel: "Label above the code", body: "Message", expiryNote: "Expiry note",
    securityNote: "Security note", button: "Button text (leave empty for no button)",
  };
  const MULTI_LINE = ["body", "intro", "expiryNote", "securityNote"];

  body.innerHTML = `
    <form id="bf" class="settings-form">
      <section class="card">
        <h3>Loading screen</h3>
        <p class="muted small">Shown when the app opens and each time someone switches to another screen. Applies to everyone, including the sign-in page.</p>
        <div class="form-grid">
          <label class="span-2">Animation
            <div class="ls-pick">
              <select name="loadingStyle">${Object.entries(LOADING_STYLES).map(([k, v]) => `<option value="${k}" ${(brand.loadingStyle || "orbit") === k ? "selected" : ""}>${esc(v.name)}: ${esc(v.desc)}</option>`).join("")}</select>
              <button type="button" class="btn ghost sm" id="ls-preview">${icon("eye")}<span>Preview</span></button>
            </div>
          </label>
          <label>Message<input name="loadingMessage" maxlength="60" placeholder="Loading…" value="${esc(brand.loadingMessage || "")}" /></label>
        </div>
      </section>
      <section class="card">
        <h3>Brand colour</h3>
        <p class="muted small">Used for the header, code box and buttons in every email. The logo and shop name are set in Settings → Shop profile.</p>
        <div class="form-grid">
          <label>Brand colour<input type="color" name="brandColor" value="${esc(brand.brandColor || DEFAULT_BRAND_COLOR)}" /></label>
        </div>
      </section>
      <section class="card">
        <h3>Emails</h3>
        <p class="muted small">Open an email to change its wording. Each email has its own window, with its own save.</p>
        <div class="list-index">${Object.keys(DEFAULT_TEMPLATES).map((k) => `
          <button type="button" class="list-row" data-tpl="${k}">
            <span class="list-row-main"><strong>${esc(DEFAULT_TEMPLATES[k].label)}</strong><small class="muted">${esc(DEFAULT_TEMPLATES[k].help)}</small></span>
            ${icon("edit")}
          </button>`).join("")}</div>
      </section>
      <div class="sticky-actions">
        <button class="btn primary" type="submit">${icon("check")}<span>Save branding</span></button>
      </div>
    </form>`;

  body.querySelector("#ls-preview").addEventListener("click", () => {
    const msg = body.querySelector('[name="loadingMessage"]').value.trim() || "Loading…";
    const style = body.querySelector('[name="loadingStyle"]').value || "orbit";
    const loader = showRouteLoader(msg, style);
    setTimeout(() => hideRouteLoader(loader, 0), 2600);
  });

  const form = body.querySelector("#bf");
  form.noValidate = true;

  // One email at a time: its fields, Restore default text, and Save for that email only.
  const openTemplate = (k) => {
    const t = tpl(k);
    openModal(DEFAULT_TEMPLATES[k].label, `
      <form id="tf" class="settings-form">
        <p class="muted small">${esc(DEFAULT_TEMPLATES[k].help)} Placeholders: ${EMAIL_PLACEHOLDERS.map((p) => `<code>{{${p}}}</code>`).join(" ")}</p>
        <div class="form-grid">
          ${tplFields(k).map((fld) => {
            const val = esc(t[fld] ?? "");
            const label = EMAIL_FIELD_LABELS[fld] || fld;
            if (fld === "button") return `<label class="span-2">${esc(label)}<input name="${fld}" value="${val}" /></label>`;
            if (MULTI_LINE.includes(fld)) return `<label class="span-2">${esc(label)}<textarea name="${fld}" rows="${fld === "body" ? 7 : 3}">${val}</textarea></label>`;
            return `<label class="span-2">${esc(label)}<input name="${fld}" value="${val}" /></label>`;
          }).join("")}
        </div>
        <div class="form-actions"><button type="button" class="btn ghost" data-default>Restore default text</button><button class="btn primary" type="submit">${icon("check")}<span>Save this email</span></button></div>
      </form>`, (host, close) => {
      const tf = host.querySelector("#tf");
      tf.noValidate = true;
      tf.querySelector("[data-default]").addEventListener("click", () => {
        for (const fld of tplFields(k)) {
          const el = tf.querySelector(`[name="${fld}"]`);
          if (el) el.value = DEFAULT_TEMPLATES[k][fld] ?? "";
        }
        toast("Default text restored. Press Save this email to keep it.", "info");
      });
      onSubmit(tf, async (e) => {
        e.preventDefault();
        const fd = new FormData(tf);
        const vals = {};
        for (const fld of tplFields(k)) {
          const val = String(fd.get(fld) || "").trim();
          vals[fld] = fld === "button" ? val : (val || DEFAULT_TEMPLATES[k][fld]);
        }
        await setDoc(doc(db, "settings", "emails"), { [k]: vals, updatedAt: serverTimestamp() }, { merge: true });
        stored[k] = vals;
        await audit("emails.update", { template: k });
        toast(`${DEFAULT_TEMPLATES[k].label} saved`, "success");
        close();
      });
    });
  };
  body.querySelectorAll("[data-tpl]").forEach((b) => b.addEventListener("click", () => openTemplate(b.dataset.tpl)));

  onSubmit(form, async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const appName = settings.shopName || "MediPOS";
    const brandColor = /^#[0-9a-f]{6}$/i.test(String(f.get("brandColor") || "")) ? String(f.get("brandColor")) : DEFAULT_BRAND_COLOR;
    try {
      await setDoc(doc(db, "branding", "public"), {
        appName, shopName: settings.shopName, brandColor, updatedAt: serverTimestamp(),
        loadingMessage: String(f.get("loadingMessage") || "").trim().slice(0, 60),
        loadingStyle: LOADING_STYLES[f.get("loadingStyle")] ? String(f.get("loadingStyle")) : "orbit",
      }, { merge: true });
      await audit("branding.update", { appName, brandColor });
      toast("Branding saved", "success");
      await viewBranding(body); // show exactly what was saved
    } catch (err) {
      toast(err.message, "error");
    }
  });
}
