// Returns and voids. Find a sale by its invoice number, return some units or void the whole sale.
// The server checks the staff member's permission and an administrator's password, then posts the stock and money back.
import { db, collection, doc, getDoc, getDocs, query, where, orderBy, limit } from "../firebase.js";
import { money, esc, icon, toast, confirmBox, fmtDateTime, withBusy } from "../core.js";
import { post } from "../api.js";
import { postWithVoucher } from "../journal.js";

export async function render(el) {
  el.innerHTML = `
    <section class="card">
      <h3>Find a sale</h3>
      <form id="rt-find" class="form-grid">
        <label class="span-2">Invoice number<input id="rt-inv" placeholder="e.g. INV-000123" autocomplete="off" /></label>
        <div class="form-actions span-2"><button class="btn primary" type="submit">${icon("eye")}<span>Find sale</span></button></div>
      </form>
    </section>
    <div id="rt-sale"></div>
    <section class="card">
      <h3>Recent returns and voids</h3>
      <div id="rt-recent"><div class="skeleton"></div></div>
    </section>`;
  el.querySelector("#rt-find").addEventListener("submit", (e) => {
    e.preventDefault();
    showSale(el, el.querySelector("#rt-inv").value.trim());
  });
  await showRecent(el);
}

async function showSale(el, invoiceNo) {
  const out = el.querySelector("#rt-sale");
  if (!invoiceNo) return toast("Type the invoice number first.", "error");
  const snap = await getDocs(query(collection(db, "sales"), where("invoiceNo", "==", invoiceNo), limit(1)));
  if (snap.empty) {
    out.innerHTML = `<section class="card"><p class="muted">No sale has the invoice number ${esc(invoiceNo)}.</p></section>`;
    return;
  }
  const sale = { id: snap.docs[0].id, ...snap.docs[0].data() };
  const ledger = await getDoc(doc(db, "saleReturns", sale.id));
  const agg = ledger.exists() ? ledger.data() : {};
  const items = sale.items || [];
  const hasService = items.some((i) => i.kind === "service");
  const voided = sale.status === "voided";
  const rows = items.map((it, i) => {
    if (it.kind === "service") {
      return `<tr><td>${esc(it.name)}</td><td colspan="5" class="muted small">Service line: reversed in Accounting</td></tr>`;
    }
    const done = agg.items?.[i] || 0;
    const left = Math.max(0, it.qty - done);
    return `<tr>
      <td>${esc(it.name)}</td>
      <td class="r">${it.qty}</td>
      <td class="r">${done}</td>
      <td class="r">${left}</td>
      <td class="r"><input type="number" min="0" max="${left}" step="1" value="0" data-q="${i}" class="rt-q" aria-label="Return quantity for ${esc(it.name)}" ${left <= 0 || voided ? "disabled" : ""} /></td>
      <td class="r">${money(it.lineTotal)}</td>
    </tr>`;
  }).join("");

  out.innerHTML = `
    <section class="card">
      <h3>${esc(sale.invoiceNo)} · ${esc(sale.date || "")}</h3>
      <p class="muted small">${esc(sale.customerName || "Walk-in")} · ${esc(sale.paymentLabel || sale.payment || "")} · Total ${money(sale.total)} · Status: ${esc(sale.status || "sold")}</p>
      ${voided ? `<p class="badge">This sale was voided.</p>` : ""}
      ${hasService ? `<p class="muted small">This sale has mobile-money or service lines, so it cannot be returned or voided here.</p>` : ""}
      <div class="table-wrap"><table class="stack-mobile">
        <thead><tr><th>Item</th><th class="r">Sold</th><th class="r">Returned</th><th class="r">Can return</th><th class="r">Return now</th><th class="r">Sold for</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <form id="rt-form" class="form-grid">
        <label class="span-2">Reason<input name="reason" minlength="3" required placeholder="e.g. wrong strength, damaged pack" /></label>
        <label>Administrator email<input name="approverEmail" type="email" autocomplete="off" required /></label>
        <label>Administrator password<input name="approverPassword" type="password" autocomplete="new-password" required /></label>
        <div class="form-actions span-2">
          <button class="btn ghost" type="button" id="rt-void-sel" ${hasService || voided ? "disabled" : ""}>${icon("x")}<span>Void selected items</span></button>
          <button class="btn ghost" type="button" id="rt-void" ${hasService || voided ? "disabled" : ""}>${icon("x")}<span>Void whole sale</span></button>
          <button class="btn primary" type="submit" ${hasService || voided ? "disabled" : ""}>${icon("check")}<span>Return selected items</span></button>
        </div>
      </form>
    </section>`;

  const form = out.querySelector("#rt-form");
  const reasonOf = () => String(form.elements.reason.value || "").trim();
  const approverOf = () => ({ approverEmail: form.elements.approverEmail.value.trim(), approverPassword: form.elements.approverPassword.value });
  const after = async (r, what) => {
    toast(`${what} saved. ${r.jvNo} posted. Refund ${money(r.refund)}.`, "success");
    form.elements.approverPassword.value = "";
    await showSale(el, invoiceNo);
    await showRecent(el);
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const lines = [...out.querySelectorAll(".rt-q")]
      .map((i) => ({ index: Number(i.dataset.q), qty: Number(i.value) || 0 }))
      .filter((l) => l.qty > 0);
    if (!lines.length) return toast("Enter how many units to return.", "error");
    if (reasonOf().length < 3) return toast("Write the reason (at least 3 letters).", "error");
    const btn = form.querySelector("button[type=submit]");
    withBusy(btn, async () => {
      const r = await postWithVoucher(() => post("/api/till", { action: "return", kind: "return", saleId: sale.id, lines, reason: reasonOf(), ...approverOf() }, { secure: true }), (x) => x.jvNo);
      await after(r, "Return");
    }).catch((err) => toast(err.message, "error"));
  });

  // Void the selected items, or the whole remaining sale. Both need a reason, a confirmation and the approver's password.
  const selectedLines = () => [...out.querySelectorAll(".rt-q")]
    .map((i) => ({ index: Number(i.dataset.q), qty: Number(i.value) || 0 }))
    .filter((l) => l.qty > 0);
  const runVoid = (btnId, wholeSale) => async () => {
    const lines = wholeSale ? [] : selectedLines();
    if (!wholeSale && !lines.length) return toast("Enter how many units to void.", "error");
    if (reasonOf().length < 3) return toast("Write the reason (at least 3 letters).", "error");
    const message = wholeSale
      ? `Void sale ${sale.invoiceNo}? All its items go back to stock and the full amount is refunded. This cannot be undone.`
      : `Void the selected items on ${sale.invoiceNo}? They go back to stock and their amount is refunded. This cannot be undone.`;
    const ok = await confirmBox(message, { title: wholeSale ? "Void this sale" : "Void selected items", confirmText: "Void", tone: "danger" });
    if (!ok) return;
    const btn = out.querySelector(btnId);
    withBusy(btn, async () => {
      const r = await postWithVoucher(() => post("/api/till", { action: "return", kind: "void", saleId: sale.id, lines, reason: reasonOf(), ...approverOf() }, { secure: true }), (x) => x.jvNo);
      await after(r, "Void");
    }).catch((err) => toast(err.message, "error"));
  };
  out.querySelector("#rt-void").addEventListener("click", runVoid("#rt-void", true));
  out.querySelector("#rt-void-sel").addEventListener("click", runVoid("#rt-void-sel", false));
}

async function showRecent(el) {
  const box = el.querySelector("#rt-recent");
  const snap = await getDocs(query(collection(db, "returns"), orderBy("createdAt", "desc"), limit(20)));
  box.innerHTML = snap.empty
    ? `<p class="muted center">No returns or voids yet.</p>`
    : `<div class="table-wrap"><table class="stack-mobile">
        <thead><tr><th>When</th><th>Type</th><th>Invoice</th><th class="r">Refund</th><th>Reason</th><th>Staff</th><th>Approved by</th><th>JV</th></tr></thead>
        <tbody>${snap.docs.map((d) => {
          const r = d.data();
          return `<tr>
            <td data-label="When">${esc(fmtDateTime(r.createdAt))}</td>
            <td data-label="Type">${r.type === "void" ? "Void" : "Return"}</td>
            <td data-label="Invoice">${esc(r.invoiceNo)}</td>
            <td data-label="Refund" class="r">${money(r.total)}</td>
            <td data-label="Reason" class="wrap-cell">${esc(r.reason)}</td>
            <td data-label="Staff">${esc(r.staffName)}</td>
            <td data-label="Approved by">${esc(r.approverName)}</td>
            <td data-label="JV">${esc(r.jvNo)}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>`;
}
