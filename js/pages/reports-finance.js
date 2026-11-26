// Finance reports, calculated live from the sales and expense records in the chosen date range.
// Nothing here is fixed: expense categories come from the data, and periods come from the dates in it.
import { db, collection, query, where, getDocs } from "../firebase.js";
import { money, round2 } from "../core.js";

export const FINANCE_KINDS = [
  ["daily", "Daily sales"],
  ["monthly", "Monthly sales"],
  ["yearly", "Yearly sales"],
  ["pl", "Profit & loss"],
  ["expenses", "Expenses"],
];
export const FINANCE_GROUPS = [["day", "Day"], ["month", "Month"], ["year", "Year"]];

const keyOf = (date, group) => (group === "year" ? date.slice(0, 4) : group === "month" ? date.slice(0, 7) : date);
const categoryOf = (e) => e.category || e.accountName || "Other";
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");

async function loadRange(from, to) {
  const [sales, expenses] = await Promise.all([
    getDocs(query(collection(db, "sales"), where("date", ">=", from), where("date", "<=", to))),
    getDocs(query(collection(db, "expenses"), where("date", ">=", from), where("date", "<=", to))),
  ]);
  return { sales: sales.docs.map((d) => d.data()), expenses: expenses.docs.map((d) => d.data()) };
}

// Sales grouped by period: bills, revenue, VAT, cost of goods and gross profit.
function salesTable(sales, group) {
  const map = new Map();
  for (const s of sales) {
    const k = keyOf(s.date, group);
    const a = map.get(k) || { bills: 0, net: 0, vat: 0, total: 0, cogs: 0 };
    a.bills += 1; a.net += s.net || 0; a.vat += s.vat || 0; a.total += s.total || 0; a.cogs += s.cogs || 0;
    map.set(k, a);
  }
  const rows = [...map.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([k, a]) => {
    const net = round2(a.net), cogs = round2(a.cogs), gross = round2(a.net - a.cogs);
    return [k, a.bills, net, round2(a.vat), round2(a.total), cogs, gross, pct(gross, net)];
  });
  const t = rows.reduce((acc, r) => ({ bills: acc.bills + r[1], net: acc.net + r[2], total: acc.total + r[4], gross: acc.gross + r[6] }), { bills: 0, net: 0, total: 0, gross: 0 });
  return {
    headers: ["Period", "Bills", "Revenue (net)", "VAT", "Total collected", "Cost of goods", "Gross profit", "Gross margin"],
    numeric: [1, 2, 3, 4, 5, 6],
    rows,
    summary: [
      ["Bills", t.bills],
      ["Revenue (net)", money(round2(t.net))],
      ["Total collected", money(round2(t.total))],
      ["Gross profit", money(round2(t.gross))],
      ["Gross margin", pct(t.gross, t.net)],
    ],
  };
}

// Profit and loss by period: revenue − cost of goods − expenses = net profit.
function plTable(sales, expenses, group) {
  const map = new Map();
  const get = (k) => map.get(k) || map.set(k, { net: 0, cogs: 0, exp: 0 }).get(k);
  for (const s of sales) { const a = get(keyOf(s.date, group)); a.net += s.net || 0; a.cogs += s.cogs || 0; }
  for (const e of expenses) { get(keyOf(e.date, group)).exp += Number(e.amount) || 0; }
  const rows = [...map.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([k, a]) => {
    const gross = round2(a.net - a.cogs);
    return [k, round2(a.net), round2(a.cogs), gross, round2(a.exp), round2(gross - a.exp)];
  });
  const t = rows.reduce((acc, r) => ({ net: acc.net + r[1], cogs: acc.cogs + r[2], gross: acc.gross + r[3], exp: acc.exp + r[4], profit: acc.profit + r[5] }),
    { net: 0, cogs: 0, gross: 0, exp: 0, profit: 0 });
  return {
    headers: ["Period", "Revenue (net)", "Cost of goods", "Gross profit", "Expenses", "Net profit"],
    numeric: [1, 2, 3, 4, 5],
    rows,
    summary: [
      ["Revenue (net)", money(round2(t.net))],
      ["Cost of goods", money(round2(t.cogs))],
      ["Gross profit", money(round2(t.gross))],
      ["Expenses", money(round2(t.exp))],
      ["Net profit", money(round2(t.profit))],
      ["Net margin", pct(t.profit, t.net)],
    ],
  };
}

// Expenses by period, with one column per category found in the data.
function expenseTable(expenses, group) {
  const cats = [...new Set(expenses.map(categoryOf))].sort((a, b) => a.localeCompare(b));
  const map = new Map();
  for (const e of expenses) {
    const k = keyOf(e.date, group);
    const row = map.get(k) || {};
    const c = categoryOf(e);
    row[c] = (row[c] || 0) + (Number(e.amount) || 0);
    map.set(k, row);
  }
  const rows = [...map.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([k, row]) => {
    const values = cats.map((c) => round2(row[c] || 0));
    return [k, ...values, round2(values.reduce((s, v) => s + v, 0))];
  });
  const totals = cats.map((c) => round2(expenses.filter((e) => categoryOf(e) === c).reduce((s, e) => s + (Number(e.amount) || 0), 0)));
  const grand = round2(totals.reduce((s, v) => s + v, 0));
  const biggest = cats.map((c, i) => [c, totals[i]]).sort((a, b) => b[1] - a[1])[0];
  return {
    headers: ["Period", ...cats, "Total"],
    numeric: cats.map((_, i) => i + 1).concat([cats.length + 1]),
    rows,
    summary: [
      ["Total spent", money(grand)],
      ["Entries", expenses.length],
      ["Categories", cats.length],
      ["Biggest category", biggest ? `${biggest[0]} (${money(biggest[1])})` : "—"],
    ],
  };
}

/** All finance reports for a date range. group: "day" | "month" | "year" (used by P&L and expenses). */
export async function buildFinance(from, to, group = "month") {
  const { sales, expenses } = await loadRange(from, to);
  return {
    daily: salesTable(sales, "day"),
    monthly: salesTable(sales, "month"),
    yearly: salesTable(sales, "year"),
    pl: plTable(sales, expenses, group),
    expenses: expenseTable(expenses, group),
  };
}
