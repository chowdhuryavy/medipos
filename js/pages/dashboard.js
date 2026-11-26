import { db, collection, query, where, orderBy, limit, getDocs } from "../firebase.js";
import {
  session, settings, money, esc, icon, todayISO, daysAgoISO, daysFromNowISO, monthStartISO,
  animateCount, fmtDateTime,
} from "../core.js";

export async function render(el) {
  const today = todayISO();
  const weekStart = daysAgoISO(6);
  const monthStart = monthStartISO();
  const from = weekStart < monthStart ? weekStart : monthStart;
  const soon = daysFromNowISO(settings.expiryWarnDays);

  const [salesSnap, productSnap, batchSnap, recentSnap] = await Promise.all([
    getDocs(query(collection(db, "sales"), where("date", ">=", from))),
    getDocs(collection(db, "products")),
    getDocs(query(collection(db, "batches"), where("remaining", ">", 0))),
    getDocs(query(collection(db, "sales"), orderBy("createdAt", "desc"), limit(6))),
  ]);

  const sales = salesSnap.docs.map((d) => d.data());
  const products = productSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.active !== false);
  const batches = batchSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const sum = (arr, k) => arr.reduce((a, b) => a + (Number(b[k]) || 0), 0);

  const todaySales = sales.filter((s) => s.date === today);
  const monthSales = sales.filter((s) => s.date >= monthStart);
  const lowStock = products.filter((p) => (p.stock || 0) <= (p.reorderLevel || 0));
  const expiring = batches.filter((b) => b.expiry >= today && b.expiry <= soon);
  const expired = batches.filter((b) => b.expiry < today);

  const kpis = [
    { label: "Today's revenue", value: sum(todaySales, "total"), fmt: money, icon: "cart" },
    { label: "Bills today", value: todaySales.length, icon: "check" },
    { label: "Gross profit today", value: sum(todaySales, "net") - sum(todaySales, "cogs"), fmt: money, icon: "reports" },
    { label: "Revenue this month", value: sum(monthSales, "total"), fmt: money, icon: "accounting" },
    { label: "Low-stock items", value: lowStock.length, icon: "alert" },
    { label: `Expiring in ${settings.expiryWarnDays} days`, value: expiring.length, icon: "alert" },
  ];

  // Top products and payment mix for the month
  const soldMap = new Map();
  for (const s of monthSales) for (const it of s.items || []) {
    const a = soldMap.get(it.name) || { qty: 0, revenue: 0 };
    a.qty += Number(it.qty) || 0; a.revenue += Number(it.lineNet) || 0;
    soldMap.set(it.name, a);
  }
  const topProducts = [...soldMap.entries()].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5);
  const payMap = new Map();
  for (const s of monthSales) {
    const k = s.paymentLabel || s.payment || "Other";
    payMap.set(k, (payMap.get(k) || 0) + (Number(s.total) || 0));
  }
  const payTotal = sum(monthSales, "total") || 0;
  const payMix = [...payMap.entries()].sort((a, b) => b[1] - a[1]);
  const topMax = Math.max(1, ...topProducts.map(([, a]) => a.revenue));

  const days = Array.from({ length: 7 }, (_, i) => daysAgoISO(6 - i));
  const totals = days.map((d) => sum(sales.filter((s) => s.date === d), "total"));
  const max = Math.max(1, ...totals);
  const dayLabel = (d) => new Date(d + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });
  const hour = new Date().getHours();
  const greet = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const firstName = (session.name || "there").split(" ")[0];

  el.innerHTML = `
    <section class="card hero">
      <div>
        <p class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
        <h1>Good ${greet}, ${esc(firstName)}</h1>
        <p class="muted">Here is how ${esc(settings.shopName)} is doing today.</p>
      </div>
      <a class="btn primary" href="#/pos">${icon("cart")}<span>Start a sale</span></a>
    </section>

    <section class="kpi-grid">
      ${kpis.map((k, i) => `
        <article class="card kpi hover-lift" style="--d:${i * 70}ms">
          <div class="kpi-ico">${icon(k.icon)}</div>
          <div><small>${esc(k.label)}</small><strong data-kpi="${i}">0</strong></div>
        </article>`).join("")}
    </section>

    <div class="grid-2">
      <section class="card">
        <header class="card-head"><h3>Last 7 days</h3><span class="muted">Revenue</span></header>
        <div class="chart">
          ${days.map((d, i) => `
            <div class="bar-col" title="${esc(d)}: ${esc(money(totals[i]))}">
              <span class="bar-value">${totals[i] ? Math.round(totals[i]).toLocaleString() : ""}</span>
              <div class="bar" style="--h:${Math.max(3, Math.round((totals[i] / max) * 100))}%; --d:${i * 90}ms"></div>
              <span class="bar-label">${esc(dayLabel(d))}</span>
            </div>`).join("")}
        </div>
      </section>
      <section class="card">
        <header class="card-head"><h3>Needs attention</h3></header>
        <ul class="alert-list">
          ${lowStock.slice(0, 5).map((p) => `<li class="pill warn">${icon("alert")}Low stock · ${esc(p.name)} (${p.stock || 0} left)</li>`).join("")}
          ${expired.slice(0, 5).map((b) => `<li class="pill danger">${icon("alert")}Expired · ${esc(b.productName)} · batch ${esc(b.batchNo || "-")} (${b.remaining})</li>`).join("")}
          ${expiring.slice(0, 5).map((b) => `<li class="pill info">${icon("alert")}Expires ${esc(b.expiry)} · ${esc(b.productName)}</li>`).join("")}
          ${!lowStock.length && !expired.length && !expiring.length ? `<li class="muted">All clear. Nothing needs attention right now.</li>` : ""}
        </ul>
      </section>
    </div>

    <div class="grid-2">
      <section class="card">
        <header class="card-head"><h3>Top products this month</h3><span class="muted">Revenue</span></header>
        <ul class="rank-list">
          ${topProducts.map(([name, a], i) => `
            <li class="rank-row" style="--d:${i * 80}ms">
              <div class="rank-top"><span><b>${i + 1}</b> ${esc(name)}</span><span>${money(a.revenue)}</span></div>
              <div class="rank-bar"><i style="width:${Math.max(4, Math.round((a.revenue / topMax) * 100))}%"></i></div>
              <small class="muted">${a.qty} sold</small>
            </li>`).join("") || `<li class="muted">No sales this month yet.</li>`}
        </ul>
      </section>
      <section class="card">
        <header class="card-head"><h3>How customers pay</h3><span class="muted">This month</span></header>
        <ul class="rank-list">
          ${payMix.map(([label, v], i) => {
            const pct = payTotal ? Math.round((v / payTotal) * 100) : 0;
            return `<li class="rank-row" style="--d:${i * 80}ms">
              <div class="rank-top"><span>${esc(label)}</span><span>${pct}% · ${money(v)}</span></div>
              <div class="rank-bar"><i style="width:${Math.max(4, pct)}%"></i></div>
            </li>`;
          }).join("") || `<li class="muted">No payments this month yet.</li>`}
        </ul>
      </section>
    </div>

    <section class="card">
      <header class="card-head"><h3>Recent sales</h3><a href="#/reports" class="link">Full reports →</a></header>
      <div class="table-wrap"><table class="stack-mobile">
        <thead><tr><th>Invoice</th><th>Customer</th><th>Payment</th><th class="r">Total</th><th>When</th></tr></thead>
        <tbody>
          ${recentSnap.docs.map((d) => {
            const s = d.data();
            return `<tr>
              <td data-label="Invoice">${esc(s.invoiceNo)}</td>
              <td data-label="Customer">${esc(s.customerName || "Walk-in")}</td>
              <td data-label="Payment"><span class="badge">${esc(s.paymentLabel || s.payment)}</span></td>
              <td data-label="Total" class="r">${money(s.total)}</td>
              <td data-label="When">${fmtDateTime(s.createdAt)}</td>
            </tr>`;
          }).join("") || `<tr><td colspan="5" class="muted center">No sales yet</td></tr>`}
        </tbody>
      </table></div>
    </section>`;

  el.querySelectorAll("[data-kpi]").forEach((n) => {
    const k = kpis[Number(n.dataset.kpi)];
    animateCount(n, k.value, k.fmt);
  });
}
