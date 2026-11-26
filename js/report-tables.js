// All report tables, built from plain data (sales, expenses, products, batches). No Firebase here, so the same code
// runs in the browser and in the scheduled-report job on the server. Money text uses the money() function passed in.
import { serviceReportRows, floatEffect } from "./services-report.js";

export const REPORTS = [
  ["sales", "Sales (item detail)"],
  ["daily", "Daily sales"],
  ["monthly", "Monthly sales"],
  ["yearly", "Yearly sales"],
  ["pl", "Profit & loss"],
  ["expenses", "Expenses"],
  ["services", "Services & wallet"],
  ["productSummary", "Products sold"],
  ["stock", "Stock"],
  ["expiry", "Expiry"],
];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");
const keyOf = (date, group) => (group === "year" ? date.slice(0, 4) : group === "month" ? date.slice(0, 7) : date);
const categoryOf = (e) => e.category || e.accountName || "Other";

function salesTable(sales, group, money) {
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

function plTable(sales, expenses, group, money) {
  const map = new Map();
  const get = (k) => map.get(k) || map.set(k, { net: 0, cogs: 0, exp: 0 }).get(k);
  for (const s of sales) { const a = get(keyOf(s.date, group)); a.net += s.net || 0; a.cogs += s.cogs || 0; }
  for (const e of expenses) get(keyOf(e.date, group)).exp += Number(e.amount) || 0;
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

function expenseTable(expenses, group, money) {
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
      ["Biggest category", biggest ? `${biggest[0]} (${money(biggest[1])})` : "-"],
    ],
  };
}

function servicesTable(sales, money) {
  const svc = serviceReportRows(sales);
  const rows = svc.map((a) => [
    a.type === "recharge" ? "Mobile recharge" : a.type === "cashin" ? "Wallet cash-in" : "Wallet cash-out",
    a.provider, a.count, round2(a.transfer), round2(a.fees), round2(floatEffect(a.type, a.transfer)),
  ]);
  const sumType = (type) => round2(svc.filter((a) => a.type === type).reduce((s, a) => s + a.transfer, 0));
  const feesAll = round2(rows.reduce((s, r) => s + r[4], 0));
  const floatAll = round2(rows.reduce((s, r) => s + r[5], 0));
  const byProvider = new Map();
  rows.forEach((r) => byProvider.set(r[1], round2((byProvider.get(r[1]) || 0) + r[4])));
  return {
    headers: ["Service", "Provider", "Count", "Transfer amount", "Fees (income)", "Float effect"],
    numeric: [2, 3, 4, 5],
    rows,
    summary: [
      ["Services sold", rows.reduce((s, r) => s + r[2], 0)],
      ["Fees earned", money(feesAll)],
      ["Recharge amount", money(sumType("recharge"))],
      ["Cash-in amount", money(sumType("cashin"))],
      ["Cash-out amount", money(sumType("cashout"))],
      ["Float change (+ grows)", money(floatAll)],
      ["Fees by provider", [...byProvider.entries()].map(([p, v]) => `${p}: ${money(v)}`).join(" · ") || "-"],
    ],
  };
}

/**
 * All report tables for a date range.
 * data: { sales, expenses, products, batches }  (raw Firestore documents' data)
 * opts: { from, to, today, soon, group, money }
 */
