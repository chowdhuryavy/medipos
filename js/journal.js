// Journal vouchers (JV). Every posting gets the next JV number inside the same transaction as the money,
// so a number is never used twice or left out. A posted voucher is never edited or deleted:
// a correction is a reversal, which is a new voucher with its own number.
import { db, doc, collection, getDoc, getDocs, query, orderBy, writeBatch, setDoc, runTransaction } from "./firebase.js";
import { buildJournal, esc, money, todayISO } from "./core.js";

export const jvNumber = (n) => `JV-${String(n).padStart(6, "0")}`;
const counterRef = () => doc(db, "counters", "main");

/** Takes the next JV number. Call inside a transaction, after all its reads and before its first write. */
export async function reserveJv(tx) {
  const ref = counterRef();
  const snap = await tx.get(ref);
  const next = (Number(snap.data()?.jv) || 0) + 1;
  tx.set(ref, { jv: next }, { merge: true });
  return jvNumber(next);
}

/** Writes a posted voucher inside a transaction. type says where it came from: sale, purchase, manual, reversal and so on. */
export function writeVoucher(tx, ref, entry, jvNo, type) {
  tx.set(ref, { ...entry, jvNo, type, status: "posted" });
  return ref.id;
}

/**
 * Reverses a posted voucher: a new voucher with the debits and credits swapped, its own number,
 * and a link both ways. The original stays in the books, marked as reversed.
 */
export async function reverseVoucher(id, reason) {
  const ref = doc(db, "journal", id);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Voucher not found.");
    const v = snap.data();
    if (!v.jvNo) throw new Error("This entry has no JV number yet. Number the existing entries first.");
    if (v.status === "reversed") throw new Error(`${v.jvNo} was already reversed by ${v.reversedBy}.`);
    if (v.reverses) throw new Error("A reversal cannot be reversed. Post a new entry instead.");
    const jvNo = await reserveJv(tx);
    const lines = (v.lines || []).map((l) => ({ account: l.account, debit: l.credit || 0, credit: l.debit || 0 }));
    const entry = buildJournal({
      date: todayISO(),
      memo: `Reversal of ${v.jvNo}${reason ? ` · ${reason}` : ""}`,
      ref: v.jvNo,
      lines,
    });
    writeVoucher(tx, doc(collection(db, "journal")), { ...entry, reverses: v.jvNo }, jvNo, "reversal");
    tx.update(ref, { status: "reversed", reversedBy: jvNo });
    return jvNo;
  });
}

/**
 * Gives numbers to entries posted before vouchers existed, in date order, and sets the counter after the last one.
 * Returns how many were numbered.
 */
export async function numberExistingVouchers() {
  const snap = await getDocs(query(collection(db, "journal"), orderBy("date", "asc")));
  const todo = snap.docs.filter((d) => !d.data().jvNo);
  if (!todo.length) return 0;
  const cref = counterRef();
  let n = Number((await getDoc(cref)).data()?.jv) || 0;
  for (let i = 0; i < todo.length; i += 400) {
    const batch = writeBatch(db);
    todo.slice(i, i + 400).forEach((d) => {
      n += 1;
      batch.update(d.ref, { jvNo: jvNumber(n), status: d.data().status || "posted", type: d.data().type || "legacy" });
    });
    await batch.commit();
  }
  await setDoc(cref, { jv: n }, { merge: true });
  return todo.length;
}

/**
 * Runs a posting started by a button click and shows its voucher in a new tab.
 * The tab is opened first, synchronously, because browsers only allow pop-ups during the click itself.
 * jvOf picks the JV number out of run()'s result (identity by default). When it is set, the tab opens that voucher. If the posting fails or has no voucher, the tab is closed.
 * Call it before any await in the click handler.
 */
export async function postWithVoucher(run, jvOf = (r) => r) {
  const tab = window.open("about:blank", "_blank");
  try {
    const result = await run();
    const jvNo = jvOf(result);
    if (jvNo) showVoucher(tab, jvNo);
    else closeTab(tab);
    return result;
  } catch (err) {
    closeTab(tab);
    throw err;
  }
}

/** Points the tab at the voucher page. If the tab was blocked, the JV number is still shown in the app. */
export function showVoucher(tab, jvNo) {
  const url = new URL("/voucher", location.origin);
  url.searchParams.set("jv", jvNo);
  if (tab && !tab.closed) {
    tab.location.href = url.href;
    return true;
  }
  return false;
}

function closeTab(tab) {
  try {
    if (tab && !tab.closed) tab.close();
  } catch {
    /* the browser refused to close it: nothing to do */
  }
}

/** Printable journal voucher: shop name, JV number, details strip, lines, balance check and sign-off boxes. */
const TYPE_LABELS = {
  sale: "Sales", return: "Sales return", void: "Void", purchase: "Purchase", payment: "Payment", receipt: "Receipt",
  expense: "Expense", float: "Float top-up", stock: "Stock movement", manual: "Manual entry", reversal: "Reversal", legacy: "Legacy entry",
};

/** True when a voucher is dated before today: printing it again is a reprint copy. */
export function isPastDay(date, today = todayISO()) {
  return !!date && String(date) < today;
}

