// Bills: open bills (kept until they are closed or voided), closed bills (charged sales), and voids (every bill, item or sale voided, with its reason).
import { db, collection, doc, getDocs, addDoc, deleteDoc, query, orderBy, limit, serverTimestamp } from "../firebase.js";
import { esc, icon, toast, openModal, onSubmit, onDelegated, money, fmtDateTime, calcTotals, round2, audit, session } from "../core.js";
import { printReceipt, saleForPrint } from "../print.js";

const TABS = [["open", "Open bills", "pause"], ["closed", "Closed bills", "accounting"], ["void", "Void", "x"]];

export async function render(el) {
  el.innerHTML = `
    <div class="tabs" role="tablist">
      ${TABS.map(([k, l, ic], i) => `<button class="tab ${i === 0 ? "active" : ""}" data-tab="${k}" role="tab">${icon(ic)}<span>${l}</span></button>`).join("")}
    </div>
    <div id="bills-body"></div>`;
  const body = el.querySelector("#bills-body");
  const show = async (key) => {
    el.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === key));
    body.innerHTML = `<section class="card"><p class="muted">Loading…</p></section>`;
    if (key === "open") return openTab(body);
    if (key === "closed") return closedTab(body);
    return voidTab(body);
  };
  el.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  await show("open");
}

// A saved bill's total: goods after its discounts and VAT, plus service fees. Transfers are not sales, so they are left out.
function billTotal(b) {
  const lines = b.lines || [];
  const goods = calcTotals(lines.filter((l) => l.kind !== "service"), 0, b.billDisc || null);
  const fees = round2(lines.filter((l) => l.kind === "service").reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.qty) || 1), 0));
  return round2(goods.total + fees);
}
const itemsText = (lines = []) => lines.map((l) => `${l.kind === "service" ? "" : `${l.qty} × `}${esc(l.name || "item")}`).join(", ") || "No items";

async function openTab(body) {
  const snap = await getDocs(query(collection(db, "openBills"), orderBy("updatedAt", "desc"), limit(100))).catch(() => ({ docs: [] }));
  const bills = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  body.innerHTML = `
    <section class="card">
      <header class="card-head"><h3>Open bills</h3><span class="badge">${bills.length}</span></header>
      <p class="muted small">A bill stays here until it is closed (charged) or voided. Open one to finish it on the Sell screen.</p>
      ${bills.length ? `<div class="stack">${bills.map((b) => `
        <div class="held-row">
          <div><strong>${esc(b.customerName || "Walk-in")} · ${esc(b.byName || "")}</strong>
            <small>${fmtDateTime(b.updatedAt || b.createdAt)} · ${itemsText(b.lines)}</small>
            <small><b>${money(billTotal(b))}</b></small></div>
          <div class="row-actions">
            <button class="btn primary sm" data-open-bill="${esc(b.id)}">Open</button>
            <button class="btn ghost sm hover-danger" data-void-open="${esc(b.id)}">Void</button>
          </div>
        </div>`).join("")}</div>`
        : `<div class="empty-state small">${icon("pause")}<p>No open bills. Press "Open bill" on the Sell screen to keep a bill for later.</p></div>`}
    </section>`;
  body.querySelectorAll("[data-open-bill]").forEach((b) => b.addEventListener("click", () => {
    sessionStorage.setItem("medipos.resumeBill", b.dataset.openBill);
    location.hash = "#/pos";
  }));
  body.querySelectorAll("[data-void-open]").forEach((b) => b.addEventListener("click", () => {
    const bill = bills.find((x) => x.id === b.dataset.voidOpen);
    askReason("Void this open bill", async (reason) => {
      const total = billTotal(bill);
      await addDoc(collection(db, "voidedBills"), {
        source: "open bill", ref: bill.id, reason, total, byName: session.name, byUid: session.uid,
        lines: (bill.lines || []).map((l) => ({ name: l.name || "item", qty: l.qty, unit: l.unit || "", price: l.price, total: round2((Number(l.price) || 0) * (Number(l.qty) || 0)) })),
        createdAt: serverTimestamp(),
      });
      await deleteDoc(doc(db, "openBills", bill.id));
      await audit("bill.void", { source: "open bill", total, reason });
      toast("Open bill voided", "info");
      await openTab(body);
    });
  }));
}