export function buildReportTables({ sales = [], expenses = [], products = [], batches = [] }, { from, to, today, soon, group = "month", money }) {
  const fmt = money || ((n) => (Number(n) || 0).toFixed(2));
  const sorted = [...sales].sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  // Sales detail, product summary and the daily chart (computed in the same pass).
  const saleRows = [];
  const byProduct = new Map();
  const dailyTotals = new Map();
  let net = 0, vat = 0, total = 0, cogs = 0;
  for (const s of sorted) {
    net += s.net || 0; vat += s.vat || 0; total += s.total || 0; cogs += s.cogs || 0;
    dailyTotals.set(s.date, (dailyTotals.get(s.date) || 0) + (s.total || 0));
    for (const it of s.items || []) {
      const isSvc = it.kind === "service";
      const profit = round2((it.lineNet || 0) - (it.cogs || 0));
      saleRows.push([s.date, s.invoiceNo, s.customerName, it.name, isSvc ? 1 : (it.pieces ?? it.qty), round2(it.lineNet), round2(it.lineVat), round2(it.lineTotal), round2(it.cogs || 0), profit, s.paymentLabel || s.payment]);
      if (isSvc) continue;
      const agg = byProduct.get(it.name) || { qty: 0, revenue: 0, cogs: 0 };
      agg.qty += it.pieces ?? it.qty; agg.revenue += it.lineNet || 0; agg.cogs += it.cogs || 0;
      byProduct.set(it.name, agg);
    }
  }
  const productRows = [...byProduct.entries()].sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([name, a]) => [name, a.qty, round2(a.revenue), round2(a.cogs), round2(a.revenue - a.cogs)]);

  const stockRows = products.filter((p) => p.active !== false).map((p) => {
    const stock = Number(p.stock) || 0;
    return [p.name, p.sku || "", p.category || "", stock, Number(p.reorderLevel) || 0, round2(p.costPrice), round2(stock * (Number(p.costPrice) || 0))];
  });
  const stockValue = round2(stockRows.reduce((s, r) => s + r[6], 0));

  const pname = Object.fromEntries(products.map((p) => [p.id, p.name]));
  const expiryRows = batches.filter((b) => (b.remaining || 0) > 0 && b.expiry <= soon)
    .sort((a, b) => a.expiry.localeCompare(b.expiry))
    .map((b) => [
      pname[b.productId] || b.productName || "", b.batchNo || "", b.expiry, b.remaining,
      round2(b.cost || 0), round2(b.remaining * (b.cost || 0)),
      b.expiry < today ? "Expired" : "Expiring soon",
    ]);

  return {
    sales: {
      headers: ["Date", "Invoice", "Customer", "Product", "Qty", "Net", "VAT", "Line total", "COGS", "Profit", "Paid by"],
      numeric: [4, 5, 6, 7, 8, 9],
      rows: saleRows,
      summary: [
        ["Bills", sales.length],
        ["Revenue (net)", fmt(round2(net))],
        ["VAT", fmt(round2(vat))],
        ["Total collected", fmt(round2(total))],
        ["Gross profit", fmt(round2(net - cogs))],
      ],
    },
    daily: salesTable(sales, "day", fmt),
    monthly: salesTable(sales, "month", fmt),
    yearly: salesTable(sales, "year", fmt),
    pl: plTable(sales, expenses, group, fmt),
    expenses: expenseTable(expenses, group, fmt),
    services: servicesTable(sales, fmt),
    productSummary: {
      headers: ["Product", "Qty", "Revenue", "COGS", "Profit"],
      numeric: [1, 2, 3, 4],
      rows: productRows,
      summary: [["Products sold", productRows.length], ["Best seller", productRows[0]?.[0] || "-"]],
    },
    stock: {
      headers: ["Product", "SKU", "Category", "Stock", "Reorder level", "Cost", "Value"],
      numeric: [3, 4, 5, 6],
      rows: stockRows,
      summary: [["Products", stockRows.length], ["Stock value", fmt(stockValue)]],
    },
    expiry: {
      headers: ["Product", "Batch", "Expiry", "Units left", "Unit cost", "Value", "Status"],
      numeric: [3, 4, 5],
      rows: expiryRows,
      summary: [
        ["Expired batches", expiryRows.filter((r) => r[6] === "Expired").length],
        ["Expiring soon", expiryRows.filter((r) => r[6] !== "Expired").length],
      ],
    },
    charts: { daily: [...dailyTotals.entries()].sort((a, b) => a[0].localeCompare(b[0])) },
  };
}

/** Turns chosen report keys into export sections: { title, summary, headers, rows, numeric }. */
export function toSections(tables, keys) {
  return keys.filter((k) => tables[k]).map((k) => {
    const label = REPORTS.find(([key]) => key === k)?.[1] || k;
    const t = tables[k];
    return { key: k, title: label, sheetName: label, summary: t.summary || [], headers: t.headers, rows: t.rows, numeric: t.numeric || [] };
  });
}
