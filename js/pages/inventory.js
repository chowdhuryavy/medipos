import { onSubmit, onAction, onDelegated } from "../core.js";
import { db, collection, doc, getDocs, query, where, addDoc, updateDoc, runTransaction, serverTimestamp } from "../firebase.js";
import {
  settings, money, esc, icon, toast, openModal, confirmBox, alertBox, todayISO, daysFromNowISO,
  round2, buildJournal, allocateFEFO, audit, ACCOUNTS,
} from "../core.js";
import { unitsOf, unitByKey, toPieces, breakdown, locationText, unitOptions, baseName } from "../packs.js";

const DAY = 864e5;
const NEW_DAYS = 7;
const active = (p) => p.active !== false;

export async function render(el) {
  const [pSnap, bSnap] = await Promise.all([
    getDocs(collection(db, "products")),
    getDocs(query(collection(db, "batches"), where("remaining", ">", 0))),
  ]);
  const products = pSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
  const batches = bSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const today = todayISO();
  const soon = daysFromNowISO(settings.expiryWarnDays);

  const rows = products.map((p) => {
    const mine = batches.filter((b) => b.productId === p.id).sort((a, b) => a.expiry.localeCompare(b.expiry));
    const stock = Number(p.stock) || 0;
    const created = p.createdAt?.toMillis ? p.createdAt.toMillis() : 0;
    return {
      ...p,
      nearest: mine[0]?.expiry || "",
      expiredQty: mine.filter((b) => b.expiry < today).reduce((s, b) => s + b.remaining, 0),
      soonQty: mine.filter((b) => b.expiry >= today && b.expiry <= soon).reduce((s, b) => s + b.remaining, 0),
      value: round2(stock * (Number(p.costPrice) || 0)),
      low: active(p) && stock <= (Number(p.reorderLevel) || 0),
      isNew: created > Date.now() - NEW_DAYS * DAY,
    };
  });
  const lowItems = rows.filter((r) => r.low);
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const kpis = [
    ["Products", rows.filter(active).length, "inventory"],
    ["Stock value", money(totalValue), "accounting"],
    ["Low stock", lowItems.length, "alert"],
    [`Expiring ≤ ${settings.expiryWarnDays}d`, rows.filter((r) => r.soonQty > 0).length, "alert"],
    ["Has expired stock", rows.filter((r) => r.expiredQty > 0).length, "alert"],
  ];

  el.innerHTML = `
    <section class="kpi-grid five">
      ${kpis.map(([label, value, ic], i) => `
        <article class="card kpi hover-lift" style="--d:${i * 60}ms">
          <div class="kpi-ico">${icon(ic)}</div>
          <div><small>${esc(label)}</small><strong>${value}</strong></div>
        </article>`).join("")}
    </section>

    ${lowItems.length ? `
    <section class="card low-card">
      <header class="card-head"><h3>${icon("alert")} Low stock: reorder soon</h3><span class="badge warn">${lowItems.length} item${lowItems.length === 1 ? "" : "s"}</span></header>
      <ul class="alert-list">
        ${lowItems.slice(0, 8).map((r) => `<li class="pill warn"><strong>${esc(r.name)}</strong> · ${esc(locationText(r))} · ${esc(breakdown(r, r.stock))} left</li>`).join("")}
      </ul>
      ${lowItems.length > 8 ? `<p class="muted small">Showing 8 of ${lowItems.length}. Use the Low stock filter below to see all.</p>` : ""}
    </section>` : ""}

    <section class="card">
      <div class="toolbar">
        <div class="search-bar">${icon("search")}<input id="i-search" type="search" placeholder="Search name, SKU, barcode, rack or shelf" /></div>
        <select id="i-filter" aria-label="Filter">
          <option value="all">All products</option>
          <option value="low">Low stock</option>
          <option value="new">Added in the last ${NEW_DAYS} days</option>
          <option value="soon">Expiring soon</option>
          <option value="expired">Has expired stock</option>
          <option value="inactive">Inactive</option>
        </select>
        <div class="grow"></div>
        <button class="btn ghost" id="i-stock">${icon("sync")}<span>Stock in / out</span></button>
        <button class="btn primary" id="i-new">${icon("plus")}<span>New product</span></button>
      </div>
      <div class="table-wrap">
        <table class="stack-mobile" id="i-table">
          <thead><tr>
            <th>Product</th><th>Rack &amp; shelf</th><th class="r">Stock</th><th class="r">Reorder</th>
            <th class="r">Cost</th><th class="r">Price</th><th class="r">Lowest</th><th>Next expiry</th><th class="r">Value</th><th></th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>`;

  const tbody = el.querySelector("#i-table tbody");
  const reload = () => render(el);

  function paint() {
    const q = el.querySelector("#i-search").value.trim().toLowerCase();
    const f = el.querySelector("#i-filter").value;
    const list = rows.filter((r) =>
      (!q || [r.name, r.sku, r.barcode, r.category, r.rack, r.shelf].some((v) => String(v || "").toLowerCase().includes(q))) &&
      (f === "all" ||
        (f === "low" && r.low) ||
        (f === "new" && r.isNew) ||
        (f === "soon" && r.soonQty > 0) ||
        (f === "expired" && r.expiredQty > 0) ||
        (f === "inactive" && !active(r))));
    tbody.innerHTML = list.map((r, i) => `
      <tr class="row-in" style="--i:${Math.min(i, 15)}">
        <td data-label="Product">
          <strong>${esc(r.name)}</strong>
          ${r.isNew ? ` <span class="badge ok">New</span>` : ""}
          ${active(r) ? "" : ` <span class="badge">inactive</span>`}
          <small class="muted block">${esc(r.category || "")}${r.sku ? " · " + esc(r.sku) : ""}</small>
        </td>
        <td data-label="Rack & shelf"><span class="loc">${esc(locationText(r))}</span></td>
        <td data-label="Stock" class="r">
          <span class="badge ${r.low ? "warn" : ""}">${r.stock || 0} ${esc(baseName(r))}</span>
          <small class="muted block">${esc(breakdown(r, r.stock))}</small>
        </td>
        <td data-label="Reorder" class="r">${r.reorderLevel || 0}</td>
        <td data-label="Cost" class="r">${money(r.costPrice)}</td>
        <td data-label="Price" class="r">${money(r.salePrice)}${packPrices(r)}</td>
        <td data-label="Lowest" class="r">${money(r.minPrice ?? r.salePrice)}</td>
        <td data-label="Next expiry">${r.nearest ? `<span class="badge ${r.expiredQty ? "danger" : r.soonQty ? "warn" : "ok"}">${esc(r.nearest)}</span>` : "—"}</td>
        <td data-label="Value" class="r">${money(r.value)}</td>
        <td class="actions">
          <button class="icon-btn sm" data-adjust="${esc(r.id)}" aria-label="Adjust stock">${icon("sync")}</button>
          <button class="icon-btn sm" data-edit="${esc(r.id)}" aria-label="Edit product">${icon("edit")}</button>
          ${active(r)
            ? `<button class="icon-btn sm hover-danger" data-off="${esc(r.id)}" aria-label="Deactivate">${icon("trash")}</button>`
            : `<button class="icon-btn sm" data-on="${esc(r.id)}" aria-label="Reactivate">${icon("check")}</button>`}
        </td>
      </tr>`).join("") || `<tr><td colspan="10" class="muted center">No products match. Try another search or filter.</td></tr>`;
  }

  el.querySelector("#i-search").addEventListener("input", paint);
  el.querySelector("#i-filter").addEventListener("change", paint);
  el.querySelector("#i-new").addEventListener("click", () => openProduct(null, reload));
  el.querySelector("#i-stock").addEventListener("click", () => openStock({ products, batches, preId: null, reload }));

  onDelegated(tbody, async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.edit) return openProduct(rows.find((r) => r.id === b.dataset.edit), reload);
    if (b.dataset.adjust) return openStock({ products, batches, preId: b.dataset.adjust, reload });
    if (b.dataset.off || b.dataset.on) {
      const id = b.dataset.off || b.dataset.on;
      const p = rows.find((r) => r.id === id);
      const turnOff = !!b.dataset.off;
      if (turnOff && !(await confirmBox(`Deactivate "${p.name}"? It will be hidden from the sales screen.`))) return;
      await updateDoc(doc(db, "products", id), { active: !turnOff, updatedAt: serverTimestamp() });
      await audit(turnOff ? "product.deactivate" : "product.reactivate", { name: p.name });
      toast(turnOff ? "Product deactivated" : "Product reactivated", "success");
      reload();
    }
  });

  paint();
}

