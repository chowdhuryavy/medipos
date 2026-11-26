// Products are stored in pieces (the smallest unit). Packs such as strip, box and carton convert to pieces.
import { esc } from "./core.js";

const keyFor = (name, size) => `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "")}${size}`;

export const baseName = (p = {}) => p.unit || "Piece";

/** Every way a product can be sold or bought: the smallest unit first, then its packs. */
export function unitsOf(p = {}) {
  const base = {
    key: "piece", name: baseName(p), size: 1, base: true,
    price: Number(p.salePrice) || 0,
    minPrice: Number(p.minPrice ?? p.salePrice) || 0,
  };
  const packs = (p.packs || [])
    .filter((k) => k && k.name && Math.round(Number(k.size)) > 1)
    .map((k) => {
      const price = Number(k.price) || 0;
      return {
        key: keyFor(k.name, Math.round(Number(k.size))), name: String(k.name).trim(),
        size: Math.round(Number(k.size)), base: false,
        price, minPrice: Number(k.minPrice ?? price) || 0,
      };
    });
  return [base, ...packs];
}

export function unitByKey(p = {}, key) {
  const all = unitsOf(p);
  return all.find((u) => u.key === key) || all[0];
}

export const toPieces = (unit, qty) => Math.round((Number(qty) || 0) * (unit?.size || 1));

/** "2 Box · 3 Strip · 5 Piece" for a number of pieces. */
export function breakdown(p = {}, pieces = 0) {
  let left = Math.max(0, Math.round(Number(pieces) || 0));
  const parts = [];
  unitsOf(p).filter((u) => !u.base).sort((a, b) => b.size - a.size).forEach((u) => {
    const n = Math.floor(left / u.size);
    if (n > 0) {
      parts.push(`${n} ${u.name}`);
      left -= n * u.size;
    }
  });
  if (left > 0 || !parts.length) parts.push(`${left} ${baseName(p)}`);
  return parts.join(" · ");
}

export function locationText(p = {}) {
  const parts = [];
  if (p.rack) parts.push(`Rack ${p.rack}`);
  if (p.shelf) parts.push(`Shelf ${p.shelf}`);
  return parts.join(" · ") || "No rack set";
}

export function unitOptions(p = {}, selectedKey = "piece") {
  return unitsOf(p).map((u) =>
    `<option value="${esc(u.key)}" ${u.key === selectedKey ? "selected" : ""}>${esc(u.name)}${u.base ? "" : ` (${u.size} ${esc(baseName(p))})`}</option>`
  ).join("");
}
