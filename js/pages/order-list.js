// Order list: what to buy next. Low-stock medicines can be added with one tap, and new medicines
// that are not in the system yet can be written in and saved. Everything is saved on the product.
import { db, collection, addDoc, updateDoc, doc, serverTimestamp } from "../firebase.js";
import { esc, icon, toast, settings, audit, openModal, withBusy } from "../core.js";
import { baseName } from "../packs.js";
import { productDatalist, findProduct, displayName } from "../picker.js";
import { printHtml } from "../print.js";

const isLow = (p) => p.active !== false && (Number(p.stock) || 0) <= (Number(p.reorderLevel) || 0);
const suggestQty = (p) => Math.max(1, (Number(p.reorderLevel) || 0) * 2 - (Number(p.stock) || 0));

/** HTML for the order card. Products are the full product list (active and inactive). */
export function orderCardHtml(products) {
  const onList = products.filter((p) => p.orderMarked);
  const suggested = products.filter((p) => isLow(p) && !p.orderMarked);

  const rowsHtml = onList.map((p) => `
    <tr>
      <td data-label="Product">
        <strong>${esc(p.name)}</strong>
        ${p.stub ? ` <span class="badge warn">New · add details</span>` : ""}
        <small class="muted block">${esc([p.category, p.subGroup].filter(Boolean).join(" › "))}</small>
      </td>
      <td data-label="Stock on hand" class="r">${Number(p.stock) || 0} ${esc(baseName(p))}</td>
      <td data-label="Order qty"><input type="number" min="1" step="1" inputmode="numeric" data-oq="${esc(p.id)}" value="${p.orderQty || suggestQty(p)}" aria-label="Order quantity" /></td>
      <td data-label="Note"><input data-on="${esc(p.id)}" value="${esc(p.orderNote || "")}" placeholder="Supplier, pack size, urgent…" aria-label="Note" /></td>
      <td class="actions">
        <button class="icon-btn sm" data-osave="${esc(p.id)}" aria-label="Save line">${icon("check")}</button>
        <button class="icon-btn sm hover-danger" data-orm="${esc(p.id)}" aria-label="Remove from order list">${icon("x")}</button>
      </td>
    </tr>`).join("");

  const suggestHtml = suggested.map((p) => `
    <li class="pill warn">
      <span><strong>${esc(p.name)}</strong> · ${Number(p.stock) || 0} ${esc(baseName(p))} left · reorder at ${Number(p.reorderLevel) || 0}</span>
      <button class="btn ghost sm" data-oadd="${esc(p.id)}">${icon("plus")}<span>Add to order list</span></button>
    </li>`).join("");

  return `
    <section class="card order-card" id="order-card">
      <header class="card-head">
        <h3>${icon("cart")} Order list</h3>
        <div class="row-actions">
          <span class="badge">${onList.length} item${onList.length === 1 ? "" : "s"}</span>
          <button class="btn ghost sm" id="o-print">${icon("print")}<span>Print</span></button>
          <button class="btn primary sm" data-oopen>${icon("plus")}<span>Add item</span></button>
        </div>
      </header>

      ${suggested.length ? `
        <p class="muted small">Low stock, not on the list yet:</p>
        <ul class="alert-list">${suggestHtml}</ul>` : ""}

      ${onList.length ? `
      <div class="table-wrap">
        <table class="stack-mobile" id="order-table">
          <thead><tr><th>Product</th><th class="r">Stock on hand</th><th>Order qty</th><th>Note</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>` : `<p class="muted small">Nothing on the order list yet. Tap “Add item”, or add a low-stock item above.</p>`}
    </section>`;
}

