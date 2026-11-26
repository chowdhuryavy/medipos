import { onSubmit, onAction, onDelegated, withBusy } from "../core.js";
import {
  auth, db, initializeApp, deleteApp, getAuth, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail, collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, query, where, orderBy, limit, serverTimestamp,
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
import { post } from "../api.js";
import { DEFAULT_TEMPLATES, EMAIL_PLACEHOLDERS } from "../email-defaults.js";

const TABS = [
  ["users", "Staff"],
  ["settings", "Shop & rules"],
  ["lists", "Lists & payments"],
  ["roles", "Role access"],
  ["branding", "Branding & email"],
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
  const views = { users: viewUsers, settings: viewSettings, lists: viewLists, roles: viewRoles, branding: viewBranding, integrations: viewIntegrations, audit: viewAudit };
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
  if (patch.shopName) await setDoc(doc(db, "branding", "public"), { shopName: patch.shopName }, { merge: true });
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

  onSubmit(body.querySelector("#lf"), async (e) => {
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
      if (count > 0) return toast(`${count} staff member${count === 1 ? " uses" : "s use"} this role. Move them to another role first.`, "error");
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
  onAction(body.querySelector("#coa"), async () => {
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

/* ───────── Branding & email ───────── */

const LOGO_MAX_CHARS = 350_000;

function readLogo(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("Choose an image file (PNG, JPG or WebP)."));
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 480 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/png");
      URL.revokeObjectURL(img.src);
      if (url.length > LOGO_MAX_CHARS) return reject(new Error("That logo is too large. Use a smaller image."));
      resolve(url);
    };
    img.onerror = () => reject(new Error("Could not read that image."));
    img.src = URL.createObjectURL(file);
  });
}

async function viewBranding(body) {
  const [bSnap, eSnap] = await Promise.all([getDoc(doc(db, "branding", "public")), getDoc(doc(db, "settings", "emails"))]);
  const brand = bSnap.exists() ? bSnap.data() : {};
  const stored = eSnap.exists() ? eSnap.data() : {};
  const tpl = (k) => ({ ...DEFAULT_TEMPLATES[k], ...(stored[k] || {}) });
  let logoUrl = brand.logoUrl || "";
  let removeLogo = false;

  body.innerHTML = `
    <form id="bf" class="settings-form">
      <section class="card">
        <h3>App name and logo</h3>
        <p class="muted small">Shown on the sign-in page, in the sidebar and in every email.</p>
        <div class="form-grid">
          <label>App name<input name="appName" required maxlength="40" value="${esc(brand.appName || "MediPOS")}" /></label>
          <div class="span-2 logo-editor">
            <div class="logo-preview" id="logo-preview">${logoUrl ? `<img src="${logoUrl}" alt="Current logo" />` : `<span class="muted small">No logo yet</span>`}</div>
            <div class="logo-actions">
              <label class="btn ghost sm file-btn">${icon("upload")}<span>Choose logo</span>
                <input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp" hidden /></label>
              <button type="button" class="btn ghost sm" id="logo-remove">${icon("trash")}<span>Remove</span></button>
              <small class="muted">PNG with a transparent background works best. Max about 350 KB after resizing.</small>
            </div>
          </div>
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
  body.querySelector("#logo-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      logoUrl = await readLogo(file);
      removeLogo = false;
      body.querySelector("#logo-preview").innerHTML = `<img src="${logoUrl}" alt="New logo" />`;
    } catch (err) {
      toast(err.message, "error");
    }
    e.target.value = "";
  });
  body.querySelector("#logo-remove").addEventListener("click", () => {
    logoUrl = "";
    removeLogo = true;
    body.querySelector("#logo-preview").innerHTML = `<span class="muted small">No logo (the default icon is used)</span>`;
  });
  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-default]");
    if (!b) return;
    const k = b.dataset.default;
    form[`${k}__subject`].value = DEFAULT_TEMPLATES[k].subject;
    form[`${k}__body`].value = DEFAULT_TEMPLATES[k].body;
    form[`${k}__button`].value = DEFAULT_TEMPLATES[k].button || "";
    toast("Default text restored. Save to apply it.", "info");
  });

  onSubmit(form, async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const appName = String(f.get("appName") || "").trim() || "MediPOS";
    const emails = {};
    for (const k of Object.keys(DEFAULT_TEMPLATES)) {
      emails[k] = {
        subject: String(f.get(`${k}__subject`) || "").trim() || DEFAULT_TEMPLATES[k].subject,
        body: String(f.get(`${k}__body`) || "").trim() || DEFAULT_TEMPLATES[k].body,
        button: String(f.get(`${k}__button`) || "").trim(),
      };
    }
    try {
      await setDoc(doc(db, "branding", "public"), {
        appName, shopName: settings.shopName, logoUrl: removeLogo ? "" : logoUrl, updatedAt: serverTimestamp(),
      }, { merge: true });
      await setDoc(doc(db, "settings", "emails"), { ...emails, updatedAt: serverTimestamp() });
      await audit("branding.update", { appName, logo: !!logoUrl && !removeLogo });
      toast("Branding and emails saved", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  });
}
