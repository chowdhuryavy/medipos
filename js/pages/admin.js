import { onSubmit, onAction, onDelegated, withBusy } from "../core.js";
import {
  auth, db, initializeApp, deleteApp, getAuth, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail, collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, query, where, orderBy, limit, serverTimestamp,
} from "../firebase.js";
import { firebaseConfig } from "../config.js";
import {
  session, roles, DEFAULT_ROLES, WRITE_AREAS, settings, DEFAULT_SETTINGS, esc, icon, toast, openModal, confirmBox, alertBox,
  audit, ensureChartOfAccounts, fmtDateTime,
} from "../core.js";

const WRITE_LABEL = {
  pos: "Sales & receipts", inventory: "Products & stock", purchasing: "Purchases",
  partners: "Customers & suppliers", accounting: "Journal, expenses & accounts",
};
import { pushToSheets } from "../sheets.js";
import { post } from "../api.js";
import { DEFAULT_TEMPLATES, EMAIL_PLACEHOLDERS, DEFAULT_BRAND_COLOR } from "../email-defaults.js";
import { DEFAULT_SERVICE_FEES, SERVICE_TYPES } from "../services.js";
import { REPORTS } from "../report-tables.js";

const TABS = [
  ["users", "Staff"],
  ["access", "Permissions"],
  ["settings", "Shop & rules"],
  ["lists", "Lists & payments"],
  ["roles", "Role access"],
  ["branding", "Branding & email"],
  ["reports", "Scheduled reports"],
  ["integrations", "Integrations"],
  ["audit", "Activity log"],
];
const PAGE_NAMES = {
  dashboard: "Dashboard", pos: "Sell", inventory: "Inventory", purchasing: "Purchasing", partners: "Customers & suppliers",
  accounting: "Accounting", reports: "Reports", admin: "Administration",
};