/** Wires the order card. reload() re-renders the page after each change. */
export function bindOrderCard(el, products, reload) {
  const card = el.querySelector("#order-card");
  if (!card) return;

  const save = (id, patch, message) => updateDoc(doc(db, "products", id), { ...patch, updatedAt: serverTimestamp() })
    .then(() => { toast(message, "success"); reload(); })
    .catch((err) => toast(err.message, "error"));

  card.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "o-print") return printOrderList(products);
    if (b.hasAttribute("data-oopen")) return openAddModal(products, reload);
    if (b.dataset.oadd) {
      const p = products.find((x) => x.id === b.dataset.oadd);
      return withBusy(b, () => save(p.id, { orderMarked: true, orderQty: suggestQty(p), orderNote: p.orderNote || "" }, `${p.name} added to the order list`));
    }
    if (b.dataset.osave) {
      const row = b.closest("tr");
      const qty = parseInt(row.querySelector("[data-oq]").value, 10) || 1;
      const note = row.querySelector("[data-on]").value.trim();
      return save(b.dataset.osave, { orderQty: qty, orderNote: note }, "Order line saved");
    }
    if (b.dataset.orm) {
      return save(b.dataset.orm, { orderMarked: false, orderQty: 0, orderNote: "" }, "Removed from the order list");
    }
  });
}

// Adds a medicine to the order list. A medicine not in the system yet becomes a placeholder product to be completed later.
async function addOrderItem(products, { text, qty, note }) {
  const existing = findProduct(products, text);
  if (existing) {
    await updateDoc(doc(db, "products", existing.id), { orderMarked: true, orderQty: qty || suggestQty(existing), orderNote: note, updatedAt: serverTimestamp() });
    return `${existing.name} added to the order list`;
  }
  await addDoc(collection(db, "products"), {
    name: text, sku: "", barcode: "", category: "General", subGroup: "", unit: settings.units[0] || "Piece",
    rack: "", shelf: "", costPrice: 0, salePrice: 0, minPrice: 0, packs: [], vatRate: settings.defaultVatRate,
    reorderLevel: 0, stock: 0, active: true, stub: true,
    orderMarked: true, orderQty: qty || 1, orderNote: note, createdAt: serverTimestamp(),
  });
  await audit("order.new_item", { name: text });
  return `${text} added. Add its price and details from Inventory.`;
}

// The add form opens in its own dialog, so the list itself stays clean on a phone.
function openAddModal(products, reload) {
  openModal("Add to order list", `
    <form id="o-new" class="form-grid">
      ${productDatalist(products, "o-products")}
      <label class="span-2">Medicine<input name="item" list="o-products" autocomplete="off" placeholder="Search a medicine, or type a new one" required /></label>
      <label>Quantity<input name="qty" type="number" min="1" step="1" inputmode="numeric" placeholder="Qty" /></label>
      <label>Note (optional)<input name="note" placeholder="Supplier, pack size, urgent…" /></label>
      <div class="form-actions span-2"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit">Add to list</button></div>
    </form>`, (body, close) => {
    body.querySelector("[data-cancel]").addEventListener("click", close);
    body.querySelector("#o-new").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const text = String(f.get("item") || "").trim();
      if (!text) return toast("Type a medicine name", "error");
      const btn = e.target.querySelector("button[type=submit]");
      await withBusy(btn, async () => {
        try {
          const msg = await addOrderItem(products, { text, qty: parseInt(f.get("qty"), 10) || 0, note: String(f.get("note") || "").trim() });
          toast(msg, "success");
          close();
          reload();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
  });
}

function printOrderList(products) {
  const list = products.filter((p) => p.orderMarked);
  if (!list.length) return toast("The order list is empty", "error");
  const rows = list.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc([p.category, p.subGroup].filter(Boolean).join(" › "))}</td><td class="r">${Number(p.stock) || 0} ${esc(baseName(p))}</td><td class="r">${p.orderQty || 0}</td><td>${esc(p.orderNote || "")}</td></tr>`).join("");
  printHtml("Order list", `<h2>Order list</h2><table><thead><tr><th>Product</th><th>Group</th><th>Stock on hand</th><th>Order qty</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>`);
}

export { displayName };
