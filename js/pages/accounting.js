import { onSubmit, onAction } from "../core.js";
import { db, collection, doc, getDoc, getDocs, query, where, orderBy, limit, addDoc, setDoc, runTransaction, serverTimestamp } from "../firebase.js";
import {
  session, money, esc, icon, toast, openModal, todayISO, monthStartISO, round2,
  buildJournal, audit, ACCOUNTS, ensureChartOfAccounts, settings, paymentMethod,
} from "../core.js";

const TABS = [
  ["journal", "Journal"],
  ["chart", "Chart of accounts"],
  ["expenses", "Expenses"],
  ["statements", "Statements"],
];

const VIEWS = { journal: viewJournal, chart: viewChart, expenses: viewExpenses, statements: viewStatements };

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
    await VIEWS[tab](body);
  };
  el.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (b) go(b.dataset.tab);
  });
  go("journal");
}

async function loadAccounts() {
  const snap = await getDocs(collection(db, "accounts"));
  return snap.docs.map((d) => ({ code: d.id, ...d.data() })).sort((a, b) => a.code.localeCompare(b.code));
}

/* ───────── Journal ───────── */

async function viewJournal(body) {
  const [jSnap, accounts] = await Promise.all([
    getDocs(query(collection(db, "journal"), orderBy("date", "desc"), limit(100))),
    loadAccounts(),
  ]);
  const name = (code) => accounts.find((a) => a.code === code)?.name || code;
  const entries = jSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  body.innerHTML = `
    <section class="card">
      <div class="toolbar">
        <h3>Latest 100 entries</h3>
        <div class="grow"></div>
        <button class="btn primary" id="j-new">${icon("plus")}<span>Manual entry</span></button>
      </div>
      <p class="muted small">Tap an entry to see its lines.</p>
      <div class="table-wrap"><table class="stack-mobile">
        <thead><tr><th>Date</th><th>Memo</th><th>Ref</th><th class="r">Debit</th><th class="r">Credit</th><th>By</th></tr></thead>
        <tbody>
          ${entries.map((e) => `
            <tr class="expandable" data-jid="${esc(e.id)}">
              <td data-label="Date">${esc(e.date)}</td><td data-label="Memo">${esc(e.memo)}</td><td data-label="Ref">${esc(e.ref || "")}</td>
              <td data-label="Debit" class="r">${money(e.debit)}</td><td data-label="Credit" class="r">${money(e.credit)}</td><td data-label="By">${esc(e.by || "")}</td>
            </tr>
            <tr class="detail hidden" data-detail="${esc(e.id)}"><td colspan="6">
              <table class="mini">${(e.lines || []).map((l) => `<tr><td>${esc(l.account)} · ${esc(name(l.account))}</td><td class="r">${l.debit ? money(l.debit) : ""}</td><td class="r">${l.credit ? money(l.credit) : ""}</td></tr>`).join("")}</table>
            </td></tr>`).join("") || `<tr><td colspan="6" class="muted center">No entries yet</td></tr>`}
        </tbody>
      </table></div>
    </section>`;

  body.addEventListener("click", (e) => {
    const tr = e.target.closest(".expandable");
    if (tr) body.querySelector(`[data-detail="${CSS.escape(tr.dataset.jid)}"]`)?.classList.toggle("hidden");
  });
  body.querySelector("#j-new").addEventListener("click", () => openManualEntry(accounts, () => viewJournal(body)));
}

function openManualEntry(accounts, reload) {
  const opts = accounts.map((a) => `<option value="${esc(a.code)}">${esc(a.code)} · ${esc(a.name)}</option>`).join("");
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
        await addDoc(collection(db, "journal"), journal);
        await audit("journal.manual", { memo: journal.memo, amount: journal.debit });
        toast("Entry posted", "success");
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
  const accounts = await loadAccounts();
  body.innerHTML = `
    <section class="card">
      <div class="toolbar">
        <h3>Chart of accounts</h3>
        <div class="grow"></div>
        <button class="btn ghost" id="ch-seed">${icon("sync")}<span>Load defaults</span></button>
        <button class="btn primary" id="ch-new">${icon("plus")}<span>New account</span></button>
      </div>
      <div class="table-wrap"><table class="stack-mobile">
        <thead><tr><th>Code</th><th>Name</th><th>Type</th></tr></thead>
        <tbody>
          ${accounts.map((a) => `<tr class="row-in"><td data-label="Code">${esc(a.code)}</td><td data-label="Name">${esc(a.name)}</td><td data-label="Type"><span class="badge">${esc(a.type)}</span></td></tr>`).join("")
            || `<tr><td colspan="3" class="muted center">No accounts yet. Tap “Load defaults”.</td></tr>`}
        </tbody>
      </table></div>
    </section>`;
  onAction(body.querySelector("#ch-seed"), async () => {
    await ensureChartOfAccounts();
    toast("Default accounts loaded", "success");
    viewChart(body);
  });
  body.querySelector("#ch-new").addEventListener("click", () => openAccountForm(() => viewChart(body)));
}

