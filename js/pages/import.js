// Bulk product import: reads a CSV file, checks every row, shows a preview, then creates the valid products.
// Products are created with zero stock. Opening stock is received through Purchasing or Inventory, where its expiry is recorded.
import { db, collection, doc, getDocs, writeBatch, serverTimestamp } from "../firebase.js";
import { settings, session, audit, toast, esc, icon, onSubmit, downloadCSV } from "../core.js";

const COLUMNS = ["name", "sku", "barcode", "group", "subGroup", "unit", "rack", "shelf", "costPrice", "salePrice", "minPrice", "vatRate", "reorderLevel"];
const REQUIRED = ["name", "costPrice", "salePrice"];
const NUMERIC = ["costPrice", "salePrice", "minPrice", "vatRate", "reorderLevel"];

// Splits CSV text into rows. Handles quoted fields, commas and line breaks inside quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const src = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}

// Checks each line. Returns { valid: [product data], problems: [{ line, message }] }.
export function checkRows(rows, existing) {
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name.toLowerCase());
  const missing = REQUIRED.filter((r) => col(r) < 0);
  if (missing.length) return { valid: [], problems: [{ line: 1, message: `Missing column(s): ${missing.join(", ")}` }] };

  const seenBarcodes = new Set(existing.map((p) => p.barcode).filter(Boolean));
  const seenSkus = new Set(existing.map((p) => p.sku).filter(Boolean).map((s) => s.toLowerCase()));
  const seenNames = new Set(existing.map((p) => (p.name || "").toLowerCase()));
  const valid = [], problems = [];

  rows.slice(1).forEach((raw, idx) => {
    const line = idx + 2;
    const get = (name) => (col(name) >= 0 ? String(raw[col(name)] ?? "").trim() : "");
    const data = {};
    const errors = [];
    for (const c of COLUMNS) data[c] = get(c);
    if (!data.name) errors.push("name is empty");
    for (const n of NUMERIC) {
      if (data[n] === "") { if (REQUIRED.includes(n)) errors.push(`${n} is empty`); continue; }
      const v = Number(data[n]);
      if (!Number.isFinite(v) || v < 0) errors.push(`${n} must be a number of zero or more`);
    }
    if (data.name && seenNames.has(data.name.toLowerCase())) errors.push("a product with this name already exists");
    if (data.sku && seenSkus.has(data.sku.toLowerCase())) errors.push("SKU already used");
    if (data.barcode && seenBarcodes.has(data.barcode)) errors.push("barcode already used");
    if (data.group && settings.categories?.length && !settings.categories.includes(data.group)) errors.push(`group "${data.group}" is not in Settings`);
    if (data.unit && settings.units?.length && !settings.units.includes(data.unit)) errors.push(`unit "${data.unit}" is not in Settings`);
    if (data.salePrice && data.costPrice && Number(data.salePrice) < Number(data.costPrice)) errors.push("sale price is below cost");

    if (errors.length) { problems.push({ line, message: errors.join("; ") }); return; }
    if (data.name) seenNames.add(data.name.toLowerCase());
    if (data.sku) seenSkus.add(data.sku.toLowerCase());
    if (data.barcode) seenBarcodes.add(data.barcode);
    valid.push({
      name: data.name,
      sku: data.sku,
      barcode: data.barcode,
      category: data.group || settings.categories?.[0] || "",
      subGroup: data.subGroup,
      unit: data.unit || settings.units?.[0] || "",
      rack: data.rack,
      shelf: data.shelf,
      costPrice: Number(data.costPrice),
      salePrice: Number(data.salePrice),
      minPrice: data.minPrice === "" ? Number(data.salePrice) : Number(data.minPrice),
      vatRate: data.vatRate === "" ? (settings.defaultVatRate ?? 0) : Number(data.vatRate),
      reorderLevel: data.reorderLevel === "" ? (settings.defaultReorderLevel ?? 0) : parseInt(data.reorderLevel, 10),
      packs: [],
      active: true,
      stub: false,
      stock: 0,
    });
  });
  return { valid, problems };
}

