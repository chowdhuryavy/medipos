import { db, collection, doc, getDocs, query, where, runTransaction, serverTimestamp, increment } from "../firebase.js";
import { onAction } from "../core.js";
import { printReceipt } from "../print.js";
import {
  session, settings, paymentMethod, money, esc, icon, toast, openModal, alertBox, todayISO, calcTotals,
  buildJournal, allocateFEFO, audit, round2, ACCOUNTS,
} from "../core.js";
import { unitsOf, unitByKey, toPieces, unitOptions, baseName } from "../packs.js";

export async function render(el) {
  const [prodSnap, custSnap, batchSnap] = await Promise.all([
    getDocs(collection(db, "products")),
    getDocs(collection(db, "customers")),
    getDocs(query(collection(db, "batches"), where("remaining", ">", 0))),
  ]);
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
    cat: "All", q: "", disc: 0,
    pay: methods.find((m) => !m.credit)?.key || methods[0]?.key || "cash",
    customerId: "",
    cart: new Map(), // "productId|unitKey" -> { key, id, unitKey, qty (in that unit), price (per unit) }
    holds: [],
  };

  el.innerHTML = `
    <div class="pos">
      <section class="card pos-catalog">
        <div class="search-bar">${icon("search")}<input id="p-search" type="search" inputmode="search" placeholder="Search name or SKU, or scan barcode" autocomplete="off" /></div>
        <div class="chips" id="p-cats" role="tablist"></div>
        <div class="product-grid" id="p-grid"></div>
      </section>

      <aside class="card pos-bill" id="p-bill">
        <header class="card-head"><h3>${icon("cart")} Current bill</h3><span class="badge" id="p-count">0 items</span></header>
        <div class="bill-actions">
          <button class="btn ghost sm" id="p-hold" title="Hold this bill (F8)">${icon("pause")}<span>Hold</span></button>
          <button class="btn ghost sm" id="p-held" title="Resume a held bill">${icon("refresh")}<span>Held <b id="p-held-n">0</b></span></button>
          <span class="kbd-hint">F2 search · F4 charge · F8 hold</span>
        </div>
        <label>Customer
          <select id="p-customer">
            <option value="">Walk-in customer</option>
            ${customers.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`).join("")}
          </select>
        </label>
        <div class="bill-lines" id="p-lines"></div>
        <p class="muted small price-rule">${allowChange
          ? "You can raise a price. It can never go below the lowest price shown."
          : "Prices are fixed by the shop. Ask an administrator to change them."}</p>
        <div class="totals" id="p-totals"></div>
        <div class="form-row">
          <label>Discount %<input id="p-disc" type="number" inputmode="decimal" min="0" max="${settings.maxDiscountPct}" step="0.5" value="0" /></label>
          <label>Paid by
            <select id="p-pay">
              ${methods.filter((m) => !m.credit || creditOk).map((m) => `<option value="${esc(m.key)}" ${m.key === st.pay ? "selected" : ""}>${esc(m.label)}</option>`).join("")}
            </select>
          </label>
        </div>
        <label id="p-cashrow" class="cash-row">Cash received
          <input id="p-tender" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Amount given by customer" />
        </label>
        <div class="change-due" id="p-change" aria-live="polite"></div>
        <button class="btn primary block xl" id="p-charge">${icon("check")}<span>Charge</span></button>
        <button class="btn ghost block" id="p-clear">Clear bill</button>
      </aside>
    </div>
    <div class="mobile-charge" id="p-mobile"><span id="p-mobile-total"></span><button class="btn primary" id="p-mobile-btn">Review & charge</button></div>`;

  const $ = (s) => el.querySelector(s);
  const piecesInCart = (id) => [...st.cart.values()].filter((l) => l.id === id)
    .reduce((s, l) => s + toPieces(unitByKey(byId[id], l.unitKey), l.qty), 0);

  // Full view of a cart line: product, unit and price rules.
  function lineView(l) {
    const p = byId[l.id];
    const u = unitByKey(p, l.unitKey);
    return {
      ...l, name: p.name, unit: u.name, size: u.size, listPrice: u.price, minPrice: u.minPrice,
      vatRate: Number(p.vatRate) || 0, pieces: toPieces(u, l.qty),
    };
  }
  const cartLines = () => [...st.cart.values()].map(lineView);

  function paintCats() {
    const cats = ["All", ...new Set(products.map((p) => p.category || "General"))];
    $("#p-cats").innerHTML = cats.map((c) => `<button class="chip ${c === st.cat ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
  }

  function paintGrid() {
    const q = st.q.trim().toLowerCase();
    const list = products.filter((p) =>
      (st.cat === "All" || (p.category || "General") === st.cat) &&
      (!q || [p.name, p.sku, p.barcode].some((v) => String(v || "").toLowerCase().includes(q))));
    $("#p-grid").innerHTML = list.map((p, i) => {
      const stock = Number(p.stock) || 0;
      const out = stock <= 0;
      const low = !out && stock <= (Number(p.reorderLevel) || 0);
      return `<button class="product-card ${out ? "is-out" : ""}" data-add="${esc(p.id)}" style="--i:${Math.min(i, 20)}" ${out ? "disabled" : ""}>
        <span class="pc-name">${esc(p.name)}</span>
        <span class="pc-sub">${esc(p.sku || p.category || "")}</span>
        <span class="pc-foot"><strong>${money(p.salePrice)}</strong><span class="badge ${out ? "danger" : low ? "warn" : "ok"}">${out ? "Out" : `${stock} ${esc(baseName(p))}`}</span></span>
        ${nearest[p.id] ? `<span class="pc-exp">Exp ${esc(nearest[p.id])}</span>` : ""}
      </button>`;
    }).join("") || `<div class="empty-state small">${icon("search")}<p>No products match your search.</p></div>`;
  }

  const billLine = (l) => {
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
    const count = lines.reduce((s, l) => s + l.qty, 0);
    $("#p-count").textContent = `${count} item${count === 1 ? "" : "s"}`;
    $("#p-lines").innerHTML = lines.length ? lines.map(billLine).join("")
      : `<div class="empty-state small">${icon("cart")}<p>Tap a product to add it to the bill.</p></div>`;
    const t = calcTotals(lines, st.disc);
    const extra = round2(lines.reduce((s, l) => s + Math.max(0, l.price - l.listPrice) * l.qty, 0));
    $("#p-totals").innerHTML = `
      <div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
      <div><span>Discount</span><span>− ${money(t.discount)}</span></div>
      ${extra > 0 ? `<div class="extra-row"><span>Price increase</span><span>+ ${money(extra)}</span></div>` : ""}
      <div><span>VAT</span><span>${money(t.vat)}</span></div>
      <div class="grand"><span>Total</span><span class="count-up">${money(t.total)}</span></div>`;
    $("#p-mobile-total").textContent = `${count} · ${money(t.total)}`;
    const cash = paymentMethod(st.pay).key === "cash";
    $("#p-cashrow").hidden = !cash;
    $("#p-change").hidden = !cash;
    if (cash && $("#p-tender").value !== "" && count) {
      const diff = round2(Number($("#p-tender").value) - t.total);
      $("#p-change").textContent = diff >= 0 ? `Change due: ${money(diff)}` : `Still to collect: ${money(-diff)}`;
      $("#p-change").className = `change-due ${diff >= 0 ? "ok" : "warn"}`;
    } else {
      $("#p-change").textContent = "";
      $("#p-change").className = "change-due";
    }
    $("#p-held-n").textContent = st.holds.length;
  }

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

  function change(key, delta) {
    const l = st.cart.get(key);
    if (!l) return;
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
    if (!l) return;
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
    if (!l) return;
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
    openModal("Held bills", `
      <div class="stack">
        ${st.holds.map((h, i) => {
          const lines = [...h.cart.values()].map((l) => `${l.qty} × ${esc(byId[l.id]?.name || "item")}`).join(", ");
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

  $("#p-cats").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    st.cat = b.dataset.cat;
    paintCats();
    paintGrid();
  });
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
    st.disc = Math.min(settings.maxDiscountPct, Math.max(0, Number(e.target.value) || 0));
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
    if (!st.cart.size) return toast("The bill is empty. Add a product first.", "error");
    const method = paymentMethod(st.pay);
    if (method.credit && !st.customerId) return toast("Choose a customer for an on-account sale", "error");
    const lines = cartLines();
    const low = lines.find((l) => l.price < l.minPrice - 0.005);
    if (low) return toast(`${low.name} can not be sold below ${money(low.minPrice)} per ${low.unit}`, "error");
    const tendered = method.key === "cash" && $("#p-tender").value !== "" ? Number($("#p-tender").value) : null;
    if (tendered !== null && tendered < 0) return toast("Cash received cannot be negative", "error");
    const btn = $("#p-charge");
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const customer = customers.find((c) => c.id === st.customerId) || null;
      const sale = await completeSale({ lines, discountPct: st.disc, method, customer, tendered });
      await audit("sale", { invoiceNo: sale.invoiceNo, total: sale.total, payment: method.key });
      for (const l of lines) byId[l.id].stock = (Number(byId[l.id].stock) || 0) - l.pieces;
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

  function showReceipt(sale) {
    const rows = sale.lines.map((l) => `
      <tr><td>${esc(l.name)}<small>${l.qty} ${esc(l.unit || "")} × ${money(l.price)}${l.price > l.listPrice ? ` (list ${money(l.listPrice)})` : ""}</small></td><td class="r">${money(l.lineTotal)}</td></tr>`).join("");
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
          <div class="grand"><span>Total</span><span>${money(sale.total)}</span></div>
          <div><span>Paid by</span><span>${esc(sale.paymentLabel)}</span></div>
          ${sale.tendered != null ? `<div><span>Cash received</span><span>${money(sale.tendered)}</span></div><div><span>Change</span><span>${money(Math.max(0, sale.change))}</span></div>` : ""}
        </div>
        <p class="r-foot">${esc(settings.receiptFooter || "")}</p>
      </div>
      <div class="form-actions">
        <button class="btn ghost" type="button" data-print-thermal>${icon("print")}<span>Receipt 80mm</span></button>
        <button class="btn ghost" type="button" data-print-a4>${icon("print")}<span>A4 invoice</span></button>
        <button class="btn primary" type="button" data-done>${icon("check")}<span>New sale</span></button>
      </div>`, (body, close) => {
      body.querySelector("[data-print-thermal]").addEventListener("click", () => printReceipt(sale, "thermal"));
      body.querySelector("[data-print-a4]").addEventListener("click", () => printReceipt(sale, "a4"));
      body.querySelector("[data-done]").addEventListener("click", close);
    });
  }

  paintCats();
  paintGrid();
  paintBill();
}