export async function render(el) {
  el.innerHTML = `
    <div class="tabs" role="tablist">
      ${TABS.map(([k, l], i) => `<button class="tab ${i === 0 ? "active" : ""}" data-tab="${k}" role="tab">${l}</button>`).join("")}
    </div>
    <div id="adm-body"></div>`;
  const body = el.querySelector("#adm-body");
  const views = { users: viewUsers, access: viewAccess, settings: viewSettings, lists: viewLists, roles: viewRoles, branding: viewBranding, reports: viewScheduledReports, integrations: viewIntegrations, audit: viewAudit };
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

async function viewUsers(body) {
  const snap = await getDocs(collection(db, "users"));
  const users = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  body.innerHTML = `
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
            <td data-label="Role"><span class="badge">${esc(roles[u.role]?.label || u.role)}</span></td>
            <td data-label="Status"><span class="badge ${u.active ? "ok" : "danger"}">${u.active ? "Active" : "Disabled"}</span></td>
            <td class="actions">
              <button class="icon-btn sm" data-edit="${esc(u.id)}" aria-label="Edit ${esc(u.name)}">${icon("edit")}</button>
              <button class="icon-btn sm" data-reset="${esc(u.id)}" aria-label="Send password reset email" title="Send password reset email">${icon("sync")}</button>
            </td></tr>`).join("") || `<tr><td colspan="5" class="muted center">No staff yet</td></tr>`}
        </tbody>
      </table></div>
    </section>`;

  body.querySelector("#u-new").addEventListener("click", () => openUserForm(null, () => viewUsers(body)));
  onDelegated(body, async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.edit) return openUserForm(users.find((u) => u.id === b.dataset.edit), () => viewUsers(body));
    if (b.dataset.reset) {
      const u = users.find((x) => x.id === b.dataset.reset);
      if (!(await confirmBox(`Reset ${u.name}'s password? A temporary password will be emailed to ${u.email}, and they must change it at sign-in.`))) return;
      try {
        await post("/api/admin/reset-password", { uid: u.id }, { secure: true });
        toast("Temporary password emailed", "success");
        reload();
      } catch (err) {
        toast(err.message, "error");
      }
    }
  });
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
      if (u && u.id === session.uid && (!active || role !== "admin")) {
        return toast("You cannot remove your own admin access", "error");
      }
      try {
        if (isNew) {
          const email = String(f.get("email") || "").trim();
          const created = await post("/api/admin/create-user", { name, email, role }, { secure: true });
          if (!active) await updateDoc(doc(db, "users", created.uid), { active: false });
        } else {
          await updateDoc(doc(db, "users", u.id), { name, role, active, updatedAt: serverTimestamp() });
          await audit("user.update", { id: u.id, role, active });
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
  ["Numbering", [
    ["invoicePrefix", "Invoice prefix", "text"],
    ["purchasePrefix", "Purchase prefix", "text"],
  ]],
  ["Password reset", [
    ["otpExpiryMinutes", "Reset code is valid for (minutes, 1–60)", "number"],
  ]],
  ["Inventory rules", [
    ["expiryWarnDays", "Warn this many days before expiry", "number"],
    ["floatWarnAmount", "Warn when a wallet or operator float falls below", "number"],
    ["defaultReorderLevel", "Default reorder level for new products", "number"],
  ]],
];

async function viewSettings(body) {
  const bSnap = await getDoc(doc(db, "branding", "public"));
  let logoUrl = (bSnap.exists() && bSnap.data().logoUrl) || "";
  let logoChanged = false;
  body.innerHTML = `
    <form id="sf" class="settings-form">
      <section class="card">
        <h3>Shop logo</h3>
        <p class="muted small">Shown on the sign-in page, the sidebar, the top bar, the dashboard, every email and as the app icon.</p>
        <div class="logo-editor">
          <div class="logo-preview" id="logo-preview">${logoUrl ? `<img src="${logoUrl}" alt="Current logo" />` : `<span class="muted small">No logo yet</span>`}</div>
          <div class="logo-actions">
            <label class="btn ghost sm file-btn">${icon("upload")}<span>Choose logo</span>
              <input type="file" id="logo-file" accept="image/*" hidden /></label>
            <button type="button" class="btn ghost sm" id="logo-remove">${icon("trash")}<span>Remove</span></button>
            <small class="muted">PNG with a transparent background works best. Saved when you press Save settings.</small>
          </div>
        </div>
      </section>
      ${FIELDS.map(([title, fields]) => `
        <section class="card">
          <h3>${esc(title)}</h3>
          <div class="form-grid">
            ${fields.map(([k, label, type]) => type === "bool"
              ? `<label class="check span-2"><input type="checkbox" name="${k}" ${settings[k] ? "checked" : ""} /> <span>${esc(label)}</span></label>`
              : `<label class="${k === "receiptFooter" || k === "shopAddress" ? "span-2" : ""}">${esc(label)}
                  <input name="${k}" type="${type}" ${type === "number" ? 'inputmode="decimal" step="any"' : ""} value="${esc(settings[k] ?? "")}" /></label>`).join("")}
          </div>
        </section>`).join("")}
      <div class="sticky-actions">
        <button type="button" class="btn ghost" id="s-reset">Restore defaults</button>
        <button class="btn primary" type="submit">${icon("check")}<span>Save settings</span></button>
      </div>
    </form>`;

  body.querySelector("#logo-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      logoUrl = await readLogo(file);
      logoChanged = true;
      body.querySelector("#logo-preview").innerHTML = `<img src="${logoUrl}" alt="New logo" />`;
    } catch (err) {
      toast(err.message, "error");
    }
    e.target.value = "";
  });
  body.querySelector("#logo-remove").addEventListener("click", () => {
    logoUrl = "";
    logoChanged = true;
    body.querySelector("#logo-preview").innerHTML = `<span class="muted small">No logo (the default icon is used)</span>`;
  });

  onSubmit(body.querySelector("#sf"), async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const patch = {};
    for (const [, fields] of FIELDS) {
      for (const [k, , type] of fields) {
        if (type === "bool") patch[k] = f.get(k) === "on";
        else if (type === "number") patch[k] = Number(f.get(k)) || 0;
        else patch[k] = String(f.get(k) || "").trim();
      }
    }
    if (!patch.currency) return toast("Currency code is required", "error");
    if (logoChanged) {
      await setDoc(doc(db, "branding", "public"), { logoUrl, updatedAt: serverTimestamp() }, { merge: true });
      await audit("branding.logo", { changed: true });
    }
    await saveGeneral(patch, "Settings saved. Reloading to apply them.");
  });

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
  setTimeout(() => location.reload(), 900);
}

/* ───────── Lists & payment methods ───────── */

/* ───────── Lists & payment methods ───────── */

const clean = (arr) => [...new Set(arr.map((v) => String(v).trim()).filter(Boolean))];

