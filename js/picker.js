// Searchable product picker: type a name, SKU or barcode and choose from the list. Each option shows stock on hand.
import { esc } from "./core.js";
import { locationText } from "./packs.js";

export const displayName = (p) => (p.sku ? `${p.name} (${p.sku})` : p.name);

export function productDatalist(products, id) {
  return `<datalist id="${esc(id)}">${products.map((p) =>
    `<option value="${esc(displayName(p))}" label="${esc(`SOH ${p.stock || 0} · ${[p.category, p.subGroup].filter(Boolean).join(" › ")} · ${locationText(p)}`)}"></option>`
  ).join("")}</datalist>`;
}

// Finds a product from what was typed or scanned: display name, barcode, SKU, then plain name.
export function findProduct(products, text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;
  return products.find((p) => displayName(p).toLowerCase() === t)
    || products.find((p) => p.barcode && String(p.barcode).toLowerCase() === t)
    || products.find((p) => p.sku && String(p.sku).toLowerCase() === t)
    || products.find((p) => String(p.name).toLowerCase() === t)
    || null;
}