function askReason(title, onOk) {
  openModal(title, `
    <form id="rs-form" class="form-grid">
      <label class="span-2">Reason<textarea name="reason" required rows="3" minlength="3" placeholder="Why is this being voided?"></textarea></label>
      <div class="form-actions span-2"><button type="button" class="btn ghost" data-cancel>Back</button><button class="btn primary" type="submit">Void</button></div>
    </form>`, (mb, close) => {
    mb.querySelector("[data-cancel]").addEventListener("click", close);
    onSubmit(mb.querySelector("#rs-form"), async (e) => {
      const reason = String(new FormData(e.target).get("reason") || "").trim();
      if (reason.length < 3) return toast("Write the reason (at least 3 letters).", "error");
      await onOk(reason);
      close();
    });
  });
}

async function closedTab(body) {
  const snap = await getDocs(query(collection(db, "sales"), orderBy("createdAt", "desc"), limit(100))).catch(() => ({ docs: [] }));
  const sales = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const statusText = (s) => (s.status === "voided" ? "Voided" : s.status === "partly voided" ? "Partly voided" : s.status === "returned" ? "Returned" : "Closed");
  body.innerHTML = `
    <section class="card">
      <header class="card-head"><h3>Closed bills</h3><span class="badge">${sales.length}</span></header>
      <p class="muted small">Every bill that was charged, newest first. A bill voided later shows its status here and under Void.</p>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Invoice</th><th>Date</th><th>Cashier</th><th>Payment</th><th class="r">Total</th><th>Status</th><th></th></tr></thead>
        <tbody>${sales.length ? sales.map((s) => `<tr>
          <td>${esc(s.invoiceNo || "")}</td><td>${fmtDateTime(s.createdAt)}</td><td>${esc(s.cashier || "")}</td>
          <td>${esc(s.paymentLabel || s.payment || "")}</td><td class="r">${money(s.total)}</td><td>${statusText(s)}</td>
          <td class="r"><button type="button" class="btn ghost sm" data-reprint="${esc(s.id)}">${icon("print")}<span>Reprint</span></button></td></tr>`).join("")
          : `<tr><td colspan="7" class="muted">No closed bills yet.</td></tr>`}</tbody>
      </table></div>
    </section>`;
  body.querySelector("tbody")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-reprint]");
    const s = b && sales.find((x) => x.id === b.dataset.reprint);
    if (s) printReceipt(saleForPrint(s), "thermal");
  });
}

async function voidTab(body) {
  const [vSnap, rSnap] = await Promise.all([
    getDocs(query(collection(db, "voidedBills"), orderBy("createdAt", "desc"), limit(100))).catch(() => ({ docs: [] })),
    // Voids of charged sales are returns records with type "void"; they are filtered here to avoid a composite index.
    getDocs(query(collection(db, "returns"), orderBy("createdAt", "desc"), limit(200))).catch(() => ({ docs: [] })),
  ]);
  const rows = [
    ...vSnap.docs.map((d) => {
      const v = d.data();
      const kind = v.source === "item" ? "Item removed" : v.source === "open bill" ? "Open bill voided" : "Bill voided";
      return { when: v.createdAt, kind, ref: v.ref ? `#${String(v.ref).slice(0, 6)}` : "", reason: v.reason, by: v.byName, total: v.total };
    }),
    ...rSnap.docs.filter((d) => d.data().type === "void").map((d) => {
      const r = d.data();
      return { when: r.createdAt, kind: "Sale voided", ref: r.invoiceNo || "", reason: r.reason, by: r.staffName, total: r.total };
    }),
  ].sort((a, b) => (b.when?.toMillis?.() || 0) - (a.when?.toMillis?.() || 0));
  body.innerHTML = `
    <section class="card">
      <header class="card-head"><h3>Void</h3><span class="badge">${rows.length}</span></header>
      <p class="muted small">Every bill, item or sale that was voided, with the reason and who did it.</p>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Date</th><th>What</th><th>Reference</th><th>Reason</th><th>By</th><th class="r">Amount</th></tr></thead>
        <tbody>${rows.length ? rows.slice(0, 200).map((r) => `<tr>
          <td>${fmtDateTime(r.when)}</td><td>${esc(r.kind)}</td><td>${esc(r.ref || "")}</td><td>${esc(r.reason || "")}</td>
          <td>${esc(r.by || "")}</td><td class="r">${money(r.total || 0)}</td></tr>`).join("")
          : `<tr><td colspan="6" class="muted">No voids yet.</td></tr>`}</tbody>
      </table></div>
    </section>`;
}
