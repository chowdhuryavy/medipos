import {
  auth, db, initializeApp, deleteApp, getAuth, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail, collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, query, orderBy, limit, serverTimestamp,
} from "../firebase.js";
import { firebaseConfig } from "../config.js";
import {
  session, roles, DEFAULT_ROLES, WRITE_AREAS, settings, DEFAULT_SETTINGS, esc, icon, toast, openModal, confirmBox,
  audit, ensureChartOfAccounts, fmtDateTime,
} from "../core.js";

const WRITE_LABEL = {
  pos: "Sales & receipts", inventory: "Products & stock", purchasing: "Purchases",
  partners: "Customers & suppliers", accounting: "Journal, expenses & accounts",
};
import { pushToSheets } from "../sheets.js";
import { passwordProblem } from "../password.js";

const TABS = [
  ["users", "Staff"],
  ["settings", "Shop & rules"],
  ["lists", "Lists & payments"],
  ["roles", "Role access"],
  ["integrations", "Google Sheets"],
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
  const views = { users: viewUsers, settings: viewSettings, lists: viewLists, roles: viewRoles, integrations: viewIntegrations, audit: viewAudit };
  const go = async (tab) => {
    el.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    body.innerHTML = `<div class="skeleton"></div>`;
    await views[tab](body);
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
  body.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.edit) return openUserForm(users.find((u) => u.id === b.dataset.edit), () => viewUsers(body));
    if (b.dataset.reset) {
      const u = users.find((x) => x.id === b.dataset.reset);
      if (!(await confirmBox(`Send a password reset email to ${u.email}?`))) return;
      await sendPasswordResetEmail(auth, u.email);
      await audit("user.reset_password", { email: u.email });
      toast("Reset email sent", "success");
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
        <label class="span-2">Temporary password<input name="password" type="password" minlength="8" required autocomplete="new-password" />
          <small class="muted">At least 8 characters. Ask the staff member to change it after first sign-in.</small></label>` : ""}
      <label>Role<select name="role">${roleOptions(u?.role || "cashier")}</select></label>
      <label class="check"><input type="checkbox" name="active" ${!u || u.active ? "checked" : ""} /> <span>Account active</span></label>
      <div class="form-actions span-2">
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" type="submit">${isNew ? "Create account" : "Save"}</button>
      </div>
    </form>`, (body, close) => {
    body.querySelector("[data-cancel]").addEventListener("click", close);
    body.querySelector("#uf").addEventListener("submit", async (e) => {
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
          const password = String(f.get("password") || "");
          const problem = passwordProblem(password);
          if (problem) return toast(problem, "error");
          const uid = await createAuthUser(email, password);
          await setDoc(doc(db, "users", uid), { name, email, role, active, createdAt: serverTimestamp(), createdBy: session.uid });
          await audit("user.create", { email, role });
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
  ]],
  ["Money & tax", [
    ["currency", "Currency code (e.g. QAR, SAR, USD, AED)", "text"],
    ["defaultVatRate", "Default VAT %", "number"],
    ["maxDiscountPct", "Maximum discount % cashiers can give", "number"],
    ["allowCreditSales", "Allow sales on account (credit)", "bool"],
  ]],
  ["Numbering", [
    ["invoicePrefix", "Invoice prefix", "text"],
    ["purchasePrefix", "Purchase prefix", "text"],
  ]],
  ["Inventory rules", [
    ["expiryWarnDays", "Warn this many days before expiry", "number"],
    ["defaultReorderLevel", "Default reorder level for new products", "number"],
  ]],
];

function viewSettings(body) {
  body.innerHTML = `
    <form id="sf" class="settings-form">
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

  body.querySelector("#sf").addEventListener("submit", async (e) => {
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
    await saveGeneral(patch, "Settings saved. Reloading to apply them.");
  });

  body.querySelector("#s-reset").addEventListener("click", async () => {
    if (!(await confirmBox("Restore the default shop settings? Your lists and payment methods are kept."))) return;
    const { categories, units, paymentMethods, writeOffReasons, ...rest } = DEFAULT_SETTINGS;
    await saveGeneral(rest, "Defaults restored.");
  });
}

async function saveGeneral(patch, message) {
  await setDoc(doc(db, "settings", "general"), { ...patch, updatedAt: serverTimestamp() }, { merge: true });
  await audit("settings.update", { keys: Object.keys(patch) });
  toast(message, "success");
  setTimeout(() => location.reload(), 900);
}

/* ───────── Lists & payment methods ───────── */

function viewLists(body) {
  const pm = settings.paymentMethods;
  body.innerHTML = `
    <form id="lf" class="settings-form">
      <section class="card">
        <h3>Product categories</h3>
        <p class="muted small">One per line. Used when adding products.</p>
        <textarea name="categories" rows="5" aria-label="Categories">${esc(settings.categories.join("\n"))}</textarea>
      </section>
      <section class="card">
        <h3>Units of measure</h3>
        <p class="muted small">One per line, e.g. Pack, Strip, Bottle.</p>
        <textarea name="units" rows="4" aria-label="Units">${esc(settings.units.join("\n"))}</textarea>
      </section>
      <section class="card">
        <h3>Write-off reasons</h3>
        <p class="muted small">One per line. Used for stock-out entries.</p>
        <textarea name="writeOffReasons" rows="4" aria-label="Write-off reasons">${esc(settings.writeOffReasons.join("\n"))}</textarea>
      </section>
      <section class="card">
        <h3>Payment methods</h3>
        <p class="muted small">Name what the customer sees, and choose which ledger account the money goes to. Tick “On account” for credit sales.</p>
        <div class="pm-list" id="pm-list">
          ${pm.map((m, i) => pmRow(m, i)).join("")}
        </div>
        <button type="button" class="btn ghost sm" id="pm-add">${icon("plus")}<span>Add method</span></button>
      </section>
      <div class="sticky-actions">
        <button class="btn primary" type="submit">${icon("check")}<span>Save lists</span></button>
      </div>
    </form>`;

  const list = body.querySelector("#pm-list");
  body.querySelector("#pm-add").addEventListener("click", () => {
    list.insertAdjacentHTML("beforeend", pmRow({ key: "", label: "", account: "1000", credit: false }, list.children.length));
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm-pm]");
    if (b && list.children.length > 1) b.closest(".pm-row").remove();
  });

  body.querySelector("#lf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const lines = (k) => String(f.get(k) || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const methods = [...list.querySelectorAll(".pm-row")].map((r, i) => {
      const label = r.querySelector('[data-k="label"]').value.trim();
      return {
        key: r.querySelector('[data-k="key"]').value.trim() || `m${i + 1}`,
        label: label || `Method ${i + 1}`,
        account: r.querySelector('[data-k="account"]').value.trim(),
        credit: r.querySelector('[data-k="credit"]').checked,
      };
    }).filter((m) => m.account);
    if (!methods.length) return toast("Add at least one payment method", "error");
    if (new Set(methods.map((m) => m.key)).size !== methods.length) return toast("Each payment method needs a unique key", "error");
    const categories = lines("categories"), units = lines("units"), writeOffReasons = lines("writeOffReasons");
    if (!categories.length || !units.length) return toast("Categories and units cannot be empty", "error");
    await saveGeneral({ categories, units, writeOffReasons, paymentMethods: methods }, "Lists saved. Reloading to apply them.");
  });
}

function pmRow(m, i) {
  return `
    <div class="pm-row">
      <input data-k="label" placeholder="Name shown to staff" value="${esc(m.label)}" aria-label="Method name" />
      <input data-k="key" placeholder="key" value="${esc(m.key)}" aria-label="Method key" />
      <input data-k="account" placeholder="Ledger account code" value="${esc(m.account)}" inputmode="numeric" aria-label="Ledger account" />
      <label class="check"><input type="checkbox" data-k="credit" ${m.credit ? "checked" : ""} /> <span>On account</span></label>
      <button type="button" class="icon-btn sm hover-danger" data-rm-pm aria-label="Remove method">${icon("x")}</button>
    </div>`;
}

/* ───────── Role access ───────── */

function viewRoles(body) {
  const pages = Object.keys(PAGE_NAMES);
  body.innerHTML = `
    <form id="rf">
    <section class="card">
      <h3>What each role can open</h3>
      <p class="muted small">Saved in the database. The database blocks reads and writes that a role is not allowed, even if someone changes the app.</p>
        <div class="table-wrap"><table class="matrix">
          <thead><tr><th>Role</th><th>Display name</th>${pages.map((p) => `<th>${esc(PAGE_NAMES[p])}</th>`).join("")}</tr></thead>
          <tbody>
            ${Object.keys(DEFAULT_ROLES).map((k) => `
              <tr data-role="${k}">
                <td><strong>${esc(k)}</strong></td>
                <td><input name="${k}__label" value="${esc(roles[k].label)}" aria-label="Display name for ${esc(k)}" /></td>
                ${pages.map((p) => `<td class="c"><input type="checkbox" name="${k}__${p}" ${roles[k].pages.includes(p) ? "checked" : ""} ${k === "admin" ? "disabled" : ""} aria-label="${esc(k)} can open ${esc(PAGE_NAMES[p])}" /></td>`).join("")}
              </tr>`).join("")}
          </tbody>
        </table></div>
      </section>
      <section class="card">
        <h3>What each role can change</h3>
        <p class="muted small">Sales, stock, purchases, customers and accounting entries. Cashiers can change stock but not prices or costs.</p>
        <div class="table-wrap"><table class="matrix">
          <thead><tr><th>Role</th>${WRITE_AREAS.map((a) => `<th>${esc(WRITE_LABEL[a])}</th>`).join("")}</tr></thead>
          <tbody>
            ${Object.keys(DEFAULT_ROLES).map((k) => `
              <tr>
                <td><strong>${esc(k)}</strong></td>
                ${WRITE_AREAS.map((a) => `<td class="c"><input type="checkbox" name="${k}__write__${a}" ${(roles[k].write || []).includes(a) ? "checked" : ""} ${k === "admin" ? "disabled" : ""} aria-label="${esc(k)} can change ${esc(WRITE_LABEL[a])}" /></td>`).join("")}
              </tr>`).join("")}
          </tbody>
        </table></div>
      </section>
        <div class="sticky-actions">
          <button type="button" class="btn ghost" id="r-reset">Restore defaults</button>
          <button class="btn primary" type="submit">${icon("check")}<span>Save access</span></button>
        </div>
    </form>`;

  body.querySelector("#rf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const out = {};
    for (const k of Object.keys(DEFAULT_ROLES)) {
      out[k] = {
        label: String(f.get(`${k}__label`) || DEFAULT_ROLES[k].label).trim(),
        pages: pages.filter((p) => f.get(`${k}__${p}`) === "on"),
        write: WRITE_AREAS.filter((a) => f.get(`${k}__write__${a}`) === "on"),
      };
    }
    // Administrators always keep every page and every write area (the rules do the same).
    out.admin.pages = [...pages];
    out.admin.write = [...WRITE_AREAS];
    await setDoc(doc(db, "settings", "roles"), out);
    await audit("roles.update", {});
    toast("Access saved. Reloading to apply it.", "success");
    setTimeout(() => location.reload(), 900);
  });

  body.querySelector("#r-reset").addEventListener("click", async () => {
    if (!(await confirmBox("Restore the default page access for all roles?"))) return;
    await setDoc(doc(db, "settings", "roles"), structuredClone(DEFAULT_ROLES));
    await audit("roles.reset", {});
    toast("Defaults restored. Reloading.", "success");
    setTimeout(() => location.reload(), 900);
  });
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
      <h3>Chart of accounts</h3>
      <p class="muted small">Adds any missing default accounts. Existing accounts are not changed.</p>
      <button class="btn ghost" id="coa">${icon("accounting")}<span>Add missing default accounts</span></button>
    </section>`;

  body.querySelector("#if").addEventListener("submit", async (e) => {
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
  body.querySelector("#if-test").addEventListener("click", async () => {
    try {
      await pushToSheets("Connection test", ["Check", "Time"], [["Connected", new Date().toLocaleString()]]);
      toast("Connected. Check the “Connection test” tab.", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  });
  body.querySelector("#coa").addEventListener("click", async () => {
    await ensureChartOfAccounts();
    toast("Chart of accounts is up to date", "success");
  });
}

/* ───────── Audit log ───────── */

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
