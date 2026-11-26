import { onAction } from "../core.js";
import { db, collection, query, where, getDocs } from "../firebase.js";
import {
  session, money, esc, icon, toast, todayISO, monthStartISO, daysFromNowISO, downloadCSV, round2, audit, settings,
} from "../core.js";
import { pushToSheets } from "../sheets.js";

const KINDS = [["sales", "Sales"], ["stock", "Stock"], ["expiry", "Expiry"]];
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
        <div class="grow"></div>
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
    data = await build(el.querySelector("#r-from").value, el.querySelector("#r-to").value, Number(el.querySelector("#r-days").value));
    paint();
  }

  function paint() {
    const k = kind();
    const d = data[k];
    out.innerHTML = `
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
  for (const s of sales) {
    net += s.net || 0; vat += s.vat || 0; total += s.total || 0; cogs += s.cogs || 0;
    for (const it of s.items || []) {
      const profit = round2((it.lineNet || 0) - (it.cogs || 0));
      saleRows.push([s.date, s.invoiceNo, s.customerName, it.name, it.qty, round2(it.lineNet), round2(it.lineVat), round2(it.lineTotal), round2(it.cogs || 0), profit, s.paymentLabel || s.payment]);
      const agg = byProduct.get(it.name) || { qty: 0, revenue: 0, cogs: 0 };
      agg.qty += it.qty; agg.revenue += it.lineNet || 0; agg.cogs += it.cogs || 0;
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

  return {
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
    productSummary: { headers: ["Product", "Qty", "Revenue", "COGS", "Profit"], rows: productRows },
  };
}
