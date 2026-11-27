// Standalone journal voucher page (voucher.html?jv=JV-000123). Opened in its own tab after a posting.
// It uses the same Firebase sign-in as the app, reads the voucher with the same rules, and offers
// Print, Save PDF and Excel. It changes nothing in the books.
import { auth, db, onAuthStateChanged, doc, getDoc, getDocs, collection, query, where, limit, addDoc, serverTimestamp } from "./firebase.js";
import { voucherHtml, isPastDay } from "./journal.js";
import { toPdf, toXlsx, rasterLogo } from "./export-files.js";

const $ = (id) => document.getElementById(id);
const sheet = $("vch-sheet");
const bar = $("vch-bar");
const status = $("vch-status");
const JV_PATTERN = /^JV-\d{6}$/;
const jv = new URLSearchParams(location.search).get("jv") || "";
let state = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function showMessage(text) {
  sheet.innerHTML = `<p class="vch-msg">${esc(text)}</p>`;
}

// The voucher is found by its JV number. The creator can always read their own voucher; accounting
// and reports staff can read any voucher. The first query carries the creator filter so it passes the rules for everyone.
async function findVoucher(user) {
  const own = await getDocs(query(collection(db, "journal"), where("jvNo", "==", jv), where("byUid", "==", user.uid), limit(1)));
  if (!own.empty) return own.docs[0].data();
  let any;
  try {
    any = await getDocs(query(collection(db, "journal"), where("jvNo", "==", jv), limit(1)));
  } catch {
    throw new Error("You do not have access to this voucher.");
  }
  if (any.empty) throw new Error(`No voucher ${jv} was found.`);
  return any.docs[0].data();
}

// Account names are for display only. Staff without access to the chart still see the account codes.
async function loadAccountNames() {
  try {
    const snap = await getDocs(collection(db, "accounts"));
    const names = {};
    snap.forEach((d) => { names[d.id] = d.data().name || d.id; });
    return names;
  } catch {
    return {};
  }
}

async function loadState(user) {
  const [voucher, general, brand, accounts] = await Promise.all([
    findVoucher(user),
    getDoc(doc(db, "settings", "general")).then((s) => s.data() || {}).catch(() => ({})),
    getDoc(doc(db, "branding", "public")).then((s) => s.data() || {}).catch(() => ({})),
    loadAccountNames(),
  ]);
  return { v: voucher, settings: general, branding: brand, accounts };
}

const shopName = () => state.settings.shopName || state.branding.shopName || "MediPOS";
const accountName = (code) => state.accounts[code] || code;

function render() {
  const { v, settings, branding } = state;
  sheet.innerHTML = voucherHtml(v, {
    shop: shopName(),
    address: settings.shopAddress || "",
    phone: settings.shopPhone || "",
    tax: settings.taxNumber || "",
    logo: branding.logoUrl || "",
    by: v.by || "",
    accountName,
  });
  if (isPastDay(v.date)) {
    const printed = new Date().toISOString().slice(0, 16).replace("T", " ");
    sheet.insertAdjacentHTML("afterbegin", `<div class="vch-reprint">Reprint copy of a voucher dated ${esc(v.date)} · printed ${esc(printed)} · this copy cannot be edited</div>`);
  }
  bar.hidden = false;
  document.title = `${v.jvNo} · MediPOS`;
}

// The same section shape the report exports use, so the PDF and Excel match the app's style.
function voucherSection() {
  const lines = state.v.lines || [];
  const debit = lines.reduce((t, l) => t + (Number(l.debit) || 0), 0);
  const credit = lines.reduce((t, l) => t + (Number(l.credit) || 0), 0);
  return {
    title: `Journal voucher ${state.v.jvNo}`,
    sheetName: state.v.jvNo,
    summary: [
      ["Date", state.v.date || ""],
      ["Reference", state.v.ref || "-"],
      ["Type", state.v.type || "manual"],
      ["Narration", state.v.memo || ""],
    ],
    headers: ["Account", "Account name", "Debit", "Credit"],
    rows: [
      ...lines.map((l) => [l.account, accountName(l.account), round2(l.debit), round2(l.credit)]),
      ["Total", "", round2(debit), round2(credit)],
    ],
    numeric: [2, 3],
  };
}

function download(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Every print, PDF or Excel copy of a voucher is written to the activity log, so reprints can be traced.
async function logCopy(kind) {
  const u = auth.currentUser;
  if (!u) return;
  try {
    await addDoc(collection(db, "audit"), { action: "voucher.copy", details: { kind, jvNo: state.v?.jvNo || jv }, by: u.email || u.uid, byUid: u.uid, at: serverTimestamp() });
  } catch (err) {
    console.warn("Copy log failed", err);
  }
}

async function savePdf() {
  const { branding } = state;
  const bytes = await toPdf({
    title: `Journal voucher ${state.v.jvNo}`,
    subtitle: `Date ${state.v.date || ""}`,
    footer: `${shopName()} · MediPOS`,
    sections: [voucherSection()],
    brand: { shop: shopName(), color: branding.brandColor || "", logo: await rasterLogo(branding.logoUrl || "") },
  });
  download(`${state.v.jvNo}.pdf`, bytes, "application/pdf");
  logCopy("pdf");
}

function saveExcel() {
  const bytes = toXlsx([voucherSection()], { shop: shopName(), color: state.branding.brandColor || "" });
  download(`${state.v.jvNo}.xlsx`, bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  logCopy("excel");
}

function guarded(fn, label) {
  return async () => {
    if (!state) return;
    status.textContent = `${label}…`;
    try {
      await fn();
      status.textContent = "";
    } catch (err) {
      status.textContent = err.message || `${label} failed.`;
    }
  };
}

$("vch-print").addEventListener("click", () => { logCopy("print"); window.print(); });
$("vch-pdf").addEventListener("click", guarded(savePdf, "Preparing PDF"));
$("vch-xlsx").addEventListener("click", guarded(async () => saveExcel(), "Preparing Excel"));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    showMessage("Sign in to MediPOS in this browser, then reload this tab.");
    return;
  }
  if (!JV_PATTERN.test(jv)) {
    showMessage("This voucher link is not valid.");
    return;
  }
  try {
    state = await loadState(user);
    render();
  } catch (err) {
    showMessage(err.message || "Could not load the voucher.");
  }
});
