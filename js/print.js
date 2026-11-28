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
  // 58mm rolls use the same layout at a narrower width.
  if (mode === "thermal58") return printNow("thermal narrow58", thermalBody(sale));
  printNow("thermal", thermalBody(sale));
}

// Shop details printed on every document. The name falls back to the app name, so it is never blank.
function shopInfo() {
  return {
    name: settings.shopName || branding.shopName || branding.appName || "Pharmacy",
    address: settings.shopAddress || "",
    phone: settings.shopPhone || "",
    tax: settings.taxNumber || "",
  };
}

function thermalBody(sale) {
  const row = (k, v, cls = "") => `<div class="t-row ${cls}"><span>${k}</span><span>${v}</span></div>`;
  const items = sale.lines.map((l) => `
    <div class="t-item">
      <div class="t-name">${esc(l.name)}</div>
      <div class="t-row"><span>${l.qty} × ${money(l.price)}</span><span>${money(l.lineTotal)}</span></div>
    </div>`).join("");
  const s = shopInfo();
  return `
    <div class="thermal">
      <div class="t-center">
        ${branding.logoUrl ? `<img class="t-logo" src="${esc(branding.logoUrl)}" alt="" />` : ""}
        <div class="t-shop">${esc(s.name)}</div>
        ${s.address ? `<div class="t-addr">${esc(s.address)}</div>` : ""}
        ${s.phone ? `<div class="t-addr">Tel: ${esc(s.phone)}</div>` : ""}
        ${s.tax ? `<div class="t-addr">Tax no. ${esc(s.tax)}</div>` : ""}
        <div class="t-title">SALES RECEIPT</div>
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
  const s = shopInfo();
  return `
    <div class="a4">
      <header class="a4-head">
        <div class="a4-logo-cell">${branding.logoUrl ? `<img class="a4-logo" src="${esc(branding.logoUrl)}" alt="" />` : ""}</div>
        <div class="a4-shop">
          <strong class="a4-shop-name">${esc(s.name)}</strong>
          ${s.address ? `<small>${esc(s.address)}</small>` : ""}
          ${s.phone ? `<small>Tel: ${esc(s.phone)}</small>` : ""}
          ${s.tax ? `<small>Tax no. ${esc(s.tax)}</small>` : ""}
        </div>
        <div class="a4-title">
          <h1>${esc(title)}</h1>
          ${period ? `<small>${esc(period)}</small>` : ""}
          <small>Printed ${esc(stamp())}</small>
        </div>
      </header>
      ${body}
      <footer class="a4-foot"><span>${esc(s.name)}</span><span>Printed by ${esc(session.name || "")}</span></footer>
    </div>`;
}

/** Turns a saved sale (items as stored) into the shape the receipt printer uses. */
export function saleForPrint(sale) {
  return {
    ...sale,
    lines: (sale.items || []).map((i) => ({
      name: i.name, qty: i.qty, price: i.price, lineNet: i.lineNet, lineVat: i.lineVat, lineTotal: i.lineTotal, service: i.service || "",
    })),
  };
}
