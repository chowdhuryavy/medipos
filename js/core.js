import { DEFAULT_EMAIL_FOOTER, DEFAULT_OTP_MINUTES } from "./email-defaults.js";
import { db, doc, getDoc, setDoc, addDoc, collection, serverTimestamp } from "./firebase.js";

/* ───────────────────────── admin-editable settings ─────────────────────────
   Defaults live here. The admin overrides them in Firestore
   (settings/general and settings/roles) from Administration → Settings.   */

export const DEFAULT_SETTINGS = {
  shopName: "My Pharmacy",
  shopAddress: "",
  shopPhone: "",
  taxNumber: "",
  currency: "QAR",
  defaultVatRate: 0,
  invoicePrefix: "INV",
  purchasePrefix: "PUR",
  receiptFooter: "Thank you for your visit. Get well soon!",
  emailFooter: DEFAULT_EMAIL_FOOTER,
  otpExpiryMinutes: DEFAULT_OTP_MINUTES,
  expiryWarnDays: 60,
  expiryDayOptions: [30, 60, 90, 180],
  defaultReorderLevel: 10,
  maxDiscountPct: 100,
  allowCreditSales: true,
  allowPriceChange: true,
  // App font: a key of APP_FONTS below. Only fonts already on the device are used, so nothing is downloaded.
  appFont: "times",
  menuStyle: "classic",
  // Mobile recharge and wallet cash-in/out buttons on the sale screen. Off unless a shop turns them on.
  posServiceButtons: false,
  // Two sale-screen buttons. They show only when both are on; each shows the products of its categories.
  posTab1Active: false, posTab1Label: "Medicine", posTab1Categories: "",
  posTab2Active: false, posTab2Label: "Others", posTab2Categories: "",
  floatWarnAmount: 1000,
  // Sign out after this many minutes with no activity. 0 = never.
  sessionTimeoutMinutes: 0,
  walletProviders: ["bKash", "Nagad", "Rocket"],
  // Service fee rules. mode "percent" = % of the amount, "flat" = fixed amount. min/max 0 = no limit.
  serviceFees: {
    recharge: { mode: "percent", value: 0, min: 0, max: 0 },
    cashin: { mode: "flat", value: 0, min: 0, max: 0 },
    cashout: { mode: "percent", value: 0, min: 0, max: 0 },
  },
  rechargeOperators: ["Grameenphone", "Robi", "Banglalink", "Airtel", "Teletalk"],
  categories: ["Medicines", "OTC", "Cosmetics", "Baby care", "Medical devices", "General"],
  units: ["Pack", "Strip", "Bottle", "Box", "Piece"],
  paymentMethods: [
    { key: "cash", label: "Cash", account: "1000", credit: false },
    { key: "card", label: "Card", account: "1010", credit: false },
    { key: "credit", label: "On account", account: "1100", credit: true },
  ],
  writeOffReasons: ["Expired", "Damaged", "Lost / theft", "Counting error", "Other"],
};

export const settings = structuredClone(DEFAULT_SETTINGS);

