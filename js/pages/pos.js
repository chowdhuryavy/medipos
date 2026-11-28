import { reserveJv, writeVoucher, postWithVoucher } from "../journal.js";
import { db, collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, query, where, orderBy, limit, runTransaction, serverTimestamp, increment } from "../firebase.js";
import { post } from "../api.js";
import { onAction, onSubmit, isPostable } from "../core.js";
import { printReceipt } from "../print.js";
import {
  session, settings, paymentMethod, money, esc, icon, toast, openModal, alertBox, todayISO, calcTotals,
  buildJournal, allocateFEFO, audit, round2, ACCOUNTS, can,
} from "../core.js";
import { unitsOf, unitByKey, toPieces, unitOptions, baseName } from "../packs.js";
import { notifyOnce, rolesWith } from "../notifications.js";
import { SERVICE_TYPES, serviceProviders, serviceLine, serviceJournalLines, serviceBreakdown, floatKey, applyFloat, calcFee } from "../services.js";

const GRID_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
const QA_ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  hold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  bills: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15"/></svg>',
  discount: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M19 5L5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>',
  cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  charge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>',
};
const LIST_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>';

export async function render(el) {
  const [prodSnap, custSnap, batchSnap, floatSnap, shiftSnap, discSnap] = await Promise.all([
    getDocs(collection(db, "products")),
    getDocs(collection(db, "customers")),
    getDocs(query(collection(db, "batches"), where("remaining", ">", 0))),
    getDocs(collection(db, "floats")).catch(() => ({ docs: [] })),
    getDocs(query(collection(db, "shifts"), orderBy("openedAt", "desc"), limit(1))).catch(() => ({ docs: [] })),
    getDocs(collection(db, "discounts")).catch(() => ({ docs: [] })),
  ]);
  // Discounts the administrator has created: whole-bill or per-item, as a percentage or an amount.
  let presets = [];
  // Reads the discounts the administrator has made. Called when the discount section or an item dialog opens, so new ones show up at once.
  async function loadPresets() {
    const snap = await getDocs(collection(db, "discounts")).catch(() => null);
    if (!snap) return;
    presets = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.active !== false)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  presets = discSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.active !== false)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  // The cash shift must be open before any sale is charged.
  const latestShift = shiftSnap.docs[0];
  const openShift = latestShift && latestShift.data().status === "open" ? { id: latestShift.id, ...latestShift.data() } : null;
  // Current float balance of each wallet and operator, kept up to date after every sale.
  const floats = Object.fromEntries(floatSnap.docs.map((d) => [d.id, Number(d.data().balance) || 0]));
  const products = prodSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  const customers = custSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const nearest = {};
  batchSnap.docs.forEach((d) => {
    const b = d.data();
    if (!nearest[b.productId] || b.expiry < nearest[b.productId]) nearest[b.productId] = b.expiry;
  });

  const methods = settings.paymentMethods.filter((m) => m.active !== false);
  const creditOk = settings.allowCreditSales;
  const allowChange = settings.allowPriceChange !== false;

  const st = {
    cat: "All", sub: "", tab: "1", q: "", billDisc: null, discMode: "bill", showDisc: false, showPay: false,
    pay: methods.find((m) => !m.credit)?.key || methods[0]?.key || "cash",
    customerId: "",
    cart: new Map(), // product lines: "productId|unitKey"; service lines: "svc|n"
    openId: null, // the open bill this cart was loaded from, if any
    svcSeq: 0,
  };

  el.innerHTML = `
    <div class="pos">
      <header class="pos-top">
        <div class="pos-id">
          <span class="pos-outlet">${icon("building")}<b>${esc(settings.shopName || "Pharmacy")}</b></span>
          <span class="pos-cashier">${esc(session.name || "")}<small>${esc(session.role || "")} · ${esc(todayISO())}</small></span>
        </div>
        <div class="pos-search">
          ${icon("search")}
          <input id="p-search" type="search" inputmode="search" placeholder="Search name, SKU or barcode" autocomplete="off" aria-label="Search products" />
          <kbd>F2</kbd>
          <button type="button" class="btn ghost sm scan-btn" data-scan-into="#p-search" data-scan-enter>Scan</button>
        </div>
        <div class="pos-status">
          <span class="pos-clock" id="p-clock"></span>
          ${openShift ? `<span class="shift-pill ok">Shift open</span>` : `<a class="shift-pill warn" href="#/shift">No shift open · Open shift</a>`}
        </div>
      </header>

      <div class="pos-main">
        <section class="card pos-catalog">
          <div class="chips" id="p-cats" role="tablist"></div>
          <div class="chips sub-chips" id="p-subs" aria-label="Sub-groups"></div>
          ${settings.posServiceButtons ? `<div class="service-bar" role="group" aria-label="Services">
            <button class="svc-btn" data-svc="recharge">${icon("plus")}<span>Mobile recharge</span></button>
            <button class="svc-btn" data-svc="cashin">${icon("plus")}<span>Wallet cash-in</span></button>
            <button class="svc-btn" data-svc="cashout">${icon("plus")}<span>Wallet cash-out</span></button>
          </div>` : ""}
          <div class="cat-toolbar">
            <span class="muted small" id="p-result"></span>
            <div class="cat-tools">
              <select id="p-filter" aria-label="Filter products">
                <option value="all">All products</option>
                <option value="in">In stock</option>
                <option value="low">Low stock</option>
                <option value="out">Out of stock</option>
              </select>
              <select id="p-sort" aria-label="Sort products">
                <option value="name">Name A–Z</option>
                <option value="price-asc">Price: low to high</option>
                <option value="price-desc">Price: high to low</option>
                <option value="stock">Stock: lowest first</option>
              </select>
              <div class="view-toggle" role="group" aria-label="View">
                <button type="button" data-view="grid" aria-label="Grid view" title="Grid">${GRID_ICON}</button>
                <button type="button" data-view="list" aria-label="List view" title="List">${LIST_ICON}</button>
              </div>
            </div>
          </div>
          <div class="product-grid" id="p-grid"></div>
          <div class="more-row" id="p-more-row" hidden><button type="button" class="btn ghost" id="p-more"></button></div>
        </section>
        <nav class="pos-actions" id="p-actions" aria-label="Quick actions">
          <button type="button" class="qa" data-qa="search">${QA_ICONS.search}<span>Search</span><kbd>F2</kbd></button>
          <button type="button" class="qa" data-qa="hold">${QA_ICONS.hold}<span>Open bill</span><kbd>F8</kbd></button>
          <button type="button" class="qa" data-qa="bills">${QA_ICONS.bills}<span>Bills</span></button>
          <button type="button" class="qa" data-qa="discount">${QA_ICONS.discount}<span>Discount</span><kbd>F6</kbd></button>
          <button type="button" class="qa primary" data-qa="charge">${QA_ICONS.charge}<span>Charge</span><kbd>F4</kbd></button>
        </nav>
      </div>

      <aside class="card pos-bill" id="p-bill">
        <header class="bill-head">
          <div><h3>Current bill</h3><small class="muted" id="p-billno">New bill</small></div>
          <span class="badge" id="p-count">0 items</span>
        </header>
        <div class="bill-customer">
        <label>Customer
          <select id="p-customer">
            <option value="">Walk-in customer</option>
            ${customers.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`).join("")}
          </select>
        </label>
          <small class="muted" id="p-custinfo"></small>
        </div>
        <div class="bill-tools">
          <button class="btn ghost sm" id="p-hold" title="Keep this bill open to finish later (F8)">${icon("pause")}<span>Open bill</span></button>
          <button class="btn ghost sm" id="p-held" title="Open bills, closed bills and voids">${icon("refresh")}<span>Bills</span></button>
          <button class="btn ghost sm" id="p-clear" title="Void this bill with a reason">${icon("x")}<span>Void</span></button>
        </div>
        <div class="bill-body">
        ${openShift ? "" : `<div class="shift-note" role="alert">No cash shift is open. <a href="#/shift">Open a shift</a> before you take payment.</div>`}
          <div class="bill-lines" id="p-lines"></div>
        <p class="muted small price-rule">${allowChange
          ? "You can raise a price. It can never go below the lowest price shown. Service fees can be changed."
          : "Prices are fixed by the shop. Ask an administrator to change them."}</p>
        </div>
        <div class="bill-foot">
        <div class="totals" id="p-totals"></div>
        <div class="step-btns" id="p-steps">
          <button type="button" class="btn ghost" id="p-discbtn">Discount<b id="p-discbadge"></b></button>
          <button type="button" class="btn ghost" id="p-paybtn">Process payment<b id="p-paybadge"></b></button>
        </div>
        <div class="step-panel" id="p-discsec" hidden>
          <div class="chip-row" id="p-discmode">
            <button type="button" class="chip" data-dmode="bill">Bill discount</button>
            <button type="button" class="chip" data-dmode="item">Item discount</button>
          </div>
          <div id="p-discbox"></div>
          <div class="itemdisc-list" id="p-itemdisc" hidden></div>
        </div>
        <div class="step-panel" id="p-paysec" hidden>
          <div class="pay-field" hidden>
            <span class="field-label">Paid by</span>
            <div class="pay-seg" id="p-paychips" role="radiogroup" aria-label="Paid by"></div>
            <select id="p-pay" hidden>
              ${methods.filter((m) => !m.credit || creditOk).map((m) => `<option value="${esc(m.key)}" ${m.key === st.pay ? "selected" : ""}>${esc(m.label)}</option>`).join("")}
            </select>
          </div>
        <label id="p-cashrow" class="cash-row">Cash received
          <input id="p-tender" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Amount given by customer" />
        </label>
        <div class="quick-cash" id="p-quick" hidden></div>
        <div class="change-due" id="p-change" aria-live="polite"></div>
        </div>
        <div class="pay-tiles" id="p-tiles" role="group" aria-label="Payment"></div>
        <button class="btn primary block xl pay-now" id="p-charge">${icon("check")}<span>Pay now</span><kbd>F4</kbd></button>
        </div>
      </aside>
    </div>
        <div class="mobile-charge" id="p-mobile"><span id="p-mobile-total"></span><button class="btn primary" id="p-mobile-btn">Review & charge</button></div>`;

  const $ = (s) => el.querySelector(s);
  const isService = (l) => l.kind === "service";
  const piecesInCart = (id) => [...st.cart.values()].filter((l) => l.id === id)
    .reduce((s, l) => s + toPieces(unitByKey(byId[id], l.unitKey), l.qty), 0);

  // Full view of a cart line: product, unit and price rules. Service lines carry their own name and fee.
  function lineView(l) {
    if (isService(l)) {
      return { ...l, unit: "service", size: 1, listPrice: l.listPrice, minPrice: 0, vatRate: 0, pieces: 0 };
    }
    const p = byId[l.id];
    const u = unitByKey(p, l.unitKey);
    return {
      ...l, name: p.name, unit: u.name, size: u.size, listPrice: u.price, minPrice: u.minPrice,
      vatRate: Number(p.vatRate) || 0, pieces: toPieces(u, l.qty),
    };
  }
  const cartLines = () => [...st.cart.values()].map(lineView);

  // Totals: goods get the discount and VAT. Service fees are revenue. Transfers are cash that passes through,
  // so they are added to or taken from what the customer pays, but never counted as sales.
  function billTotals(lines) {
    const goods = calcTotals(lines.filter((l) => !isService(l)), 0, st.billDisc);
    const fees = round2(lines.filter(isService).reduce((s, l) => s + l.price * l.qty, 0));
    const transfersIn = round2(lines.filter((l) => isService(l) && (l.serviceType === "cashin" || l.serviceType === "recharge"))
      .reduce((s, l) => s + l.transfer, 0));
    const transfersOut = round2(lines.filter((l) => isService(l) && l.serviceType === "cashout").reduce((s, l) => s + l.transfer, 0));
    const saleTotal = round2(goods.total + fees);
    const collect = round2(saleTotal + transfersIn - transfersOut);
    return { goods, fees, transfersIn, transfersOut, saleTotal, collect };
  }

  // Two sale-screen buttons: only when both are on. Each one shows the products of its categories.
  const listOf = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  const tabsOn = () => !!settings.posTab1Active && !!settings.posTab2Active;
  const tabLabel = (n) => settings[`posTab${n}Label`] || `Button ${n}`;
  function inTab(p, n) {
    const cat = p.category || "General";
    const mine = listOf(settings[`posTab${n}Categories`]);
    const other = listOf(settings[`posTab${3 - n}Categories`]);
    return mine.length ? mine.includes(cat) : !other.includes(cat);
  }

  // Catalogue view: sort, stock filter, grid or list, and "show more" paging (48 at a time).
  const pageView = { sort: "name", filter: "all", view: "grid", limit: 48, key: "" };
  const soonBy = () => new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  function stockPass(p) {
    const stock = Number(p.stock) || 0;
    const low = stock > 0 && stock <= (Number(p.reorderLevel) || 0);
    if (pageView.filter === "in") return stock > 0;
    if (pageView.filter === "low") return low;
    if (pageView.filter === "out") return stock <= 0;
    return true;
  }
  function visibleProducts() {
    const q = st.q.trim().toLowerCase();
    const list = products.filter((p) =>
      (tabsOn() ? inTab(p, Number(st.tab)) : (st.cat === "All" || (p.category || "General") === st.cat)) &&
      (!st.sub || p.subGroup === st.sub) &&
      (!q || [p.name, p.sku, p.barcode].some((v) => String(v || "").toLowerCase().includes(q))) &&
      stockPass(p));
    const price = (p) => Number(p.salePrice) || 0;
    const sorters = {
      name: (a, b) => a.name.localeCompare(b.name),
      "price-asc": (a, b) => price(a) - price(b),
      "price-desc": (a, b) => price(b) - price(a),
      stock: (a, b) => (Number(a.stock) || 0) - (Number(b.stock) || 0),
    };
    return list.sort(sorters[pageView.sort] || sorters.name);
  }

  function paintCats() {
    if (tabsOn()) {
      $("#p-cats").innerHTML = [1, 2].map((n) => `<button class="chip ${String(n) === st.tab ? "active" : ""}" data-tab="${n}">${esc(tabLabel(n))}</button>`).join("");
      return;
    }
    const cats = ["All", ...new Set(products.map((p) => p.category || "General"))];
    $("#p-cats").innerHTML = cats.map((c) => {
      const n = c === "All" ? products.length : products.filter((p) => (p.category || "General") === c).length;
      return `<button class="chip ${c === st.cat ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}<small>${n}</small></button>`;
    }).join("");
  }

  // Sub-groups of the category (or button) in view. Shown only when there is more than one group to pick from.
  function paintSubs() {
    const inScope = products.filter((p) => tabsOn() ? inTab(p, Number(st.tab)) : (st.cat === "All" || (p.category || "General") === st.cat));
    const subs = [...new Set(inScope.map((p) => p.subGroup).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (st.sub && !subs.includes(st.sub)) st.sub = "";
    $("#p-subs").hidden = subs.length === 0;
    $("#p-subs").innerHTML = subs.length
      ? ["", ...subs].map((s) => `<button class="chip sub ${s === st.sub ? "active" : ""}" data-sub="${esc(s)}">${esc(s || "All groups")}</button>`).join("")
      : "";
  }

  function productCard(p, i) {
    const stock = Number(p.stock) || 0;
    const out = stock <= 0;
    const low = !out && stock <= (Number(p.reorderLevel) || 0);
    const inBill = piecesInCart(p.id);
    const exp = nearest[p.id];
    const monogram = initialsOf(p.name);
    const unit = esc(baseName(p));
    return `<button type="button" class="product-card ${out ? "is-out" : ""} ${inBill ? "in-bill" : ""} ${low ? "is-low" : ""}" data-add="${esc(p.id)}" style="--i:${Math.min(i, 20)}" ${out ? "disabled" : ""}>
      ${inBill ? `<span class="pc-incart" aria-label="${inBill} in bill">${inBill}</span>` : ""}
      <span class="pc-img">${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" loading="lazy" />` : `<span class="pc-mono">${esc(monogram)}</span>`}</span>
      <span class="pc-name">${esc(p.name)}</span>
      <span class="pc-sub">${esc([p.sku, p.category || "General", p.subGroup].filter(Boolean).join(" · "))}</span>
      <span class="pc-foot"><strong>${money(p.salePrice)}</strong><span class="badge ${out ? "danger" : low ? "warn" : "ok"}">${out ? "Out of stock" : `${low ? "Low · " : ""}${stock} ${unit}`}</span></span>
      ${exp ? `<span class="pc-exp ${exp <= soonBy() ? "soon" : ""}">Exp ${esc(exp)}</span>` : ""}
      <span class="pc-add">${icon("plus")}<span>Add</span></span>
    </button>`;
  }

  function paintGrid() {
    paintSubs();
    const key = [st.cat, st.tab, st.sub, st.q, pageView.sort, pageView.filter].join("|");
    if (key !== pageView.key) { pageView.key = key; pageView.limit = 48; }
    const list = visibleProducts();
    const shown = list.slice(0, pageView.limit);
    const grid = $("#p-grid");
    grid.classList.toggle("is-list", pageView.view === "list");
    grid.innerHTML = shown.length
      ? (pageView.view === "list" ? `<div class="pl-head"><span>Product</span><span>Category</span><span>Price · Stock</span><span>Expiry</span></div>` : "") + shown.map(productCard).join("")
      : `<div class="empty-state small">${icon("search")}<p>No products match your search or filter.</p>${can("inventory") ? `<a class="btn primary sm" href="#/inventory">${icon("plus")}<span>Add a new product</span></a>` : ""}</div>`;
    $("#p-result").textContent = `${list.length} product${list.length === 1 ? "" : "s"}`;
    const more = list.length - shown.length;
    $("#p-more-row").hidden = more <= 0;
    $("#p-more").textContent = `Show more · ${more} left`;
    el.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === pageView.view));
  }

  const serviceBillLine = (l) => {
    const def = SERVICE_TYPES[l.serviceType];
    const b = serviceBreakdown(l.serviceType, l.transfer, l.price);
    const how = l.serviceType === "cashout"
      ? `Customer sends ${money(l.transfer)} to the wallet and gets ${money(l.transfer)} cash`
      : `Customer gives ${money(b.customerGives)}, ${money(l.transfer)} goes to the ${l.serviceType === "recharge" ? "operator" : "wallet"}`;
    return `
      <div class="bill-line svc-line">
        <div class="bl-info">
          <strong>${esc(def.label)} · ${esc(l.provider)}</strong>
          <small>${esc(how)}${l.phone ? ` · ${esc(l.phone)}` : ""}</small>
        </div>
        <div class="qty"><span class="muted">1</span></div>
        <label class="bl-price">Fee (auto)
          <input type="text" value="${money(l.price)}" readonly aria-label="Service fee, calculated" />
        </label>
        <strong class="bl-total">${money(l.price)}</strong>
        <button class="icon-btn sm hover-danger" data-rm="${esc(l.key)}" aria-label="Remove service">${icon("x")}</button>
      </div>`;
  };

  const initialsOf = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
  const billLine = (l) => {
    if (isService(l)) return serviceBillLine(l);
    const extra = round2(l.price - l.listPrice);
    return `
      <div class="bill-line">
        <span class="bl-thumb">${byId[l.id]?.imageUrl ? `<img src="${esc(byId[l.id].imageUrl)}" alt="" loading="lazy" />` : esc(initialsOf(l.name))}</span>
        <div class="bl-info">
          <button type="button" class="bl-name" data-open="${esc(l.key)}" aria-label="Adjust ${esc(l.name)}">${esc(l.name)}</button>
          <small>${money(l.price)} / ${esc(l.unit || "")}${l.disc ? ` · <b class="extra">${esc(l.disc.name || "Discount")} ${esc(discountText(l.disc))}</b>` : ""}${extra > 0 ? ` · <b class="extra">+${money(extra)}</b>` : ""}</small>
        </div>
        <div class="qty">
          <button type="button" class="qty-btn" data-dec="${esc(l.key)}" aria-label="Decrease quantity">−</button>
          <input class="qty-input" data-qty="${esc(l.key)}" value="${l.qty}" inputmode="numeric" aria-label="Quantity" />
          <button type="button" class="qty-btn" data-inc="${esc(l.key)}" aria-label="Increase quantity">+</button>
        </div>
        <strong class="bl-total">${money(l.price * l.qty)}</strong>
        <button type="button" class="icon-btn sm bl-remove" data-rm="${esc(l.key)}" aria-label="Remove ${esc(l.name)}">${icon("trash")}</button>
      </div>`;
  };

  function paintBill() {
    const lines = cartLines();
    const count = lines.reduce((s, l) => s + (isService(l) ? 1 : l.qty), 0);
    $("#p-count").textContent = `${count} item${count === 1 ? "" : "s"}`;
    $("#p-count").className = `badge ${count ? "ok" : ""}`;
    // One tile per payment method: cash and card keep their colours and shortcuts; the others share a teal tile.
    $("#p-tiles").innerHTML = methods.filter((m) => !m.credit || creditOk).map((m) => {
      const isCash = m.key === cashKey();
      const isCard = !isCash && m.key === cardKey();
      return `<button type="button" class="pt ${isCash ? "pt-cash" : isCard ? "pt-card" : "pt-alt"} ${m.key === st.pay ? "is-on" : ""}" data-pay="${esc(m.key)}" aria-pressed="${m.key === st.pay}">
        <span>${esc(m.label)}</span>${isCash ? "<kbd>F9</kbd>" : isCard ? "<kbd>F10</kbd>" : ""}</button>`;
    }).join("");
    $("#p-tiles").hidden = !lines.length;
    $("#p-billno").textContent = st.openId ? `Open bill · ${String(st.openId).slice(-6).toUpperCase()}` : "New bill";
    const cust = customers.find((c) => c.id === st.customerId);
    $("#p-custinfo").textContent = cust
      ? [cust.phone, Number(cust.balance) ? `Balance ${money(cust.balance)}` : ""].filter(Boolean).join(" · ") || "Registered customer"
      : "Walk-in sale";
    $("#p-lines").innerHTML = lines.length ? lines.map(billLine).join("")
      : `<div class="empty-state small">${icon("cart")}<p>Tap a product, or a service above, to add it to the bill.</p></div>`;
    const t = billTotals(lines);
    const extra = round2(lines.filter((l) => !isService(l)).reduce((s, l) => s + Math.max(0, l.price - l.listPrice) * l.qty, 0));
    $("#p-totals").innerHTML = `
      <div><span>Subtotal</span><span>${money(t.goods.subtotal)}</span></div>
      <div class="disc-row"><span>Discount</span><span>− ${money(t.goods.discount)}</span></div>
      ${extra > 0 ? `<div class="extra-row"><span>Price increase</span><span>+ ${money(extra)}</span></div>` : ""}
      <div><span>VAT</span><span>${money(t.goods.vat)}</span></div>
      ${t.fees > 0 ? `<div><span>Service fees</span><span>+ ${money(t.fees)}</span></div>` : ""}
      <div class="grand"><span>Total payable</span><span class="count-up">${money(t.saleTotal)}</span></div>
      ${t.transfersIn ? `<div><span>Sent to wallets / operators</span><span>+ ${money(t.transfersIn)}</span></div>` : ""}
      ${t.transfersOut ? `<div><span>Cash-out paid to customer</span><span>− ${money(t.transfersOut)}</span></div>` : ""}
      ${t.transfersIn || t.transfersOut ? `<div class="grand"><span>${t.collect >= 0 ? "To collect" : "To pay customer"}</span><span>${money(Math.abs(t.collect))}</span></div>` : ""}`;
    // Discount, payment, Charge and Clear appear only once the bill has something in it.
    const hasItems = lines.length > 0;
    $("#p-steps").hidden = !hasItems;
    if (!hasItems) { st.showDisc = false; st.showPay = false; }
    $("#p-discsec").hidden = !(hasItems && st.showDisc);
    $("#p-paysec").hidden = !(hasItems && st.showPay);
    $("#p-discbtn").classList.toggle("active", st.showDisc);
    $("#p-paybtn").classList.toggle("active", st.showPay);
    $("#p-discbadge").textContent = st.billDisc ? discountText(st.billDisc) : "";
    paintDiscountBox();
    $("#p-paybadge").textContent = paymentMethod(st.pay)?.label || "";
    $("#p-charge").hidden = !hasItems;
    $("#p-clear").disabled = !hasItems;
    $("#p-hold").disabled = !hasItems;
    $("#p-mobile-total").textContent = `${count} · ${money(Math.abs(t.collect))}${t.collect < 0 ? " to customer" : ""}`;
    const chargeLabel = $("#p-charge span");
    if (chargeLabel && !$("#p-charge").classList.contains("loading")) {
      chargeLabel.textContent = t.collect < 0 ? `Pay customer ${money(Math.abs(t.collect))}` : `Charge ${money(t.saleTotal)}`;
    }
    const cash = paymentMethod(st.pay).key === "cash";
    const needsTender = cash && t.collect > 0;
    $("#p-cashrow").hidden = !needsTender;
    $("#p-change").hidden = !(cash && count);
    if (needsTender && $("#p-tender").value !== "") {
      const diff = round2(Number($("#p-tender").value) - t.collect);
      $("#p-change").textContent = diff >= 0 ? `Change due: ${money(diff)}` : `Still to collect: ${money(-diff)}`;
      $("#p-change").className = `change-due ${diff >= 0 ? "ok" : "warn"}`;
    } else if (cash && t.collect < 0) {
      $("#p-change").textContent = `Pay the customer: ${money(-t.collect)}`;
      $("#p-change").className = "change-due warn";
    } else {
      $("#p-change").textContent = "";
      $("#p-change").className = "change-due";
    }

    // Payment methods as tap chips (the hidden select keeps the value for the rest of the screen).
    $("#p-paychips").innerHTML = methods.filter((m) => !m.credit || creditOk).map((m) =>
      `<button type="button" class="pay-chip ${m.key === st.pay ? "active" : ""}" data-pay="${esc(m.key)}" role="radio" aria-checked="${m.key === st.pay}">${esc(m.label)}</button>`).join("");
    // Quick cash: the exact amount, then the next few notes above it.
    const quick = $("#p-quick");
    if (needsTender) {
      const exact = round2(t.collect);
      const notes = [20, 50, 100, 200, 500, 1000, 2000].filter((n) => n > exact).slice(0, 3);
      quick.innerHTML = [`<button type="button" class="quick-btn exact" data-tender="${exact}">Exact ${money(exact)}</button>`,
        ...notes.map((n) => `<button type="button" class="quick-btn" data-tender="${n}">${money(n)}</button>`)].join("");
      quick.hidden = false;
    } else {
      quick.hidden = true;
    }
  }

  $("#p-paychips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pay]");
    if (!b) return;
    st.pay = b.dataset.pay;
    $("#p-pay").value = st.pay;
    paintBill();
  });
  $("#p-quick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tender]");
    if (!b) return;
    $("#p-tender").value = b.dataset.tender;
    paintBill();
    $("#p-tender").focus();
  });

  function flash(id) {
    const c = el.querySelector(`[data-add="${CSS.escape(id)}"]`);
    if (!c) return;
    c.classList.remove("flash");
    void c.offsetWidth;
    c.classList.add("flash");
  }

  // Discounts: the administrator's presets plus open % and open amount typed by the cashier.
  const discountText = (d) => !d ? "" : d.mode === "pct" ? `${d.value}%` : money(d.value);
  function discountControls(scope, current) {
    const list = presets.filter((d) => d.scope === scope);
    const applied = current
      ? `<span class="disc-now"><b>${esc(current.name || "Discount")}</b> · ${esc(discountText(current))}</span>`
      : `<span class="disc-now muted">No discount applied</span>`;
    return `
      <div class="disc-box">
        <div class="disc-section">
          <span class="field-label">Saved discounts</span>
          <div class="disc-presets">${list.length ? list.map((d) => `<button type="button" class="chip ${current?.presetId === d.id ? "active" : ""}" data-preset="${esc(d.id)}">${esc(d.name)} · ${esc(discountText(d))}</button>`).join("")
            : `<span class="muted small">No ${scope === "item" ? "item" : "bill"} discounts yet. The administrator creates them.</span>`}</div>
        </div>
        <div class="disc-section">
          <span class="field-label">Custom</span>
          <div class="disc-open">
            <button type="button" class="btn ghost" data-open-kind="pct">Open %</button>
            <button type="button" class="btn ghost" data-open-kind="amt">Open amount</button>
          </div>
        </div>
        <div class="disc-actions">
          ${applied}
          <button type="button" class="btn ghost sm" data-disc-clear ${current ? "" : "disabled"}>Clear</button>
        </div>
      </div>`;
  }
  // Open % and open amount ask for the value in a small dialog, and only when the button is pressed.
  function openCustomDiscount(kind, onSet, afterwards) {
    const isPct = kind === "pct";
    openModal(isPct ? "Open % discount" : "Open amount discount", `
      <form id="od-form" class="item-adjust">
        <label>${isPct ? "Percentage off" : "Amount off"}
          <input id="od-val" type="number" inputmode="decimal" min="0" ${isPct ? 'max="100" step="0.5"' : 'step="0.01"'} placeholder="${isPct ? "e.g. 10" : "e.g. 50"}" required />
        </label>
        <p class="muted small">${isPct ? "Taken off the price as a percentage, from 0 to 100." : "Taken off the price as a fixed amount."}</p>
        <div class="form-actions">
          <button type="button" class="btn ghost" data-od-cancel>Cancel</button>
          <button type="submit" class="btn primary">Apply discount</button>
        </div>
      </form>`, (body, close) => {
        const input = body.querySelector("#od-val");
        const done = () => { close(); if (afterwards) afterwards(); };
        body.querySelector("[data-od-cancel]").addEventListener("click", done);
        body.querySelector("#od-form").addEventListener("submit", (e) => {
          e.preventDefault();
          const v = Number(input.value);
          if (isPct && !(v > 0 && v <= 100)) return toast("Enter a percentage between 0 and 100", "error");
          if (!isPct && !(v > 0)) return toast("Enter an amount above 0", "error");
          onSet({ name: isPct ? "Open %" : "Open amount", mode: isPct ? "pct" : "amt", value: isPct ? v : round2(v) });
          done();
        });
        setTimeout(() => input.focus(), 30);
      }, { center: true });
  }
  function bindDiscountControls(root, onSet, afterwards) {
    root.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      const d = presets.find((x) => x.id === b.dataset.preset);
      if (d) onSet({ presetId: d.id, name: d.name, mode: d.mode, value: Number(d.value) });
    }));
    root.querySelector("[data-disc-clear]").addEventListener("click", () => onSet(null));
    root.querySelectorAll("[data-open-kind]").forEach((b) => b.addEventListener("click", () => openCustomDiscount(b.dataset.openKind, onSet, afterwards)));
  }
  // Item discounts: one row per product on the bill; each opens its own discount dialog.
  function paintItemDiscounts() {
    const list = $("#p-itemdisc");
    const rows = cartLines().filter((l) => !isService(l));
    list.innerHTML = rows.length ? rows.map((l) => `
      <div class="itemdisc-row">
        <div><strong>${esc(l.name)}</strong><small>${l.disc ? `${esc(l.disc.name || "Discount")} · ${esc(discountText(l.disc))}` : "No discount"}</small></div>
        <button type="button" class="btn ghost sm" data-idisc="${esc(l.key)}">Discount</button>
      </div>`).join("")
      : `<p class="muted small">Add an item first, then give it a discount here.</p>`;
  }
  // The whole-bill discount box, drawn again only when the discount changes so typing is not lost.
  function paintDiscountBox() {
    const box = $("#p-discbox");
    if (!box) return;
    const isBill = st.discMode !== "item";
    box.hidden = !isBill;
    $("#p-itemdisc").hidden = isBill;
    el.querySelectorAll("[data-dmode]").forEach((b) => b.classList.toggle("active", b.dataset.dmode === st.discMode));
    if (!isBill) return paintItemDiscounts();
    const key = JSON.stringify(st.billDisc);
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = discountControls("bill", st.billDisc);
    bindDiscountControls(box, (d) => { st.billDisc = d; paintBill(); });
  }

  // Small dialog to change one product line: unit, quantity, price, or remove it.
  async function openItem(key) {
    await loadPresets();
    if (!st.cart.has(key)) return;
    openModal("Adjust item", "", (body, close) => {
      let cur = key;
      const draw = () => {
        const line = st.cart.get(cur);
        if (!line) return close();
        const v = lineView(line);
        const p = byId[line.id];
        body.innerHTML = `
          <div class="item-adjust">
            <strong class="item-name">${esc(v.name)}</strong>
            <label>Unit<select id="ia-unit">${unitOptions(p, line.unitKey)}</select></label>
            <div class="qty-row"><span>Quantity</span>
              <div class="qty"><button type="button" class="icon-btn sm" id="ia-dec" aria-label="Decrease quantity">−</button><span>${line.qty}</span><button type="button" class="icon-btn sm" id="ia-inc" aria-label="Increase quantity">+</button></div>
            </div>
            <label>Price per unit<input id="ia-price" type="number" inputmode="decimal" step="0.01" min="${v.minPrice}" value="${v.price}" ${allowChange ? "" : "readonly"} /></label>
            <p class="muted small">List ${money(v.listPrice)} · lowest ${money(v.minPrice)}</p>
            <h4 class="sec-title">Item discount</h4>
            ${discountControls("item", line.disc)}
            <div class="form-actions">
              <button type="button" class="btn ghost" id="ia-remove">Remove</button>
              <button type="button" class="btn primary" id="ia-done">Done</button>
            </div>
          </div>`;
        body.querySelector("#ia-unit").addEventListener("change", (e) => {
          const before = cur;
          setUnit(before, e.target.value);
          cur = `${line.id}|${e.target.value}`;
          if (!st.cart.has(cur)) cur = before;
          paintBill(); draw();
        });
        body.querySelector("#ia-dec").addEventListener("click", () => { change(cur, -1); paintBill(); draw(); });
        body.querySelector("#ia-inc").addEventListener("click", () => { change(cur, 1); paintBill(); draw(); });
        body.querySelector("#ia-price").addEventListener("change", (e) => { setPrice(cur, e.target.value); paintBill(); draw(); });
        bindDiscountControls(body.querySelector(".disc-box"), (d) => { const l = st.cart.get(cur); if (l) l.disc = d; paintBill(); }, () => openItem(cur));
        body.querySelector("#ia-remove").addEventListener("click", () => { removeLine(cur); close(); });
        body.querySelector("#ia-done").addEventListener("click", close);
      };
      draw();
    });
  }

  function add(id, unitKey = "piece") {
    const p = byId[id];
    if (!p) return;
    const u = unitByKey(p, unitKey);
    if (piecesInCart(id) + u.size > (Number(p.stock) || 0)) {
      return toast(`Only ${p.stock || 0} ${baseName(p)} of ${p.name} in stock`, "error");
    }
    const key = `${id}|${u.key}`;
    const have = st.cart.get(key);
    if (have) have.qty += 1;
    else st.cart.set(key, { key, id, unitKey: u.key, qty: 1, price: u.price });
    paintBill();
    flash(id);
  }

  function addService(line) {
    st.svcSeq += 1;
    const key = `svc|${st.svcSeq}`;
    st.cart.set(key, { ...line, key });
    paintBill();
  }

  function change(key, delta) {
    const l = st.cart.get(key);
    if (!l || isService(l)) return;
    const next = l.qty + delta;
    if (next <= 0) return removeLine(key);
    const p = byId[l.id];
    const u = unitByKey(p, l.unitKey);
    if (delta > 0 && piecesInCart(l.id) + u.size > (Number(p.stock) || 0)) {
      return toast(`Not enough ${baseName(p)} of ${p.name} in stock`, "error");
    }
    l.qty = next;
    paintBill();
  }

  function removeLine(key) {
    const l = st.cart.get(key);
    st.cart.delete(key);
    if (l) logItemVoid(l);
    paintBill();
  }

  // Switching unit keeps the same number of pieces, at that unit's list price.
  function setUnit(key, newKey) {
    const l = st.cart.get(key);
    if (!l || isService(l)) return;
    const p = byId[l.id];
    const from = unitByKey(p, l.unitKey);
    const to = unitByKey(p, newKey);
    if (to.key === from.key) return;
    const qty = Math.max(1, Math.round((l.qty * from.size) / to.size));
    st.cart.delete(key);
    const nk = `${l.id}|${to.key}`;
    const existing = st.cart.get(nk);
    if (existing) existing.qty += qty;
    else st.cart.set(nk, { key: nk, id: l.id, unitKey: to.key, qty, price: to.price });
    paintBill();
  }

  // The cashier may raise a price. A price below the lowest allowed is refused and reset.
  function setPrice(key, value) {
    const l = st.cart.get(key);
    if (!l || isService(l)) return;
    const p = byId[l.id];
    const u = unitByKey(p, l.unitKey);
    if (!allowChange) return paintBill();
    let n = round2(Number(value) || 0);
    if (n < u.minPrice) {
      alertBox({
        title: "Price is too low", tone: "warn",
        message: `${p.name} can not be sold below ${money(u.minPrice)} per ${u.name}. The price has been set to that lowest price.`,
      });
      n = u.minPrice;
    }
    l.price = n;
    paintBill();
  }

  // Open bills are saved in the database: they stay open after a reload and can be finished on any till.
  const billRecord = () => ({
    lines: [...st.cart.values()].map((l) => ({ ...l })),
    billDisc: st.billDisc || null,
    customerId: st.customerId || "",
    customerName: customers.find((c) => c.id === st.customerId)?.name || "Walk-in",
    pay: st.pay,
  });
  async function saveOpenBill() {
    const data = { ...billRecord(), status: "open", byName: session.name, byUid: session.uid, updatedAt: serverTimestamp() };
    if (st.openId) await updateDoc(doc(db, "openBills", st.openId), data);
    else {
      const ref = await addDoc(collection(db, "openBills"), { ...data, createdAt: serverTimestamp() });
      st.openId = ref.id;
    }
  }
  const lineSummary = (lines) => lines.map((l) => ({
    name: isService(l) ? l.name : byId[l.id]?.name || "item",
    qty: l.qty,
    unit: isService(l) ? "service" : unitByKey(byId[l.id], l.unitKey).name,
    price: l.price,
    total: round2(l.price * l.qty),
  }));
  async function hold() {
    if (!st.cart.size) return toast("Add products before opening a bill", "error");
    try { await saveOpenBill(); } catch (err) { return toast(err.message, "error"); }
    st.openId = null;
    clearBill();
    toast("Bill kept open. Find it under Bills, Open.", "success");
  }

  function clearBill() {
    st.cart.clear(); st.billDisc = null; st.customerId = ""; $("#p-customer").value = ""; $("#p-tender").value = "";
    paintBill();
  }

  // Voiding asks for a reason. Every void is kept under Bills, Void.
  function askReason(title, onOk) {
    openModal(title, `
      <form id="rs-form" class="form-grid">
        <label class="span-2">Reason<textarea name="reason" required rows="3" minlength="3" placeholder="Why is this being voided?"></textarea></label>
        <div class="form-actions span-2"><button type="button" class="btn ghost" data-cancel>Back</button><button class="btn primary" type="submit">Void</button></div>
      </form>`, (mb, close) => {
      mb.querySelector("[data-cancel]").addEventListener("click", close);
      onSubmit(mb.querySelector("#rs-form"), async (e) => {
        const reason = String(new FormData(e.target).get("reason") || "").trim();
        if (reason.length < 3) return toast("Write the reason (at least 3 letters).", "error");
        await onOk(reason);
        close();
      });
    });
  }
  function voidBill() {
    if (!st.cart.size) return;
    askReason("Void this bill", async (reason) => {
      const lines = cartLines();
      const total = billTotals(lines).saleTotal;
      const source = st.openId ? "open bill" : "bill";
      await addDoc(collection(db, "voidedBills"), {
        source, ref: st.openId || "", reason, lines: lineSummary([...st.cart.values()]), total,
        byName: session.name, byUid: session.uid, createdAt: serverTimestamp(),
      });
      if (st.openId) await deleteDoc(doc(db, "openBills", st.openId)).catch(() => {});
      await audit("bill.void", { source, total, reason });
      st.openId = null;
      clearBill();
      toast("Bill voided", "info");
    });
  }
  // Removing a line is kept as a void too, so every item taken off a bill can be seen.
  function logItemVoid(l) {
    const summary = lineSummary([l]);
    addDoc(collection(db, "voidedBills"), {
      source: "item", ref: st.openId || "", reason: "Item removed from the bill", lines: summary, total: summary[0]?.total || 0,
      byName: session.name, byUid: session.uid, createdAt: serverTimestamp(),
    }).catch(() => {});
  }

  // Open bills, from the Bills page: the bill is loaded here, and the bill on the screen is kept open first.
  async function resumeBill(id) {
    try {
      const snap = await getDoc(doc(db, "openBills", id));
      if (!snap.exists()) return toast("That open bill is no longer there", "error");
      if (st.cart.size) await saveOpenBill();
      const b = snap.data();
      st.cart = new Map((b.lines || []).map((l) => [l.key, { ...l }]));
      st.billDisc = b.billDisc || null;
      st.customerId = b.customerId || "";
      st.pay = b.pay || st.pay;
      st.openId = id;
      $("#p-customer").value = st.customerId;
      $("#p-pay").value = st.pay;
      paintBill();
      paintGrid();
      toast("Open bill loaded", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // Recharge, cash-in and cash-out. The operator or wallet comes from the admin's lists.
  function openServiceForm(type) {
    const def = SERVICE_TYPES[type];
    const providers = serviceProviders(type);
    if (!providers.length) {
      return alertBox({
        title: `No ${def.providerLabel.toLowerCase()}s yet`, tone: "warn",
        message: `Add ${def.providerLabel.toLowerCase()}s under Administration → Lists & payments, then come back here.`,
      });
    }
    const floatOf = (p) => money(floats[floatKey(type, p)] || 0);
    openModal(def.label, `
      <form id="svc-form" class="form-grid">
        <label class="span-2">${def.providerLabel}
          <select name="provider" required>${providers.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("")}</select>
        </label>
        <p class="muted small span-2" id="svc-float">${def.providerLabel} float: ${floatOf(providers[0])}</p>
        <label class="span-2">${esc(def.amountLabel)}<input name="amount" type="number" inputmode="decimal" min="1" step="0.01" required /></label>
        <label class="span-2">${def.phoneRequired ? "Mobile number to recharge" : "Customer wallet number (optional)"}
          <input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX" ${def.phoneRequired ? "required" : ""} />
        </label>
        <div class="svc-calc span-2" id="svc-calc" aria-live="polite"></div>
        <div class="form-actions span-2"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit">${icon("plus")}<span>Add to bill</span></button></div>
      </form>`, (body, close) => {
      const form = body.querySelector("#svc-form");
      const calc = () => {
        const f = new FormData(form);
        const provider = String(f.get("provider"));
        body.querySelector("#svc-float").textContent = `${def.providerLabel} float: ${floatOf(provider)}`;
        const T = Number(f.get("amount")) || 0;
        if (!(T > 0)) { body.querySelector("#svc-calc").innerHTML = `<p class="muted small">Enter the amount to see the fee and the cash to take or give.</p>`; return; }
        const fee = calcFeePreview(type, T);
        const b = serviceBreakdown(type, T, fee);
        const rows = type === "cashout"
          ? [["Customer sends to wallet", money(T)], ["Shop gives customer cash", money(T)], ["Customer pays fee in cash", money(fee)], ["Cash drawer change", money(b.cashChange)]]
          : [["Customer gives cash", money(b.customerGives)], ["Sent from float", money(T)], ["Shop fee (income)", money(fee)]];
        body.querySelector("#svc-calc").innerHTML = `<div class="svc-rows">${rows.map(([l, v]) => `<div><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join("")}</div>`;
      };
      form.addEventListener("input", calc);
      form.addEventListener("change", calc);
      body.querySelector("[data-cancel]").addEventListener("click", close);
      calc();
      onSubmit(form, async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const provider = String(f.get("provider"));
        try {
          addService(serviceLine({
            type, provider, amount: f.get("amount"), phone: String(f.get("phone") || ""),
            balance: floats[floatKey(type, provider)] || 0,
          }));
          close();
          toast(`${def.label} added to the bill`, "success");
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
  }

  const calcFeePreview = (type, T) => calcFee(type, T);

  $("#p-cats").addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (t) {
      st.tab = t.dataset.tab;
      st.sub = "";
      paintCats();
      paintGrid();
      return;
    }
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    st.cat = b.dataset.cat;
    st.sub = "";
    paintCats();
    paintGrid();
  });
  $("#p-subs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sub]");
    if (!b) return;
    st.sub = b.dataset.sub;
    paintGrid();
  });
  el.querySelectorAll("[data-svc]").forEach((b) => b.addEventListener("click", () => openServiceForm(b.dataset.svc)));
  $("#p-grid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-add]");
    if (b) add(b.dataset.add);
  });
  $("#p-lines").addEventListener("click", (e) => {
    const o = e.target.closest("[data-open]");
    if (o) return openItem(o.dataset.open);
    const t = e.target.closest("[data-inc],[data-dec],[data-rm]");
    if (!t) return;
    if (t.dataset.inc) change(t.dataset.inc, 1);
    else if (t.dataset.dec) change(t.dataset.dec, -1);
    else removeLine(t.dataset.rm);
  });
  $("#p-lines").addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.qty) {
      const l = st.cart.get(t.dataset.qty);
      const want = Math.floor(Number(t.value));
      if (!l) return;
      if (!(want > 0)) { toast("Enter a quantity of 1 or more, or use Remove", "error"); return paintBill(); }
      return change(t.dataset.qty, want - l.qty);
    }
    if (t.dataset.unit) setUnit(t.dataset.unit, t.value);
    else if (t.dataset.price) setPrice(t.dataset.price, t.value);
  });
  $("#p-search").addEventListener("input", (e) => { st.q = e.target.value; paintGrid(); });
  $("#p-search").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const code = e.target.value.trim();
    if (!code) return;
    const hit = products.find((p) => p.barcode === code || p.sku === code);
    if (hit) {
      add(hit.id);
      st.q = "";
      e.target.value = "";
      paintGrid();
    } else {
      toast(`No product has the code ${code}`, "error");
    }
  });
  $("#p-customer").addEventListener("change", (e) => { st.customerId = e.target.value; paintBill(); });
  $("#p-disc")?.addEventListener("input", (e) => {
    st.disc = Math.min(100, Math.max(0, Number(e.target.value) || 0));
    paintBill();
  });
  $("#p-discbtn").addEventListener("click", async () => {
    st.showDisc = !st.showDisc;
    paintBill();
    if (st.showDisc) { await loadPresets(); paintBill(); }
  });
  $("#p-discmode").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-dmode]");
    if (!b) return;
    st.discMode = b.dataset.dmode;
    paintBill();
    await loadPresets();
    paintBill();
  });
  $("#p-itemdisc").addEventListener("click", (e) => {
    const b = e.target.closest("[data-idisc]");
    if (b) openItem(b.dataset.idisc);
  });
  $("#p-paybtn").addEventListener("click", () => { st.showPay = !st.showPay; paintBill(); });
  $("#p-pay").addEventListener("change", () => { st.pay = $("#p-pay").value; paintBill(); });
  $("#p-tender").addEventListener("input", paintBill);
  $("#p-hold").addEventListener("click", hold);
  $("#p-held").addEventListener("click", async () => {
    try { if (st.cart.size) await saveOpenBill(); } catch (err) { return toast(err.message, "error"); }
    location.hash = "#/bills";
  });
  $("#p-clear").addEventListener("click", voidBill);
  onAction($("#p-charge"), charge);
  $("#p-mobile-btn").addEventListener("click", () => {
    $("#p-bill").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // Cash and card use the payment method with that name, and open the payment step.
  const cashKey = () => methods.find((m) => m.key === "cash" || /cash/i.test(m.label))?.key;
  const cardKey = () => (methods.find((m) => /card/i.test(`${m.key} ${m.label}`)) || methods.find((m) => !m.credit && m.key !== cashKey()))?.key;
  const pickPay = (key) => {
    if (!key) return toast("That payment method is not set up in Settings.", "error");
    st.pay = key; $("#p-pay").value = key; st.showPay = true; paintBill();
    if (key === cashKey()) $("#p-tender")?.focus();
  };
  const openDiscount = () => { if (!st.showDisc) $("#p-discbtn").click(); };
  // Shortcuts press the same buttons on screen, so they respect each button's rules. F2 search, F4 charge, F6 discount,
  // F8 open bill, F9 cash, F10 card. F5, F11 and F12 are left to the browser (reload, full screen, developer tools).
  const onKey = (e) => {
    if (!el.isConnected) return document.removeEventListener("keydown", onKey);
    if (document.getElementById("modal-root")?.children.length) return;
    const act = { F2: () => $("#p-search").focus(), F4: () => $("#p-charge").click(), F6: openDiscount,
      F8: () => $("#p-hold").click(), F9: () => pickPay(cashKey()), F10: () => pickPay(cardKey()) }[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  };
  document.addEventListener("keydown", onKey);

  $("#p-tiles").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pay]");
    if (b) pickPay(b.dataset.pay);
  });
  $("#p-actions").addEventListener("click", (e) => {
    const b = e.target.closest("[data-qa]");
    if (!b) return;
    const act = { search: () => $("#p-search").focus(), hold: () => $("#p-hold").click(), bills: () => $("#p-held").click(),
      discount: openDiscount, cash: () => pickPay(cashKey()), card: () => pickPay(cardKey()), charge: () => $("#p-charge").click() }[b.dataset.qa];
    act?.();
  });
  $("#p-sort").addEventListener("change", (e) => { pageView.sort = e.target.value; paintGrid(); });
  $("#p-filter").addEventListener("change", (e) => { pageView.filter = e.target.value; paintGrid(); });
  $(".view-toggle").addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (!b) return;
    pageView.view = b.dataset.view;
    paintGrid();
  });
  $("#p-more").addEventListener("click", () => { pageView.limit += 48; paintGrid(); });

  // Live clock in the top bar; stops when the page is left.
  const paintClock = () => {
    const c = $("#p-clock");
    if (c) c.textContent = new Date().toLocaleString([], { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };
  paintClock();
  const clockTick = setInterval(() => { if (!el.isConnected) return clearInterval(clockTick); paintClock(); }, 15000);

  async function charge() {
    if (!openShift) return toast("Open a cash shift before you take payment.", "error");
    if (!st.cart.size) return toast("The bill is empty. Add a product first.", "error");
    const method = paymentMethod(st.pay);
    const lines = cartLines();
    const hasServices = lines.some(isService);
    if (method.credit && !st.customerId) return toast("Choose a customer for an on-account sale", "error");
    if (method.credit && hasServices) return toast("Recharge and wallet services must be paid now, not on account", "error");
    const low = lines.find((l) => !isService(l) && l.price < l.minPrice - 0.005);
    if (low) return toast(`${low.name} can not be sold below ${money(low.minPrice)} per ${low.unit}`, "error");
    const t = billTotals(lines);
    const cashOnBill = method.key === "cash" && t.collect > 0;
    const tendered = cashOnBill && $("#p-tender").value !== "" ? Number($("#p-tender").value) : null;
    if (tendered !== null && tendered < 0) return toast("Cash received cannot be negative", "error");
    // Cash sales need the amount the customer gave, and it must cover the total. Otherwise the till would be short.
    if (cashOnBill && tendered === null) { $("#p-tender")?.focus(); return toast("Enter the cash received from the customer", "error"); }
    if (cashOnBill && tendered < t.collect - 0.005) { $("#p-tender")?.focus(); return toast(`Cash received is ${money(tendered)}. The total is ${money(t.collect)}.`, "error"); }
    // A discount above the cashier limit needs an administrator to approve it first.
    let approvalId = null;
    const storedPct = Math.ceil((t.goods.effectivePct || 0) * 100) / 100;
    if (storedPct > settings.maxDiscountPct) {
      try { approvalId = await askDiscountApproval(storedPct); } catch (err) { return toast(err.message, "error"); }
    }
    const btn = $("#p-charge");
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const customer = customers.find((c) => c.id === st.customerId) || null;
      const sale = await postWithVoucher(() => completeSale({ lines, billDisc: st.billDisc, method, customer, tendered, approvalId }), (r) => r.jvNo);
      await audit("sale", { invoiceNo: sale.invoiceNo, total: sale.total, payment: method.key, services: sale.serviceCount });
      for (const l of lines) if (!isService(l)) byId[l.id].stock = (Number(byId[l.id].stock) || 0) - l.pieces;
      Object.assign(floats, sale.floatBalances || {});
      if (st.openId) { await deleteDoc(doc(db, "openBills", st.openId)).catch(() => {}); st.openId = null; }
      afterSale(lines, sale);
      clearBill();
      paintGrid();
      if (sale.priceExtra > 0) {
        toast(`Sale saved. Price increases added ${money(sale.priceExtra)}.`, "success");
      }
      showReceipt(sale);
    } catch (err) {
      console.error(err);
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  }

  // Alerts after a sale: out of stock, low stock, and a wallet float that has run low. Once per item per day.
  function afterSale(lines, sale) {
    const today = todayISO();
    const inv = rolesWith("inventory");
    for (const l of lines) {
      if (isService(l)) continue;
      const p = byId[l.id];
      const stock = Number(p.stock) || 0;
      if (stock <= 0) notifyOnce(`out-${l.id}-${today}`, { roleKeys: inv, kind: "stock", title: `Out of stock: ${p.name}`, body: "Reorder now.", link: "inventory" });
      else if ((Number(p.reorderLevel) || 0) > 0 && stock <= Number(p.reorderLevel)) {
        notifyOnce(`low-${l.id}-${today}`, { roleKeys: inv, kind: "stock", title: `Low stock: ${p.name}`, body: `${stock} left, reorder level ${p.reorderLevel}.`, link: "inventory" });
      }
    }
    const warn = Number(settings.floatWarnAmount ?? 1000);
    for (const [k, b] of Object.entries(sale.floatBalances || {})) {
      if (b < warn) {
        notifyOnce(`float-${k}-${today}`, {
          roleKeys: rolesWith("accounting"), kind: "float", title: `Float running low: ${k.replace(/_/g, " ")}`,
          body: `Balance ${money(b)}. Top it up in Accounting.`, link: "accounting",
        });
      }
    }
  }

  function showReceipt(sale) {
    const rows = sale.lines.map((l) => `
      <tr><td>${esc(l.name)}<small>${l.service ? esc(l.service) : `${l.qty} ${esc(l.unit || "")} × ${money(l.price)}${l.price > l.listPrice ? ` (list ${money(l.listPrice)})` : ""}`}</small></td><td class="r">${money(l.lineTotal)}</td></tr>`).join("");
    openModal(`Invoice ${sale.invoiceNo}`, `
      <div class="receipt print-area">
        <div class="r-head">
          <div class="r-check">${icon("check")}</div>
          <strong>${esc(settings.shopName)}</strong>
          <small>${esc(settings.shopAddress || "")}</small>
          ${settings.taxNumber ? `<small>Tax no. ${esc(settings.taxNumber)}</small>` : ""}
          <small>${new Date().toLocaleString()}</small>
        </div>
        <table class="r-table"><tbody>${rows}</tbody></table>
        <div class="r-totals">
          <div><span>Subtotal</span><span>${money(sale.subtotal)}</span></div>
          <div><span>Discount</span><span>− ${money(sale.discount)}</span></div>
          ${sale.priceExtra > 0 ? `<div><span>Price increases</span><span>+ ${money(sale.priceExtra)}</span></div>` : ""}
          <div><span>VAT</span><span>${money(sale.vat)}</span></div>
          ${sale.fees > 0 ? `<div><span>Service fees</span><span>${money(sale.fees)}</span></div>` : ""}
          <div class="grand"><span>Total</span><span>${money(sale.total)}</span></div>
          ${sale.transfersIn ? `<div><span>Sent to wallets / operators</span><span>${money(sale.transfersIn)}</span></div>` : ""}
          ${sale.transfersOut ? `<div><span>Cash-out paid to customer</span><span>${money(sale.transfersOut)}</span></div>` : ""}
          <div class="grand"><span>${sale.collect >= 0 ? "Collected" : "Paid to customer"}</span><span>${money(Math.abs(sale.collect))}</span></div>
          <div><span>Paid by</span><span>${esc(sale.paymentLabel)}</span></div>
          ${sale.tendered != null ? `<div><span>Cash received</span><span>${money(sale.tendered)}</span></div><div><span>Change</span><span>${money(Math.max(0, sale.change))}</span></div>` : ""}
        </div>
        <p class="r-foot">${esc(settings.receiptFooter || "")}</p>
      </div>
      <div class="form-actions">
        <button class="btn ghost" type="button" data-print-thermal>${icon("print")}<span>Receipt 80mm</span></button>
        <button class="btn ghost" type="button" data-print-thermal58>${icon("print")}<span>Receipt 58mm</span></button>
        <button class="btn ghost" type="button" data-print-a4>${icon("print")}<span>A4 invoice</span></button>
        <button class="btn primary" type="button" data-done>${icon("check")}<span>New sale</span></button>
      </div>`, (body, close) => {
      body.querySelector("[data-print-thermal]").addEventListener("click", () => printReceipt(sale, "thermal"));
      body.querySelector("[data-print-thermal58]").addEventListener("click", () => printReceipt(sale, "thermal58"));
      body.querySelector("[data-print-a4]").addEventListener("click", () => printReceipt(sale, "a4"));
      body.querySelector("[data-done]").addEventListener("click", close);
    });
  }

  paintCats();
  paintGrid();
  paintBill();
  const resumeId = sessionStorage.getItem("medipos.resumeBill");
  if (resumeId) { sessionStorage.removeItem("medipos.resumeBill"); resumeBill(resumeId); }
}

// Asks an administrator to approve a discount. The server checks their password and returns a short-lived approval.
function askDiscountApproval(pct) {
  return new Promise((resolve, reject) => {
    openModal("Manager approval needed", `
      <p class="muted small">This discount (${pct}%) is above the limit for cashiers (${settings.maxDiscountPct}%). An administrator must approve it with their own email and password.</p>
      <form id="da-form" class="form-grid">
        <label class="span-2">Administrator email<input name="email" type="email" autocomplete="off" required /></label>
        <label class="span-2">Administrator password<input name="password" type="password" autocomplete="off" required /></label>
        <div class="form-actions span-2">
          <button class="btn ghost" type="button" id="da-cancel">Cancel</button>
          <button class="btn primary" type="submit">Approve</button>
        </div>
      </form>`, (host, close) => {
      const form = host.querySelector("#da-form");
      host.querySelector("#da-cancel").addEventListener("click", () => { close(); reject(new Error("Discount cancelled.")); });
      onSubmit(form, async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        try {
          const r = await post("/api/till", { action: "discount-approval", discountPct: pct, approverEmail: f.get("email"), approverPassword: f.get("password") }, { secure: true });
          close();
          toast(`Discount approved by ${r.approvedBy}`, "success");
          resolve(r.approvalId);
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
  });
}

/* Runs the whole sale atomically: stock in pieces (FEFO batches), lowest-price check, service fees and transfers,
   invoice number, one balanced journal, customer balance. */
async function completeSale({ lines, billDisc = null, method, customer, tendered = null, approvalId = null }) {
  const today = todayISO();
  const productLines = lines.filter((l) => l.kind !== "service");
  const serviceLines = lines.filter((l) => l.kind === "service");
  const candidateIds = {};
  for (const l of productLines) {
    const snap = await getDocs(query(collection(db, "batches"), where("productId", "==", l.id)));
    candidateIds[l.id] = snap.docs.map((d) => d.id);
  }

  const saleRef = doc(collection(db, "sales"));
  const journalRef = doc(collection(db, "journal"));
  const counterRef = doc(db, "counters", "main");

  return runTransaction(db, async (tx) => {
    const counter = await tx.get(counterRef);
    const payAcc = await tx.get(doc(db, "accounts", method.account));
    if (payAcc.exists() && !isPostable(payAcc.data())) throw new Error(`The payment account for ${method.label} is ${payAcc.data().status}. Make it active in Chart of accounts first.`);
    const seq = ((counter.exists() && counter.data().sale) || 0) + 1;

    const priced = [];
    const used = {};
    let cogs = 0;
    const productWrites = [];
    const batchWrites = [];

    for (const l of productLines) {
      const pRef = doc(db, "products", l.id);
      const pSnap = await tx.get(pRef);
      if (!pSnap.exists()) throw new Error(`"${l.name}" no longer exists`);
      const p = pSnap.data();
      const u = unitByKey(p, l.unitKey);
      const pieces = toPieces(u, l.qty);
      const available = (Number(p.stock) || 0) - (used[l.id] || 0);
      if (available < pieces) throw new Error(`Only ${available} ${baseName(p)} of ${p.name} left in stock`);
      used[l.id] = (used[l.id] || 0) + pieces;
      if (l.price < u.minPrice - 0.005) throw new Error(`${p.name} can not be sold below ${money(u.minPrice)} per ${u.name}`);

      const batches = [];
      for (const bid of candidateIds[l.id]) {
        const bs = await tx.get(doc(db, "batches", bid));
        if (bs.exists()) batches.push({ id: bid, ...bs.data() });
      }
      const plan = allocateFEFO(batches, pieces);
      let lineCogs = 0;
      for (const step of plan) {
        const b = batches.find((x) => x.id === step.id);
        batchWrites.push({ ref: doc(db, "batches", step.id), remaining: b.remaining - step.take });
        lineCogs += step.take * (Number(b.cost) || 0);
      }
      lineCogs = round2(lineCogs);
      cogs += lineCogs;
      productWrites.push({ ref: pRef, stock: (Number(p.stock) || 0) - pieces });
      priced.push({
        ...l, name: p.name, unit: u.name, size: u.size, pieces,
        listPrice: u.price, price: l.price, vatRate: Number(p.vatRate) || 0, minPrice: u.minPrice,
        disc: l.disc || null, costPrice: Number(p.costPrice) || 0, cogs: lineCogs, kind: "product",
        batches: plan.map((step) => ({ id: step.id, pieces: step.take, cost: Number(batches.find((x) => x.id === step.id)?.cost) || 0 })),
      });
    }

    // Services: fee is revenue, transfer moves through the wallet or operator float.
    const services = serviceLines.map((l) => {
      const fee = round2(l.price * l.qty);
      return {
        kind: "service", serviceType: l.serviceType, provider: l.provider, phone: l.phone || "",
        transfer: round2(l.transfer), name: l.name, unit: "service", size: 1, pieces: 0, qty: 1,
        listPrice: fee, price: fee, vatRate: 0, costPrice: 0, cogs: 0, fee,
      };
    });
    // Float balances are read and checked here, before any write, so a sale can never send more than the float holds.
    const floatBalances = {};
    for (const v of services) {
      const k = floatKey(v.serviceType, v.provider);
      if (!(k in floatBalances)) {
        const fs = await tx.get(doc(db, "floats", k));
        floatBalances[k] = fs.exists() ? Number(fs.data().balance) || 0 : 0;
      }
      floatBalances[k] = applyFloat(v.serviceType, floatBalances[k], v.transfer, v.provider);
      v.floatAfter = floatBalances[k];
      v.floatKey = k;
    }

    const goods = calcTotals(priced, 0, billDisc);
    // Each line's price after its own and the shared bill discount must still reach the lowest price.
    for (const gl of goods.lines) {
      if (gl.kind === "service") continue;
      if (gl.lineNet < gl.minPrice * gl.qty - 0.01) throw new Error(`${gl.name} can not be sold below ${money(gl.minPrice)} per ${gl.unit} after the discount`);
    }
    const storedPct = Math.ceil((goods.effectivePct || 0) * 100) / 100;
    const feesTotal = round2(services.reduce((s, v) => s + v.fee, 0));
    const transfersIn = round2(services.filter((v) => v.serviceType === "cashin" || v.serviceType === "recharge").reduce((s, v) => s + v.transfer, 0));
    const transfersOut = round2(services.filter((v) => v.serviceType === "cashout").reduce((s, v) => s + v.transfer, 0));
    const saleTotal = round2(goods.total + feesTotal);
    const saleNet = round2(goods.net + feesTotal);
    const collect = round2(saleTotal + transfersIn - transfersOut);
    const cogsTotal = round2(cogs);
    const priceExtra = round2(priced.reduce((s, l) => s + Math.max(0, l.price - l.listPrice) * l.qty, 0));
    const invoiceNo = `${settings.invoicePrefix || "INV"}-${String(seq).padStart(6, "0")}`;
    const paid = collect >= 0 ? tendered : null;

    // Goods part of the entry, then each service's own balanced entry, all on the same bill.
    const journalLines = [
      { account: method.account, debit: goods.total },
      { account: ACCOUNTS.SALES, credit: goods.net },
      { account: ACCOUNTS.VAT_PAYABLE, credit: goods.vat },
      { account: ACCOUNTS.COGS, debit: cogsTotal },
      { account: ACCOUNTS.INVENTORY, credit: cogsTotal },
      ...services.flatMap((v) => serviceJournalLines(v.serviceType, v.transfer, v.fee, method.account)),
    ];
    const journal = buildJournal({
      date: today,
      memo: `Sale ${invoiceNo} (${method.label})${services.length ? ` + ${services.length} service${services.length === 1 ? "" : "s"}` : ""}`,
      ref: invoiceNo,
      lines: journalLines,
    });

    const jvNo = await reserveJv(tx);
    tx.set(counterRef, { sale: seq }, { merge: true });
    Object.entries(floatBalances).forEach(([k, b]) => tx.set(doc(db, "floats", k), { balance: b, updatedAt: serverTimestamp() }, { merge: true }));
    productWrites.forEach((w) => tx.update(w.ref, { stock: w.stock, updatedAt: serverTimestamp() }));
    batchWrites.forEach((w) => tx.update(w.ref, { remaining: w.remaining }));
    if (method.credit) tx.update(doc(db, "customers", customer.id), { balance: increment(saleTotal) });
    writeVoucher(tx, journalRef, journal, jvNo, "sale");

    const items = [
      ...goods.lines.map((l) => ({
        productId: l.id, name: l.name, unit: l.unit, unitSize: l.size, qty: l.qty, pieces: l.pieces,
        price: l.price, listPrice: l.listPrice, priceExtra: round2(Math.max(0, l.price - l.listPrice) * l.qty),
        vatRate: l.vatRate, costPrice: l.costPrice, cogs: l.cogs, batches: l.batches || [],
        lineNet: l.lineNet, lineVat: l.lineVat, lineTotal: l.lineTotal, kind: "product",
        gross: l.gross, itemDiscount: l.disc || null, itemDiscountAmount: l.itemDiscount || 0, billDiscountAmount: l.billDiscount || 0, lineDiscount: l.lineDisc || 0,
      })),
      ...services.map((v) => ({
        kind: "service", serviceType: v.serviceType, provider: v.provider, phone: v.phone, transfer: v.transfer,
        name: v.name, unit: "service", qty: 1, pieces: 0, price: v.fee, listPrice: v.fee, priceExtra: 0,
        vatRate: 0, costPrice: 0, cogs: 0, lineNet: v.fee, lineVat: 0, lineTotal: v.fee, productId: null,
        floatKey: v.floatKey, floatAfter: v.floatAfter,
      })),
    ];
    tx.set(saleRef, {
      invoiceNo, date: today,
      customerId: customer?.id || null,
      customerName: customer?.name || "Walk-in",
      items,
      subtotal: goods.subtotal, discount: goods.discount, discountPct: storedPct,
      billDiscount: billDisc ? { name: billDisc.name || "", mode: billDisc.mode, value: Number(billDisc.value) || 0 } : null,
      net: saleNet, vat: goods.vat, total: saleTotal, cogs: cogsTotal, priceExtra,
      serviceFees: feesTotal, serviceCount: services.length, transfersIn, transfersOut, collect,
      payment: method.key, paymentLabel: method.label,
      tendered: paid, change: paid === null ? null : round2(paid - collect),
      cashier: session.name, cashierUid: session.uid, journalId: journalRef.id,
      paymentAccount: method.account, approvalId: approvalId || null,
      createdAt: serverTimestamp(),
    });

    return {
      id: saleRef.id, invoiceNo, jvNo,
      subtotal: goods.subtotal, discount: goods.discount, net: saleNet, vat: goods.vat, total: saleTotal,
      fees: feesTotal, transfersIn, transfersOut, collect, serviceCount: services.length,
      lines: [
        ...goods.lines.map((l) => ({ ...l, service: "" })),
        ...services.map((v) => ({
          name: v.name, qty: 1, unit: "service", price: v.fee, listPrice: v.fee, lineTotal: v.fee,
          service: v.transfer ? `${v.serviceType === "cashout" ? "Cash-out" : v.serviceType === "cashin" ? "Cash-in" : "Recharge"} amount ${v.transfer}${v.phone ? ` · ${v.phone}` : ""}` : "",
        })),
      ],
      paymentLabel: method.label, customerName: customer?.name || "Walk-in", floatBalances,
      tendered: paid, change: paid === null ? null : round2(paid - collect), priceExtra,
    };
  });
}