const TEMPLATE = [
  COLUMNS,
  ["Paracetamol 500mg tablet", "PCM-500", "8901234567890", "", "Analgesics", "", "A", "2", "1.20", "2.00", "1.80", "0", "50"],
];

export async function render(el) {
  el.innerHTML = `
    <div class="import-page stack">
      <section class="card">
        <header class="card-head"><h3>${icon("inventory")} Import products from CSV</h3></header>
        <p class="muted small">Save your sheet as CSV (File → Save as → CSV in Excel or Google Sheets). The first row must hold column names. Required: <b>name, costPrice, salePrice</b>. Optional: ${COLUMNS.filter((c) => !REQUIRED.includes(c)).join(", ")}.</p>
        <p class="muted small">Groups and units must already exist in Settings. Barcodes and SKUs must be unique. Stock is added later through Purchasing, where expiry dates are recorded.</p>
        <div class="row-actions wrap">
          <button type="button" class="btn ghost" id="im-template">${icon("download")}<span>Download template</span></button>
        </div>
        <form id="im-form" class="stack">
          <label>CSV file<input id="im-file" type="file" accept=".csv,text/csv" required /></label>
          <div id="im-preview"></div>
          <div class="form-actions"><button class="btn primary" type="submit" id="im-go" disabled>${icon("check")}<span>Import products</span></button></div>
        </form>
      </section>
    </div>`;

  let pending = null;
  el.querySelector("#im-template").addEventListener("click", () => downloadCSV("medipos-products-template.csv", TEMPLATE));

  el.querySelector("#im-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    const go = el.querySelector("#im-go");
    const out = el.querySelector("#im-preview");
    pending = null; go.disabled = true;
    if (!file) { out.innerHTML = ""; return; }
    if (file.size > 2_000_000) { out.innerHTML = `<p class="warn-text">This file is larger than 2 MB. Split it into smaller files.</p>`; return; }
    const rows = parseCsv(await file.text());
    if (rows.length < 2) { out.innerHTML = `<p class="warn-text">The file has no product rows.</p>`; return; }
    const snap = await getDocs(collection(db, "products"));
    const existing = snap.docs.map((d) => d.data());
    const { valid, problems } = checkRows(rows, existing);
    pending = valid;
    go.disabled = valid.length === 0;
    out.innerHTML = `
      <p><b>${valid.length}</b> ready to import${problems.length ? `, <b>${problems.length}</b> with problems that will be skipped` : ""}.</p>
      ${problems.length ? `<div class="table-wrap"><table><thead><tr><th>Line</th><th>Problem</th></tr></thead><tbody>
        ${problems.slice(0, 200).map((p) => `<tr><td>${p.line}</td><td>${esc(p.message)}</td></tr>`).join("")}
      </tbody></table></div>${problems.length > 200 ? `<p class="muted small">Showing the first 200 problems.</p>` : ""}` : ""}
      ${valid.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Group</th><th class="num">Cost</th><th class="num">Sale</th></tr></thead><tbody>
        ${valid.slice(0, 15).map((v) => `<tr><td>${esc(v.name)}</td><td>${esc(v.category)}</td><td class="num">${v.costPrice}</td><td class="num">${v.salePrice}</td></tr>`).join("")}
      </tbody></table></div>${valid.length > 15 ? `<p class="muted small">Showing 15 of ${valid.length}.</p>` : ""}` : ""}`;
  });

  onSubmit(el.querySelector("#im-form"), async () => {
    if (!pending || !pending.length) throw new Error("Choose a CSV file with valid rows first.");
    let done = 0;
    // Firestore batches hold at most 500 writes; 400 leaves room.
    for (let i = 0; i < pending.length; i += 400) {
      const batch = writeBatch(db);
      for (const p of pending.slice(i, i + 400)) {
        batch.set(doc(collection(db, "products")), { ...p, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }
      await batch.commit();
      done += Math.min(400, pending.length - i);
    }
    await audit("product.import", { count: done, by: session.name });
    toast(`${done} products imported`, "success");
    render(el);
  });
}
