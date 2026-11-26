import { onSubmit, onAction, onDelegated } from "../core.js";
import { db, collection, doc, getDocs, query, where, addDoc, updateDoc, runTransaction, serverTimestamp } from "../firebase.js";
import {
  settings, money, esc, icon, toast, openModal, confirmBox, todayISO, daysFromNowISO,
  round2, buildJournal, allocateFEFO, audit, ACCOUNTS,
} from "../core.js";

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
    return {
      ...p,
      nearest: mine[0]?.expiry || "",
      expiredQty: mine.filter((b) => b.expiry < today).reduce((s, b) => s + b.remaining, 0),
      soonQty: mine.filter((b) => b.expiry >= today && b.expiry <= soon).reduce((s, b) => s + b.remaining, 0),
      value: round2(stock * (Number(p.costPrice) || 0)),
      low: active(p) && stock <= (Number(p.reorderLevel) || 0),
    };
  });
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const kpis = [
    ["Products", rows.filter(active).length, "inventory"],
    ["Stock value", money(totalValue), "accounting"],
    ["Low stock", rows.filter((r) => r.low).length, "alert"],
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

    <section class="card">
      <div class="toolbar">
        <div class="search-bar">${icon("search")}<input id="i-search" type="search" placeholder="Search products" /></div>
        <select id="i-filter" aria-label="Filter">
          <option value="all">All products</option>
          <option value="low">Low stock</option>
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
            <th>Product</th><th>SKU</th><th>Category</th><th class="r">Stock</th><th class="r">Reorder</th>
            <th class="r">Cost</th><th class="r">Price</th><th>Next expiry</th><th class="r">Value</th><th></th>
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
      (!q || [r.name, r.sku, r.barcode, r.category].some((v) => String(v || "").toLowerCase().includes(q))) &&
      (f === "all" ||
        (f === "low" && r.low) ||
        (f === "soon" && r.soonQty > 0) ||
        (f === "expired" && r.expiredQty > 0) ||
        (f === "inactive" && !active(r))));
    tbody.innerHTML = list.map((r, i) => `
      <tr class="row-in" style="--i:${Math.min(i, 15)}">
        <td data-label="Product"><strong>${esc(r.name)}</strong>${active(r) ? "" : ` <span class="badge">inactive</span>`}</td>
        <td data-label="SKU">${esc(r.sku || "—")}</td>
        <td data-label="Category">${esc(r.category || "")}</td>
        <td data-label="Stock" class="r"><span class="badge ${r.low ? "warn" : ""}">${r.stock || 0}</span></td>
        <td data-label="Reorder" class="r">${r.reorderLevel || 0}</td>
        <td data-label="Cost" class="r">${money(r.costPrice)}</td>
        <td data-label="Price" class="r">${money(r.salePrice)}</td>
        <td data-label="Next expiry">${r.nearest ? `<span class="badge ${r.expiredQty ? "danger" : r.soonQty ? "warn" : "ok"}">${esc(r.nearest)}</span>` : "—"}</td>
        <td data-label="Value" class="r">${money(r.value)}</td>
        <td class="actions">
          <button class="icon-btn sm" data-adjust="${esc(r.id)}" aria-label="Adjust stock">${icon("sync")}</button>
          <button class="icon-btn sm" data-edit="${esc(r.id)}" aria-label="Edit product">${icon("edit")}</button>
          ${active(r) ? `<button class="icon-btn sm hover-danger" data-off="${esc(r.id)}" aria-label="Deactivate">${icon("trash")}</button>` : `<button class="icon-btn sm" data-on="${esc(r.id)}" aria-label="Reactivate">${icon("check")}</button>`}
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

const active = (p) => p.active !== false;

function productForm(p = {}) {
  const cats = settings.categories.includes(p.category) || !p.category ? settings.categories : [...settings.categories, p.category];
  const units = settings.units.includes(p.unit) || !p.unit ? settings.units : [...settings.units, p.unit];
  return `
    <form id="pf" class="form-grid">
      <label class="span-2">Product name<input name="name" required value="${esc(p.name || "")}" /></label>
      <label>SKU<input name="sku" value="${esc(p.sku || "")}" /></label>
      <label>Barcode<input name="barcode" inputmode="numeric" value="${esc(p.barcode || "")}" /></label>
      <label>Category<select name="category">${cats.map((c) => `<option ${c === p.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <label>Unit<select name="unit">${units.map((u) => `<option ${u === p.unit ? "selected" : ""}>${esc(u)}</option>`).join("")}</select></label>
      <label>Cost price<input name="costPrice" type="number" inputmode="decimal" step="0.01" min="0" required value="${p.costPrice ?? ""}" /></label>
      <label>Sale price<input name="salePrice" type="number" inputmode="decimal" step="0.01" min="0" required value="${p.salePrice ?? ""}" /></label>
      <label>VAT %<input name="vatRate" type="number" inputmode="decimal" step="0.5" min="0" value="${p.vatRate ?? settings.defaultVatRate}" /></label>
      <label>Reorder level<input name="reorderLevel" type="number" inputmode="numeric" min="0" value="${p.reorderLevel ?? settings.defaultReorderLevel}" /></label>
      <div class="form-actions span-2">
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" type="submit">${p.id ? "Save changes" : "Create product"}</button>
      </div>
    </form>`;
}

function openProduct(p, reload) {
  openModal(p ? `Edit ${p.name}` : "New product", productForm(p || {}), (body, close) => {
    body.querySelector("[data-cancel]").addEventListener("click", close);
    onSubmit(body.querySelector("#pf"), async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = String(fd.get("name") || "").trim();
      if (!name) return toast("Product name is required", "error");
      const data = {
        name,
        sku: String(fd.get("sku") || "").trim(),
        barcode: String(fd.get("barcode") || "").trim(),
        category: String(fd.get("category") || "General"),
        unit: String(fd.get("unit") || "Pack"),
        costPrice: round2(Number(fd.get("costPrice")) || 0),
        salePrice: round2(Number(fd.get("salePrice")) || 0),
        vatRate: Number(fd.get("vatRate")) || 0,
        reorderLevel: parseInt(fd.get("reorderLevel"), 10) || 0,
        active: p ? active(p) : true,
        updatedAt: serverTimestamp(),
      };
      try {
        if (p) await updateDoc(doc(db, "products", p.id), data);
        else await addDoc(collection(db, "products"), { ...data, stock: 0, createdAt: serverTimestamp() });
        await audit(p ? "product.update" : "product.create", { name });
        toast("Product saved", "success");
        close();
        reload();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

function openStock({ products, batches, preId, reload }) {
  const opts = products.map((p) => `<option value="${esc(p.id)}" ${p.id === preId ? "selected" : ""}>${esc(p.name)} (stock ${p.stock || 0})</option>`).join("");
  openModal("Stock in / out", `
    <form id="sf" class="form-grid">
      <div class="seg span-2" role="radiogroup">
        <label><input type="radio" name="mode" value="in" checked /><span>Stock in</span></label>
        <label><input type="radio" name="mode" value="out" /><span>Stock out</span></label>
      </div>
      <label class="span-2">Product<select name="productId" required>${opts}</select></label>
      <label>Quantity<input name="qty" type="number" inputmode="numeric" min="1" step="1" required /></label>
      <label class="mode-in">Unit cost<input name="cost" type="number" inputmode="decimal" min="0" step="0.01" /></label>
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
    const sync = () => {
      const out = form.elements.mode.value === "out";
      form.querySelectorAll(".mode-in").forEach((n) => n.classList.toggle("hidden", out));
      form.querySelectorAll(".mode-out").forEach((n) => n.classList.toggle("hidden", !out));
    };
    form.addEventListener("change", sync);
    sync();
    body.querySelector("[data-cancel]").addEventListener("click", close);
    onSubmit(form, async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const mode = fd.get("mode");
      const productId = String(fd.get("productId"));
      const qty = parseInt(fd.get("qty"), 10);
      if (!(qty > 0)) return toast("Quantity must be at least 1", "error");
      try {
        if (mode === "in") {
          const expiry = String(fd.get("expiry") || "");
          if (!expiry) return toast("An expiry date is required", "error");
          await receiveStock({ productId, qty, cost: Number(fd.get("cost")) || 0, expiry, batchNo: String(fd.get("batchNo") || "") });
        } else {
          const ids = batches.filter((b) => b.productId === productId).map((b) => b.id);
          await writeOff({ productId, qty, reason: String(fd.get("reason")), batchIds: ids });
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

async function receiveStock({ productId, qty, cost, expiry, batchNo }) {
  const pRef = doc(db, "products", productId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(pRef);
    if (!snap.exists()) throw new Error("Product not found");
    const p = snap.data();
    const oldStock = Number(p.stock) || 0;
    const oldCost = Number(p.costPrice) || 0;
    const newStock = oldStock + qty;
    const newCost = round2((oldStock * oldCost + qty * cost) / newStock);
    const value = round2(qty * cost);
    tx.update(pRef, { stock: newStock, costPrice: newCost, updatedAt: serverTimestamp() });
    tx.set(doc(collection(db, "batches")), {
      productId, productName: p.name, batchNo: batchNo || "-", expiry, qty, remaining: qty, cost, createdAt: serverTimestamp(),
    });
    if (value > 0) {
      tx.set(doc(collection(db, "journal")), buildJournal({
        memo: `Stock in: ${p.name} x${qty}`,
        ref: `ADJ-${Date.now()}`,
        lines: [{ account: ACCOUNTS.INVENTORY, debit: value }, { account: ACCOUNTS.EQUITY, credit: value }],
      }));
    }
  });
  await audit("stock.in", { productId, qty, expiry });
}

async function writeOff({ productId, qty, reason, batchIds }) {
  const pRef = doc(db, "products", productId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(pRef);
    if (!snap.exists()) throw new Error("Product not found");
    const p = snap.data();
    if ((Number(p.stock) || 0) < qty) throw new Error(`Only ${p.stock || 0} in stock`);
    const batches = [];
    for (const id of batchIds) {
      const bs = await tx.get(doc(db, "batches", id));
      if (bs.exists()) batches.push({ id, ...bs.data() });
    }
    const plan = allocateFEFO(batches, qty, { includeExpired: true });
    let value = 0;
    for (const step of plan) {
      const b = batches.find((x) => x.id === step.id);
      tx.update(doc(db, "batches", step.id), { remaining: b.remaining - step.take });
      value += step.take * (Number(b.cost) || 0);
    }
    value = round2(value);
    tx.update(pRef, { stock: (Number(p.stock) || 0) - qty, updatedAt: serverTimestamp() });
    if (value > 0) {
      tx.set(doc(collection(db, "journal")), buildJournal({
        memo: `Stock out (${reason}): ${p.name} x${qty}`,
        ref: `ADJ-${Date.now()}`,
        lines: [{ account: ACCOUNTS.OTHER_EXPENSE, debit: value }, { account: ACCOUNTS.INVENTORY, credit: value }],
      }));
    }
  });
  await audit("stock.out", { productId, qty, reason });
}
