import { onSubmit, onAction, canWrite } from "../core.js";
import { unitsOf, unitByKey, toPieces, unitOptions } from "../packs.js";
import { db, collection, doc, getDocs, query, orderBy, limit, runTransaction, serverTimestamp, increment } from "../firebase.js";
import { productDatalist, findProduct, displayName } from "../picker.js";
import {
  session, settings, money, esc, icon, toast, todayISO, round2, buildJournal, audit,
  ACCOUNTS, PURCHASE_PAYMENT_ACCOUNT, fmtDateTime,
} from "../core.js";


export async function render(el) {
  const canPost = canWrite("purchasing");
  const [pSnap, sSnap] = await Promise.all([getDocs(collection(db, "products")), getDocs(collection(db, "suppliers"))]);
  const products = pSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  const suppliers = sSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));

  el.innerHTML = `
    <div class="tabs" role="tablist">
      ${canPost ? `<button class="tab active" data-tab="new">New purchase</button>` : ""}
      <button class="tab ${canPost ? "" : "active"}" data-tab="hist">History</button>
    </div>
    ${canPost ? `
    ${productDatalist(products, "pur-products")}
    <section class="card" id="pur-new">
      <form id="pur-form" class="form-grid">
        <label>Supplier
          <select name="supplierId" required>
            <option value="">Choose a supplier…</option>
            ${suppliers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}
          </select>
        </label>
        <label>Supplier invoice no.<input name="invoiceNo" placeholder="Optional" /></label>
        <label>Date<input name="date" type="date" value="${todayISO()}" required /></label>
        <label>Payment
          <select name="payment">
            <option value="credit">On credit (pay later)</option>
            <option value="bank">Bank transfer</option>
            <option value="cash">Cash</option>
          </select>
        </label>
      </form>

      <div class="lines-head"><h3>Items</h3><button class="btn ghost sm" id="pur-add" type="button">${icon("plus")}<span>Add item</span></button></div>
      <div class="table-wrap">
        <table class="lines-table stack-mobile">
          <thead><tr><th>Product</th><th class="r">Qty</th><th class="r">Unit cost</th><th>Batch no.</th><th>Expiry</th><th class="r">Line total</th><th></th></tr></thead>
          <tbody id="pur-lines"></tbody>
        </table>
      </div>
      <div class="totals-box">
        <div><span>Net</span><strong id="pur-net">—</strong></div>
        <div><span>VAT (input)</span><strong id="pur-vat">—</strong></div>
        <div class="grand"><span>Total</span><strong id="pur-total">—</strong></div>
      </div>
      <div class="form-actions"><button class="btn primary" id="pur-save" type="button">${icon("check")}<span>Post purchase</span></button></div>
    </section>` : ""}

    <section class="card ${canPost ? "hidden" : ""}" id="pur-hist"></section>`;

  el.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    el.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    el.querySelector("#pur-new")?.classList.toggle("hidden", t.dataset.tab !== "new");
    el.querySelector("#pur-hist").classList.toggle("hidden", t.dataset.tab !== "hist");
    if (t.dataset.tab === "hist") loadHistory(el);
  }));

  if (!canPost) return loadHistory(el);

  const tbody = el.querySelector("#pur-lines");
  const lines = [{ productId: "", unit: "piece", qty: 1, cost: 0, batchNo: "", expiry: "" }];

  const rowHtml = (l, i) => { const p0 = products.find((x) => x.id === l.productId); return `
    <tr class="row-in">
      <td data-label="Product"><input data-i="${i}" data-f="productName" list="pur-products" autocomplete="off" value="${esc(p0 ? displayName(p0) : (l.productName || ""))}" placeholder="Type name, SKU or barcode…" />
        <small class="muted block">${p0 ? `SOH ${p0.stock || 0} ${esc(p0.unit || "Piece")}` : "Search and choose from the list"}</small></td>
      <td data-label="Unit"><select data-i="${i}" data-f="unit">${unitOptions(products.find((x) => x.id === l.productId), l.unit || "piece")}</select></td>
      <td data-label="Qty" class="r"><input type="number" inputmode="numeric" min="1" step="1" data-i="${i}" data-f="qty" value="${l.qty}" /></td>
      <td data-label="Unit cost" class="r"><input type="number" inputmode="decimal" min="0" step="0.01" data-i="${i}" data-f="cost" value="${l.cost}" /></td>
      <td data-label="Batch"><input data-i="${i}" data-f="batchNo" value="${esc(l.batchNo)}" /></td>
      <td data-label="Expiry"><input type="date" data-i="${i}" data-f="expiry" value="${esc(l.expiry)}" /></td>
      <td data-label="Line total" class="r" data-lt="${i}">${money(l.qty * l.cost)}</td>
      <td><button class="icon-btn sm hover-danger" type="button" data-rm="${i}" aria-label="Remove line">${icon("x")}</button></td>
    </tr>`; };

  function totals() {
    let net = 0, vat = 0;
    lines.forEach((l, i) => {
      const p = products.find((x) => x.id === l.productId);
      const lt = round2((Number(l.qty) || 0) * (Number(l.cost) || 0));
      net += lt;
      vat += round2(lt * ((p && p.vatRate) || 0) / 100);
      const cell = tbody.querySelector(`[data-lt="${i}"]`);
      if (cell) cell.textContent = money(lt);
    });
    net = round2(net); vat = round2(vat);
    el.querySelector("#pur-net").textContent = money(net);
    el.querySelector("#pur-vat").textContent = money(vat);
    el.querySelector("#pur-total").textContent = money(net + vat);
  }

  const paintLines = () => { tbody.innerHTML = lines.map(rowHtml).join(""); totals(); };

  tbody.addEventListener("input", (e) => {
    const t = e.target;
    if (!t.dataset.f || ["productName", "unit"].includes(t.dataset.f)) return;
    const i = Number(t.dataset.i);
    lines[i][t.dataset.f] = ["qty", "cost"].includes(t.dataset.f) ? Number(t.value) || 0 : t.value;
    totals();
  });
  tbody.addEventListener("change", (e) => {
    const t = e.target;
    const i = Number(t.dataset.i);
    if (t.dataset.f === "unit") { lines[i].unit = t.value; return paintLines(); }
    if (t.dataset.f !== "productName") return;
    const p = findProduct(products, t.value);
    lines[i].productId = p ? p.id : "";
    lines[i].productName = t.value;
    if (p) {
      lines[i].unit = "piece";
      // Cost is shown per piece to start; the buyer changes the unit if the bill is per pack.
      lines[i].cost = Number(p.costPrice) || 0;
    } else if (t.value.trim()) {
      toast("Choose a product from the list. Type to search.", "error");
    }
    paintLines();
  });
  tbody.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    lines.splice(Number(b.dataset.rm), 1);
    if (!lines.length) lines.push({ productId: "", unit: "piece", qty: 1, cost: 0, batchNo: "", expiry: "" });
    paintLines();
  });
  el.querySelector("#pur-add").addEventListener("click", () => {
    lines.push({ productId: "", unit: "piece", qty: 1, cost: 0, batchNo: "", expiry: "" });
    paintLines();
  });

  onAction(el.querySelector("#pur-save"), async () => {
    const btn = el.querySelector("#pur-save");
    const form = new FormData(el.querySelector("#pur-form"));
    const supplier = suppliers.find((s) => s.id === form.get("supplierId"));
    const payment = String(form.get("payment"));
    const date = String(form.get("date") || todayISO());
    const valid = lines.filter((l) => l.productId && l.qty > 0);
    if (!supplier) return toast("Choose a supplier first", "error");
    if (!valid.length) return toast("Add at least one item", "error");
    if (valid.some((l) => !l.expiry)) return toast("Every item needs an expiry date", "error");
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const res = await postPurchase({
        supplier, invoiceNo: String(form.get("invoiceNo") || ""), date, payment, lines: valid,
      });
      await audit("purchase", { purNo: res.purNo, total: res.total });
      toast(`Purchase ${res.purNo} posted`, "success");
      render(el);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  });

  paintLines();
}