function packPrices(p) {
  return unitsOf(p).filter((u) => !u.base)
    .map((u) => `<small class="muted block">${esc(u.name)} ${money(u.price)}</small>`).join("");
}

/* ───────── product form ───────── */

const PRESETS = { Strip: 10, Box: 100, Carton: 1000 };

function packRow(k = {}) {
  return `
    <div class="pack-row">
      <input data-pk="name" placeholder="Name (Strip, Box…)" value="${esc(k.name || "")}" aria-label="Pack name" />
      <input data-pk="size" type="number" inputmode="numeric" min="2" step="1" placeholder="Pieces" value="${k.size ?? ""}" aria-label="Pieces in this pack" />
      <input data-pk="price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Price" value="${k.price ?? ""}" aria-label="Sale price of this pack" />
      <input data-pk="minPrice" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Lowest" value="${k.minPrice ?? ""}" aria-label="Lowest price of this pack" />
      <button type="button" class="icon-btn sm hover-danger" data-pk-rm aria-label="Remove pack">${icon("x")}</button>
    </div>`;
}

function productForm(p = {}) {
  const cats = settings.categories.includes(p.category) || !p.category ? settings.categories : [...settings.categories, p.category];
  const units = settings.units.includes(p.unit) || !p.unit ? settings.units : [...settings.units, p.unit];
  return `
    <form id="pf" class="form-grid">
      <label class="span-2">Product name<input name="name" required value="${esc(p.name || "")}" /></label>
      <label>SKU<input name="sku" value="${esc(p.sku || "")}" /></label>
      <label>Barcode<input name="barcode" inputmode="numeric" value="${esc(p.barcode || "")}" /></label>
      <label>Category<select name="category">${cats.map((c) => `<option ${c === p.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <label>Smallest unit<select name="unit">${units.map((u) => `<option ${u === p.unit ? "selected" : ""}>${esc(u)}</option>`).join("")}</select></label>
      <label>Rack<input name="rack" placeholder="e.g. A" value="${esc(p.rack || "")}" /></label>
      <label>Shelf<input name="shelf" placeholder="e.g. 3" value="${esc(p.shelf || "")}" /></label>
      <label>Cost per piece<input name="costPrice" type="number" inputmode="decimal" step="0.0001" min="0" required value="${p.costPrice ?? ""}" /></label>
      <label>Sale price per piece<input name="salePrice" type="number" inputmode="decimal" step="0.01" min="0" required value="${p.salePrice ?? ""}" /></label>
      <label>Lowest price per piece<input name="minPrice" type="number" inputmode="decimal" step="0.01" min="0" placeholder="Same as sale price" value="${p.minPrice ?? ""}" /></label>
      <label>VAT %<input name="vatRate" type="number" inputmode="decimal" step="0.5" min="0" value="${p.vatRate ?? settings.defaultVatRate}" /></label>
      <label>Reorder level (pieces)<input name="reorderLevel" type="number" inputmode="numeric" min="0" value="${p.reorderLevel ?? settings.defaultReorderLevel}" /></label>

      <fieldset class="span-2 packs-box">
        <legend>Bigger packs</legend>
        <p class="muted small">Strips, boxes or cartons this product comes in. Enter how many pieces each one holds, and its own prices.</p>
        <div id="pk-rows">${(p.packs || []).map(packRow).join("")}</div>
        <div class="row-actions wrap">
          ${Object.keys(PRESETS).map((n) => `<button type="button" class="btn ghost sm" data-preset="${n}">+ ${n}</button>`).join("")}
          <button type="button" class="btn ghost sm" data-add-pack>+ Custom pack</button>
        </div>
      </fieldset>

      <div class="form-actions span-2">
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" type="submit">${p.id ? "Save changes" : "Create product"}</button>
      </div>
    </form>`;
}

function openProduct(p, reload) {
  openModal(p ? `Edit ${p.name}` : "New product", productForm(p || {}), (body, close) => {
    const form = body.querySelector("#pf");
    const rowsEl = body.querySelector("#pk-rows");
    body.querySelector("[data-cancel]").addEventListener("click", close);
    body.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      rowsEl.insertAdjacentHTML("beforeend", packRow({ name: b.dataset.preset, size: PRESETS[b.dataset.preset] }));
    }));
    body.querySelector("[data-add-pack]").addEventListener("click", () => rowsEl.insertAdjacentHTML("beforeend", packRow({})));
    rowsEl.addEventListener("click", (e) => {
      const rm = e.target.closest("[data-pk-rm]");
      if (rm) rm.closest(".pack-row").remove();
    });

    onSubmit(form, async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get("name") || "").trim();
      if (!name) return toast("Product name is required", "error");

      const salePrice = round2(Number(fd.get("salePrice")) || 0);
      const minRaw = String(fd.get("minPrice") || "").trim();
      const minPrice = minRaw === "" ? salePrice : round2(Number(minRaw) || 0);
      if (minPrice > salePrice) return toast("The lowest price cannot be more than the sale price", "error");

      const packs = [...form.querySelectorAll(".pack-row")].map((row) => {
        const v = (k) => row.querySelector(`[data-pk="${k}"]`).value.trim();
        const price = round2(Number(v("price")) || 0);
        const pMin = v("minPrice") === "" ? price : round2(Number(v("minPrice")) || 0);
        return { name: v("name"), size: Math.round(Number(v("size")) || 0), price, minPrice: pMin };
      }).filter((k) => k.name || k.size || k.price);
      for (const k of packs) {
        if (!k.name || k.size < 2) return toast("Each pack needs a name and at least 2 pieces inside", "error");
        if (!(k.price > 0)) return toast(`Set the sale price for ${k.name}`, "error");
        if (k.minPrice > k.price) return toast(`The lowest price for ${k.name} cannot be more than its price`, "error");
      }

      const data = {
        name,
        sku: String(fd.get("sku") || "").trim(),
        barcode: String(fd.get("barcode") || "").trim(),
        category: String(fd.get("category") || "General"),
        unit: String(fd.get("unit") || "Piece"),
        rack: String(fd.get("rack") || "").trim(),
        shelf: String(fd.get("shelf") || "").trim(),
        costPrice: round4(Number(fd.get("costPrice")) || 0),
        salePrice,
        minPrice,
        packs,
        vatRate: Number(fd.get("vatRate")) || 0,
        reorderLevel: parseInt(fd.get("reorderLevel"), 10) || 0,
        active: p ? active(p) : true,
        updatedAt: serverTimestamp(),
      };
      try {
        if (p) {
          await updateDoc(doc(db, "products", p.id), data);
        } else {
          await addDoc(collection(db, "products"), { ...data, stock: 0, createdAt: serverTimestamp() });
        }
        await audit(p ? "product.update" : "product.create", { name });
        close();
        reload();
        if (p) toast("Product saved", "success");
        else {
          const where = data.rack || data.shelf
            ? `Keep ${name} at ${locationText(data)}.`
            : `Add a rack and shelf for ${name} so staff can find it.`;
          alertBox({ title: "Product added", tone: "success", message: `${name} is saved. ${where} Receive stock from Stock in / out or a purchase.` });
        }
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

const round4 = (v) => Math.round(v * 10000) / 10000;

/* ───────── stock in / out (any unit) ───────── */

function openStock({ products, batches, preId, reload }) {
  const opts = products.map((p) => `<option value="${esc(p.id)}" ${p.id === preId ? "selected" : ""}>${esc(p.name)} (${p.stock || 0} ${esc(baseName(p))} · ${esc(locationText(p))})</option>`).join("");
  openModal("Stock in / out", `
    <form id="sf" class="form-grid">
      <div class="seg span-2" role="radiogroup">
        <label><input type="radio" name="mode" value="in" checked /><span>Stock in</span></label>
        <label><input type="radio" name="mode" value="out" /><span>Stock out</span></label>
      </div>
      <label class="span-2">Product<select name="productId" required>${opts}</select></label>
      <label>Counted in<select name="unit"></select></label>
      <label>Quantity<input name="qty" type="number" inputmode="numeric" min="1" step="1" required /></label>
      <p class="muted small span-2" id="sf-hint"></p>
      <label class="mode-in">Cost per <span id="sf-unit-name">piece</span><input name="cost" type="number" inputmode="decimal" min="0" step="0.01" /></label>
      <label class="mode-in">Expiry date<input name="expiry" type="date" /></label>
      <label class="mode-in span-2">Batch number<input name="batchNo" /></label>
      <label class="mode-out span-2">Reason<select name="reason">${settings.writeOffReasons.map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
      <p class="muted small span-2">Use Purchasing for supplier bills. Stock in here is for opening or found stock.</p>
      <div class="form-actions span-2">
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>`, (body, close) => {
    const form = body.querySelector("#sf");
    const current = () => products.find((p) => p.id === form.elements.productId.value);
    const unitNow = () => unitByKey(current(), form.elements.unit.value);

    const updateHint = () => {
      const p = current();
      const u = unitNow();
      const q = parseInt(form.elements.qty.value, 10) || 0;
      const pieces = toPieces(u, q);
      form.querySelector("#sf-unit-name").textContent = u.base ? baseName(p).toLowerCase() : `${u.name.toLowerCase()} (${u.size} pieces)`;
      form.querySelector("#sf-hint").textContent = q > 0
        ? `That is ${pieces} ${baseName(p)}${pieces === 1 ? "" : "s"}.`
        : "Choose the unit you count in, then enter the quantity.";
    };
    const fillUnits = () => {
      form.elements.unit.innerHTML = unitOptions(current(), "piece");
      updateHint();
    };
    const sync = () => {
      const out = form.elements.mode.value === "out";
      form.querySelectorAll(".mode-in").forEach((n) => n.classList.toggle("hidden", out));
      form.querySelectorAll(".mode-out").forEach((n) => n.classList.toggle("hidden", !out));
    };
    form.elements.productId.addEventListener("change", fillUnits);
    form.elements.unit.addEventListener("change", updateHint);
    form.elements.qty.addEventListener("input", updateHint);
    form.elements.mode.forEach((r) => r.addEventListener("change", sync));
    fillUnits();
    sync();

    body.querySelector("[data-cancel]").addEventListener("click", close);
    onSubmit(form, async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const mode = fd.get("mode");
      const productId = String(fd.get("productId"));
      const p = products.find((x) => x.id === productId);
      const u = unitByKey(p, fd.get("unit"));
      const qty = parseInt(fd.get("qty"), 10);
      if (!(qty > 0)) return toast("Quantity must be at least 1", "error");
      const pieces = toPieces(u, qty);
      try {
        if (mode === "in") {
          const expiry = String(fd.get("expiry") || "");
          if (!expiry) return toast("An expiry date is required", "error");
          const costPerPiece = round4((Number(fd.get("cost")) || 0) / u.size);
          await receiveStock({ productId, pieces, cost: costPerPiece, expiry, batchNo: String(fd.get("batchNo") || "") });
        } else {
          const ids = batches.filter((b) => b.productId === productId).map((b) => b.id);
          await writeOff({ productId, pieces, reason: String(fd.get("reason")), batchIds: ids });
        }
        toast("Stock updated", "success");
        close();
        reload();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

// Stock is always stored in pieces. Cost is per piece.
async function receiveStock({ productId, pieces, cost, expiry, batchNo }) {
  const pRef = doc(db, "products", productId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(pRef);
    if (!snap.exists()) throw new Error("Product not found");
    const p = snap.data();
    const oldStock = Number(p.stock) || 0;
    const oldCost = Number(p.costPrice) || 0;
    const newStock = oldStock + pieces;
    const newCost = round4((oldStock * oldCost + pieces * cost) / newStock);
    const value = round2(pieces * cost);
    tx.update(pRef, { stock: newStock, costPrice: newCost, updatedAt: serverTimestamp() });
    tx.set(doc(collection(db, "batches")), {
      productId, productName: p.name, batchNo: batchNo || "-", expiry, qty: pieces, remaining: pieces, cost, createdAt: serverTimestamp(),
    });
    if (value > 0) {
      tx.set(doc(collection(db, "journal")), buildJournal({
        memo: `Stock in: ${p.name} x${pieces} ${baseName(p)}`,
        ref: `ADJ-${Date.now()}`,
        lines: [{ account: ACCOUNTS.INVENTORY, debit: value }, { account: ACCOUNTS.EQUITY, credit: value }],
      }));
    }
  });
  await audit("stock.in", { productId, pieces, expiry });
}

async function writeOff({ productId, pieces, reason, batchIds }) {
  const pRef = doc(db, "products", productId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(pRef);
    if (!snap.exists()) throw new Error("Product not found");
    const p = snap.data();
    if ((Number(p.stock) || 0) < pieces) throw new Error(`Only ${p.stock || 0} ${baseName(p)} in stock`);
    const batches = [];
    for (const id of batchIds) {
      const bs = await tx.get(doc(db, "batches", id));
      if (bs.exists()) batches.push({ id, ...bs.data() });
    }
    const plan = allocateFEFO(batches, pieces, { includeExpired: true });
    let value = 0;
    for (const step of plan) {
      const b = batches.find((x) => x.id === step.id);
      tx.update(doc(db, "batches", step.id), { remaining: b.remaining - step.take });
      value += step.take * (Number(b.cost) || 0);
    }
    value = round2(value);
    tx.update(pRef, { stock: (Number(p.stock) || 0) - pieces, updatedAt: serverTimestamp() });
    if (value > 0) {
      tx.set(doc(collection(db, "journal")), buildJournal({
        memo: `Stock out (${reason}): ${p.name} x${pieces} ${baseName(p)}`,
        ref: `ADJ-${Date.now()}`,
        lines: [{ account: ACCOUNTS.OTHER_EXPENSE, debit: value }, { account: ACCOUNTS.INVENTORY, credit: value }],
      }));
    }
  });
  await audit("stock.out", { productId, pieces, reason });
}
