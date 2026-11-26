import { db, collection, doc, getDoc, getDocs, query, where, runTransaction, serverTimestamp, increment } from "../firebase.js";
import { onAction } from "../core.js";
import {
  session, settings, paymentMethod, money, esc, icon, toast, openModal, todayISO, calcTotals,
  buildJournal, allocateFEFO, audit, round2, ACCOUNTS,
} from "../core.js";

export async function render(el) {
  const [prodSnap, custSnap, batchSnap, shopSnap] = await Promise.all([
    getDocs(collection(db, "products")),
    getDocs(collection(db, "customers")),
    getDocs(query(collection(db, "batches"), where("remaining", ">", 0))),
    getDoc(doc(db, "settings", "general")),
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

  const st = {
    cat: "All", q: "", disc: 0,
    pay: settings.paymentMethods[0]?.key || "cash",
    customerId: "",
    cart: new Map(), // productId -> qty
    holds: [], // parked bills
  };
  const methods = settings.paymentMethods;
  const creditOk = settings.allowCreditSales;

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
        <div class="totals" id="p-totals"></div>
        <div class="form-row">
          <label>Discount %<input id="p-disc" type="number" inputmode="decimal" min="0" max="${settings.maxDiscountPct}" step="0.5" value="0" /></label>
          <label>Paid by
            <select id="p-pay">
              ${methods.filter((m) => !m.credit || creditOk).map((m) => `<option value="${esc(m.key)}">${esc(m.label)}</option>`).join("")}
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
  const cartLines = () => [...st.cart.entries()].map(([id, qty]) => ({
    id, name: byId[id].name, qty, price: Number(byId[id].salePrice) || 0, vatRate: Number(byId[id].vatRate) || 0,
  }));

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
      const out = (p.stock || 0) <= 0;
      const low = !out && (p.stock || 0) <= (p.reorderLevel || 0);
      return `<button class="product-card ${out ? "is-out" : ""}" data-add="${esc(p.id)}" style="--i:${Math.min(i, 20)}" ${out ? "disabled" : ""}>
        <span class="pc-name">${esc(p.name)}</span>
        <span class="pc-sub">${esc(p.sku || p.category || "")}</span>
        <span class="pc-foot"><strong>${money(p.salePrice)}</strong><span class="badge ${out ? "danger" : low ? "warn" : "ok"}">${out ? "Out" : p.stock}</span></span>
        ${nearest[p.id] ? `<span class="pc-exp">Exp ${esc(nearest[p.id])}</span>` : ""}
      </button>`;
    }).join("") || `<div class="empty-state small">${icon("search")}<p>No products match your search.</p></div>`;
  }

  function paintBill() {
    const lines = cartLines();
    const count = lines.reduce((s, l) => s + l.qty, 0);
    $("#p-count").textContent = `${count} item${count === 1 ? "" : "s"}`;
    $("#p-lines").innerHTML = lines.length ? lines.map((l) => `
      <div class="bill-line">
        <div class="bl-info"><strong>${esc(l.name)}</strong><small>${money(l.price)} each</small></div>
        <div class="qty">
          <button class="icon-btn sm" data-dec="${esc(l.id)}" aria-label="Decrease quantity">−</button>
          <span>${l.qty}</span>
          <button class="icon-btn sm" data-inc="${esc(l.id)}" aria-label="Increase quantity">+</button>
        </div>
        <strong class="bl-total">${money(l.price * l.qty)}</strong>
        <button class="icon-btn sm hover-danger" data-rm="${esc(l.id)}" aria-label="Remove item">${icon("x")}</button>
      </div>`).join("") : `<div class="empty-state small">${icon("cart")}<p>Tap a product to add it to the bill.</p></div>`;
    const t = calcTotals(lines, st.disc);
    $("#p-totals").innerHTML = `
      <div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
      <div><span>Discount</span><span>− ${money(t.discount)}</span></div>
      <div><span>VAT</span><span>${money(t.vat)}</span></div>
      <div class="grand"><span>Total</span><span class="count-up">${money(t.total)}</span></div>`;
    $("#p-mobile-total").textContent = `${count} · ${money(t.total)}`;
    const cash = paymentMethod(st.pay).key === "cash";
    $("#p-cashrow").hidden = !cash;
    $("#p-change").hidden = !cash;
    const given = Number($("#p-tender").value);
    if (cash && $("#p-tender").value !== "" && count) {
      const diff = round2(given - t.total);
      $("#p-change").textContent = diff >= 0 ? `Change due: ${money(diff)}` : `Still to collect: ${money(-diff)}`;
      $("#p-change").className = `change-due ${diff >= 0 ? "ok" : "warn"}`;
    } else {
      $("#p-change").textContent = "";
      $("#p-change").className = "change-due";
    }
    $("#p-held-n").textContent = st.holds.length;
  }

  function hold() {
    if (!st.cart.size) return toast("Add products before holding a bill", "error");
    st.holds.push({ cart: new Map(st.cart), disc: st.disc, customerId: st.customerId, pay: st.pay, at: new Date().toLocaleTimeString() });
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
          const lines = [...h.cart.entries()].map(([id, q]) => `${q} × ${esc(byId[id]?.name || "item")}`).join(", ");
          return `<div class="held-row"><div><strong>Held at ${esc(h.at)}</strong><small>${esc(lines)}</small></div>
            <div class="row-actions"><button class="btn primary sm" data-resume="${i}">Resume</button><button class="btn ghost sm hover-danger" data-discard="${i}">Discard</button></div></div>`;
        }).join("")}
      </div>`, (body, close) => {
      body.querySelectorAll("[data-resume]").forEach((b) => b.addEventListener("click", () => {
        const h = st.holds.splice(Number(b.dataset.resume), 1)[0];
        if (st.cart.size) st.holds.push({ cart: new Map(st.cart), disc: st.disc, customerId: st.customerId, pay: st.pay, at: new Date().toLocaleTimeString() });
        st.cart = new Map(h.cart); st.disc = h.disc; st.customerId = h.customerId; st.pay = h.pay;
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

  $("#p-hold").addEventListener("click", hold);
  $("#p-held").addEventListener("click", openHeld);
  $("#p-tender").addEventListener("input", paintBill);
  $("#p-pay").addEventListener("change", () => { st.pay = $("#p-pay").value; paintBill(); });

  // Keyboard: F2 search, F4 charge, F8 hold. Ignored while a dialog is open or this page is gone.
  const onKey = (e) => {
    if (!el.isConnected) return document.removeEventListener("keydown", onKey);
    if (document.getElementById("modal-root")?.children.length) return;
    if (e.key === "F2") { e.preventDefault(); $("#p-search").focus(); }
    else if (e.key === "F4") { e.preventDefault(); charge(); }
    else if (e.key === "F8") { e.preventDefault(); hold(); }
  };
  document.addEventListener("keydown", onKey);

  function flash(id) {
    const c = el.querySelector(`[data-add="${CSS.escape(id)}"]`);
    if (!c) return;
    c.classList.remove("flash");
    void c.offsetWidth;
    c.classList.add("flash");
  }

  function add(id) {
    const p = byId[id];
    if (!p) return;
    const have = st.cart.get(id) || 0;
    if (have + 1 > (Number(p.stock) || 0)) return toast(`Only ${p.stock || 0} of ${p.name} in stock`, "error");
    st.cart.set(id, have + 1);
    paintBill();
    flash(id);
  }

  function change(id, delta) {
    const next = (st.cart.get(id) || 0) + delta;
    if (next <= 0) st.cart.delete(id);
    else if (next > (Number(byId[id].stock) || 0)) return toast("Not enough stock for that quantity", "error");
    else st.cart.set(id, next);
    paintBill();
  }

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
    else { st.cart.delete(t.dataset.rm); paintBill(); }
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
  $("#p-clear").addEventListener("click", () => {
    clearBill();
  });
  onAction($("#p-charge"), charge);
  $("#p-mobile-btn").addEventListener("click", () => {
    $("#p-bill").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  async function charge() {
    if (!st.cart.size) return toast("The bill is empty. Add a product first.", "error");
    const method = paymentMethod(st.pay);
    if (method.credit && !st.customerId) return toast("Choose a customer for an on-account sale", "error");
    const tendered = method.key === "cash" && $("#p-tender").value !== "" ? Number($("#p-tender").value) : null;
    if (tendered !== null && tendered < 0) return toast("Cash received cannot be negative", "error");
    const btn = $("#p-charge");
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const customer = customers.find((c) => c.id === st.customerId) || null;
      const sale = await completeSale({ lines: cartLines(), discountPct: st.disc, method, customer, tendered });
      if (tendered !== null && tendered < sale.total) {
        toast(`Cash received is less than the total. The sale was recorded as ${money(sale.total)}.`, "info");
      }
      await audit("sale", { invoiceNo: sale.invoiceNo, total: sale.total, payment: method.key });
      for (const [id, qty] of st.cart) byId[id].stock = (Number(byId[id].stock) || 0) - qty;
      clearBill();
      paintGrid();
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
      <tr><td>${esc(l.name)}<small>${l.qty} × ${money(l.price)}</small></td><td class="r">${money(l.lineTotal)}</td></tr>`).join("");
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
          <div><span>VAT</span><span>${money(sale.vat)}</span></div>
          <div class="grand"><span>Total</span><span>${money(sale.total)}</span></div>
          <div><span>Paid by</span><span>${esc(sale.paymentLabel)}</span></div>
          ${sale.tendered != null ? `<div><span>Cash received</span><span>${money(sale.tendered)}</span></div><div><span>Change</span><span>${money(Math.max(0, sale.change))}</span></div>` : ""}
        </div>
        <p class="r-foot">${esc(settings.receiptFooter || "")}</p>
      </div>
      <div class="form-actions">
        <button class="btn ghost" type="button" data-print>${icon("print")}<span>Print</span></button>
        <button class="btn primary" type="button" data-done>${icon("check")}<span>New sale</span></button>
      </div>`, (body, close) => {
      body.querySelector("[data-print]").addEventListener("click", () => window.print());
      body.querySelector("[data-done]").addEventListener("click", close);
    });
  }

  paintCats();
  paintGrid();
  paintBill();
}

/* Runs the whole sale atomically: stock (FEFO batches), invoice number, journal, customer balance. */
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
    let cogs = 0;
    const productWrites = [];
    const batchWrites = [];

    for (const l of lines) {
      const pRef = doc(db, "products", l.id);
      const pSnap = await tx.get(pRef);
      if (!pSnap.exists()) throw new Error(`"${l.name}" no longer exists`);
      const p = pSnap.data();
      if ((Number(p.stock) || 0) < l.qty) throw new Error(`Only ${p.stock || 0} of ${p.name} left in stock`);

      const batches = [];
      for (const bid of candidateIds[l.id]) {
        const bs = await tx.get(doc(db, "batches", bid));
        if (bs.exists()) batches.push({ id: bid, ...bs.data() });
      }
      const plan = allocateFEFO(batches, l.qty);
      let lineCogs = 0;
      for (const step of plan) {
        const b = batches.find((x) => x.id === step.id);
        batchWrites.push({ ref: doc(db, "batches", step.id), remaining: b.remaining - step.take });
        lineCogs += step.take * (Number(b.cost) || 0);
      }
      lineCogs = round2(lineCogs);
      cogs += lineCogs;
      productWrites.push({ ref: pRef, stock: p.stock - l.qty });
      priced.push({
        ...l, name: p.name, price: Number(p.salePrice) || 0, vatRate: Number(p.vatRate) || 0,
        costPrice: Number(p.costPrice) || 0, cogs: lineCogs,
      });
    }

    const totals = calcTotals(priced, discountPct);
    const cogsTotal = round2(cogs);
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
        productId: l.id, name: l.name, qty: l.qty, price: l.price, vatRate: l.vatRate,
        costPrice: l.costPrice, cogs: l.cogs, lineNet: l.lineNet, lineVat: l.lineVat, lineTotal: l.lineTotal,
      })),
      subtotal: totals.subtotal, discount: totals.discount, discountPct: Number(discountPct) || 0,
      net: totals.net, vat: totals.vat, total: totals.total, cogs: cogsTotal,
      payment: method.key, paymentLabel: method.label,
      tendered: tendered, change: tendered === null ? null : round2(tendered - totals.total),
      cashier: session.name, cashierUid: session.uid, journalId: journalRef.id,
      createdAt: serverTimestamp(),
    });

    return {
      id: saleRef.id, invoiceNo, ...totals,
      lines: totals.lines, paymentLabel: method.label,
      tendered, change: tendered === null ? null : round2(tendered - totals.total),
    };
  });
}