// Fonts that are already on the phone or computer. Each stack lists fallbacks.
export const APP_FONTS = {
  times: { label: "Times New Roman (default)", stack: '"Times New Roman", Times, serif' },
  system: { label: "System", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  arial: { label: "Arial", stack: 'Arial, Helvetica, sans-serif' },
  verdana: { label: "Verdana", stack: 'Verdana, Geneva, sans-serif' },
  trebuchet: { label: "Trebuchet", stack: '"Trebuchet MS", Helvetica, sans-serif' },
  tahoma: { label: "Tahoma", stack: 'Tahoma, Geneva, sans-serif' },
  georgia: { label: "Georgia (serif)", stack: 'Georgia, "Times New Roman", serif' },
};

// A reload keeps the page the person is on: the address is remembered and the app returns to it after signing in again.
const RETURN_KEY = "medipos.returnTo";
export function reloadKeepingPage(delay = 0) {
  try { sessionStorage.setItem(RETURN_KEY, location.hash); } catch { /* storage unavailable: the reload goes to the dashboard */ }
  setTimeout(() => location.reload(), delay);
}
/** Returns the page to go back to after a reload, and forgets it. */
export function takeReturnPage() {
  try {
    const h = sessionStorage.getItem(RETURN_KEY) || "";
    sessionStorage.removeItem(RETURN_KEY);
    return h;
  } catch {
    return "";
  }
}

/** Sets the app font from the settings. Printed receipts and reports keep their own fonts. */
export function applyAppFont() {
  const f = APP_FONTS[settings.appFont] || APP_FONTS.system;
  document.documentElement.style.setProperty("--app-font", f.stack);
}

// Areas a role can change data in. The database (firestore.rules) enforces these;
// the screens only mirror them so people are not shown buttons that would fail.
export const WRITE_AREAS = ["pos", "inventory", "purchasing", "partners", "accounting"];

export const DEFAULT_ROLES = {
  admin:       { label: "Administrator", pages: ["dashboard", "pos", "shift", "returns", "inventory", "purchasing", "partners", "accounting", "reports", "admin"], write: [...WRITE_AREAS] },
  pharmacist:  { label: "Pharmacist",    pages: ["dashboard", "pos", "shift", "returns", "inventory", "purchasing", "partners", "reports"], write: ["pos", "inventory", "purchasing", "partners"] },
  cashier:     { label: "Cashier",       pages: ["dashboard", "pos", "shift", "returns", "partners"], write: ["pos", "partners"] },
  storekeeper: { label: "Storekeeper",   pages: ["inventory", "purchasing", "partners"], write: ["inventory", "purchasing"] },
  accountant:  { label: "Accountant",    pages: ["dashboard", "accounting", "reports", "purchasing", "partners"], write: ["accounting"] },
};

// Filled by loadSettings() from settings/roles in Firestore; edited by the admin.
export const roles = structuredClone(DEFAULT_ROLES);

export const session = { uid: null, name: "", email: "", role: null, access: null };
// A person's own screens and areas (set by an administrator) replace the role's lists; null means the role's lists apply.
export const effectivePages = () => session.access?.pages ?? roles[session.role]?.pages ?? [];
export const effectiveWrite = () => session.access?.write ?? roles[session.role]?.write ?? [];

export const can = (page) => !!session.role && effectivePages().includes(page);
export const canWrite = (area) => !!session.role && effectiveWrite().includes(area);

/** Loads shop settings and role permissions from Firestore, merged over the defaults. */
export async function loadSettings() {
  const g = await getDoc(doc(db, "settings", "general"));
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS), g.exists() ? g.data() : {});
  applyAppFont();
  const r = await getDoc(doc(db, "settings", "roles"));
  const saved = r.exists() ? r.data() : {};
  // Every role in the database is loaded, including roles the admin created.
  // Once roles are saved, the database is the only list: a role the admin deleted stays deleted.
  const keys = new Set(["admin", ...(r.exists() ? Object.keys(saved) : Object.keys(DEFAULT_ROLES))]);
  for (const key of Object.keys(roles)) if (!keys.has(key)) delete roles[key];
  for (const key of keys) {
    // Mirror the database exactly; the rules deny anything not listed there.
    // Admins always keep everything (the rules do the same).
    const s = saved[key] || {};
    roles[key] = key === "admin"
      ? { label: s.label || "Administrator", pages: [...DEFAULT_ROLES.admin.pages], write: [...WRITE_AREAS] }
      : {
          label: s.label || DEFAULT_ROLES[key]?.label || key,
          pages: Array.isArray(s.pages) ? s.pages : [],
          write: Array.isArray(s.write) ? s.write : [],
        };
  }
  // The cash shift page goes with the sale screen, so anyone who can sell can open and close the shift.
  // The same goes for the new screens: the import page follows stock access; prescriptions follow the sale screen.
  for (const key of Object.keys(roles)) {
    const pages = roles[key].pages || [];
    const add = [];
    if (pages.includes("pos") && !pages.includes("shift")) add.push("shift");
    if (pages.includes("pos") && !pages.includes("prescriptions")) add.push("prescriptions");
    if (pages.includes("inventory") && !pages.includes("import")) add.push("import");
    if (add.length) roles[key].pages = [...pages, ...add];
  }
  fmtCache = null;
  return r.exists();
}

