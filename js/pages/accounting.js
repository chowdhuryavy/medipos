import { isPostable, ACCOUNT_STATUSES, statusLabel } from "../core.js";
import { reserveJv, writeVoucher, reverseVoucher, numberExistingVouchers, voucherHtml, postWithVoucher, isPastDay } from "../journal.js";
import { billInputHtml, readBillFrom, billRecord, viewBills } from "../bills.js";
import { branding } from "../branding.js";
import { manageExpenseCategories, expenseCategories } from "../expense-categories.js";
import { onSubmit, onAction, downloadCSV } from "../core.js";
import { printHtml } from "../print.js";
import { SERVICE_TYPES, serviceProviders, floatKey } from "../services.js";
import { db, collection, doc, getDoc, getDocs, query, where, orderBy, limit, addDoc, setDoc, updateDoc, deleteDoc, runTransaction, serverTimestamp } from "../firebase.js";
import {
  session, money, esc, icon, toast, openModal, confirmBox, alertBox, canWrite, todayISO, monthStartISO, round2,
  buildJournal, audit, ACCOUNTS, ensureChartOfAccounts, settings, paymentMethod,
} from "../core.js";

const TABS = [
  ["overview", "Overview"],
  ["journal", "Vouchers"],
  ["ledger", "General ledger"],
  ["trial", "Trial balance"],
  ["income", "Income statement"],
  ["chart", "Chart of accounts"],
  ["expenses", "Expenses"],
  ["statements", "Statements"],
];

const VIEWS = { overview: viewOverview, journal: viewJournal, ledger: viewLedger, trial: viewTrialBalance, income: viewIncomeStatement, chart: viewChart, expenses: viewExpenses, statements: viewStatements };

export async function render(el) {
  el.innerHTML = `
    <div class="tabs" role="tablist">
      ${TABS.map(([k, l], i) => `<button class="tab ${i === 0 ? "active" : ""}" data-tab="${k}" role="tab">${l}</button>`).join("")}
    </div>
    <div id="acc-body"></div>`;
  const body = el.querySelector("#acc-body");

  const go = async (tab) => {
    el.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    body.innerHTML = `<div class="skeleton"></div>`;
    await VIEWS[tab](body, go);
  };
  el.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (b) go(b.dataset.tab);
  });
  go("overview");
}

async function loadAccounts() {
  const snap = await getDocs(collection(db, "accounts"));
  return snap.docs.map((d) => ({ code: d.id, ...d.data() })).sort((a, b) => a.code.localeCompare(b.code));
}

/* ───────── Overview ───────── */

const monthKey = (d) => d.slice(0, 7);

async function viewOverview(body, go) {
  body.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
  const [accounts, jSnap, floatSnap] = await Promise.all([loadAccounts(), getDocs(collection(db, "journal")), getDocs(collection(db, "floats")).catch(() => ({ docs: [] }))]);
  const entries = jSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const expenseAccounts = accounts.filter((a) => a.type === "expense" && isPostable(a));
  const all = accumulate(entries, accounts, "0000-00-00");
  const byCode = Object.fromEntries(all.map((a) => [a.code, a]));
  const balanceOf = (code) => {
    const a = byCode[code];
    if (!a) return 0;
    return a.type === "liability" || a.type === "equity" || a.type === "revenue" ? round2(a.credit - a.debit) : round2(a.debit - a.credit);
  };

  // Revenue and expenses per month, from the journal. Revenue is credit-minus-debit on revenue accounts.
  const perMonth = new Map();
  const monthOf = (k) => perMonth.get(k) || perMonth.set(k, { rev: 0, exp: 0 }).get(k);
  const typeOf = Object.fromEntries(accounts.map((a) => [a.code, a.type]));
  for (const e of entries) {
    const m = monthOf(monthKey(e.date));
    for (const l of e.lines || []) {
      const t = typeOf[l.account];
      if (t === "revenue") m.rev += (l.credit || 0) - (l.debit || 0);
      if (t === "expense") m.exp += (l.debit || 0) - (l.credit || 0);
    }
  }
  const now = new Date();
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const m = perMonth.get(k) || { rev: 0, exp: 0 };
    trend.push({ key: k, label: d.toLocaleString("en", { month: "short" }), rev: round2(m.rev), exp: round2(m.exp) });
  }
  const thisMonth = trend[trend.length - 1];
  const tMax = Math.max(1, ...trend.flatMap((t) => [t.rev, t.exp]));

  const totalDr = round2(entries.reduce((s, e) => s + (e.debit || 0), 0));
  const totalCr = round2(entries.reduce((s, e) => s + (e.credit || 0), 0));
  const balanced = Math.abs(totalDr - totalCr) < 0.01;
  const recent = [...entries].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 8);

  // Wallet and operator floats: each balance is kept by the sales and top-ups. Their total must match ledger account 1020.
  const floatRows = floatSnap.docs.map((d) => ({ id: d.id, balance: round2(Number(d.data().balance) || 0) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const floatTotal = round2(floatRows.reduce((s, f) => s + f.balance, 0));
  const ledgerFloat = balanceOf(ACCOUNTS.WALLET_FLOAT);
  const floatName = (id) => id.replace(/^wallet_/, "Wallet · ").replace(/^operator_/, "Operator · ").replace(/_/g, " ");
  const floatOk = Math.abs(floatTotal - ledgerFloat) < 0.01;

  const kpi = (ico, label, value, tone = "") => `
    <article class="card kpi hover-lift ${tone}"><div class="kpi-ico">${icon(ico)}</div><div><small>${esc(label)}</small><strong>${esc(value)}</strong></div></article>`;

  body.innerHTML = `
    <section class="card">
      <div class="toolbar wrap">
        <h3>Accounts overview</h3>
        <span class="badge ${balanced ? "ok" : "danger"}">${balanced ? "Books balance" : "Books out of balance"}</span>
        <div class="grow"></div>
        <button class="btn primary" data-qa="manual">${icon("plus")}<span>Manual entry</span></button>
        <button class="btn ghost" data-qa="expense">${icon("currency")}<span>Record expense</span></button>
        <button class="btn ghost" data-qa="statements">${icon("reports")}<span>Statements</span></button>
      </div>
    </section>
    <section class="kpi-grid">
      ${kpi("currency", "Cash on hand", money(balanceOf(ACCOUNTS.CASH)))}
      ${kpi("accounting", "Bank", money(balanceOf(ACCOUNTS.BANK)))}
      ${kpi("currency", "Mobile wallet float", money(balanceOf(ACCOUNTS.WALLET_FLOAT)))}
      ${kpi("partners", "Customers owe you", money(balanceOf(ACCOUNTS.AR)))}
      ${kpi("inventory", "Stock value", money(balanceOf(ACCOUNTS.INVENTORY)))}
      ${kpi("partners", "You owe suppliers", money(balanceOf(ACCOUNTS.AP)))}
      ${kpi("reports", "Revenue this month", money(thisMonth.rev))}
      ${kpi("reports", "Expenses this month", money(thisMonth.exp))}
      ${kpi("reports", "Profit this month", money(round2(thisMonth.rev - thisMonth.exp)), thisMonth.rev >= thisMonth.exp ? "" : "tone-warn")}
    </section>
    <section class="card">
      <header class="card-head"><h3>Wallet & operator floats</h3><button class="btn primary sm" data-qa="topup">${icon("plus")}<span>Add to float</span></button></header>
      <p class="muted small">Money the shop holds to send to wallets and top up operators. Cash-in and recharge take from these; cash-out adds to them.</p>
      <div class="recent-list">
        ${floatRows.map((f) => `<div class="recent-row"><strong>${esc(floatName(f.id))}</strong><strong class="r ${f.balance < 0 ? "bad-text" : ""}">${money(f.balance)}</strong></div>`).join("")
          || `<p class="muted center">No float yet. Add money to a wallet or operator to start selling these services.</p>`}
      </div>
      <p class="badge ${floatOk ? "ok" : "danger"}">${floatOk ? `Matches ledger account ${ACCOUNTS.WALLET_FLOAT}` : `Differs from ledger ${ACCOUNTS.WALLET_FLOAT} by ${money(Math.abs(floatTotal - ledgerFloat))}`}</p>
    </section>
    <section class="card">
      <header class="card-head"><h3>Last 6 months</h3><span class="muted small"><i class="sw sw-rev"></i> Revenue <i class="sw sw-exp"></i> Expenses</span></header>
      <div class="chart trend">
        ${trend.map((t, i) => `
          <div class="bar-col" title="${esc(t.label)}: revenue ${esc(money(t.rev))}, expenses ${esc(money(t.exp))}">
            <div class="pair">
              <div class="bar rev" style="--h:${Math.max(2, Math.round((t.rev / tMax) * 100))}%; --i:${i}"></div>
              <div class="bar exp" style="--h:${Math.max(2, Math.round((t.exp / tMax) * 100))}%; --i:${i}"></div>
            </div>
            <span class="bar-label">${esc(t.label)}</span>
          </div>`).join("")}
      </div>
    </section>
    <section class="card">
      <header class="card-head"><h3>Latest entries</h3><button class="btn ghost sm" data-qa="journal">View all</button></header>
      <div class="recent-list">
        ${recent.map((e) => `
          <div class="recent-row">
            <div><strong>${esc(e.memo)}</strong><small>${esc(e.date)}${e.ref ? " · " + esc(e.ref) : ""}</small></div>
            <strong class="r">${money(e.debit)}</strong>
          </div>`).join("") || `<p class="muted center">No entries yet. Make a sale or record an expense to see them here.</p>`}
      </div>
    </section>`;

  body.querySelectorAll("[data-qa]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.qa;
    if (k === "manual") openManualEntry(accounts.filter(isPostable), () => viewOverview(body, go));
    else if (k === "expense") openExpenseForm(expenseAccounts, accounts, () => viewOverview(body, go));
    else if (k === "topup") openFloatTopUp(accounts.filter(isPostable), () => viewOverview(body, go));
    else go(k);
  }));
}