/* Runs the whole sale atomically: stock in pieces (FEFO batches), lowest-price check, invoice number, journal, customer balance. */
async function completeSale({ lines, discountPct, method, customer, tendered = null }) {
  const today = todayISO();
  const candidateIds = {};
  for (const l of lines) {
    const snap = await getDocs(query(collection(db, "batches"), where("productId", "==", l.id)));
    candidateIds[l.id] = snap.docs.map((d) => d.id);
  }

  const saleRef = doc(collection(db, "sales"));
  const journalRef = doc(collection(db, "journal"));
  const counterRef = doc(db, "counters", "main");

  return runTransaction(db, async (tx) => {
    const counter = await tx.get(counterRef);
    const seq = ((counter.exists() && counter.data().sale) || 0) + 1;

    const priced = [];
    const used = {};
    let cogs = 0;
    const productWrites = [];
    const batchWrites = [];

    for (const l of lines) {
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
        costPrice: Number(p.costPrice) || 0, cogs: lineCogs,
      });
    }

    const totals = calcTotals(priced, discountPct);
    const cogsTotal = round2(cogs);
    const priceExtra = round2(priced.reduce((s, l) => s + Math.max(0, l.price - l.listPrice) * l.qty, 0));
    const invoiceNo = `${settings.invoicePrefix || "INV"}-${String(seq).padStart(6, "0")}`;

    const journal = buildJournal({
      date: today,
      memo: `Sale ${invoiceNo} (${method.label})`,
      ref: invoiceNo,
      lines: [
        { account: method.account, debit: totals.total },
        { account: ACCOUNTS.SALES, credit: totals.net },
        { account: ACCOUNTS.VAT_PAYABLE, credit: totals.vat },
        { account: ACCOUNTS.COGS, debit: cogsTotal },
        { account: ACCOUNTS.INVENTORY, credit: cogsTotal },
      ],
    });

    tx.set(counterRef, { sale: seq }, { merge: true });
    productWrites.forEach((w) => tx.update(w.ref, { stock: w.stock, updatedAt: serverTimestamp() }));
    batchWrites.forEach((w) => tx.update(w.ref, { remaining: w.remaining }));
    if (method.credit) tx.update(doc(db, "customers", customer.id), { balance: increment(totals.total) });
    tx.set(journalRef, journal);
    tx.set(saleRef, {
      invoiceNo, date: today,
      customerId: customer?.id || null,
      customerName: customer?.name || "Walk-in",
      items: totals.lines.map((l) => ({
        productId: l.id, name: l.name, unit: l.unit, unitSize: l.size, qty: l.qty, pieces: l.pieces,
        price: l.price, listPrice: l.listPrice, priceExtra: round2(Math.max(0, l.price - l.listPrice) * l.qty),
        vatRate: l.vatRate, costPrice: l.costPrice, cogs: l.cogs,
        lineNet: l.lineNet, lineVat: l.lineVat, lineTotal: l.lineTotal,
      })),
      subtotal: totals.subtotal, discount: totals.discount, discountPct: Number(discountPct) || 0,
      net: totals.net, vat: totals.vat, total: totals.total, cogs: cogsTotal, priceExtra,
      payment: method.key, paymentLabel: method.label,
      tendered: tendered, change: tendered === null ? null : round2(tendered - totals.total),
      cashier: session.name, cashierUid: session.uid, journalId: journalRef.id,
      createdAt: serverTimestamp(),
    });

    return {
      id: saleRef.id, invoiceNo, ...totals,
      lines: totals.lines, paymentLabel: method.label, customerName: customer?.name || "Walk-in",
      tendered, change: tendered === null ? null : round2(tendered - totals.total), priceExtra,
    };
  });
}