/* ───────────────────────── accounting constants ───────────────────────── */

export const ACCOUNTS = {
  CASH: "1000", BANK: "1010", AR: "1100", INVENTORY: "1200", VAT_INPUT: "1300",
  AP: "2000", VAT_PAYABLE: "2100", EQUITY: "3000", SALES: "4000", COGS: "5000",
  OTHER_EXPENSE: "6900", WALLET_FLOAT: "1020", SERVICE_COMMISSION: "4100",
};

export const DEFAULT_ACCOUNTS = [
  { code: "1000", name: "Cash on Hand", type: "asset" },
  { code: "1010", name: "Bank Account", type: "asset" },
  { code: "1020", name: "Mobile wallet float (bKash, Nagad…)", type: "asset" },
  { code: "1100", name: "Accounts Receivable (Customers)", type: "asset" },
  { code: "1200", name: "Inventory (Medicines & Goods)", type: "asset" },
  { code: "1300", name: "VAT Input (Recoverable)", type: "asset" },
  { code: "2000", name: "Accounts Payable (Suppliers)", type: "liability" },
  { code: "2100", name: "VAT Payable", type: "liability" },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "4000", name: "Sales Revenue", type: "revenue" },
  { code: "4100", name: "Service commission income", type: "revenue" },
  { code: "5000", name: "Cost of Goods Sold", type: "expense" },
  { code: "6100", name: "Salaries & Wages", type: "expense" },
  { code: "6200", name: "Rent", type: "expense" },
  { code: "6300", name: "Utilities", type: "expense" },
  { code: "6400", name: "Maintenance", type: "expense" },
  { code: "6900", name: "Other Expenses / Stock Write-off", type: "expense" },
];

export const PURCHASE_PAYMENT_ACCOUNT = { cash: ACCOUNTS.CASH, bank: ACCOUNTS.BANK, credit: ACCOUNTS.AP };

// Active accounts take new postings. Inactive and closed accounts keep their history, but cannot be picked or posted to.
export const ACCOUNT_STATUSES = [["active", "Active"], ["inactive", "Inactive"], ["closed", "Closed"]];
export const isPostable = (a) => !a.status || a.status === "active";
export const statusLabel = (a) => (isPostable(a) ? "" : ACCOUNT_STATUSES.find(([v]) => v === a.status)?.[1] || "Inactive");

/* ───────────────────────── formatting & dates ───────────────────────── */

let fmtCache = null;
export function money(n) {
  if (!fmtCache) {
    try {
      fmtCache = new Intl.NumberFormat(undefined, { style: "currency", currency: settings.currency, minimumFractionDigits: 2 });
    } catch {
      fmtCache = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 });
    }
  }
  return fmtCache.format(Number(n) || 0);
}
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const todayISO = () => new Date().toLocaleDateString("en-CA");
export const daysAgoISO = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString("en-CA"); };
export const daysFromNowISO = (n) => daysAgoISO(-n);
export const monthStartISO = () => todayISO().slice(0, 8) + "01";
export const fmtDateTime = (ts) => {
  const d = ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null;
  return d ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
};

/* ───────────────────────── icons ───────────────────────── */

const ICONS = {
  bell: '<path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/>',
  dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  pos: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 002 1.6h9.7a2 2 0 002-1.6L23 6H6"/>',
  inventory: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/>',
  purchase: '<path d="M3 3h2l2.4 12.4a2 2 0 002 1.6h7.7a2 2 0 002-1.5L21 7H6"/><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/>',
  partners: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0114 0M16 4a4 4 0 010 8M22 21a7 7 0 00-5-6.7"/>',
  accounting: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>',
  reports: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  admin: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><path d="M6 14h12v8H6z"/>',
  sync: '<path d="M21 12a9 9 0 01-15.5 6.2L3 16M3 12a9 9 0 0115.5-6.2L21 8M21 3v5h-5M3 21v-5h5"/>',
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.9 12.1L21 2M18 5l3 3M15 8l3 3"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.9 17.9A10.7 10.7 0 0112 19c-7 0-11-7-11-7a19.8 19.8 0 014.2-5.1M9.9 5.1A10.4 10.4 0 0112 5c7 0 11 7 11 7a19.5 19.5 0 01-2.2 3.2M1 1l22 22"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  upload: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  building: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M9 13h1M9 17h1M14 9h1M14 13h1M14 17h1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};