/* Adds money to a wallet or operator float: cash or bank goes into the float, and the journal shows it. */
function openFloatTopUp(accounts, reload) {
  const payMethods = settings.paymentMethods.filter((m) => !m.credit && m.active !== false);
  const kindOpts = [["wallet", "Wallet", settings.walletProviders || []], ["operator", "Operator", settings.rechargeOperators || []]];
  openModal("Add to float", `
    <form id="ftf" class="form-grid">
      <label>Type
        <select name="kind">${kindOpts.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      </label>
      <label>Provider
        <select name="provider" required>${kindOpts[0][2].map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("")}</select>
      </label>
      <label>Amount<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required /></label>
      <label>Paid from
        <select name="method">${payMethods.map((m) => `<option value="${esc(m.account)}">${esc(m.label)}</option>`).join("")}</select>
      </label>
      <label class="span-2">Note<input name="note" /></label>
      <div class="form-actions span-2"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit">Add to float</button></div>
    </form>`, (body, close) => {
    const kind = body.querySelector('[name="kind"]');
    const prov = body.querySelector('[name="provider"]');
    kind.addEventListener("change", () => {
      const list = kindOpts.find(([k]) => k === kind.value)[2];
      prov.innerHTML = list.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
    });
    body.querySelector("[data-cancel]").addEventListener("click", close);
    onSubmit(body.querySelector("#ftf"), async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const amount = round2(Number(f.get("amount")) || 0);
      const provider = String(f.get("provider"));
      const method = String(f.get("method"));
      if (!(amount > 0)) return toast("Enter an amount above 0", "error");
      const type = String(f.get("kind")) === "operator" ? "recharge" : "cashin";
      const key = floatKey(type, provider);
      try {
        const jvNo = await postWithVoucher(() => runTransaction(db, async (tx) => {
          const ref = doc(db, "floats", key);
          const snap = await tx.get(ref);
          const before = snap.exists() ? Number(snap.data().balance) || 0 : 0;
          const jvNo = await reserveJv(tx);
          tx.set(ref, { balance: round2(before + amount), kind: String(f.get("kind")), provider, updatedAt: serverTimestamp() }, { merge: true });
          writeVoucher(tx, doc(collection(db, "journal")), buildJournal({
            date: todayISO(),
            memo: `Float top-up · ${provider}${f.get("note") ? " · " + f.get("note") : ""}`,
            ref: key,
            lines: [{ account: ACCOUNTS.WALLET_FLOAT, debit: amount }, { account: method, credit: amount }],
          }), jvNo, "float");
          return jvNo;
        }));
        await audit("float.topup", { key, amount });
        toast(`Float updated · ${jvNo}`, "success");
        close();
        reload();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

/* ───────── Journal ───────── */

async function viewJournal(body) {
  const accounts = await loadAccounts();
  const name = (code) => accounts.find((a) => a.code === code)?.name || code;
  const today = todayISO();
  const canEdit = canWrite("accounting");
  let byId = new Map();
  let shown = [];
  body.innerHTML = `
    <section class="card">
      <div class="toolbar wrap">
        <h3>Journal vouchers</h3>
        <div class="grow"></div>
        ${canEdit ? `<button class="btn ghost hidden" id="j-number">${icon("sync")}<span>Number existing entries</span></button>` : ""}
        ${canEdit ? `<button class="btn primary" id="j-new">${icon("plus")}<span>Manual entry</span></button>` : ""}
      </div>
      <div class="filter-row">
        <label class="inline">From<input type="date" id="j-from" /></label>
        <label class="inline">To<input type="date" id="j-to" value="${today}" /></label>
        <select id="j-status" aria-label="Status">
          <option value="">All vouchers</option><option value="posted">Posted</option><option value="reversed">Reversed</option><option value="reversal">Reversal vouchers</option>
        </select>
        <input type="search" id="j-q" placeholder="Search JV no, narration, reference, account or amount" aria-label="Search vouchers" />
        <button class="btn ghost sm" id="j-apply">${icon("search")}<span>Search</span></button>
        <button class="btn ghost sm" id="j-clear">Reset</button>
        <button class="btn ghost sm" id="j-csv">${icon("download")}<span>CSV</span></button>
      </div>
      <p class="muted small" id="j-info">Tap a voucher to see its lines. Use View to print it.</p>
      <div class="table-wrap" id="j-table"></div>
    </section>`;

  const statusBadge = (e) => {
    if (e.status === "reversed") return `<span class="badge danger">Reversed by ${esc(e.reversedBy)}</span>`;
    if (e.reverses) return `<span class="badge warn">Reversal of ${esc(e.reverses)}</span>`;
    return `<span class="badge ok">Posted</span>`;
  };

  const load = async () => {
    const from = body.querySelector("#j-from").value;
    const to = body.querySelector("#j-to").value || today;
    const q = body.querySelector("#j-q").value.trim().toLowerCase();
    const status = body.querySelector("#j-status").value;
    body.querySelector("#j-table").innerHTML = `<div class="skeleton"></div>`;
    const snap = from
      ? await getDocs(query(collection(db, "journal"), where("date", ">=", from), where("date", "<=", to), orderBy("date", "desc"), limit(500)))
      : await getDocs(query(collection(db, "journal"), where("date", "<=", to), orderBy("date", "desc"), limit(200)));
    const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    byId = new Map(all.map((e) => [e.id, e]));
    const unnumbered = all.filter((e) => !e.jvNo).length;
    if (canEdit) body.querySelector("#j-number")?.classList.toggle("hidden", !unnumbered);
    shown = all
      .filter((e) => !status || (status === "reversal" ? !!e.reverses : e.status === status))
      .filter((e) => !q || [e.jvNo, e.memo, e.ref, e.by, ...(e.lines || []).map((l) => `${l.account} ${name(l.account)} ${l.debit || ""} ${l.credit || ""}`)]
        .some((v) => String(v || "").toLowerCase().includes(q)))
      .sort((a, b) => String(b.jvNo || "").localeCompare(String(a.jvNo || "")) || String(b.date).localeCompare(String(a.date)));
    body.querySelector("#j-info").textContent = `${shown.length} voucher${shown.length === 1 ? "" : "s"}${from ? ` from ${from}` : ""} to ${to}.${unnumbered ? ` ${unnumbered} entr${unnumbered === 1 ? "y has" : "ies have"} no JV number yet.` : ""}`;
    body.querySelector("#j-table").innerHTML = `
      <table class="stack-mobile">
        <thead><tr><th>JV no.</th><th>Date</th><th>Narration</th><th>Ref</th><th class="r">Debit</th><th class="r">Credit</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${shown.slice(0, 300).map((e) => `
            <tr class="expandable" data-jid="${esc(e.id)}">
              <td data-label="JV no."><strong>${esc(e.jvNo || "—")}</strong></td>
              <td data-label="Date">${esc(e.date)}</td><td data-label="Narration">${esc(e.memo)}</td><td data-label="Ref">${esc(e.ref || "")}</td>
              <td data-label="Debit" class="r">${money(e.debit)}</td><td data-label="Credit" class="r">${money(e.credit)}</td>
              <td data-label="Status">${statusBadge(e)}</td>
              <td class="actions">
                <button class="icon-btn sm" data-view="${esc(e.id)}" aria-label="View ${esc(e.jvNo || "entry")}">${icon("search")}</button>
                ${e.jvNo ? `<button class="btn ghost sm" data-tab="${esc(e.jvNo)}" type="button">Open</button>` : ""}
                ${canEdit && e.jvNo && !e.reverses && e.status !== "reversed"
                  ? `<button class="btn ghost sm" data-reverse="${esc(e.id)}">Reverse</button>` : ""}
              </td>
            </tr>
            <tr class="detail hidden" data-detail="${esc(e.id)}"><td colspan="8">
              <table class="mini">${(e.lines || []).map((l) => `<tr><td>${esc(l.account)} · ${esc(name(l.account))}</td><td class="r">${l.debit ? money(l.debit) : ""}</td><td class="r">${l.credit ? money(l.credit) : ""}</td></tr>`).join("")}</table>
            </td></tr>`).join("") || `<tr><td colspan="8" class="muted center">No vouchers match.</td></tr>`}
        </tbody>
      </table>`;
  };

  body.querySelector("#j-table").addEventListener("click", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) return window.open(`/voucher?jv=${encodeURIComponent(tab.dataset.tab)}`, "_blank");
    const view = e.target.closest("[data-view]");
    if (view) return openVoucher(byId.get(view.dataset.view), name, () => load());
    const rev = e.target.closest("[data-reverse]");
    if (rev) return openReverse(byId.get(rev.dataset.reverse), () => load());
    if (e.target.closest("button, a")) return;
    const tr = e.target.closest(".expandable");
    if (tr) body.querySelector(`[data-detail="${CSS.escape(tr.dataset.jid)}"]`)?.classList.toggle("hidden");
  });
  body.querySelector("#j-apply").addEventListener("click", load);
  body.querySelector("#j-status").addEventListener("change", load);
  body.querySelector("#j-q").addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
  body.querySelector("#j-clear").addEventListener("click", () => {
    body.querySelector("#j-from").value = ""; body.querySelector("#j-to").value = today;
    body.querySelector("#j-q").value = ""; body.querySelector("#j-status").value = ""; load();
  });
  body.querySelector("#j-csv").addEventListener("click", () => {
    const rows = [["JV no.", "Date", "Narration", "Ref", "Status", "Account", "Account name", "Debit", "Credit"]];
    shown.forEach((e) => (e.lines || []).forEach((l) => rows.push([e.jvNo || "", e.date, e.memo, e.ref || "", e.status || "posted", l.account, name(l.account), l.debit || 0, l.credit || 0])));
    downloadCSV(`vouchers-${todayISO()}.csv`, rows);
  });
  body.querySelector("#j-new")?.addEventListener("click", () => openManualEntry(accounts, () => viewJournal(body)));
  onAction(body.querySelector("#j-number"), async () => {
    const n = await numberExistingVouchers();
    toast(n ? `${n} entries numbered` : "Nothing to number", "success");
    load();
  });
  load();
}

// Printable voucher, shown in a dialog first.
function openVoucher(v, name, reload) {
  if (!v) return;
  const html = voucherHtml(v, {
    shop: settings.shopName || "MediPOS", address: settings.shopAddress || "", phone: settings.shopPhone || "", logo: branding.logoUrl || "", tax: settings.taxNumber || "", by: session.name || "", accountName: name,
  });
  openModal(v.jvNo ? `Voucher ${v.jvNo}` : "Voucher", `<div class="jv-view">${html}</div>
    <div class="form-actions"><button class="btn ghost" data-cancel>Close</button><button class="btn primary" id="jv-print">${icon("print")}<span>Print</span></button></div>`,
  (body, close) => {
    body.querySelector("[data-cancel]").addEventListener("click", close);
    body.querySelector("#jv-print").addEventListener("click", () => printHtml(`Journal voucher ${v.jvNo || ""}`, html));
  });
}

// A reversal is a new voucher with its own number. The original is kept, marked reversed.
function openReverse(v, reload) {
  if (!v) return;
  openModal(`Reverse ${v.jvNo}`, `
    <form id="rv" class="form-grid">
      <p class="span-2 muted small">A reversal posts a new voucher with its own JV number that cancels ${esc(v.jvNo)}. Nothing is deleted; both vouchers stay in the books.</p>
      <label class="span-2">Reason<input name="reason" maxlength="120" placeholder="e.g. wrong account, duplicate" /></label>
      <div class="form-actions span-2"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn danger" type="submit">Post reversal</button></div>
    </form>`, (body, close) => {
    body.querySelector("[data-cancel]").addEventListener("click", close);
    onSubmit(body.querySelector("#rv"), async (e) => {
      e.preventDefault();
      const jvNo = await postWithVoucher(() => reverseVoucher(v.id, String(new FormData(e.target).get("reason") || "").trim()));
      toast(`Reversed. New voucher ${jvNo}`, "success");
      close();
      reload();
    });
  });
}

async function viewLedger(body) {
  const accounts = await loadAccounts();
  const today = todayISO();
  body.innerHTML = `
    <section class="card">
      <div class="toolbar wrap"><h3>General ledger</h3></div>
      <p class="muted small">Every voucher line for one account, in date order, with the running balance. Debit balances show as Dr, credit balances as Cr.</p>
      <div class="filter-row">
        <label class="inline">Account<select id="g-acc">${accounts.map((a) => `<option value="${esc(a.code)}">${esc(a.code)} · ${esc(a.name)}</option>`).join("")}</select></label>
        <label class="inline">From<input type="date" id="g-from" value="${today.slice(0, 4)}-01-01" /></label>
        <label class="inline">To<input type="date" id="g-to" value="${today}" /></label>
        <button class="btn ghost sm" id="g-apply">${icon("search")}<span>Show</span></button>
        <button class="btn ghost sm" id="g-csv">${icon("download")}<span>CSV</span></button>
      </div>
      <div class="table-wrap" id="g-out"></div>
    </section>`;
  const name = (code) => accounts.find((a) => a.code === code)?.name || code;
  const bal = (x) => `${money(Math.abs(x))} ${x >= 0 ? "Dr" : "Cr"}`;
  let table = [];
  let byId = new Map();

  const load = async () => {
    const code = body.querySelector("#g-acc").value;
    const from = body.querySelector("#g-from").value || "0000-01-01";
    const to = body.querySelector("#g-to").value || today;
    body.querySelector("#g-out").innerHTML = `<div class="skeleton"></div>`;
    const snap = await getDocs(query(collection(db, "journal"), where("date", "<=", to), orderBy("date", "asc")));
    byId = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    let opening = 0;
    const lines = [];
    for (const e of byId.values()) {
      for (const l of e.lines || []) {
        if (l.account !== code) continue;
        const amt = (Number(l.debit) || 0) - (Number(l.credit) || 0);
        if (e.date < from) opening += amt;
        else lines.push({ id: e.id, date: e.date, jvNo: e.jvNo || "", memo: e.memo, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, amt });
      }
    }
    let run = opening, dr = 0, cr = 0;
    table = lines.map((r) => { run += r.amt; dr += r.debit; cr += r.credit; return { ...r, running: run }; });
    body.querySelector("#g-out").innerHTML = `
      <table class="stack-mobile">
        <thead><tr><th>Date</th><th>JV no.</th><th>Narration</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead>
        <tbody>
          <tr class="muted"><td colspan="5"><strong>Opening balance</strong> ${from === "0000-01-01" ? "" : `before ${esc(from)}`}</td><td class="r">${bal(opening)}</td></tr>
          ${table.map((r) => `<tr>
              <td data-label="Date">${esc(r.date)}</td>
              <td data-label="JV no."><button class="link-btn" data-gview="${esc(r.id)}">${esc(r.jvNo || "—")}</button></td>
              <td data-label="Narration">${esc(r.memo)}</td>
              <td data-label="Debit" class="r">${r.debit ? money(r.debit) : ""}</td>
              <td data-label="Credit" class="r">${r.credit ? money(r.credit) : ""}</td>
              <td data-label="Balance" class="r">${bal(r.running)}</td></tr>`).join("")
            || `<tr><td colspan="6" class="muted center">No lines for ${esc(code)} in this period.</td></tr>`}
        </tbody>
        <tfoot><tr><th colspan="3">Period total · ${esc(code)} ${esc(name(code))}</th><th class="r">${money(dr)}</th><th class="r">${money(cr)}</th><th class="r">${bal(run)}</th></tr></tfoot>
      </table>`;
    body.querySelector("#g-out").dataset.acc = code;
  };

  body.querySelector("#g-apply").addEventListener("click", load);
  body.querySelector("#g-out").addEventListener("click", (e) => {
    const b = e.target.closest("[data-gview]");
    if (b) openVoucher(byId.get(b.dataset.gview), name, () => {});
  });
  body.querySelector("#g-csv").addEventListener("click", () => {
    const code = body.querySelector("#g-acc").value;
    const rows = [["Date", "JV no.", "Narration", "Debit", "Credit", "Balance"]];
    table.forEach((r) => rows.push([r.date, r.jvNo, r.memo, r.debit, r.credit, r.running]));
    downloadCSV(`ledger-${code}-${todayISO()}.csv`, rows);
  });
  load();
}

function openManualEntry(accounts, reload) {
  const opts = accounts.filter(isPostable).map((a) => `<option value="${esc(a.code)}">${esc(a.code)} · ${esc(a.name)}</option>`).join("");
  const rowHtml = () => `
    <div class="jl-row">
      <select data-k="account" aria-label="Account"><option value="">Account…</option>${opts}</select>
      <input data-k="debit" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Debit" aria-label="Debit" />
      <input data-k="credit" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Credit" aria-label="Credit" />
      <button type="button" class="icon-btn sm hover-danger" data-rm aria-label="Remove line">${icon("x")}</button>
    </div>`;

  openModal("Manual journal entry", `
    <form id="me" class="form-grid">
      <label>Date<input name="date" type="date" value="${todayISO()}" required /></label>
      <label>Reference<input name="ref" placeholder="Optional" /></label>
      <label class="span-2">Memo<input name="memo" required /></label>
    </form>
    <div id="jl">${rowHtml()}${rowHtml()}</div>
    <div class="row-between">
      <button class="btn ghost sm" type="button" id="jl-add">${icon("plus")}<span>Add line</span></button>
      <span id="jl-bal" class="badge">Debit 0 · Credit 0</span>
    </div>
    <div class="form-actions">
      <button class="btn ghost" type="button" data-cancel>Cancel</button>
      <button class="btn primary" type="button" id="me-save">Post entry</button>
    </div>`, (body, close) => {
    const jl = body.querySelector("#jl");
    const badge = body.querySelector("#jl-bal");
    const recalc = () => {
      let d = 0, c = 0;
      jl.querySelectorAll(".jl-row").forEach((r) => {
        d += Number(r.querySelector('[data-k="debit"]').value) || 0;
        c += Number(r.querySelector('[data-k="credit"]').value) || 0;
      });
      d = round2(d); c = round2(c);
      const ok = Math.abs(d - c) < 0.005 && d > 0;
      badge.textContent = ok ? `Balanced · ${money(d)}` : `Out by ${money(Math.abs(d - c))}`;
      badge.className = `badge ${ok ? "ok" : "danger"}`;
    };
    jl.addEventListener("input", recalc);
    body.querySelector("#jl-add").addEventListener("click", () => {
      jl.insertAdjacentHTML("beforeend", rowHtml());
    });
    jl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-rm]");
      if (b && jl.querySelectorAll(".jl-row").length > 2) { b.closest(".jl-row").remove(); recalc(); }
    });
    body.querySelector("[data-cancel]").addEventListener("click", close);
    onAction(body.querySelector("#me-save"), async () => {
      const f = new FormData(body.querySelector("#me"));
      const lines = [...jl.querySelectorAll(".jl-row")].map((r) => ({
        account: r.querySelector('[data-k="account"]').value,
        debit: Number(r.querySelector('[data-k="debit"]').value) || 0,
        credit: Number(r.querySelector('[data-k="credit"]').value) || 0,
      })).filter((l) => l.account);
      try {
        const journal = buildJournal({ date: String(f.get("date")), memo: String(f.get("memo")), ref: String(f.get("ref") || ""), lines });
        const jvNo = await postWithVoucher(() => runTransaction(db, async (tx) => {
          const jvNo = await reserveJv(tx);
          writeVoucher(tx, doc(collection(db, "journal")), journal, jvNo, "manual");
          return jvNo;
        }));
        await audit("journal.manual", { memo: journal.memo, amount: journal.debit });
        toast(`Entry posted · ${jvNo}`, "success");
        close();
        reload();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

/* ───────── Chart of accounts ───────── */

async function viewChart(body) {
  const [accounts, journalSnap] = await Promise.all([loadAccounts(), getDocs(collection(db, "journal"))]);
  // Entries per account. An account with entries keeps its place in the books, so it cannot be deleted.
  const entries = new Map();
  journalSnap.docs.forEach((d) => (d.data().lines || []).forEach((l) => entries.set(l.account, (entries.get(l.account) || 0) + 1)));
  const systemCodes = new Set(Object.values(ACCOUNTS));
  const paymentCodes = new Set(settings.paymentMethods.map((m) => m.account));
  const isSystem = (code) => systemCodes.has(code);
  const deleteBlock = (a) => {
    if (isSystem(a.code)) return "The system posts sales, purchases and payments to this account, so it cannot be deleted. You can still rename it.";
    if (paymentCodes.has(a.code)) return "A payment method posts to this account. Point that payment method somewhere else first.";
    const n = entries.get(a.code) || 0;
    if (n) return `This account has ${n} journal ${n === 1 ? "entry" : "entries"}, so it cannot be deleted.`;
    return "";
  };
  body.innerHTML = `
    <section class="card">
      <div class="toolbar">
        <h3>Chart of accounts</h3>
        <div class="grow"></div>
        <button class="btn ghost" id="ch-seed">${icon("sync")}<span>Load defaults</span></button>
        <button class="btn primary" id="ch-new">${icon("plus")}<span>New account</span></button>
      </div>
      <p class="muted small">Rename any account or change its type. The code is fixed once created. Accounts with journal entries cannot be deleted. Accounts marked “System” are used by sales, purchases and payments.</p>
      <div class="table-wrap"><table class="stack-mobile">
        <thead><tr><th>Code</th><th>Name</th><th>Type</th><th class="r">Entries</th><th></th></tr></thead>
        <tbody>
          ${accounts.map((a) => `<tr class="row-in">
            <td data-label="Code">${esc(a.code)}${isSystem(a.code) ? ` <span class="badge">System</span>` : ""}</td>
            <td data-label="Name">${esc(a.name)}${statusLabel(a) ? ` <span class="badge">${esc(statusLabel(a))}</span>` : ""}</td>
            <td data-label="Type"><span class="badge">${esc(a.type)}</span></td>
            <td data-label="Entries" class="r">${entries.get(a.code) || 0}</td>
            <td class="actions">
              <button class="icon-btn sm" data-acc-edit="${esc(a.code)}" aria-label="Edit account ${esc(a.code)}">${icon("edit")}</button>
              <button class="icon-btn sm hover-danger" data-acc-del="${esc(a.code)}" aria-label="Delete account ${esc(a.code)}">${icon("trash")}</button>
            </td></tr>`).join("")
            || `<tr><td colspan="5" class="muted center">No accounts yet. Tap “Load defaults”.</td></tr>`}
        </tbody>
      </table></div>
    </section>`;
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  onAction(body.querySelector("#ch-seed"), async () => {
    await ensureChartOfAccounts();
    toast("Default accounts loaded", "success");
    viewChart(body);
  });
  body.querySelector("#ch-new").addEventListener("click", () => openAccountForm(null, () => viewChart(body), isSystem));
  body.querySelectorAll("[data-acc-edit]").forEach((b) => b.addEventListener("click", () =>
    openAccountForm(byCode.get(b.dataset.accEdit), () => viewChart(body), isSystem)));
  body.querySelectorAll("[data-acc-del]").forEach((b) => b.addEventListener("click", async () => {
    const a = byCode.get(b.dataset.accDel);
    const why = deleteBlock(a);
    if (why) return alertBox({ title: "Cannot delete", tone: "warn", message: why });
    if (!(await confirmBox(`Delete account ${a.code} · ${a.name}? This cannot be undone.`))) return;
    await deleteDoc(doc(db, "accounts", a.code));
    await audit("account.delete", { code: a.code, name: a.name });
    toast("Account deleted", "success");
    viewChart(body);
  }));
}

// One form for create and edit. The code is fixed after creation; accounts the system uses keep their type.
function openAccountForm(account, reload, isSystem = () => false) {
  const editing = !!account;
  const locked = editing && isSystem(account.code);
  const a = account || { code: "", name: "", type: "asset" };
  openModal(editing ? `Edit ${a.code}` : "New account", `
    <form id="af" class="form-grid">
      <label>Code<input name="code" inputmode="numeric" required placeholder="e.g. 6500" value="${esc(a.code)}" ${editing ? "readonly" : ""} /></label>
      <label>Type
        <select name="type" ${locked ? "disabled" : ""}>
          ${[["asset", "Asset"], ["liability", "Liability"], ["equity", "Equity"], ["revenue", "Revenue"], ["expense", "Expense"]]
            .map(([v, l]) => `<option value="${v}" ${a.type === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <label>Status
        <select name="status" ${locked ? "disabled" : ""}>
          ${ACCOUNT_STATUSES.map(([v, l]) => `<option value="${v}" ${(a.status || "active") === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <label class="span-2">Name<input name="name" required maxlength="80" value="${esc(a.name)}" /></label>
      <div class="form-actions span-2"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit">${editing ? "Save changes" : "Create"}</button></div>
    </form>`, (body, close) => {
    body.querySelector("[data-cancel]").addEventListener("click", close);
    onSubmit(body.querySelector("#af"), async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const name = String(f.get("name")).trim();
      if (!name) throw new Error("Give the account a name.");
      if (editing) {
        const patch = { name, status: locked ? "active" : String(f.get("status") || "active") };
        if (!locked) patch.type = String(f.get("type"));
        await updateDoc(doc(db, "accounts", a.code), patch);
        await audit("account.update", { code: a.code, ...patch });
        toast("Account saved", "success");
      } else {
        const code = String(f.get("code")).trim();
        if (!/^\d{4,6}$/.test(code)) throw new Error("The code must be 4 to 6 digits.");
        const ref = doc(db, "accounts", code);
        if ((await getDoc(ref)).exists()) throw new Error("That code already exists.");
        await setDoc(ref, { code, name, type: String(f.get("type")), status: String(f.get("status") || "active") });
        await audit("account.create", { code });
        toast("Account created", "success");
      }
      close();
      reload();
    });
  });
}

/* ───────── Expenses ───────── */

async function viewExpenses(body) {
  const [snap, accounts] = await Promise.all([
    getDocs(query(collection(db, "expenses"), orderBy("date", "desc"), limit(100))),
    loadAccounts(),
  ]);
  const expenseAccounts = accounts.filter((a) => a.type === "expense" && isPostable(a));
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  body.innerHTML = `
    <section class="card">
      <div class="toolbar">
        <h3>Recent expenses</h3>
        <div class="grow"></div>
        <button class="btn ghost" id="ex-cats">${icon("label")}<span>Categories</span></button>
        <button class="btn primary" id="ex-new">${icon("plus")}<span>Record expense</span></button>
      </div>
      <div class="table-wrap"><table class="stack-mobile">
        <thead><tr><th>Date</th><th>Category</th><th>Payee</th><th>Note</th><th>Paid from</th><th class="r">Amount</th><th>Bill</th></tr></thead>
        <tbody>
          ${rows.map((x) => `<tr>
            <td data-label="Date">${esc(x.date)}</td>
            <td data-label="Category">${esc(x.category || x.accountName)}</td>
            <td data-label="Payee">${esc(x.payee || "—")}</td>
            <td data-label="Note">${esc(x.note || "")}</td>
            <td data-label="Paid from">${esc(x.paidFromName)}</td>
            <td data-label="Amount" class="r">${money(x.amount)}</td>
            <td data-label="Bill"><button class="btn ghost" type="button" data-bills="${esc(x.id)}">Bills</button></td></tr>`).join("")
            || `<tr><td colspan="7" class="muted center">No expenses recorded</td></tr>`}
        </tbody>
      </table></div>
    </section>`;
  body.querySelector("#ex-new").addEventListener("click", () => openExpenseForm(expenseAccounts, accounts, () => viewExpenses(body)));
  body.querySelector("#ex-cats").addEventListener("click", () => manageExpenseCategories(() => viewExpenses(body)));
  body.querySelectorAll("[data-bills]").forEach((b) => b.addEventListener("click", () => viewBills(doc(db, "expenses", b.dataset.bills), "expense")));
}

function openExpenseForm(expenseAccounts, accounts, reload) {
  const payMethods = settings.paymentMethods.filter((m) => !m.credit && m.active !== false);
  openModal("Record expense", `
    <form id="exf" class="form-grid">
      <label>Date<input name="date" type="date" value="${todayISO()}" required /></label>
      <label>Amount<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required /></label>
      <label class="span-2">Category
        <select name="account" required>${expenseCategories(expenseAccounts).map((c) => `<option value="${esc(c.account)}">${esc(c.name)}</option>`).join("")}</select>
      </label>
      <label>Payee<input name="payee" /></label>
      <label>Paid from
        <select name="method">${payMethods.map((m) => `<option value="${esc(m.account)}">${esc(m.label)}</option>`).join("")}</select>
      </label>
      <label class="span-2">Note<input name="note" /></label>
      ${billInputHtml()}
      <div class="form-actions span-2"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit">Save expense</button></div>
    </form>`, (body, close) => {
    body.querySelector("[data-cancel]").addEventListener("click", close);
    onSubmit(body.querySelector("#exf"), async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const amount = round2(Number(f.get("amount")) || 0);
      const account = String(f.get("account"));
      const method = String(f.get("method"));
      const accName = accounts.find((a) => a.code === account)?.name || account;
      const category = expenseCategories(expenseAccounts).find((c) => c.account === account)?.name || accName;
      const paidFromName = payMethods.find((m) => m.account === method)?.label || method;
      if (!(amount > 0)) return toast("Enter an amount above 0", "error");
      try {
        const expRef = doc(collection(db, "expenses"));
        const jvNo = await postWithVoucher(async () => {
          const bill = await readBillFrom(f.get("bill"));
          return runTransaction(db, async (tx) => {
          const jvNo = await reserveJv(tx);
          tx.set(expRef, {
            date: String(f.get("date")), amount, account, accountName: accName, category,
            payee: String(f.get("payee") || ""), note: String(f.get("note") || ""),
            paidFrom: method, paidFromName, jvNo, by: session.name, createdAt: serverTimestamp(),
          });
          writeVoucher(tx, doc(collection(db, "journal")), buildJournal({
            date: String(f.get("date")),
            memo: `Expense: ${accName}${f.get("payee") ? " · " + f.get("payee") : ""}`,
            ref: `EXP-${expRef.id.slice(0, 6)}`,
            lines: [{ account, debit: amount }, { account: method, credit: amount }],
          }), jvNo, "expense");
          if (bill) tx.set(doc(collection(expRef, "bills")), billRecord(bill));
          return jvNo;
          });
        });
        await audit("expense.create", { amount, account });
        toast(`Expense recorded · ${jvNo}`, "success");
        close();
        reload();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

/* ───────── Statements ───────── */

async function viewStatements(body) {
  body.innerHTML = `
    <section class="card">
      <div class="toolbar wrap">
        <div class="seg" id="st-kind" role="radiogroup">
          <label><input type="radio" name="kind" value="pl" checked /><span>Profit & Loss</span></label>
          <label><input type="radio" name="kind" value="bs" /><span>Balance Sheet</span></label>
          <label><input type="radio" name="kind" value="tb" /><span>Trial Balance</span></label>
        </div>
        <div class="grow"></div>
        <label class="inline">From<input type="date" id="st-from" value="${monthStartISO()}" /></label>
        <label class="inline">To<input type="date" id="st-to" value="${todayISO()}" /></label>
        <button class="btn primary" id="st-run">${icon("reports")}<span>Show</span></button>
        <button class="btn ghost" id="st-print">${icon("print")}<span>Print</span></button>
      </div>
      <div id="st-out" class="statement"></div>
    </section>`;

  const out = body.querySelector("#st-out");
  const run = async () => {
    const kind = body.querySelector('input[name="kind"]:checked').value;
    const from = body.querySelector("#st-from").value || "0000-01-01";
    const to = body.querySelector("#st-to").value || todayISO();
    out.innerHTML = `<div class="skeleton"></div>`;
    const [jSnap, accounts] = await Promise.all([
      getDocs(query(collection(db, "journal"), where("date", "<=", to))),
      loadAccounts(),
    ]);
    const accts = accumulate(jSnap.docs.map((d) => d.data()), accounts, from);
    out.innerHTML = kind === "pl" ? profitLoss(accts, from, to)
      : kind === "bs" ? balanceSheet(accts, to)
      : trialBalance(accts, to);
  };
  body.querySelector("#st-run").addEventListener("click", run);
  body.querySelector("#st-print").addEventListener("click", () => {
    if (!out.innerHTML.trim()) return;
    printHtml("Statement", out.innerHTML);
  });
  body.querySelector("#st-kind").addEventListener("change", run);
  run();
}

function accumulate(entries, accounts, from) {
  const map = new Map(accounts.map((a) => [a.code, { code: a.code, name: a.name, type: a.type, debit: 0, credit: 0, pDebit: 0, pCredit: 0 }]));
  for (const e of entries) {
    for (const l of e.lines || []) {
      if (!map.has(l.account)) map.set(l.account, { code: l.account, name: l.account, type: "unknown", debit: 0, credit: 0, pDebit: 0, pCredit: 0 });
      const m = map.get(l.account);
      m.debit += l.debit || 0;
      m.credit += l.credit || 0;
      if (e.date >= from) { m.pDebit += l.debit || 0; m.pCredit += l.credit || 0; }
    }
  }
  return [...map.values()];
}

const sumBy = (arr, fn) => round2(arr.reduce((s, a) => s + fn(a), 0));
const statementTable = (head, rows, foot) => `
  <div class="table-wrap"><table class="stack-mobile">
    ${head ? `<thead>${head}</thead>` : ""}
    <tbody>${rows}${foot || ""}</tbody>
  </table></div>`;
const amountRow = (a, amt) => `<tr><td data-label="Code" class="muted">${esc(a.code)}</td><td data-label="Account">${esc(a.name)}</td><td data-label="Amount" class="r">${money(amt)}</td></tr>`;
const totalRow = (label, amt, cls = "") => `<tr class="total ${cls}"><td colspan="2">${esc(label)}</td><td class="r">${money(amt)}</td></tr>`;

function section(title, list, amtFn) {
  const rows = list.filter((a) => amtFn(a) !== 0).map((a) => amountRow(a, amtFn(a))).join("");
  const total = sumBy(list, amtFn);
  return { html: `<tr class="section"><td colspan="3">${esc(title)}</td></tr>${rows}`, total };
}

function profitLoss(accts, from, to) {
  const rev = accts.filter((a) => a.type === "revenue");
  const exp = accts.filter((a) => a.type === "expense");
  const rAmt = (a) => a.pCredit - a.pDebit;
  const eAmt = (a) => a.pDebit - a.pCredit;
  const r = section("Revenue", rev, rAmt);
  const x = section("Expenses", exp, eAmt);
  const profit = round2(r.total - x.total);
  return `
    <h3>Profit & Loss · ${esc(from)} to ${esc(to)}</h3>
    ${statementTable(null, r.html + totalRow("Total revenue", r.total) + x.html + totalRow("Total expenses", x.total),
      `<tr class="grand-row ${profit >= 0 ? "ok-text" : "bad-text"}"><td colspan="2">Net profit</td><td class="r">${money(profit)}</td></tr>`)}`;
}

function balanceSheet(accts, to) {
  const dr = (a) => a.debit - a.credit;
  const cr = (a) => a.credit - a.debit;
  const assets = section("Assets", accts.filter((a) => a.type === "asset"), dr);
  const liab = section("Liabilities", accts.filter((a) => a.type === "liability"), cr);
  const eq = section("Equity", accts.filter((a) => a.type === "equity"), cr);
  const earnings = round2(sumBy(accts.filter((a) => a.type === "revenue"), cr) - sumBy(accts.filter((a) => a.type === "expense"), dr));
  const diff = round2(assets.total - liab.total - eq.total - earnings);
  const ok = Math.abs(diff) < 0.01;
  return `
    <h3>Balance Sheet · as of ${esc(to)}</h3>
    ${statementTable(null, assets.html + totalRow("Total assets", assets.total) + liab.html + totalRow("Total liabilities", liab.total)
      + eq.html + `<tr><td colspan="2">Current earnings</td><td class="r">${money(earnings)}</td></tr>`
      + totalRow("Liabilities + equity", liab.total + eq.total + earnings))}
    <p class="badge ${ok ? "ok" : "danger"}">${ok ? "Balances" : `Out of balance by ${money(diff)}`}</p>`;
}

function trialBalance(accts, to) {
  let dTot = 0, cTot = 0;
  const rows = accts.filter((a) => a.debit || a.credit).sort((a, b) => a.code.localeCompare(b.code)).map((a) => {
    const net = round2(a.debit - a.credit);
    const d = net > 0 ? net : 0;
    const c = net < 0 ? -net : 0;
    dTot += d; cTot += c;
    return `<tr><td data-label="Code" class="muted">${esc(a.code)}</td><td data-label="Account">${esc(a.name)}</td>
      <td data-label="Debit" class="r">${d ? money(d) : ""}</td><td data-label="Credit" class="r">${c ? money(c) : ""}</td></tr>`;
  }).join("");
  return `
    <h3>Trial Balance · as of ${esc(to)}</h3>
    <div class="table-wrap"><table class="stack-mobile">
      <thead><tr><th>Code</th><th>Account</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead>
      <tbody>${rows}<tr class="grand-row"><td colspan="2">Totals</td><td class="r">${money(round2(dTot))}</td><td class="r">${money(round2(cTot))}</td></tr></tbody>
    </table></div>`;
}

// Shared loader for the two reports: every journal line up to the end date, with activity since the start date.
async function reportData(from, to) {
  const [jSnap, accounts] = await Promise.all([
    getDocs(query(collection(db, "journal"), where("date", "<=", to))),
    loadAccounts(),
  ]);
  return accumulate(jSnap.docs.map((d) => d.data()), accounts, from);
}

async function viewTrialBalance(body) {
  body.innerHTML = `
    <section class="card">
      <div class="toolbar wrap">
        <h3>Trial balance</h3>
        <div class="grow"></div>
        <label class="inline">As of<input type="date" id="tb-to" value="${todayISO()}" /></label>
        <button class="btn primary" id="tb-run">${icon("reports")}<span>Show</span></button>
        <button class="btn ghost" id="tb-csv">${icon("download")}<span>Excel (CSV)</span></button>
        <button class="btn ghost" id="tb-print">${icon("print")}<span>Print</span></button>
      </div>
      <div id="tb-out" class="statement"></div>
    </section>`;
  const out = body.querySelector("#tb-out");
  let last = null;
  const run = async () => {
    const to = body.querySelector("#tb-to").value || todayISO();
    out.innerHTML = `<div class="skeleton"></div>`;
    const accts = await reportData("0000-01-01", to);
    const diff = round2(accts.reduce((s, a) => s + (a.debit - a.credit), 0));
    const ok = Math.abs(diff) < 0.01;
    last = { to, accts: accts.filter((a) => a.debit || a.credit).sort((a, b) => a.code.localeCompare(b.code)) };
    out.innerHTML = trialBalance(accts, to) + `<p class="badge ${ok ? "ok" : "danger"}">${ok ? "Debits equal credits" : `Out of balance by ${money(diff)}`}</p>`;
  };
  body.querySelector("#tb-run").addEventListener("click", run);
  body.querySelector("#tb-print").addEventListener("click", () => { if (out.innerHTML.trim()) printHtml("Trial balance", out.innerHTML); });
  body.querySelector("#tb-csv").addEventListener("click", () => {
    if (!last) return;
    const rows = [["Code", "Account", "Debit", "Credit"]];
    let d = 0, c = 0;
    for (const a of last.accts) {
      const net = round2(a.debit - a.credit);
      const dv = net > 0 ? net : 0, cv = net < 0 ? -net : 0;
      d += dv; c += cv;
      rows.push([a.code, a.name, dv || "", cv || ""]);
    }
    rows.push(["", "Totals", round2(d), round2(c)]);
    downloadCSV(`trial-balance-${last.to}.csv`, rows);
  });
  body.querySelector("#tb-to").addEventListener("change", run);
  run();
}

async function viewIncomeStatement(body) {
  body.innerHTML = `
    <section class="card">
      <div class="toolbar wrap">
        <h3>Income statement</h3>
        <div class="grow"></div>
        <label class="inline">From<input type="date" id="is-from" value="${monthStartISO()}" /></label>
        <label class="inline">To<input type="date" id="is-to" value="${todayISO()}" /></label>
        <button class="btn primary" id="is-run">${icon("reports")}<span>Show</span></button>
        <button class="btn ghost" id="is-print">${icon("print")}<span>Print</span></button>
      </div>
      <div id="is-out" class="statement"></div>
    </section>`;
  const out = body.querySelector("#is-out");
  const run = async () => {
    const from = body.querySelector("#is-from").value || "0000-01-01";
    const to = body.querySelector("#is-to").value || todayISO();
    out.innerHTML = `<div class="skeleton"></div>`;
    const accts = await reportData(from, to);
    out.innerHTML = incomeStatement(accts, from, to);
  };
  body.querySelector("#is-run").addEventListener("click", run);
  body.querySelector("#is-print").addEventListener("click", () => { if (out.innerHTML.trim()) printHtml("Income statement", out.innerHTML); });
  run();
}

// Revenue, cost of sales (accounts starting with 5), gross profit, operating expenses, net profit.
function incomeStatement(accts, from, to) {
  const rAmt = (a) => a.pCredit - a.pDebit;
  const eAmt = (a) => a.pDebit - a.pCredit;
  const revenue = section("Revenue", accts.filter((a) => a.type === "revenue"), rAmt);
  const expenses = accts.filter((a) => a.type === "expense");
  const cogs = section("Cost of sales", expenses.filter((a) => String(a.code).startsWith("5")), eAmt);
  const opex = section("Operating expenses", expenses.filter((a) => !String(a.code).startsWith("5")), eAmt);
  const gross = round2(revenue.total - cogs.total);
  const net = round2(gross - opex.total);
  const margin = revenue.total > 0 ? ((gross / revenue.total) * 100).toFixed(1) : "0.0";
  return `
    <h3>Income statement · ${esc(from)} to ${esc(to)}</h3>
    ${statementTable(null,
      revenue.html + totalRow("Total revenue", revenue.total)
      + cogs.html + totalRow("Total cost of sales", cogs.total)
      + `<tr class="total"><td colspan="2">Gross profit (margin ${margin}%)</td><td class="r">${money(gross)}</td></tr>`
      + opex.html + totalRow("Total operating expenses", opex.total),
      `<tr class="grand-row ${net >= 0 ? "ok-text" : "bad-text"}"><td colspan="2">Net profit</td><td class="r">${money(net)}</td></tr>`)}`;
}