export function voucherHtml(v, { shop, address = "", phone = "", tax = "", logo = "", by = "", accountName = (c) => c, color = "#0f766e" }) {
  const lines = v.lines || [];
  const debit = lines.reduce((t, l) => t + (Number(l.debit) || 0), 0);
  const credit = lines.reduce((t, l) => t + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(debit - credit) < 0.005;
  const status = v.status === "reversed" ? "Reversed" : v.reverses ? "Reversal" : "Posted";
  const statusNote = v.status === "reversed" ? `Reversed by ${esc(v.reversedBy)}` : v.reverses ? `Reversal of ${esc(v.reverses)}` : "";
  const typeLabel = TYPE_LABELS[v.type] || (v.type ? String(v.type) : "Manual entry");
  const contact = [address, phone ? `Tel ${phone}` : "", tax ? `Tax no. ${tax}` : ""].filter(Boolean).map(esc).join(" · ");
  const printedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
  const rows = lines.map((l, i) => `
      <tr${i % 2 ? ' class="alt"' : ""}><td class="code">${esc(l.account)}</td><td>${esc(accountName(l.account))}</td>
        <td class="r amt">${l.debit ? money(l.debit) : ""}</td><td class="r amt">${l.credit ? money(l.credit) : ""}</td></tr>`).join("");
  return `
  <div class="jv" style="--jv:${esc(color)}">
    <div class="jv-band"></div>
    <header class="jv-head">
      <div>
        ${logo ? `<img class="jv-logo" src="${esc(logo)}" alt="" />` : ""}
        <h1>${esc(shop || "Pharmacy")}</h1>
        ${contact ? `<div class="jv-addr">${contact}</div>` : ""}
      </div>
      <div class="jv-title">
        <div class="jv-kind">Journal voucher</div>
        <div class="jv-no">${esc(v.jvNo || "—")}</div>
      </div>
    </header>
    <dl class="jv-strip">
      <div><dt>Date</dt><dd>${esc(v.date || "—")}</dd></div>
      <div><dt>Reference</dt><dd>${esc(v.ref || "—")}</dd></div>
      <div><dt>Entry type</dt><dd>${esc(typeLabel)}</dd></div>
      <div><dt>Posted by</dt><dd>${esc(v.by || "—")}</dd></div>
      <div><dt>Status</dt><dd>${status}</dd></div>
    </dl>
    <div class="jv-narr"><span>Narration</span>${esc(v.memo || "—")}${statusNote ? `<em>${statusNote}</em>` : ""}</div>
    <table class="jv-lines">
      <thead><tr><th class="code">Code</th><th>Account</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead>
      <tbody>${rows}
      </tbody>
      <tfoot><tr><th colspan="2">Total</th><th class="r amt">${money(debit)}</th><th class="r amt">${money(credit)}</th></tr></tfoot>
    </table>
    <div class="jv-check ${balanced ? "ok" : "bad"}">${balanced ? "Balanced: total debits equal total credits" : "Warning: debits and credits do not match"}</div>
    <div class="jv-sign">
      <div><b>Prepared by</b><span></span></div>
      <div><b>Checked by</b><span></span></div>
      <div><b>Approved by</b><span></span></div>
    </div>
    <footer class="jv-foot">${esc(shop || "MediPOS")} · Printed ${esc(printedAt)}</footer>
  </div>
  <style>
    .jv{font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:12px}
    .jv-band{height:8px;background:var(--jv);border-radius:4px 4px 0 0}
    .jv-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:16px 0 14px;border-bottom:1px solid #e5e7eb}
    .jv-logo{display:block;max-height:52px;max-width:170px;object-fit:contain;margin:0 0 8px}
    .jv-head h1{margin:0 0 4px;font-size:20px;color:#111827}
    .jv-addr{color:#6b7280;font-size:11px;line-height:1.5}
    .jv-title{text-align:right}
    .jv-kind{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--jv);font-weight:700}
    .jv-no{font-family:"Courier New",monospace;font-size:20px;font-weight:700;color:#111827;margin-top:4px}
    .jv-strip{display:grid;grid-template-columns:repeat(5,1fr);margin:14px 0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden}
    .jv-strip div{padding:8px 10px;border-right:1px solid #e5e7eb;background:#f9fafb}
    .jv-strip div:last-child{border-right:0}
    .jv-strip dt{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6b7280}
    .jv-strip dd{margin:3px 0 0;font-weight:700;color:#111827}
    .jv-narr{padding:10px 12px;border-left:3px solid var(--jv);background:#f9fafb;margin-bottom:14px;line-height:1.5}
    .jv-narr span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:3px}
    .jv-narr em{display:block;margin-top:4px;font-size:11px;color:#6b7280}
    .jv-lines{width:100%;border-collapse:collapse}
    .jv-lines thead th{background:var(--jv);color:#fff;text-align:left;padding:8px 10px;font-size:11px;letter-spacing:.5px}
    .jv-lines td{padding:7px 10px;border-bottom:1px solid #eef0f3}
    .jv-lines tr.alt td{background:#fafafa}
    .jv-lines td.code,.jv-lines th.code{font-family:"Courier New",monospace;width:90px}
    .jv-lines td.code{color:#4b5563}
    .jv-lines tfoot th{padding:9px 10px;border-top:2px solid #111827;font-size:12px;text-align:left}
    .r{text-align:right}
    .amt{font-variant-numeric:tabular-nums;white-space:nowrap}
    .jv-check{display:inline-block;margin-top:10px;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:700}
    .jv-check.ok{background:#dcfce7;color:#166534}
    .jv-check.bad{background:#fee2e2;color:#991b1b}
    .jv-sign{display:flex;gap:18px;margin-top:48px}
    .jv-sign div{flex:1;border-top:1px solid #9ca3af;padding-top:6px;min-height:36px}
    .jv-sign b{display:block;font-size:11px;color:#374151}
    .jv-sign span{display:block;font-size:11px;color:#6b7280;margin-top:2px}
    .jv-foot{margin-top:22px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:10px;color:#9ca3af;text-align:center}
  </style>`;
}