export const icon = (name, cls = "") =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

/* ───────────────────────── UI helpers ───────────────────────── */

export function toast(message, type = "info") {
  const host = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === "error" ? "alert" : "check")}<span>${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, 3200);
}

export function openModal(title, html, onMount, opts = {}) {
  const host = document.getElementById("modal-root");
  host.innerHTML = `
    <div class="modal-backdrop${opts.center ? " modal-center" : ""}">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <header><h3>${esc(title)}</h3>
          <button class="icon-btn sm" type="button" data-close aria-label="Close">${icon("x")}</button>
        </header>
        <div class="modal-body">${html}</div>
      </div>
    </div>`;
  const backdrop = host.querySelector(".modal-backdrop");
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.classList.add("closing");
    setTimeout(() => { if (host.contains(backdrop)) host.innerHTML = ""; }, 180);
  };
  host.querySelector("[data-close]").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  onMount?.(host.querySelector(".modal-body"), close);
  return close;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelector("#modal-root [data-close]")?.click();
});

const TONE_ICON = { success: "check", error: "alert", warn: "alert", info: "reports" };

/** App-styled message box. Resolves when the user presses OK. */
export function alertBox({ title = "Notice", message = "", tone = "info", button = "OK" } = {}) {
  return new Promise((resolve) => {
    openModal(title, `
      <div class="app-alert tone-${tone}">
        <div class="aa-ico">${icon(TONE_ICON[tone] || "reports")}</div>
        <h3 class="aa-title">${esc(title)}</h3>
        <p class="aa-msg">${esc(message)}</p>
        <div class="form-actions"><button class="btn primary" type="button" data-ok>${esc(button)}</button></div>
      </div>`, (body, close) => {
      body.querySelector("[data-ok]").addEventListener("click", () => { close(); resolve(true); });
    }, { center: true });
  });
}

/** App-styled yes/no box. Resolves true only when the user confirms. */
export function confirmBox(message, { title = "Please confirm", confirmText = "Confirm", tone = "warn" } = {}) {
  return new Promise((resolve) => {
    openModal(title, `
      <div class="app-alert tone-${tone}">
        <div class="aa-ico">${icon(TONE_ICON[tone] || "alert")}</div>
        <h3 class="aa-title">${esc(title)}</h3>
        <p class="aa-msg">${esc(message)}</p>
        <div class="form-actions">
          <button class="btn ghost" type="button" data-no>Cancel</button>
          <button class="btn ${tone === "error" ? "danger" : "primary"}" type="button" data-yes>${esc(confirmText)}</button>
        </div>
      </div>`, (body, close) => {
      body.querySelector("[data-no]").addEventListener("click", () => { close(); resolve(false); });
      body.querySelector("[data-yes]").addEventListener("click", () => { close(); resolve(true); });
    }, { center: true });
  });
}