function openAccountForm(reload) {
  openModal("New account", `
    <form id="af" class="form-grid">
      <label>Code<input name="code" inputmode="numeric" required placeholder="e.g. 6500" /></label>
      <label>Type
        <select name="type">
          <option value="asset">Asset</option><option value="liability">Liability</option><option value="equity">Equity</option>
          <option value="revenue">Revenue</option><option value="expense">Expense</option>
        </select>
      </label>
      <label class="span-2">Name<input name="name" required /></label>
      <div class="form-actions span-2"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit">Create</button></div>
    </form>`, (body, close) => {
    body.querySelector("[data-cancel]").addEventListener("click", close);
    onSubmit(body.querySelector("#af"), async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const code = String(f.get("code")).trim();
      const ref = doc(db, "accounts", code);
      if ((await getDoc(ref)).exists()) return toast("That code already exists", "error");
      await setDoc(ref, { code, name: String(f.get("name")).trim(), type: String(f.get("type")) });
      await audit("account.create", { code });
      toast("Account created", "success");
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
  const expenseAccounts = accounts.filter((a) => a.type === "expense");
  const rows = snap.docs.map((d) => d.data());
  body.innerHTML = `
    <section class="card">
      <div class="toolbar">
        <h3>Recent expenses</h3>
        <div class="grow"></div>
        <button class="btn primary" id="ex-new">${icon("plus")}<span>Record expense</span></button>
      </div>
      <div class="table-wrap"><table class="stack-mobile">
        <thead><tr><th>Date</th><th>Account</th><th>Payee</th><th>Note</th><th>Paid from</th><th class="r">Amount</th></tr></thead>
        <tbody>
          ${rows.map((x) => `<tr>
            <td data-label="Date">${esc(x.date)}</td>
            <td data-label="Account">${esc(x.accountName)}</td>
            <td data-label="Payee">${esc(x.payee || "—")}</td>
            <td data-label="Note">${esc(x.note || "")}</td>
            <td data-label="Paid from">${esc(x.paidFromName)}</td>
            <td data-label="Amount" class="r">${money(x.amount)}</td></tr>`).join("")
            || `<tr><td colspan="6" class="muted center">No expenses recorded</td></tr>`}
        </tbody>
      </table></div>
    </section>`;
  body.querySelector("#ex-new").addEventListener("click", () => openExpenseForm(expenseAccounts, accounts, () => viewExpenses(body)));
}

function openExpenseForm(expenseAccounts, accounts, reload) {
  const payMethods = settings.paymentMethods.filter((m) => !m.credit);
  openModal("Record expense", `
    <form id="exf" class="form-grid">
      <label>Date<input name="date" type="date" value="${todayISO()}" required /></label>
      <label>Amount<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required /></label>
      <label class="span-2">Expense account
        <select name="account" required>${expenseAccounts.map((a) => `<option value="${esc(a.code)}">${esc(a.name)}</option>`).join("")}</select>
      </label>
      <label>Payee<input name="payee" /></label>
      <label>Paid from
        <select name="method">${payMethods.map((m) => `<option value="${esc(m.account)}">${esc(m.label)}</option>`).join("")}</select>
      </label>
      <label class="span-2">Note<input name="note" /></label>
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
      const paidFromName = payMethods.find((m) => m.account === method)?.label || method;
      if (!(amount > 0)) return toast("Enter an amount above 0", "error");
      try {
        const expRef = doc(collection(db, "expenses"));
        await runTransaction(db, async (tx) => {
          tx.set(expRef, {
            date: String(f.get("date")), amount, account, accountName: accName,
            payee: String(f.get("payee") || ""), note: String(f.get("note") || ""),
            paidFrom: method, paidFromName, by: session.name, createdAt: serverTimestamp(),
          });
          tx.set(doc(collection(db, "journal")), buildJournal({
            date: String(f.get("date")),
            memo: `Expense: ${accName}${f.get("payee") ? " · " + f.get("payee") : ""}`,
            ref: `EXP-${expRef.id.slice(0, 6)}`,
            lines: [{ account, debit: amount }, { account: method, credit: amount }],
          }));
        });
        await audit("expense.create", { amount, account });
        toast("Expense recorded", "success");
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
