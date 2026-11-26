import { esc, money, settings, session } from "./core.js";
import { branding } from "./branding.js";

// Printing renders into #print-root; the print stylesheet shows only that element.
const ROOT_ID = "print-root";

function printNow(mode, html) {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }
  root.className = `print-root ${mode}`;
  root.innerHTML = html;
  const cleanup = () => {
    document.getElementById(ROOT_ID)?.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  setTimeout(() => window.print(), 60);
}

const logo = (cls = "print-logo") => (branding.logoUrl ? `<img class="${cls}" src="${esc(branding.logoUrl)}" alt="" />` : "");
const stamp = () => new Date().toLocaleString();

/** Receipt: "thermal" (80mm roll printer) or "a4" (full tax invoice). */
export function printReceipt(sale, mode = "thermal") {
  if (mode === "a4") return printNow("a4", a4Frame("Tax invoice", `${sale.invoiceNo}`, invoiceBody(sale)));
  printNow("thermal", thermalBody(sale));
}

function thermalBody(sale) {
  const row = (k, v, cls = "") => `<div class="t-row ${cls}"><span>${k}</span><span>${v}</span></div>`;
  const items = sale.lines.map((l) => `
    <div class="t-item">
      <div class="t-name">${esc(l.name)}</div>
      <div class="t-row"><span>${l.qty} × ${money(l.price)}</span><span>${money(l.lineTotal)}</span></div>
    </div>`).join("");
  return `
    <div class="thermal">
      ${logo("print-logo t-logo")}
      <div class="t-center">
        <div class="t-shop">${esc(settings.shopName)}</div>
        ${settings.shopAddress ? `<div>${esc(settings.shopAddress)}</div>` : ""}
        ${settings.taxNumber ? `<div>Tax no. ${esc(settings.taxNumber)}</div>` : ""}
      </div>
      <div class="t-dash"></div>
      ${row("Invoice", esc(sale.invoiceNo))}
      ${row("Date", esc(stamp()))}
      ${row("Cashier", esc(session.name || ""))}
      ${row("Customer", esc(sale.customerName || "Walk-in"))}
      <div class="t-dash"></div>
      ${items}
      <div class="t-dash"></div>
      ${row("Subtotal", money(sale.subtotal))}
      ${sale.discount ? row("Discount", "− " + money(sale.discount)) : ""}
      ${row("VAT", money(sale.vat))}
      <div class="t-dash"></div>
      ${row("TOTAL", money(sale.total), "t-big")}
      ${row("Paid by", esc(sale.paymentLabel))}
      ${sale.tendered != null ? row("Cash", money(sale.tendered)) + row("Change", money(Math.max(0, sale.change))) : ""}
      <div class="t-dash"></div>
      <div class="t-center t-foot">${esc(settings.receiptFooter || "Thank you for your visit")}</div>
    </div>`;
}

function invoiceBody(sale) {
  const rows = sale.lines.map((l, i) => `
    <tr><td>${i + 1}</td><td>${esc(l.name)}</td><td class="r">${l.qty}</td><td class="r">${money(l.price)}</td>
    <td class="r">${money(l.lineNet || 0)}</td><td class="r">${money(l.lineVat || 0)}</td><td class="r">${money(l.lineTotal)}</td></tr>`).join("");
  return `
    <div class="inv-bill">
      <div><small>Bill to</small><strong>${esc(sale.customerName || "Walk-in")}</strong></div>
      <div class="r"><small>Paid by</small><strong>${esc(sale.paymentLabel)}</strong></div>
    </div>
    <table class="p-table">
      <thead><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Net</th><th class="r">VAT</th><th class="r">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="inv-totals">
      <div><span>Subtotal</span><span>${money(sale.subtotal)}</span></div>
      <div><span>Discount</span><span>− ${money(sale.discount || 0)}</span></div>
      <div><span>VAT</span><span>${money(sale.vat)}</span></div>
      <div class="grand"><span>Total</span><span>${money(sale.total)}</span></div>
      ${sale.tendered != null ? `<div><span>Cash received</span><span>${money(sale.tendered)}</span></div><div><span>Change</span><span>${money(Math.max(0, sale.change))}</span></div>` : ""}
    </div>
    <p class="inv-sign">Received by ______________________</p>
    <p class="muted-print">${esc(settings.receiptFooter || "")}</p>`;
}

/** A4 report from a table (used by Reports). */
export function printReport({ title, from, to, summary = [], headers, rows, numeric = [] }) {
  const kpis = summary.length
    ? `<div class="p-kpis">${summary.map(([l, v]) => `<div class="p-kpi"><small>${esc(l)}</small><strong>${esc(v)}</strong></div>`).join("")}</div>` : "";
  const body = `${kpis}
    <table class="p-table">
      <thead><tr>${headers.map((h, i) => `<th class="${numeric.includes(i) ? "r" : ""}">${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td class="${numeric.includes(i) ? "r" : ""}">${numeric.includes(i) && typeof v === "number" ? money(v) : esc(v)}</td>`).join("")}</tr>`).join("")
        || `<tr><td colspan="${headers.length}">Nothing to show for this period.</td></tr>`}</tbody>
    </table>`;
  printNow("a4", a4Frame(title, from ? `${from} to ${to}` : "", body));
}

/** A4 print of already-rendered HTML (used by Statements). */
export function printHtml(title, html) {
  printNow("a4", a4Frame(title, "", html));
}

function a4Frame(title, period, body) {
  return `
    <div class="a4">
      <header class="a4-head">
        ${logo()}
        <div class="a4-shop">
          <strong>${esc(settings.shopName)}</strong>
          ${settings.shopAddress ? `<small>${esc(settings.shopAddress)}</small>` : ""}
          ${settings.taxNumber ? `<small>Tax no. ${esc(settings.taxNumber)}</small>` : ""}
        </div>
        <div class="a4-title">
          <h1>${esc(title)}</h1>
          ${period ? `<small>${esc(period)}</small>` : ""}
          <small>Printed ${esc(stamp())}</small>
        </div>
      </header>
      ${body}
      <footer class="a4-foot"><span>${esc(branding.appName || "MediPOS")}</span><span>Printed by ${esc(session.name || "")}</span></footer>
    </div>`;
}