async function loadHistory(el) {
  const host = el.querySelector("#pur-hist");
  host.innerHTML = `<div class="skeleton"></div>`;
  const snap = await getDocs(query(collection(db, "purchases"), orderBy("createdAt", "desc"), limit(50)));
  host.innerHTML = `
    <div class="table-wrap"><table class="stack-mobile">
      <thead><tr><th>No.</th><th>Supplier</th><th>Supplier invoice</th><th>Payment</th><th class="r">Total</th><th>Posted</th></tr></thead>
      <tbody>
        ${snap.docs.map((d) => { const p = d.data(); return `<tr>
          <td data-label="No.">${esc(p.purNo)}</td>
          <td data-label="Supplier">${esc(p.supplierName)}</td>
          <td data-label="Supplier invoice">${esc(p.supplierInvoice || "—")}</td>
          <td data-label="Payment"><span class="badge">${esc(p.payment)}</span></td>
          <td data-label="Total" class="r">${money(p.total)}</td>
          <td data-label="Posted">${fmtDateTime(p.createdAt)}</td></tr>`; }).join("")
          || `<tr><td colspan="6" class="muted center">No purchases yet</td></tr>`}
      </tbody>
    </table></div>`;
}

// One transaction: batches created, weighted-average cost updated, journal posted, supplier balance updated.
async function postPurchase({ supplier, invoiceNo, date, payment, lines }) {
  const counterRef = doc(db, "counters", "main");
  const purRef = doc(collection(db, "purchases"));
  const supplierRef = doc(db, "suppliers", supplier.id);

  return runTransaction(db, async (tx) => {
    const counter = await tx.get(counterRef);
    const seq = ((counter.exists() && counter.data().purchase) || 0) + 1;
    const purNo = `${settings.purchasePrefix || "PUR"}-${String(seq).padStart(6, "0")}`;

    const writes = [];
    const items = [];
    let net = 0, vat = 0;

    for (const l of lines) {
      const pRef = doc(db, "products", l.productId);
      const ps = await tx.get(pRef);
      if (!ps.exists()) throw new Error("A product in this purchase no longer exists");
      const p = ps.data();
      // Quantity and cost are in the unit the buyer chose (box, strip…). Stock is kept in pieces.
      const u = unitByKey(p, l.unit);
      const packs = Number(l.qty);
      const unitCost = round2(Number(l.cost) || 0);
      const qty = toPieces(u, packs);
      const cost = Math.round((unitCost / u.size) * 10000) / 10000; // cost per piece
      const oldStock = Number(p.stock) || 0;
      const oldCost = Number(p.costPrice) || 0;
      const newStock = oldStock + qty;
      const newCost = newStock ? Math.round(((oldStock * oldCost + qty * cost) / newStock) * 10000) / 10000 : cost;
      const lineNet = round2(packs * unitCost);
      const lineVat = round2(lineNet * (Number(p.vatRate) || 0) / 100);
      net += lineNet;
      vat += lineVat;
      writes.push({ pRef, data: { stock: newStock, costPrice: newCost, updatedAt: serverTimestamp() }, batch: {
        productId: l.productId, productName: p.name, batchNo: l.batchNo || purNo, expiry: l.expiry,
        qty, remaining: qty, cost, purNo, createdAt: serverTimestamp(),
      } });
      items.push({ productId: l.productId, name: p.name, unit: u.name, qty: packs, pieces: qty, unitCost, cost, expiry: l.expiry, batchNo: l.batchNo || purNo, lineNet, lineVat });
    }

    net = round2(net);
    vat = round2(vat);
    const total = round2(net + vat);

    tx.set(counterRef, { purchase: seq }, { merge: true });
    for (const w of writes) {
      tx.update(w.pRef, w.data);
      tx.set(doc(collection(db, "batches")), w.batch);
    }
    tx.set(doc(collection(db, "journal")), buildJournal({
      date,
      memo: `Purchase ${purNo} from ${supplier.name}`,
      ref: purNo,
      lines: [
        { account: ACCOUNTS.INVENTORY, debit: net },
        { account: ACCOUNTS.VAT_INPUT, debit: vat },
        { account: PURCHASE_PAYMENT_ACCOUNT[payment], credit: total },
      ],
    }));
    if (payment === "credit") tx.update(supplierRef, { balance: increment(total) });
    tx.set(purRef, {
      purNo, supplierId: supplier.id, supplierName: supplier.name, supplierInvoice: invoiceNo,
      date, payment, items, net, vat, total, by: session.name, createdAt: serverTimestamp(),
    });
    return { purNo, total };
  });
}
