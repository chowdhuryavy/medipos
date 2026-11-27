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

/** Printable journal voucher: shop name, JV number, dates, lines, totals and sign-off boxes. */
export function voucherHtml(v, { shop, address = "", phone = "", logo = "", accountName = (c) => c }) {
  const reversedNote = v.status === "reversed" ? `Reversed by ${esc(v.reversedBy)}` : v.reverses ? `Reversal of ${esc(v.reverses)}` : "";
  const rows = (v.lines || []).map((l) => `
    <tr><td>${esc(l.account)}</td><td>${esc(accountName(l.account))}</td>
      <td class="r">${l.debit ? money(l.debit) : ""}</td><td class="r">${l.credit ? money(l.credit) : ""}</td></tr>`).join("");
  return `
  <div class="jv">
    <header class="jv-head">
      <div>
        ${logo ? `<img class="jv-logo" src="${esc(logo)}" alt="" />` : ""}
        <h1>${esc(shop)}</h1>
        ${address ? `<div>${esc(address)}</div>` : ""}
        ${phone ? `<div>${esc(phone)}</div>` : ""}
      </div>
      <div class="jv-title">
        <h2>JOURNAL VOUCHER</h2>
        <table class="jv-meta">
          <tr><th>JV No.</th><td>${esc(v.jvNo || "—")}</td></tr>
          <tr><th>Date</th><td>${esc(v.date)}</td></tr>
          <tr><th>Reference</th><td>${esc(v.ref || "—")}</td></tr>
          <tr><th>Type</th><td>${esc(v.type || "manual")}</td></tr>
        </table>
      </div>
    </header>
    <p class="jv-memo"><strong>Narration:</strong> ${esc(v.memo || "")}</p>
    ${reversedNote ? `<p class="jv-note">${reversedNote}</p>` : ""}
    <table class="jv-lines">
      <thead><tr><th>Account</th><th>Account name</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th colspan="2">Total</th><th class="r">${money(v.debit)}</th><th class="r">${money(v.credit)}</th></tr></tfoot>
    </table>
    <div class="jv-sign">
      <div>Prepared by<br><small>${esc(v.by || "")}</small></div>
      <div>Checked by</div>
      <div>Approved by</div>
    </div>
  </div>
  <style>
    .jv{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:12px}
    .jv-logo{display:block;max-height:60px;max-width:180px;object-fit:contain;margin:0 0 6px}
    .jv-head{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #111;padding-bottom:10px}
    .jv-head h1{margin:0 0 4px;font-size:20px}
    .jv-title{text-align:right}
    .jv-title h2{margin:0 0 6px;font-size:16px;letter-spacing:2px}
    .jv-meta{margin-left:auto;border-collapse:collapse}
    .jv-meta th{text-align:left;padding:2px 10px 2px 0;font-weight:600}
    .jv-meta td{padding:2px 0;font-family:monospace;font-weight:700}
    .jv-memo{margin:14px 0 6px}
    .jv-note{margin:0 0 10px;font-style:italic}
    .jv-lines{width:100%;border-collapse:collapse;margin-top:8px}
    .jv-lines th,.jv-lines td{border:1px solid #888;padding:6px 8px;text-align:left}
    .jv-lines thead th{background:#eee}
    .jv-lines tfoot th{border-top:2px solid #111}
    .r{text-align:right}
    .jv-sign{display:flex;justify-content:space-between;margin-top:56px;gap:20px}
    .jv-sign div{flex:1;border-top:1px solid #111;padding-top:4px;text-align:center}
  </style>`;
}