async function viewLists(body) {
  const [accSnap, prodSnap] = await Promise.all([getDocs(collection(db, "accounts")), getDocs(collection(db, "products"))]);
  const products = prodSnap.docs.map((d) => d.data());
  // Ledger accounts a till payment can post to: every asset account, plus any already in use.
  const accounts = accSnap.docs.map((d) => ({ code: d.id, ...d.data() })).filter((a) => a.type === "asset");
  const accountChoices = [...new Map([
    ...accounts.map((a) => [a.code, a.name]),
    ...settings.paymentMethods.map((m) => [m.account, m.account]),
  ]).entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const state = {
    categories: [...settings.categories],
    units: [...settings.units],
    writeOffReasons: [...settings.writeOffReasons],
    walletProviders: [...(settings.walletProviders || [])],
    serviceFees: JSON.parse(JSON.stringify({ ...DEFAULT_SERVICE_FEES, ...(settings.serviceFees || {}) })),
    rechargeOperators: [...(settings.rechargeOperators || [])],
    methods: settings.paymentMethods.map((m) => ({ ...m, active: m.active !== false })),
  };

  const root = document.createElement("div");
  body.innerHTML = "";
  body.appendChild(root);

  // Read what is typed in the payment-method cards into state before anything is re-drawn.
  const syncFromDom = () => {
    root.querySelectorAll("[data-fee]").forEach((r) => {
      const t = r.dataset.fee, f = (k) => r.querySelector(`[data-k="${k}"]`);
      state.serviceFees[t] = { mode: f("mode").value, value: Number(f("value").value) || 0, min: Number(f("min").value) || 0, max: Number(f("max").value) || 0 };
    });
    root.querySelectorAll(".pm-card").forEach((c, i) => {
      const m = state.methods[i];
      if (!m) return;
      m.label = c.querySelector('[data-f="label"]').value;
      m.account = c.querySelector('[data-f="account"]').value;
      m.credit = c.querySelector('[data-f="credit"]').checked;
      m.active = c.querySelector('[data-f="active"]').checked;
    });
  };

  const usageOf = (listKey, value) => {
    if (listKey === "categories") return products.filter((p) => p.category === value).length;
    if (listKey === "units") return products.filter((p) => p.unit === value).length;
    return null;
  };

  const chipSection = (key, title, help) => `
    <section class="card list-card" data-list="${key}">
      <header class="card-head"><h3>${title}</h3><span class="badge">${state[key].length}</span></header>
      <p class="muted small">${help}</p>
      <div class="chips-edit">
        ${state[key].map((v, i) => {
          const used = usageOf(key, v);
          return `<span class="chip-edit">${esc(v)}${used !== null ? `<small>${used} product${used === 1 ? "" : "s"}</small>` : ""}
            <button type="button" class="chip-x" data-rm-chip="${i}" aria-label="Remove ${esc(v)}">×</button></span>`;
        }).join("") || `<span class="muted small">Nothing here yet.</span>`}
      </div>
      <div class="add-row">
        <input data-new maxlength="40" placeholder="Type a new one, then press Enter" aria-label="New ${esc(title)}" />
        <button type="button" class="btn ghost sm" data-add-chip>${icon("plus")}<span>Add</span></button>
      </div>
    </section>`;

  const methodCard = (m, i) => `
    <article class="pm-card ${m.active ? "" : "is-off"}" style="--d:${i * 70}ms">
      <div class="pm-top">
        <span class="pm-num">${i === 0 ? "Default" : `#${i + 1}`}</span>
        <input data-f="label" value="${esc(m.label)}" placeholder="Name shown to staff" maxlength="30" aria-label="Payment method name" />
        <div class="pm-move">
          ${i > 0 ? `<button type="button" class="icon-btn sm" data-pm-up="${i}" aria-label="Move up">↑</button>` : ""}
          ${i > 0 ? `<button type="button" class="btn ghost sm" data-pm-top="${i}">Make default</button>` : ""}
          <button type="button" class="icon-btn sm hover-danger" data-pm-del="${i}" aria-label="Delete ${esc(m.label)}">${icon("trash")}</button>
        </div>
      </div>
      <div class="pm-bottom">
        <label class="pm-account">Posts to ledger account
          <select data-f="account">${accountChoices.map(([code, name]) => `<option value="${esc(code)}" ${code === m.account ? "selected" : ""}>${esc(code)} · ${esc(name)}</option>`).join("")}</select>
        </label>
        <label class="switch"><input type="checkbox" data-f="credit" ${m.credit ? "checked" : ""} /><span>Sale on account (customer pays later)</span></label>
        <label class="switch"><input type="checkbox" data-f="active" ${m.active ? "checked" : ""} /><span>Shown at the till</span></label>
      </div>
    </article>`;

  const paint = () => {
    root.innerHTML = `
      <form id="lf" class="settings-form">
        <section class="card">
          <header class="card-head"><h3>Payment methods</h3><span class="muted small">The first one is the default at the till</span></header>
          <p class="muted small">Add, rename, reorder or delete payment methods. Turn one off to hide it at the till without losing its history. Every method posts to a ledger account.</p>
          <div class="pm-grid">${state.methods.map(methodCard).join("")}</div>
          <button type="button" class="btn ghost" data-pm-add>${icon("plus")}<span>Add payment method</span></button>
        </section>
        ${chipSection("categories", "Product categories", "Used when adding products. Shows how many products use each one.")}
        ${chipSection("units", "Units of measure", "e.g. Pack, Strip, Bottle. Shows how many products use each one.")}
        ${chipSection("writeOffReasons", "Write-off reasons", "Used when you record stock lost, damaged or expired.")}
        <section class="card">
          <header class="card-head"><h3>Service fees</h3></header>
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
        </section>
        ${chipSection("walletProviders", "Mobile wallets", "e.g. bKash, Nagad, Rocket. Shown when the cashier does a wallet cash-in or cash-out.")}
        ${chipSection("rechargeOperators", "Mobile operators", "e.g. Grameenphone, Robi. Shown when the cashier sells a mobile recharge.")}
        <div class="sticky-actions">
          <button class="btn primary" type="submit">${icon("check")}<span>Save lists</span></button>
        </div>
      </form>`;
  };

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const sec = b.closest("[data-list]");
    if (b.hasAttribute("data-add-chip")) {
      const input = sec.querySelector("[data-new]");
      const v = input.value.trim();
      if (!v) return;
      const key = sec.dataset.list;
      if (state[key].some((x) => x.toLowerCase() === v.toLowerCase())) return toast("That is already in the list", "error");
      syncFromDom();
      state[key].push(v);
      paint();
      root.querySelector(`[data-list="${key}"] [data-new]`).focus();
    } else if (b.hasAttribute("data-rm-chip")) {
      const key = sec.dataset.list;
      syncFromDom();
      state[key].splice(Number(b.dataset.rmChip), 1);
      paint();
    } else if (b.hasAttribute("data-pm-add")) {
      syncFromDom();
      state.methods.push({ key: `m${Date.now().toString(36)}`, label: "", account: accountChoices[0]?.[0] || "1000", credit: false, active: true });
      paint();
      root.querySelector(".pm-card:last-of-type [data-f='label']")?.focus();
    } else if (b.hasAttribute("data-pm-up")) {
      syncFromDom();
      const i = Number(b.dataset.pmUp);
      [state.methods[i - 1], state.methods[i]] = [state.methods[i], state.methods[i - 1]];
      paint();
    } else if (b.hasAttribute("data-pm-top")) {
      syncFromDom();
      const i = Number(b.dataset.pmTop);
      const [m] = state.methods.splice(i, 1);
      state.methods.unshift(m);
      paint();
    } else if (b.hasAttribute("data-pm-del")) {
      const i = Number(b.dataset.pmDel);
      syncFromDom();
      const m = state.methods[i];
      const others = state.methods.filter((x, j) => j !== i && x.active && !x.credit);
      if (!others.length && m.active && !m.credit) return alertBox({ title: "Cannot delete", tone: "warn", message: "Keep at least one active cash-type payment method." });
      confirmBox(`Delete "${m.label || "this payment method"}"? Past sales keep their payment record. It just stops being offered at the till.`).then((ok) => {
        if (!ok) return;
        state.methods.splice(i, 1);
        paint();
      });
    }
  });

  root.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("[data-new]")) {
      e.preventDefault();
      root.querySelector(`[data-list="${e.target.closest("[data-list]").dataset.list}"] [data-add-chip]`).click();
    }
  });

  paint();

  onSubmit(root.querySelector("#lf"), async () => {
    syncFromDom();
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
    await saveGeneral({ categories, units, writeOffReasons, paymentMethods, walletProviders, rechargeOperators, serviceFees }, "Lists saved. Reloading to apply them.");
  });
}

/* ───────── Role access ───────── */

const PAGE_KEYS = Object.keys(PAGE_NAMES);
const slugRole = (name) => String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);

function viewRoles(body) {
  // Working copy: edits stay here until "Save roles" is pressed.
  const working = structuredClone(roles);
  const removed = new Set();

  const draw = () => {
    const keys = Object.keys(working);
    body.innerHTML = `
      <section class="card">
        <div class="toolbar">
          <div>
            <h3>Roles and permissions</h3>
            <p class="muted small">Create a role, tick what it can open and change, and save. Staff get the role's access the next time they sign in. The database enforces it, not just the menu.</p>
          </div>
          <div class="grow"></div>
          <button class="btn ghost" type="button" id="role-new">${icon("plus")}<span>New role</span></button>
        </div>
        <form id="rf">
          <div class="table-wrap role-matrix-wrap"><table class="matrix role-matrix">
            <thead>
              <tr>
                <th rowspan="2">Role</th>
                <th colspan="${PAGE_KEYS.length}" class="grp">Can open these pages</th>
                <th colspan="${WRITE_AREAS.length}" class="grp">Can change data in these areas</th>
                <th rowspan="2"></th>
              </tr>
              <tr>
                ${PAGE_KEYS.map((p) => `<th class="rot" title="${esc(PAGE_NAMES[p])}"><span>${esc(PAGE_NAMES[p])}</span></th>`).join("")}
                ${WRITE_AREAS.map((a) => `<th class="rot" title="${esc(WRITE_LABEL[a])}"><span>${esc(WRITE_LABEL[a])}</span></th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${keys.map((k) => {
                const isAdmin = k === "admin";
                return `
                <tr data-role="${esc(k)}">
                  <td class="role-name">
                    <input name="${esc(k)}__label" value="${esc(working[k].label)}" aria-label="Name of role ${esc(k)}" ${isAdmin ? "readonly" : ""} />
                    <small class="muted mono">${esc(k)}</small>
                  </td>
                  ${PAGE_KEYS.map((p) => `<td class="c"><input type="checkbox" name="${esc(k)}__page__${p}" ${(working[k].pages || []).includes(p) || isAdmin ? "checked" : ""} ${isAdmin ? "disabled" : ""} aria-label="${esc(working[k].label)} can open ${esc(PAGE_NAMES[p])}" /></td>`).join("")}
                  ${WRITE_AREAS.map((a) => `<td class="c"><input type="checkbox" name="${esc(k)}__write__${a}" ${(working[k].write || []).includes(a) || isAdmin ? "checked" : ""} ${isAdmin ? "disabled" : ""} aria-label="${esc(working[k].label)} can change ${esc(WRITE_LABEL[a])}" /></td>`).join("")}
                  <td class="c">${isAdmin ? `<span class="badge">locked</span>` : `<button class="icon-btn sm hover-danger" type="button" data-del-role="${esc(k)}" aria-label="Delete role ${esc(k)}">${icon("trash")}</button>`}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table></div>
          <p class="muted small">Administrator always has every page and every change area, so it cannot be locked out. A role that still has staff assigned cannot be deleted.</p>
          <div class="sticky-actions">
            <button class="btn primary" type="submit">${icon("check")}<span>Save roles</span></button>
          </div>
        </form>
      </section>`;
    bind();
  };

  const bind = () => {
    body.querySelector("#role-new").addEventListener("click", () => openRoleName());
    body.querySelectorAll("[data-del-role]").forEach((b) => b.addEventListener("click", () => deleteRole(b.dataset.delRole, b)));
    body.querySelector("#rf").addEventListener("submit", (e) => {
      e.preventDefault();
      const btn = e.submitter || body.querySelector("#rf button[type=submit]");
      withBusy(btn, () => saveRoles()).catch((err) => toast(err.message, "error"));
    });
  };

  // Reads what is ticked on screen into the working copy before any change.
  const readScreen = () => {
    const f = new FormData(body.querySelector("#rf"));
    for (const k of Object.keys(working)) {
      if (k === "admin") continue;
      working[k] = {
        label: String(f.get(`${k}__label`) || working[k].label).trim() || k,
        pages: PAGE_KEYS.filter((p) => f.get(`${k}__page__${p}`) === "on"),
        write: WRITE_AREAS.filter((a) => f.get(`${k}__write__${a}`) === "on"),
      };
    }
  };

  const openRoleName = () => openModal("New role", `
    <form id="nr" class="stack">
      <label class="field"><span class="field-label">Role name</span>
        <span class="input-wrap"><input name="name" maxlength="40" placeholder="e.g. Senior cashier" required /></span></label>
      <p class="muted small">You will set its permissions in the table after it is created.</p>
      <div class="form-actions"><button class="btn ghost" type="button" data-cancel>Cancel</button><button class="btn primary" type="submit"><span>Create role</span></button></div>
    </form>`, (m, close) => {
    m.querySelector("[data-cancel]").addEventListener("click", close);
    onSubmit(m.querySelector("#nr"), async (e) => {
      const name = String(new FormData(e.target).get("name") || "").trim();
      const key = slugRole(name);
      if (!key) throw new Error("Enter a name with letters or numbers.");
      if (key === "admin" || key in working) throw new Error("A role with this name already exists.");
      readScreen();
      working[key] = { label: name, pages: ["dashboard"], write: [] };
      removed.delete(key);
      close();
      draw();
      toast(`Role "${name}" added. Set what it can do, then Save roles.`, "info");
    });
  });

  const deleteRole = async (key, btn) => {
    if (key === "admin") return;
    await withBusy(btn, async () => {
      const snap = await getDocs(query(collection(db, "users"), where("role", "==", key)));
      const count = snap.size;
      if (count > 0) return alertBox({ title: "Role is in use", tone: "warn", message: `${count} staff member${count === 1 ? " uses" : "s use"} this role. Move them to another role first.` });
      if (!(await confirmBox(`Delete the role "${working[key].label}"? Its permissions are removed when you save.`))) return;
      readScreen();
      delete working[key];
      removed.add(key);
      draw();
    });
  };

  async function saveRoles() {
    readScreen();
    const out = {};
    for (const k of Object.keys(working)) {
      const r = working[k];
      if (k === "admin") {
        out.admin = { label: r.label || "Administrator", pages: [...PAGE_KEYS], write: [...WRITE_AREAS] };
        continue;
      }
      if (!r.label) throw new Error("Every role needs a name.");
      out[k] = { label: r.label, pages: r.pages, write: r.write };
    }
    if (!out.admin) throw new Error("The administrator role is required.");
    await setDoc(doc(db, "settings", "roles"), out);
    await audit("roles.update", { roles: Object.keys(out), removed: [...removed] });
    toast("Roles saved. Reloading to apply them.", "success");
    setTimeout(() => location.reload(), 900);
  }

  draw();
}

/* ───────── Google Sheets ───────── */

async function viewIntegrations(body) {
  const snap = await getDoc(doc(db, "settings", "integrations"));
  const cfg = snap.exists() ? snap.data() : {};
  body.innerHTML = `
    <section class="card">
      <h3>Google Sheets reporting</h3>
      <p class="muted small">Sheets is a reporting copy, not the live database. Set up the Apps Script described in the README, then paste its web-app URL here. Sign-in is not needed: the shared secret protects the link.</p>
      <form id="if" class="form-grid">
        <label class="span-2">Apps Script web-app URL<input name="sheetsUrl" type="url" inputmode="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg.sheetsUrl || "")}" /></label>
        <label class="span-2">Shared secret<input name="sheetsSecret" type="password" autocomplete="off" value="${esc(cfg.sheetsSecret || "")}" /></label>
        <div class="form-actions span-2">
          <button type="button" class="btn ghost" id="if-test">${icon("sync")}<span>Test connection</span></button>
          <button class="btn primary" type="submit">${icon("check")}<span>Save</span></button>
        </div>
      </form>
    </section>
    <section class="card">
      <h3>Email sending</h3>
      <p class="muted small">Sends password reset codes, new staff logins and admin resets. Choose one provider and save. Secrets are stored for administrators only and are never shown again. Leave a secret field empty to keep the saved one.</p>
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
      </form>
    </section>
    <section class="card">
      <h3>Chart of accounts</h3>
      <p class="muted small">Adds any missing default accounts. Existing accounts are not changed.</p>
      <button class="btn ghost" id="coa">${icon("accounting")}<span>Add missing default accounts</span></button>
    </section>`;

  onSubmit(body.querySelector("#if"), async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await setDoc(doc(db, "settings", "integrations"), {
      sheetsUrl: String(f.get("sheetsUrl") || "").trim(),
      sheetsSecret: String(f.get("sheetsSecret") || ""),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    await audit("integrations.update", { sheets: true });
    toast("Saved", "success");
  });
  onAction(body.querySelector("#if-test"), async () => {
    try {
      await pushToSheets("Connection test", ["Check", "Time"], [["Connected", new Date().toLocaleString()]]);
      toast("Connected. Check the “Connection test” tab.", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  });
  onSubmit(body.querySelector("#ef"), async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const patch = {
      emailProvider: String(f.get("emailProvider") || ""),
      mailFrom: String(f.get("mailFrom") || "").trim(),
      smtpHost: String(f.get("smtpHost") || "").trim(),
      smtpPort: Number(f.get("smtpPort")) || 0,
      smtpUser: String(f.get("smtpUser") || "").trim(),
    };
    // Secrets are only written when a new value is typed.
    const resendApiKey = String(f.get("resendApiKey") || "").trim();
    const smtpPass = String(f.get("smtpPass") || "");
    if (resendApiKey) patch.resendApiKey = resendApiKey;
    if (smtpPass) patch.smtpPass = smtpPass;
    try {
      await setDoc(doc(db, "settings", "integrations"), { ...patch, updatedAt: serverTimestamp() }, { merge: true });
      await audit("integrations.email", { provider: patch.emailProvider, from: patch.mailFrom });
      toast("Email settings saved", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  });
  onAction(body.querySelector("#ef-test"), async () => {
    try {
      await post("/api/admin/test-email", {}, { secure: true });
      toast("Test email sent. Check your inbox and spam folder.", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  });
  onAction(body.querySelector("#coa"), async () => {
    await ensureChartOfAccounts();
    toast("Chart of accounts is up to date", "success");
  });
}

/* ───────── Audit log ───────── */

/* ───────── Permissions: pick a person, see every role's access side by side ───────── */

async function viewAccess(body) {
  const snap = await getDocs(collection(db, "users"));
  const users = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const roleKeys = Object.keys(roles);
  let selected = users.find((u) => u.id === session.uid)?.id || users[0]?.id;

  const canOf = (roleKey, kind, key) => {
    if (roleKey === "admin") return true;
    const r = roles[roleKey];
    if (!r) return false;
    return kind === "page" ? r.pages.includes(key) : r.write.includes(key);
  };

  const paint = () => {
    const u = users.find((x) => x.id === selected);
    if (!u) { body.innerHTML = `<section class="card"><p class="muted center">No staff yet. Add staff first.</p></section>`; return; }
    const current = u.role || "";
    body.innerHTML = `
      <div class="access-grid">
        <aside class="card access-list">
          <header class="card-head"><h3>Staff</h3><span class="badge">${users.length}</span></header>
          ${users.map((x) => `
            <button class="access-user ${x.id === selected ? "active" : ""}" data-pick="${esc(x.id)}">
              <span class="avatar sm">${esc((x.name || "?").trim().charAt(0).toUpperCase())}</span>
              <span><strong>${esc(x.name || "Unnamed")}</strong><small>${esc(roles[x.role]?.label || x.role || "No role")}${x.active ? "" : " · disabled"}</small></span>
            </button>`).join("")}
        </aside>
        <section class="card access-panel">
          <header class="card-head">
            <div><h3>${esc(u.name || "Unnamed")}</h3><small class="muted">${esc(u.email || "")}</small></div>
            <div class="row-actions">
              <select id="ac-role" aria-label="Role for ${esc(u.name)}">${roleKeys.map((k) => `<option value="${esc(k)}" ${k === current ? "selected" : ""}>${esc(roles[k].label)}</option>`).join("")}</select>
              <button class="btn primary sm" id="ac-save">${icon("check")}<span>Save role</span></button>
            </div>
          </header>
          <p class="muted small">The highlighted column is this person's role. Each row shows what a role can do. The database enforces the same rules.</p>
          <div class="table-wrap"><table class="matrix access-matrix">
            <thead><tr>
              <th>Permission</th>
              ${roleKeys.map((k) => `<th class="${k === current ? "is-mine" : ""}">${esc(roles[k].label)}</th>`).join("")}
            </tr></thead>
            <tbody>
              <tr class="grp-row"><td colspan="${roleKeys.length + 1}">Can open these pages</td></tr>
              ${PAGE_KEYS.map((p) => `<tr><td>${esc(PAGE_NAMES[p])}</td>${roleKeys.map((k) => `<td class="c ${k === current ? "is-mine" : ""}">${canOf(k, "page", p) ? `<span class="yes">${icon("check")}</span>` : `<span class="no">–</span>`}</td>`).join("")}</tr>`).join("")}
              <tr class="grp-row"><td colspan="${roleKeys.length + 1}">Can change data in these areas</td></tr>
              ${WRITE_AREAS.map((a) => `<tr><td>${esc(WRITE_LABEL[a])}</td>${roleKeys.map((k) => `<td class="c ${k === current ? "is-mine" : ""}">${canOf(k, "write", a) ? `<span class="yes">${icon("check")}</span>` : `<span class="no">–</span>`}</td>`).join("")}</tr>`).join("")}
            </tbody>
          </table></div>
        </section>
      </div>`;
    body.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => { selected = b.dataset.pick; paint(); }));
    onAction(body.querySelector("#ac-save"), async () => {
      const role = body.querySelector("#ac-role").value;
      if (u.id === session.uid && role !== "admin") return toast("You cannot remove your own admin access", "error");
      await updateDoc(doc(db, "users", u.id), { role, updatedAt: serverTimestamp() });
      await audit("user.role", { id: u.id, role });
      u.role = role;
      toast("Role saved. It applies the next time they sign in.", "success");
      paint();
    });
  };
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
        await save();
        const out = await post("/api/admin/report-send", { scheduleId: items[i].id }, { secure: true });
        toast(`Sent the reports for ${out.reportDate} to ${out.to.join ? out.to.join(", ") : out.to}`, "success");
      } catch (err) {
        toast(err.message, "error");
      }
    }));
  }

  paint();
}

async function viewAudit(body) {
  const snap = await getDocs(query(collection(db, "audit"), orderBy("at", "desc"), limit(100)));
  body.innerHTML = `
    <section class="card">
      <h3>Recent activity</h3>
      <div class="table-wrap"><table class="stack-mobile">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>
          ${snap.docs.map((d) => { const a = d.data(); return `<tr>
            <td data-label="When">${fmtDateTime(a.at)}</td>
            <td data-label="Who">${esc(a.by)}</td>
            <td data-label="Action"><span class="badge">${esc(a.action)}</span></td>
            <td data-label="Details" class="wrap-cell">${esc(JSON.stringify(a.details || {}))}</td></tr>`; }).join("")
            || `<tr><td colspan="4" class="muted center">No activity yet</td></tr>`}
        </tbody>
      </table></div>
    </section>`;
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

  body.innerHTML = `
    <form id="bf" class="settings-form">
      <section class="card">
        <h3>Brand colour</h3>
        <p class="muted small">Used for the header, code box and buttons in every email. The logo and shop name are set in Settings → Shop profile.</p>
        <div class="form-grid">
          <label>Brand colour<input type="color" name="brandColor" value="${esc(brand.brandColor || DEFAULT_BRAND_COLOR)}" /></label>
        </div>
      </section>
      ${Object.keys(DEFAULT_TEMPLATES).map((k) => `
        <section class="card">
          <h3>${esc(DEFAULT_TEMPLATES[k].label)}</h3>
          <p class="muted small">${esc(DEFAULT_TEMPLATES[k].help)} Placeholders: ${EMAIL_PLACEHOLDERS.map((p) => `<code>{{${p}}}</code>`).join(" ")}</p>
          <div class="form-grid">
            <label class="span-2">Subject<input name="${k}__subject" value="${esc(tpl(k).subject)}" required /></label>
            <label class="span-2">Message<textarea name="${k}__body" rows="6" required>${esc(tpl(k).body)}</textarea></label>
            <label class="span-2">Button text (leave empty for no button)<input name="${k}__button" value="${esc(tpl(k).button || "")}" /></label>
          </div>
          <div class="form-actions"><button type="button" class="btn ghost sm" data-default="${k}">Restore default text</button></div>
        </section>`).join("")}
      <div class="sticky-actions">
        <button class="btn primary" type="submit">${icon("check")}<span>Save branding & emails</span></button>
      </div>
    </form>`;

  const form = body.querySelector("#bf");
  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-default]");
    if (!b) return;
    const k = b.dataset.default;
    for (const f of tplFields(k)) form[`${k}__${f}`].value = DEFAULT_TEMPLATES[k][f] ?? "";
    toast("Default text restored. Save to apply it.", "info");
  });

  onSubmit(form, async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const appName = settings.shopName || "MediPOS";
    const emails = {};
    for (const k of Object.keys(DEFAULT_TEMPLATES)) {
      emails[k] = {};
      for (const fld of tplFields(k)) {
        const v = String(f.get(`${k}__${fld}`) || "").trim();
        emails[k][fld] = fld === "button" ? v : (v || DEFAULT_TEMPLATES[k][fld]);
      }
    }
    const brandColor = /^#[0-9a-f]{6}$/i.test(String(f.get("brandColor") || "")) ? String(f.get("brandColor")) : DEFAULT_BRAND_COLOR;
    try {
      await setDoc(doc(db, "branding", "public"), {
        appName, shopName: settings.shopName, brandColor, updatedAt: serverTimestamp(),
      }, { merge: true });
      await setDoc(doc(db, "settings", "emails"), { ...emails, updatedAt: serverTimestamp() });
      await audit("branding.update", { appName, brandColor });
      toast("Branding and emails saved", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  });
}
