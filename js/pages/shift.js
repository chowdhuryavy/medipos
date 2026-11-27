// Cash shift: the till is opened with a counted float and closed with a counted cash figure.
// Expected cash = opening cash + cash sales − cash refunds, all since the shift opened. Sales can't be charged without an open shift.
import { db, collection, doc, getDocs, addDoc, updateDoc, query, where, orderBy, limit, serverTimestamp } from "../firebase.js";
import { session, money, esc, icon, toast, audit, onSubmit, confirmBox, canWrite } from "../core.js";

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

export async function render(el) {
  const snap = await getDocs(query(collection(db, "shifts"), orderBy("openedAt", "desc"), limit(20)));
  const shifts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const open = shifts.find((s) => s.status === "open") || null;
  const live = open ? { ...open, ...(await figures(open.openedAt)) } : null;
  if (live) live.expected = round2(num(live.openingCash) + live.cashIn - live.cashRefunds);
  const canAct = canWrite("pos");

  el.innerHTML = `
    <div class="shift-page">
      ${open ? openCard(live, canAct) : openForm(canAct)}
      <section class="card">
        <header class="card-head"><h3>Recent shifts</h3></header>
        ${historyTable(shifts)}
      </section>
    </div>`;

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
    </section>`;
}

function historyTable(list) {
  if (!list.length) return `<div class="empty-state small">${icon("cart")}<p>No shifts yet.</p></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Opened</th><th>By</th><th class="num">Opening</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Difference</th><th>Closed by</th></tr></thead>
    <tbody>${list.map((s) => `<tr>
      <td data-label="Opened">${esc(when(s.openedAt))}</td>
      <td data-label="By">${esc(s.openedBy || "")}</td>
      <td data-label="Opening" class="num">${money(num(s.openingCash))}</td>
      <td data-label="Expected" class="num">${s.status === "open" ? "Open" : money(num(s.expectedCash))}</td>
      <td data-label="Counted" class="num">${s.status === "open" ? "" : money(num(s.countedCash))}</td>
      <td data-label="Difference" class="num">${s.status === "open" ? "" : `<span class="badge ${num(s.difference) === 0 ? "ok" : "danger"}">${money(num(s.difference))}</span>`}</td>
      <td data-label="Closed by">${esc(s.closedBy || (s.status === "open" ? "Still open" : ""))}</td>
    </tr>`).join("")}</tbody></table></div>`;
}
