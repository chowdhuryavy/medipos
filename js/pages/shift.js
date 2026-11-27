// Cash shift: the till is opened with a counted float and closed with a counted cash figure.
// Expected cash = opening cash + cash sales − cash refunds, all since the shift opened. Sales can't be charged without an open shift.
import { db, collection, doc, getDocs, addDoc, updateDoc, query, where, orderBy, limit, serverTimestamp } from "../firebase.js";
import { session, settings, money, esc, icon, toast, audit, onSubmit, confirmBox, canWrite } from "../core.js";
import { printHtml } from "../print.js";

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round(n * 100) / 100;
const when = (ts) => (ts?.toDate ? ts.toDate().toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

// Cash taken and cash paid back since the shift opened. Reads only the time range, so no extra index is needed.
async function figures(openedAt) {
  const since = new Date(openedAt.toMillis());
  const [sales, returns] = await Promise.all([
    getDocs(query(collection(db, "sales"), where("createdAt", ">=", since))),
    getDocs(query(collection(db, "returns"), where("createdAt", ">=", since))),
  ]);
  const cashIn = round2(sales.docs.map((d) => d.data()).filter((s) => s.payment === "cash")
    .reduce((t, s) => t + num(s.collect ?? s.total), 0));
  const cashRefunds = round2(returns.docs.map((d) => d.data()).filter((r) => r.paymentKey === "cash")
    .reduce((t, r) => t + num(r.total), 0));
  return { cashIn, cashRefunds };
}

// Printable shift report: cash count, sales and refunds by payment method, bills and voids, and signature lines.
async function shiftReport(s) {
  const from = new Date(s.openedAt.toMillis());
  const to = s.closedAt ? new Date(s.closedAt.toMillis()) : new Date();
  const [salesSnap, retSnap] = await Promise.all([
    getDocs(query(collection(db, "sales"), where("createdAt", ">=", from), where("createdAt", "<=", to))),
    getDocs(query(collection(db, "returns"), where("createdAt", ">=", from), where("createdAt", "<=", to))),
  ]);
  const sales = salesSnap.docs.map((d) => d.data());
  const returns = retSnap.docs.map((d) => d.data());
  const byMethod = new Map();
  for (const x of sales) {
    const k = x.paymentLabel || x.payment || "-";
    const g = byMethod.get(k) || { bills: 0, amount: 0 };
    g.bills += 1; g.amount += num(x.collect ?? x.total);
    byMethod.set(k, g);
  }
  const sum = (arr, f) => round2(arr.reduce((t, x) => t + f(x), 0));
  const cashSales = sum(sales.filter((x) => x.payment === "cash"), (x) => num(x.collect ?? x.total));
  const cashRefunds = sum(returns.filter((r) => r.paymentKey === "cash"), (r) => num(r.total));
  const isOpen = s.status === "open";
  const expected = round2(num(s.openingCash) + cashSales - cashRefunds);
  const counted = isOpen ? null : num(s.countedCash);
  const diff = isOpen ? null : round2(counted - num(s.expectedCash ?? expected));
  const invoices = sales.map((x) => x.invoiceNo).filter(Boolean).sort();
  const voids = returns.filter((r) => r.type === "void").length;
  const refunds = returns.filter((r) => r.type !== "void").length;
  const methodRows = [...byMethod.entries()].sort((a, b) => b[1].amount - a[1].amount)
    .map(([k, g]) => `<tr><td>${esc(k)}</td><td class="r">${g.bills}</td><td class="r">${money(round2(g.amount))}</td></tr>`).join("")
    || `<tr><td colspan="3" class="muted">No sales in this shift.</td></tr>`;
  const html = `
    <h2>${esc(settings.shopName || "Pharmacy")}</h2>
    <h3>${isOpen ? "Shift report (so far)" : "Cash shift report"}</h3>
    <table class="a4-table">
      <tr><th>Opened by</th><td>${esc(s.openedBy || "")}</td><th>Opened</th><td>${esc(when(s.openedAt))}</td></tr>
      <tr><th>Closed by</th><td>${esc(s.closedBy || (isOpen ? "Still open" : ""))}</td><th>Closed</th><td>${esc(isOpen ? "" : when(s.closedAt))}</td></tr>
    </table>
    <h4>Cash in the drawer</h4>
    <table class="a4-table">
      <tr><td>Opening cash</td><td class="r">${money(num(s.openingCash))}</td></tr>
      <tr><td>Cash sales</td><td class="r">+ ${money(cashSales)}</td></tr>
      <tr><td>Cash refunds</td><td class="r">− ${money(cashRefunds)}</td></tr>
      <tr><th>Expected in drawer</th><th class="r">${money(expected)}</th></tr>
      ${isOpen ? "" : `<tr><td>Counted cash</td><td class="r">${money(counted)}</td></tr>
      <tr><th>Difference</th><th class="r">${money(diff)}</th></tr>
      ${s.note ? `<tr><td>Note</td><td>${esc(s.note)}</td></tr>` : ""}`}
    </table>
    <h4>Sales by payment method</h4>
    <table class="a4-table">
      <thead><tr><th>Payment method</th><th class="r">Bills</th><th class="r">Amount</th></tr></thead>
      <tbody>${methodRows}</tbody>
    </table>
    <h4>Bills</h4>
    <table class="a4-table">
      <tr><td>Bills</td><td class="r">${sales.length}</td></tr>
      <tr><td>Invoice range</td><td class="r">${invoices.length ? `${esc(invoices[0])} to ${esc(invoices[invoices.length - 1])}` : "-"}</td></tr>
      <tr><td>Refunds</td><td class="r">${refunds}</td></tr>
      <tr><td>Voids</td><td class="r">${voids}</td></tr>
    </table>
    <p style="margin-top:40px">Cashier: ____________________ &nbsp;&nbsp;&nbsp; Checked by: ____________________</p>`;
  return { html, title: `${isOpen ? "Shift so far" : "Shift report"} ${when(s.openedAt)}` };
}

export async function render(el) {
  const snap = await getDocs(query(collection(db, "shifts"), orderBy("openedAt", "desc"), limit(20)));
  const shifts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const open = shifts.find((s) => s.status === "open") || null;
  const live = open ? { ...open, ...(await figures(open.openedAt)) } : null;
  if (live) live.expected = round2(num(live.openingCash) + live.cashIn - live.cashRefunds);
  const canAct = canWrite("pos");
  const byId = Object.fromEntries(shifts.map((x) => [x.id, x]));

  el.innerHTML = `
    <div class="shift-page">
      ${open ? openCard(live, canAct) : openForm(canAct)}
      <section class="card">
        <header class="card-head"><h3>Recent shifts</h3></header>
        ${historyTable(shifts)}
      </section>
    </div>`;

  el.querySelectorAll("[data-report]").forEach((b) => b.addEventListener("click", async () => {
    const shift = byId[b.dataset.report];
    if (!shift) return;
    b.disabled = true;
    try {
      const r = await shiftReport(shift);
      printHtml(r.title, r.html);
    } catch (err) {
      toast(err.message || "Could not prepare the report", "error");
    } finally {
      b.disabled = false;
    }
  }));

  const form = el.querySelector("#sh-open");
  if (form) onSubmit(form, async (e) => {
    const opening = round2(Number(new FormData(e.target).get("amount")));
    if (!(opening >= 0)) throw new Error("Enter the cash counted in the drawer.");
    await addDoc(collection(db, "shifts"), {
      status: "open", openingCash: opening, openedAt: serverTimestamp(),
      openedBy: session.name, openedByUid: session.uid,
    });
    await audit("shift.open", { openingCash: opening });
    toast("Shift opened. You can take payment now.", "success");
    render(el);
  });

  const close = el.querySelector("#sh-close");
  if (close) {
    const counted = el.querySelector("#sh-counted");
    const note = el.querySelector("#sh-note");
    const preview = el.querySelector("#sh-diff");
    const showDiff = () => {
      if (counted.value === "") { preview.textContent = ""; return; }
      const diff = round2(Number(counted.value) - live.expected);
      preview.textContent = diff === 0 ? "Matches the expected cash." : diff > 0 ? `Over by ${money(diff)}` : `Short by ${money(-diff)}`;
      preview.className = `shift-diff ${diff === 0 ? "ok" : "warn"}`;
    };
    counted.addEventListener("input", showDiff);
    onSubmit(close, async (e) => {
      const n = round2(Number(counted.value));
      if (!(n >= 0)) throw new Error("Count the cash in the drawer first.");
      // Recount at the moment of closing, so late sales and refunds are included.
      const fresh = await figures(open.openedAt);
      const expected = round2(num(open.openingCash) + fresh.cashIn - fresh.cashRefunds);
      const diff = round2(n - expected);
      if (diff !== 0 && !note.value.trim()) throw new Error("The count differs from the expected cash. Write the reason in the note.");
      if (!(await confirmBox(`Close this shift with ${money(n)} counted? Expected ${money(expected)}.`, { title: "Close shift", confirmText: "Close shift" }))) return;
      await updateDoc(doc(db, "shifts", open.id), {
        status: "closed", closedAt: serverTimestamp(), closedBy: session.name, closedByUid: session.uid,
        cashIn: fresh.cashIn, cashRefunds: fresh.cashRefunds, expectedCash: expected, countedCash: n,
        difference: diff, note: note.value.trim(),
      });
      await audit("shift.close", { expectedCash: expected, countedCash: n, difference: diff });
      toast(diff === 0 ? "Shift closed. The cash matches." : `Shift closed. Difference ${money(diff)}.`, diff === 0 ? "success" : "error");
      render(el);
    });
  }
}

function openForm(canAct) {
  return `
    <section class="card shift-card">
      <header class="card-head"><h3>${icon("cart")} No cash shift is open</h3></header>
      <p class="muted small">Count the cash in the drawer before the first sale. Sales can't be charged until a shift is open.</p>
      ${canAct ? `<form id="sh-open" class="stack">
        <label>Opening cash<input name="amount" type="number" inputmode="decimal" min="0" step="0.01" required /></label>
        <div class="form-actions"><button class="btn primary" type="submit">${icon("check")}<span>Open shift</span></button></div>
      </form>` : `<p class="muted small">Ask a cashier or administrator to open the shift.</p>`}
    </section>`;
}

function openCard(s, canAct) {
  return `
    <section class="card shift-card shift-open">
      <header class="card-head"><h3>${icon("cart")} Shift open</h3><span class="badge ok">Open</span></header>
      <p class="muted small">Opened by ${esc(s.openedBy || "")} · ${esc(when(s.openedAt))}</p>
      <div class="shift-figs">
        <div><span>Opening cash</span><strong>${money(num(s.openingCash))}</strong></div>
        <div><span>Cash sales</span><strong>+ ${money(s.cashIn)}</strong></div>
        <div><span>Cash refunds</span><strong>− ${money(s.cashRefunds)}</strong></div>
        <div class="expected"><span>Expected in drawer</span><strong>${money(s.expected)}</strong></div>
      </div>
      ${canAct ? `<form id="sh-close" class="stack">
        <label>Counted cash<input id="sh-counted" type="number" inputmode="decimal" min="0" step="0.01" required placeholder="Count the drawer" /></label>
        <p id="sh-diff" class="shift-diff" aria-live="polite"></p>
        <label>Note (required if the count differs)<textarea id="sh-note" rows="2" placeholder="Reason for any difference"></textarea></label>
        <div class="form-actions"><button class="btn primary" type="submit">${icon("check")}<span>Close shift</span></button></div>
      </form>` : `<p class="muted small">Only a cashier or administrator can close the shift.</p>`}
      <div class="form-actions"><button class="btn ghost" type="button" data-report="${esc(s.id)}">${icon("print")}<span>Print report so far</span></button></div>
    </section>`;
}

function historyTable(list) {
  if (!list.length) return `<div class="empty-state small">${icon("cart")}<p>No shifts yet.</p></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Opened</th><th>By</th><th class="num">Opening</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Difference</th><th>Closed by</th><th></th></tr></thead>
    <tbody>${list.map((s) => `<tr>
      <td data-label="Opened">${esc(when(s.openedAt))}</td>
      <td data-label="By">${esc(s.openedBy || "")}</td>
      <td data-label="Opening" class="num">${money(num(s.openingCash))}</td>
      <td data-label="Expected" class="num">${s.status === "open" ? "Open" : money(num(s.expectedCash))}</td>
      <td data-label="Counted" class="num">${s.status === "open" ? "" : money(num(s.countedCash))}</td>
      <td data-label="Difference" class="num">${s.status === "open" ? "" : `<span class="badge ${num(s.difference) === 0 ? "ok" : "danger"}">${money(num(s.difference))}</span>`}</td>
      <td data-label="Closed by">${esc(s.closedBy || (s.status === "open" ? "Still open" : ""))}</td>
      <td data-label="Report"><button class="btn ghost sm" type="button" data-report="${esc(s.id)}">${icon("print")}<span>Report</span></button></td>
    </tr>`).join("")}</tbody></table></div>`;
}
