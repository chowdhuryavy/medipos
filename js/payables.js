// Supplier bills on credit: due dates, status, and paying a supplier against its oldest bills first.
import { db, collection, doc, getDocs, query, where, runTransaction, serverTimestamp } from "./firebase.js";
import { settings, money, esc, round2, toast, openModal, onSubmit, audit, buildJournal, ACCOUNTS, todayISO } from "./core.js";
import { reserveJv, writeVoucher, postWithVoucher } from "./journal.js";

const DAY = 86400000;
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Adds days to a yyyy-mm-dd date (local calendar, no time-zone shift). */
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + (Number(n) || 0));
  return localDate(d);
}

/** Whole days from today to the date. Negative means the date has passed. */
export const dayDiff = (iso) => Math.round((new Date(`${iso}T00:00:00`) - new Date(`${todayISO()}T00:00:00`)) / DAY);
export const billDue = (b) => b.dueDate || b.date;
export const billRemaining = (b) => round2(Math.max(0, (Number(b.total) || 0) - (Number(b.paid) || 0)));
export const isOpenBill = (b) => b.payment === "credit" && (b.status || "open") !== "paid" && billRemaining(b) > 0;

/** Label shown in lists: Paid, Partly paid or Open. Cash and bank purchases are always Paid. */
export function billStatus(b) {
  if (b.payment !== "credit" || b.status === "paid" || billRemaining(b) <= 0) return "Paid";
  return (Number(b.paid) || 0) > 0 ? "Partly paid" : "Open";
}

const byDue = (a, b) => String(billDue(a)).localeCompare(String(billDue(b))) || String(a.date).localeCompare(String(b.date));

/** Open credit bills of one supplier, oldest due first. */
export async function openBillsFor(supplierId) {
  const snap = await getDocs(query(collection(db, "purchases"), where("supplierId", "==", supplierId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(isOpenBill).sort(byDue);
}

/** Every open credit bill across all suppliers, oldest due first. */
export async function allOpenBills() {
  const snap = await getDocs(query(collection(db, "purchases"), where("payment", "==", "credit")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(isOpenBill).sort(byDue);
}

/** Which bills a payment clears, oldest first. Pure: used both for the preview and inside the transaction. */
export function planAllocation(bills, amount) {
  let left = round2(amount);
  const plan = [];
  for (const b of bills) {
    if (left <= 0) break;
    const rem = billRemaining(b);
    if (rem <= 0) continue;
    const pay = round2(Math.min(rem, left));
    left = round2(left - pay);
    const paid = round2((Number(b.paid) || 0) + pay);
    plan.push({ id: b.id, purNo: b.purNo, due: billDue(b), pay, paid, status: paid >= (Number(b.total) || 0) - 0.005 ? "paid" : "partial" });
  }
  return plan;
}

/** Pays a supplier. The amount clears the oldest bills first; anything left over reduces the opening balance. */
export async function settleSupplier({ supplierId, name, amount, cashAccount }) {
  const bills = await openBillsFor(supplierId);
  const supRef = doc(db, "suppliers", supplierId);
  const res = await runTransaction(db, async (tx) => {
    const s = await tx.get(supRef);
    if (!s.exists()) throw new Error("Supplier not found");
    const bal = round2(Number(s.data().balance) || 0);
    if (amount > bal + 0.005) throw new Error(`Amount is more than the balance (${money(bal)})`);
    // Re-read each bill inside the transaction, so a payment made a moment ago is never applied twice.
    const fresh = [];
    for (const b of bills) {
      const snap = await tx.get(doc(db, "purchases", b.id));
      if (snap.exists() && isOpenBill({ id: b.id, ...snap.data() })) fresh.push({ id: b.id, ...snap.data() });
    }
    const plan = planAllocation(fresh, amount);
    const jvNo = await reserveJv(tx);
    tx.update(supRef, { balance: round2(bal - amount), updatedAt: serverTimestamp() });
    for (const p of plan) tx.update(doc(db, "purchases", p.id), { paid: p.paid, status: p.status, paidAt: serverTimestamp() });
    writeVoucher(tx, doc(collection(db, "journal")), buildJournal({
      memo: `Payment to ${name}${plan.length ? ` for ${plan.map((p) => p.purNo).join(", ")}` : ""}`,
      ref: `PMT-${Date.now()}`,
      lines: [{ account: ACCOUNTS.AP, debit: amount }, { account: cashAccount, credit: amount }],
    }), jvNo, "payment");
    return { cleared: plan.map((p) => p.purNo), jvNo };
  });
  await audit("supplier.payment", { id: supplierId, amount, bills: res.cleared.length });
  return res;
}

/** Dialog: pay a supplier, with a live preview of which bills the amount clears. */
export async function openPaySupplier(supplier, reload) {
  const bills = await openBillsFor(supplier.id);
  const methods = settings.paymentMethods.filter((m) => !m.credit && m.active !== false);
  if (!methods.length) return toast("No payment method is available. Turn one on in Settings.", "error");
  const owed = round2(Number(supplier.balance) || 0);
  openModal(`Pay ${supplier.name}`, `
    <form id="spf" class="form-grid">
      <div class="span-2 pay-summary"><span>Owed</span><strong>${money(owed)}</strong><span>Open bills</span><strong>${bills.length}</strong></div>
      <label>Amount<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" max="${owed}" value="${owed}" required /></label>
      <label>Paid from
        <select name="method">${methods.map((m) => `<option value="${esc(m.account)}">${esc(m.label)}</option>`).join("")}</select>
      </label>
      <div class="span-2" id="spf-plan"></div>
      <div class="form-actions span-2">
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" type="submit">Record payment</button>
      </div>
    </form>`, (body, close) => {
    body.querySelector("[data-cancel]").addEventListener("click", close);
    const planEl = body.querySelector("#spf-plan");
    const preview = () => {
      const amt = round2(Number(body.querySelector('[name="amount"]').value) || 0);
      if (!bills.length) { planEl.innerHTML = `<p class="muted small">No open bills. The payment reduces the opening balance.</p>`; return; }
      const plan = planAllocation(bills, amt);
      const rest = round2(amt - plan.reduce((s, p) => s + p.pay, 0));
      planEl.innerHTML = `
        <p class="muted small">Applied to the oldest bills first</p>
        <ul class="alert-list">${plan.map((p) => `<li class="pill"><span><strong>${esc(p.purNo)}</strong> <small class="muted">due ${esc(p.due)}</small></span>
          <span>${money(p.pay)} · ${p.status === "paid" ? "clears it" : "part payment"}</span></li>`).join("")}</ul>
        ${rest > 0 ? `<p class="muted small">${money(rest)} is left over and reduces the opening balance.</p>` : ""}`;
    };
    body.querySelector('[name="amount"]').addEventListener("input", preview);
    preview();
    onSubmit(body.querySelector("#spf"), async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const amount = round2(Number(fd.get("amount")) || 0);
      if (!(amount > 0)) return toast("Enter an amount above 0", "error");
      try {
        const { cleared } = await postWithVoucher(() => settleSupplier({ supplierId: supplier.id, name: supplier.name, amount, cashAccount: String(fd.get("method")) }), (r) => r.jvNo);
        toast(cleared.length ? `Paid. Updated ${cleared.join(", ")}` : "Payment recorded", "success");
        close();
        reload?.();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}