export function animateCount(el, to, fmt = (v) => Math.round(v).toLocaleString()) {
  const start = performance.now();
  const dur = 900;
  const tick = (now) => {
    const p = Math.min(1, (now - start) / dur);
    el.textContent = fmt(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = fmt(to);
  };
  requestAnimationFrame(tick);
}

export function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ───────────────────────── business helpers ───────────────────────── */

// Bill totals. Prices are VAT-exclusive; the bill-level discount % is spread across lines.
export function calcTotals(lines, discountPct = 0) {
  const pct = Math.min(100, Math.max(0, Number(discountPct) || 0));
  let subtotal = 0, net = 0, vat = 0;
  const out = lines.map((l) => {
    const gross = round2(l.price * l.qty);
    const lineDisc = round2(gross * pct / 100);
    const lineNet = round2(gross - lineDisc);
    const lineVat = round2(lineNet * (l.vatRate || 0) / 100);
    subtotal += gross; net += lineNet; vat += lineVat;
    return { ...l, gross, lineDisc, lineNet, lineVat, lineTotal: round2(lineNet + lineVat) };
  });
  subtotal = round2(subtotal); net = round2(net); vat = round2(vat);
  return { lines: out, subtotal, discount: round2(subtotal - net), net, vat, total: round2(net + vat) };
}

// First-expired-first-out allocation. Expired batches are skipped unless includeExpired is set.
export function allocateFEFO(batches, qty, { includeExpired = false } = {}) {
  const today = todayISO();
  const usable = batches
    .filter((b) => (b.remaining || 0) > 0 && (includeExpired || b.expiry >= today))
    .sort((a, b) => (a.expiry || "").localeCompare(b.expiry || ""));
  const plan = [];
  let need = qty;
  for (const b of usable) {
    if (need <= 0) break;
    const take = Math.min(b.remaining, need);
    plan.push({ id: b.id, take, cost: b.cost || 0 });
    need -= take;
  }
  if (need > 0) throw new Error(`Not enough usable stock in batches (short by ${need})`);
  return plan;
}

// Double-entry guard: every journal must balance before it is written.
export function buildJournal({ date = todayISO(), memo, ref = "", lines }) {
  // Every line is checked: no negative amounts, one side per line, nothing dropped silently.
  const norm = [];
  for (const l of lines) {
    const d = round2(Number(l.debit) || 0), c = round2(Number(l.credit) || 0);
    if (d < 0 || c < 0) throw new Error(`Journal amounts cannot be negative (account ${l.account}).`);
    if (d > 0 && c > 0) throw new Error(`Account ${l.account} has a debit and a credit on one line. Use two lines.`);
    if (d === 0 && c === 0) continue;
    norm.push({ account: String(l.account), debit: d, credit: c });
  }
  if (!norm.length) throw new Error("Journal has no amounts");
  const debit = round2(norm.reduce((s, l) => s + l.debit, 0));
  const credit = round2(norm.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(debit - credit) > 0.005) throw new Error(`Journal not balanced: debit ${debit} vs credit ${credit}`);
  return { date, memo, ref, lines: norm, debit, credit, by: session.name, byUid: session.uid, createdAt: serverTimestamp() };
}

export async function audit(action, details = {}) {
  try {
    await addDoc(collection(db, "audit"), { action, details, by: session.name, byUid: session.uid, at: serverTimestamp() });
  } catch (err) {
    console.warn("Audit write failed", err);
  }
}

export async function ensureChartOfAccounts() {
  for (const a of DEFAULT_ACCOUNTS) {
    const ref = doc(db, "accounts", a.code);
    if (!(await getDoc(ref)).exists()) await setDoc(ref, a);
  }
}

/** Looks up a configured payment method by key (cash, card, credit, or any admin-added key). */
export const paymentMethod = (key) => settings.paymentMethods.find((m) => m.key === key) || settings.paymentMethods[0];

/* ───────────────────────── busy buttons ─────────────────────────
   Every save, submit and action button shows a spinner and cannot be pressed twice while it runs. */

export async function withBusy(el, fn) {
  if (!el) return fn();
  const wasDisabled = el.disabled;
  el.disabled = true;
  el.classList.add("loading");
  try {
    return await fn();
  } finally {
    if (el.isConnected) {
      el.disabled = wasDisabled;
      el.classList.remove("loading");
    }
  }
}

/** Runs an async form handler with the form's submit button busy. Errors become toasts. */
export function onSubmit(form, handler) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const btn = e.submitter || form.querySelector('button[type="submit"], button:not([type])');
    withBusy(btn, () => handler(e)).catch((err) => toast(err?.message || "Something went wrong.", "error"));
  });
}

/** Runs an async click handler with the clicked button busy. Errors become toasts. */
export function onAction(el, handler) {
  el.addEventListener("click", (e) => {
    withBusy(el, () => handler(e)).catch((err) => toast(err?.message || "Something went wrong.", "error"));
  });
}

/** For tables and lists: the clicked button gets the spinner, not the whole table. */
export function onDelegated(el, handler) {
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    withBusy(b, () => handler(e, b)).catch((err) => toast(err?.message || "Something went wrong.", "error"));
  });
}
