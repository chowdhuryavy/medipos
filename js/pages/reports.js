import { onAction } from "../core.js";
import { db, collection, query, where, getDocs } from "../firebase.js";
import {
  session, money, esc, icon, toast, todayISO, monthStartISO, daysFromNowISO, downloadCSV, round2, audit, settings,
} from "../core.js";
import { pushToSheets } from "../sheets.js";
import { printReport } from "../print.js";
import { FINANCE_KINDS, FINANCE_GROUPS, buildFinance } from "./reports-finance.js";
import { serviceReportRows, floatEffect } from "../services.js";

const KINDS = [["sales", "Sales"], ...FINANCE_KINDS, ["services", "Services & wallet"], ["productSummary", "Products"], ["stock", "Stock"], ["expiry", "Expiry"]];
// Only admins can read the Sheets secret (settings/integrations), so only they can send reports.
const CAN_SYNC = ["admin"];

export async function render(el) {
  el.innerHTML = `
    <section class="card">
      <div class="toolbar wrap">
        <div class="seg" id="r-kind" role="radiogroup">
          ${KINDS.map(([k, l], i) => `<label><input type="radio" name="kind" value="${k}" ${i === 0 ? "checked" : ""} /><span>${l}</span></label>`).join("")}
        </div>
        <label class="inline">From<input type="date" id="r-from" value="${monthStartISO()}" /></label>
        <label class="inline">To<input type="date" id="r-to" value="${todayISO()}" /></label>
        <label class="inline">Expiry window
          <select id="r-days">
            ${[30, 60, 90, 180].map((d) => `<option value="${d}" ${d === settings.expiryWarnDays ? "selected" : ""}>${d} days</option>`).join("")}
          </select>
        </label>
        <label class="inline" id="r-group-wrap">Group by
          <select id="r-group">${FINANCE_GROUPS.map(([v, l]) => `<option value="${v}" ${v === "month" ? "selected" : ""}>${l}</option>`).join("")}</select>
        </label>
        <div class="grow"></div>
        <button class="btn ghost" id="r-print">${icon("print")}<span>Print A4</span></button>
        <button class="btn ghost" id="r-csv">${icon("download")}<span>Download CSV</span></button>
        ${CAN_SYNC.includes(session.role) ? `<button class="btn primary" id="r-sync">${icon("sync")}<span>Send to Google Sheets</span></button>` : ""}
      </div>
    </section>
    <div id="r-out"></div>`;

  let data = null;
  const out = el.querySelector("#r-out");
  const kind = () => el.querySelector('input[name="kind"]:checked').value;

  async function load() {
    out.innerHTML = `<div class="skeleton"></div>`;
    const from = el.querySelector("#r-from").value;
    const to = el.querySelector("#r-to").value;
    const base = await build(from, to, Number(el.querySelector("#r-days").value));
    data = { ...base, ...(await buildFinance(from, to, el.querySelector("#r-group").value)) };
    paint();
  }

  function paint() {
    const k = kind();
    el.querySelector("#r-group-wrap").hidden = !["pl", "expenses"].includes(k);
    const d = data[k];
    const daily = data.charts?.daily || [];
    const dMax = Math.max(1, ...daily.map(([, v]) => v));
    out.innerHTML = `
      ${k === "sales" && daily.length ? `
      <section class="card">
        <header class="card-head"><h3>Daily revenue</h3><span class="muted">${daily.length} day${daily.length === 1 ? "" : "s"} with sales</span></header>
        <div class="chart">
          ${daily.map(([date, v]) => `
            <div class="bar-col" title="${esc(date)}: ${esc(money(v))}">
              <span class="bar-value">${Math.round(v).toLocaleString()}</span>
              <div class="bar" style="--h:${Math.max(3, Math.round((v / dMax) * 100))}%"></div>
              <span class="bar-label">${esc(date.slice(5))}</span>
            </div>`).join("")}
        </div>
      </section>` : ""}
      ${d.summary ? `<section class="kpi-grid">${d.summary.map(([l, v], i) => `
        <article class="card kpi hover-lift" style="--d:${i * 60}ms"><div class="kpi-ico">${icon("reports")}</div><div><small>${esc(l)}</small><strong>${esc(v)}</strong></div></article>`).join("")}</section>` : ""}
      <section class="card">
        <div class="table-wrap"><table class="stack-mobile">
          <thead><tr>${d.headers.map((h, i) => `<th class="${d.numeric.includes(i) ? "r" : ""}">${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>${d.rows.map((r, ri) => `<tr class="row-in" style="--i:${Math.min(ri, 15)}">${r.map((v, i) =>
            `<td data-label="${esc(d.headers[i])}" class="${d.numeric.includes(i) ? "r" : ""}">${d.numeric.includes(i) && typeof v === "number" ? money(v) : esc(v)}</td>`).join("")}</tr>`).join("")
            || `<tr><td colspan="${d.headers.length}" class="muted center">Nothing to show for this period.</td></tr>`}</tbody>
        </table></div>
      </section>`;
  }

  el.querySelector("#r-kind").addEventListener("change", paint);
  ["#r-from", "#r-to", "#r-days"].forEach((s) => el.querySelector(s).addEventListener("change", load));

  el.querySelector("#r-print").addEventListener("click", () => {
    const k = kind();
    const d = data[k];
    printReport({
      title: KINDS.find(([key]) => key === k)[1] + " report",
      from: el.querySelector("#r-from").value, to: el.querySelector("#r-to").value,
      summary: d.summary || [], headers: d.headers, rows: d.rows, numeric: d.numeric || [],
    });
  });

  el.querySelector("#r-csv").addEventListener("click", () => {
    const d = data[kind()];
    downloadCSV(`${kind()}-${todayISO()}.csv`, [d.headers, ...d.rows]);
  });

  const syncBtn = el.querySelector("#r-sync");
  if (syncBtn) onAction(syncBtn, async () => {
    const btn = syncBtn;
    try {
      for (const [k, label] of KINDS) {
        await pushToSheets(label, data[k].headers, data[k].rows);
      }
      await audit("sheets.sync", { from: el.querySelector("#r-from").value, to: el.querySelector("#r-to").value });
      toast("Reports sent to Google Sheets", "success");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  });

  el.querySelector("#r-group").addEventListener("change", load);
  load();
}

async function build(from, to, days) {
  const [salesSnap, prodSnap, batchSnap] = await Promise.all([
    getDocs(query(collection(db, "sales"), where("date", ">=", from), where("date", "<=", to))),
    getDocs(collection(db, "products")),
    getDocs(collection(db, "batches")),
  ]);
  const sales = salesSnap.docs.map((d) => d.data());
  const products = prodSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const batches = batchSnap.docs.map((d) => d.data()).filter((b) => (b.remaining || 0) > 0);
  const today = todayISO();
  const soon = daysFromNowISO(days);

  // Sales: one row per item sold.
  const saleRows = [];
  const byProduct = new Map();
  let net = 0, vat = 0, total = 0, cogs = 0;
  const dailyTotals = new Map();
  for (const s of sales) {
    net += s.net || 0; vat += s.vat || 0; total += s.total || 0; cogs += s.cogs || 0;
    dailyTotals.set(s.date, (dailyTotals.get(s.date) || 0) + (s.total || 0));
    for (const it of s.items || []) {
      const profit = round2((it.lineNet || 0) - (it.cogs || 0));
      const isSvc = it.kind === "service";
      saleRows.push([s.date, s.invoiceNo, s.customerName, it.name, isSvc ? 1 : (it.pieces ?? it.qty), round2(it.lineNet), round2(it.lineVat), round2(it.lineTotal), round2(it.cogs || 0), profit, s.paymentLabel || s.payment]);
      if (isSvc) continue;
      const agg = byProduct.get(it.name) || { qty: 0, revenue: 0, cogs: 0 };
      agg.qty += it.pieces ?? it.qty; agg.revenue += it.lineNet || 0; agg.cogs += it.cogs || 0;
      byProduct.set(it.name, agg);
    }
  }
  const salesSummary = [
    ["Bills", sales.length],
    ["Revenue (net)", money(round2(net))],
    ["VAT", money(round2(vat))],
    ["Total collected", money(round2(total))],
    ["Gross profit", money(round2(net - cogs))],
  ];
  const productRows = [...byProduct.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([name, a]) => [name, a.qty, round2(a.revenue), round2(a.cogs), round2(a.revenue - a.cogs)]);

  // Stock valuation: one row per active product.
  const stockRows = products.filter((p) => p.active !== false).map((p) => {
    const stock = Number(p.stock) || 0;
    return [p.name, p.sku || "", p.category || "", stock, Number(p.reorderLevel) || 0, round2(p.costPrice), round2(stock * (Number(p.costPrice) || 0))];
  });
  const stockValue = round2(stockRows.reduce((s, r) => s + r[6], 0));

  // Expiry: batches expiring within the window, or already expired.
  const pname = Object.fromEntries(products.map((p) => [p.id, p.name]));
  const expiryRows = batches
    .filter((b) => b.expiry <= soon)
    .sort((a, b) => a.expiry.localeCompare(b.expiry))
    .map((b) => [
      pname[b.productId] || b.productName || "", b.batchNo || "", b.expiry, b.remaining,
      round2(b.cost || 0), round2(b.remaining * (b.cost || 0)),
      b.expiry < today ? "Expired" : "Expiring soon",
    ]);

  // Services: recharge, wallet cash-in and cash-out. Fees are income; transfers move the wallet float.
  const svcRows = serviceReportRows(sales).map((a) => [
    a.type === "recharge" ? "Mobile recharge" : a.type === "cashin" ? "Wallet cash-in" : "Wallet cash-out",
    a.provider, a.count, round2(a.transfer), round2(a.fees), round2(floatEffect(a.type, a.transfer)),
  ]);
  const sumSvc = (type) => round2(serviceReportRows(sales).filter((a) => a.type === type).reduce((s, a) => s + a.transfer, 0));
  const feesAll = round2(svcRows.reduce((s, r) => s + r[4], 0));
  const floatAll = round2(svcRows.reduce((s, r) => s + r[5], 0));
  const byProvider = new Map();
  svcRows.forEach((r) => byProvider.set(r[1], round2((byProvider.get(r[1]) || 0) + r[4])));

  return {
    services: {
      headers: ["Service", "Provider", "Count", "Transfer amount", "Fees (income)", "Wallet float effect"],
      numeric: [2, 3, 4, 5],
      rows: svcRows,
      summary: [
        ["Services sold", svcRows.reduce((s, r) => s + r[2], 0)],
        ["Fees earned", money(feesAll)],
        ["Recharge amount", money(sumSvc("recharge"))],
        ["Cash-in amount", money(sumSvc("cashin"))],
        ["Cash-out amount", money(sumSvc("cashout"))],
        ["Float change (+ grows)", money(floatAll)],
        ["Commission by provider", [...byProvider.entries()].map(([p, v]) => `${p}: ${money(v)}`).join(" · ") || "—"],
      ],
    },
    sales: {
      headers: ["Date", "Invoice", "Customer", "Product", "Qty", "Net", "VAT", "Line total", "COGS", "Profit", "Paid by"],
      numeric: [4, 5, 6, 7, 8, 9],
      rows: saleRows,
      summary: salesSummary,
      // Product summary is shown beneath via headers of the table; CSV contains item detail.
    },
    stock: {
      headers: ["Product", "SKU", "Category", "Stock", "Reorder level", "Cost", "Value"],
      numeric: [5, 6],
      rows: stockRows,
      summary: [["Products", stockRows.length], ["Stock value", money(stockValue)]],
    },
    expiry: {
      headers: ["Product", "Batch", "Expiry", "Units left", "Unit cost", "Value", "Status"],
      numeric: [4, 5],
      rows: expiryRows,
      summary: [
        ["Expired batches", expiryRows.filter((r) => r[6] === "Expired").length],
        ["Expiring soon", expiryRows.filter((r) => r[6] !== "Expired").length],
      ],
    },
    productSummary: {
      headers: ["Product", "Qty", "Revenue", "COGS", "Profit"],
      numeric: [1, 2, 3, 4],
      rows: productRows,
      summary: [["Products sold", productRows.length], ["Best seller", productRows[0]?.[0] || "-"]],
    },
    charts: { daily: [...dailyTotals.entries()].sort((a, b) => a[0].localeCompare(b[0])) },
  };
}
