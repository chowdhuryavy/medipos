import { reserveJv, writeVoucher, postWithVoucher } from "../journal.js";
import { db, collection, doc, getDocs, query, where, orderBy, limit, runTransaction, serverTimestamp, increment } from "../firebase.js";
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

export async function render(el) {
  const [prodSnap, custSnap, batchSnap, floatSnap, shiftSnap] = await Promise.all([
    getDocs(collection(db, "products")),
    getDocs(collection(db, "customers")),
    getDocs(query(collection(db, "batches"), where("remaining", ">", 0))),
    getDocs(collection(db, "floats")).catch(() => ({ docs: [] })),
    getDocs(query(collection(db, "shifts"), orderBy("openedAt", "desc"), limit(1))).catch(() => ({ docs: [] })),
  ]);
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
    cat: "All", sub: "", tab: "1", q: "", disc: 0,
    pay: methods.find((m) => !m.credit)?.key || methods[0]?.key || "cash",
    customerId: "",
    cart: new Map(), // product lines: "productId|unitKey"; service lines: "svc|n"
    holds: [],
    svcSeq: 0,
  };

  el.innerHTML = `
    <div class="pos">
      <header class="pos-strip">
        <div class="strip-item">${icon("pos")}<span><b>Sale</b> · ${esc(session.name || "")}</span></div>
        <div class="strip-item muted">${esc(todayISO())}</div>
        <div class="strip-item muted">${icon("search")}<span>F2 search · F4 charge · F8 hold</span></div>
        <div class="strip-item strip-clock clock-live" id="strip-clock" title="Shop time"></div>
      </header>
      <section class="card pos-catalog">
        <div class="search-bar">${icon("search")}<input id="p-search" type="search" inputmode="search" placeholder="Search name or SKU, or scan barcode" autocomplete="off" /><button type="button" class="btn ghost sm scan-btn" data-scan-into="#p-search" data-scan-enter>Scan</button></div>
        ${settings.posServiceButtons ? `<div class="service-bar" role="group" aria-label="Services">
          <button class="svc-btn" data-svc="recharge">${icon("plus")}<span>Mobile recharge</span></button>
          <button class="svc-btn" data-svc="cashin">${icon("plus")}<span>Wallet cash-in</span></button>
          <button class="svc-btn" data-svc="cashout">${icon("plus")}<span>Wallet cash-out</span></button>
        </div>` : ""}
        <div class="chips" id="p-cats" role="tablist"></div>
        <div class="chips sub-chips" id="p-subs" aria-label="Sub-groups"></div>
        <div class="product-grid" id="p-grid"></div>
      </section>

      <aside class="card pos-bill" id="p-bill">
        <header class="card-head"><h3>${icon("cart")} Current bill</h3><span class="badge" id="p-count">0 items</span></header>
        <p class="bill-meta muted small">${esc(session.name || "")} · ${esc(todayISO())}</p>
        <div class="bill-actions">
          <button class="btn ghost sm" id="p-hold" title="Hold this bill (F8)">${icon("pause")}<span>Hold</span></button>
          <button class="btn ghost sm" id="p-held" title="Resume a held bill">${icon("refresh")}<span>Held <b id="p-held-n">0</b></span></button>
          <button class="btn ghost sm" id="p-clear" title="Empty this bill">${icon("x")}<span>Clear</span></button>
          <span class="kbd-hint">F2 search · F4 charge · F8 hold</span>
        </div>
        <label>Customer
          <select id="p-customer">
            <option value="">Walk-in customer</option>
            ${customers.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`).join("")}
          </select>
        </label>
        ${openShift ? "" : `<div class="shift-note" role="alert">No cash shift is open. <a href="#/shift">Open a shift</a> before you take payment.</div>`}
        <div class="bill-lines" id="p-lines"></div>
        <p class="muted small price-rule">${allowChange
          ? "You can raise a price. It can never go below the lowest price shown. Service fees can be changed."
          : "Prices are fixed by the shop. Ask an administrator to change them."}</p>
        <div class="totals" id="p-totals"></div>
        <div class="form-row" id="p-payrow">
          <label>Discount %<input id="p-disc" type="number" inputmode="decimal" min="0" max="100" step="0.5" value="0" /></label>
          <div class="pay-field">
            <span class="field-label">Paid by</span>
            <div class="pay-seg" id="p-paychips" role="radiogroup" aria-label="Paid by"></div>
            <select id="p-pay" hidden>
              ${methods.filter((m) => !m.credit || creditOk).map((m) => `<option value="${esc(m.key)}" ${m.key === st.pay ? "selected" : ""}>${esc(m.label)}</option>`).join("")}
            </select>
          </div>
        </div>
        <label id="p-cashrow" class="cash-row">Cash received
          <input id="p-tender" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Amount given by customer" />
        </label>
        <div class="quick-cash" id="p-quick" hidden></div>
        <div class="change-due" id="p-change" aria-live="polite"></div>
        <button class="btn primary block xl" id="p-charge">${icon("check")}<span>Charge</span></button>
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
    const goods = calcTotals(lines.filter((l) => !isService(l)), st.disc);
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

  function paintCats() {
    if (tabsOn()) {
      $("#p-cats").innerHTML = [1, 2].map((n) => `<button class="chip ${String(n) === st.tab ? "active" : ""}" data-tab="${n}">${esc(tabLabel(n))}</button>`).join("");
      return;
    }
    const cats = ["All", ...new Set(products.map((p) => p.category || "General"))];
    $("#p-cats").innerHTML = cats.map((c) => `<button class="chip ${c === st.cat ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
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

  function paintGrid() {
    paintSubs();
    const q = st.q.trim().toLowerCase();
    const list = products.filter((p) =>
      (tabsOn() ? inTab(p, Number(st.tab)) : (st.cat === "All" || (p.category || "General") === st.cat)) &&
      (!st.sub || p.subGroup === st.sub) &&
      (!q || [p.name, p.sku, p.barcode].some((v) => String(v || "").toLowerCase().includes(q))));
    $("#p-grid").innerHTML = list.map((p, i) => {
      const stock = Number(p.stock) || 0;
      const out = stock <= 0;
      const low = !out && stock <= (Number(p.reorderLevel) || 0);
      const inBill = piecesInCart(p.id);
      return `<button class="product-card ${out ? "is-out" : ""} ${inBill ? "in-bill" : ""}" data-add="${esc(p.id)}" style="--i:${Math.min(i, 20)}" ${out ? "disabled" : ""}>
        ${inBill ? `<span class="pc-incart" aria-label="${inBill} in bill">${inBill}</span>` : ""}
        <span class="pc-name">${esc(p.name)}</span>
        <span class="pc-sub">${esc([p.category || "General", p.subGroup].filter(Boolean).join(" › "))}</span>
        <span class="pc-foot"><strong>${money(p.salePrice)}</strong><span class="badge ${out ? "danger" : low ? "warn" : "ok"}">${out ? "Out" : `${stock} ${esc(baseName(p))}`}</span></span>
        ${nearest[p.id] ? `<span class="pc-exp">Exp ${esc(nearest[p.id])}</span>` : ""}
      </button>`;
    }).join("") || `<div class="empty-state small">${icon("search")}<p>No products match your search.</p>${can("inventory") ? `<a class="btn primary sm" href="#/inventory">${icon("plus")}<span>Add a new product</span></a>` : ""}</div>`;
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

  const billLine = (l) => {
    if (isService(l)) return serviceBillLine(l);
    const p = byId[l.id];
    const extra = round2(l.price - l.listPrice);
    return `
      <div class="bill-line">
        <div class="bl-info">
          <strong>${esc(l.name)}</strong>
          <select class="unit-pick" data-unit="${esc(l.key)}" aria-label="Unit for ${esc(l.name)}">${unitOptions(p, l.unitKey)}</select>
          <small>List ${money(l.listPrice)} · lowest ${money(l.minPrice)}${extra > 0 ? ` · <b class="extra">+${money(extra)} extra</b>` : ""}</small>
        </div>
        <div class="qty">
          <button class="icon-btn sm" data-dec="${esc(l.key)}" aria-label="Decrease quantity">−</button>
          <span>${l.qty}</span>
          <button class="icon-btn sm" data-inc="${esc(l.key)}" aria-label="Increase quantity">+</button>
        </div>
        <label class="bl-price">Price
          <input type="number" inputmode="decimal" step="0.01" min="${l.minPrice}" value="${l.price}" data-price="${esc(l.key)}" ${allowChange ? "" : "readonly"} aria-label="Unit price" />
        </label>
        <strong class="bl-total">${money(l.price * l.qty)}</strong>
        <button class="icon-btn sm hover-danger" data-rm="${esc(l.key)}" aria-label="Remove item">${icon("x")}</button>
      </div>`;
  };

  function paintBill() {
    const lines = cartLines();
    const count = lines.reduce((s, l) => s + (isService(l) ? 1 : l.qty), 0);
    $("#p-count").textContent = `${count} item${count === 1 ? "" : "s"}`;
    $("#p-lines").innerHTML = lines.length ? lines.map(billLine).join("")
      : `<div class="empty-state small">${icon("cart")}<p>Tap a product, or a service above, to add it to the bill.</p></div>`;
    const t = billTotals(lines);
    const extra = round2(lines.filter((l) => !isService(l)).reduce((s, l) => s + Math.max(0, l.price - l.listPrice) * l.qty, 0));
    $("#p-totals").innerHTML = `
      <div><span>Subtotal</span><span>${money(t.goods.subtotal)}</span></div>
      <div><span>Discount</span><span>− ${money(t.goods.discount)}</span></div>
      ${extra > 0 ? `<div class="extra-row"><span>Price increase</span><span>+ ${money(extra)}</span></div>` : ""}
      <div><span>VAT</span><span>${money(t.goods.vat)}</span></div>
      ${t.fees > 0 ? `<div><span>Service fees</span><span>+ ${money(t.fees)}</span></div>` : ""}
      <div class="grand"><span>Total sale</span><span class="count-up">${money(t.saleTotal)}</span></div>
      ${t.transfersIn ? `<div><span>Sent to wallets / operators</span><span>+ ${money(t.transfersIn)}</span></div>` : ""}
      ${t.transfersOut ? `<div><span>Cash-out paid to customer</span><span>− ${money(t.transfersOut)}</span></div>` : ""}
      ${t.transfersIn || t.transfersOut ? `<div class="grand"><span>${t.collect >= 0 ? "To collect" : "To pay customer"}</span><span>${money(Math.abs(t.collect))}</span></div>` : ""}`;
    // Discount, payment, Charge and Clear appear only once the bill has something in it.
    const hasItems = lines.length > 0;
    $("#p-payrow").hidden = !hasItems;
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
    $("#p-held-n").textContent = st.holds.length;

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
    st.cart.delete(key);
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

  function hold() {
    if (!st.cart.size) return toast("Add products before holding a bill", "error");
    st.holds.push({ cart: cloneCart(st.cart), disc: st.disc, customerId: st.customerId, pay: st.pay, at: new Date().toLocaleTimeString() });
    clearBill();
    toast(`Bill held (${st.holds.length} on hold)`, "success");
  }

  function clearBill() {
    st.cart.clear(); st.disc = 0; st.customerId = ""; $("#p-disc").value = 0; $("#p-customer").value = ""; $("#p-tender").value = "";
    paintBill();
  }

  function openHeld() {
    if (!st.holds.length) return toast("No bills are on hold", "info");
    const nameOf = (l) => (isService(l) ? l.name : byId[l.id]?.name || "item");
    openModal("Held bills", `
      <div class="stack">
        ${st.holds.map((h, i) => {
          const lines = [...h.cart.values()].map((l) => `${isService(l) ? "" : l.qty + " × "}${esc(nameOf(l))}`).join(", ");
          return `<div class="held-row"><div><strong>Held at ${esc(h.at)}</strong><small>${lines}</small></div>
            <div class="row-actions"><button class="btn primary sm" data-resume="${i}">Resume</button><button class="btn ghost sm hover-danger" data-discard="${i}">Discard</button></div></div>`;
        }).join("")}
      </div>`, (body, close) => {
      body.querySelectorAll("[data-resume]").forEach((b) => b.addEventListener("click", () => {
        const h = st.holds.splice(Number(b.dataset.resume), 1)[0];
        if (st.cart.size) st.holds.push({ cart: cloneCart(st.cart), disc: st.disc, customerId: st.customerId, pay: st.pay, at: new Date().toLocaleTimeString() });
        st.cart = cloneCart(h.cart); st.disc = h.disc; st.customerId = h.customerId; st.pay = h.pay;
        $("#p-disc").value = st.disc; $("#p-customer").value = st.customerId; $("#p-pay").value = st.pay;
        paintBill(); close();
      }));
      body.querySelectorAll("[data-discard]").forEach((b) => b.addEventListener("click", () => {
        st.holds.splice(Number(b.dataset.discard), 1);
        paintBill(); close();
        toast("Held bill discarded", "info");
      }));
    });
  }

  // Held bills must not share line objects with the live cart.
  const cloneCart = (m) => new Map([...m].map(([k, v]) => [k, { ...v }]));

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
    const t = e.target.closest("[data-inc],[data-dec],[data-rm]");
    if (!t) return;
    if (t.dataset.inc) change(t.dataset.inc, 1);
    else if (t.dataset.dec) change(t.dataset.dec, -1);
    else removeLine(t.dataset.rm);
  });
  $("#p-lines").addEventListener("change", (e) => {
    const t = e.target;
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
  $("#p-customer").addEventListener("change", (e) => { st.customerId = e.target.value; });
  $("#p-disc").addEventListener("input", (e) => {
    st.disc = Math.min(100, Math.max(0, Number(e.target.value) || 0));
    paintBill();
  });
  $("#p-pay").addEventListener("change", () => { st.pay = $("#p-pay").value; paintBill(); });
  $("#p-tender").addEventListener("input", paintBill);
  $("#p-hold").addEventListener("click", hold);
  $("#p-held").addEventListener("click", openHeld);
  $("#p-clear").addEventListener("click", clearBill);
  onAction($("#p-charge"), charge);
  $("#p-mobile-btn").addEventListener("click", () => {
    $("#p-bill").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // Keyboard: F2 search, F4 charge, F8 hold. Ignored while a dialog is open or this page is gone.
  const onKey = (e) => {
    if (!el.isConnected) return document.removeEventListener("keydown", onKey);
    if (document.getElementById("modal-root")?.children.length) return;
    if (e.key === "F2") { e.preventDefault(); $("#p-search").focus(); }
    else if (e.key === "F4") { e.preventDefault(); charge(); }
    else if (e.key === "F8") { e.preventDefault(); hold(); }
  };
  document.addEventListener("keydown", onKey);

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
    // A discount above the cashier limit needs an administrator to approve it first.
    let approvalId = null;
    if (st.disc > settings.maxDiscountPct) {
      try { approvalId = await askDiscountApproval(st.disc); } catch (err) { return toast(err.message, "error"); }
    }
    const btn = $("#p-charge");
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const customer = customers.find((c) => c.id === st.customerId) || null;
      const sale = await postWithVoucher(() => completeSale({ lines, discountPct: st.disc, method, customer, tendered, approvalId }), (r) => r.jvNo);
      await audit("sale", { invoiceNo: sale.invoiceNo, total: sale.total, payment: method.key, services: sale.serviceCount });
      for (const l of lines) if (!isService(l)) byId[l.id].stock = (Number(byId[l.id].stock) || 0) - l.pieces;
      Object.assign(floats, sale.floatBalances || {});
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
      form.addEventListener("submit", async (e) => {
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
async function completeSale({ lines, discountPct, method, customer, tendered = null, approvalId = null }) {
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
        listPrice: u.price, price: l.price, vatRate: Number(p.vatRate) || 0,
        costPrice: Number(p.costPrice) || 0, cogs: lineCogs, kind: "product",
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

    const goods = calcTotals(priced, discountPct);
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
      subtotal: goods.subtotal, discount: goods.discount, discountPct: Number(discountPct) || 0,
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
