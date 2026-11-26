// Writes PDF, Excel (.xlsx) and zip files with plain code: no libraries, so the same file runs in the browser and on the server.
// Input is a list of report sections: { title, summary: [[label, value]], headers, rows, numeric: [columnIndexes] }.

const enc = new TextEncoder();

/* ───────── zip (stored, no compression) ───────── */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    lh.set(name, 30);
    locals.push(lh, data);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    ch.set(name, 46);
    centrals.push(ch);
    offset += lh.length + data.length;
  }
  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  return concat([...locals, ...centrals, end]);
}

/* ───────── Excel ───────── */

const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const colName = (i) => {
  let s = "", n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};
const sheetName = (s, used) => {
  let base = String(s).replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Sheet";
  let name = base, k = 2;
  while (used.has(name.toLowerCase())) { name = `${base.slice(0, 28)} ${k++}`; }
  used.add(name.toLowerCase());
  return name;
};

const STYLE_NUM = 1, STYLE_BOLD = 2;
function sheetXml(sec) {
  const numeric = new Set(sec.numeric || []);
  const rows = [];
  let r = 0;
  const cell = (v, style = 0) => {
    const ref = `${colName(0)}`; // placeholder, replaced below
    return { v, style, ref };
  };
  const put = (cells) => { r += 1; rows.push({ r, cells }); };
  const colsUsed = Math.max(sec.headers.length, 2);
  put([{ v: sec.title, style: STYLE_BOLD }]);
  (sec.summary || []).forEach(([l, v]) => put([{ v: l, style: 0 }, { v, style: 0 }]));
  if (sec.summary?.length) put([]);
  put(sec.headers.map((h, i) => ({ v: h, style: STYLE_BOLD, numeric: numeric.has(i) })));
  sec.rows.forEach((row) => put(row.map((v, i) => ({ v, style: typeof v === "number" && numeric.has(i) ? STYLE_NUM : 0 }))));

  // Column widths from the longest text in each column.
  const widths = Array.from({ length: colsUsed }, (_, i) => {
    const lens = rows.map((row) => String(row.cells[i]?.v ?? "").length);
    return Math.min(48, Math.max(10, ...lens) + 2);
  });
  const body = rows.map((row) => {
    const cells = row.cells.map((c, i) => {
      const ref = `${colName(i)}${row.r}`;
      if (typeof c.v === "number" && Number.isFinite(c.v)) return `<c r="${ref}" s="${c.style}"><v>${c.v}</v></c>`;
      if (c.v === undefined || c.v === null || c.v === "") return "";
      return `<c r="${ref}" s="${c.style}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
    }).join("");
    return `<row r="${row.r}">${cells}</row>`;
  }).join("");
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

export function toXlsx(sections) {
  const used = new Set();
  const names = sections.map((s) => sheetName(s.sheetName || s.title, used));
  const files = [];
  files.push({ name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`) });
  files.push({ name: "_rels/.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) });
  files.push({ name: "xl/workbook.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`) });
  files.push({ name: "xl/_rels/workbook.xml.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) });
  files.push({ name: "xl/styles.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`) });
  sections.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s)) }));
  return zip(files);
}

/* ───────── PDF (A4, Helvetica, tables that repeat their header across pages) ───────── */

// PDF text here is plain ASCII: symbols that do not exist in the font are mapped to close ASCII forms.
export function pdfSafe(v) {
  return String(v ?? "")
    .replace(/৳/g, "Tk").replace(/[−–—]/g, "-").replace(/[•·]/g, "-")
    .replace(/…/g, "...").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e]/g, "?");
}
const pdfEsc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const fmtNum = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cellText = (v) => pdfSafe(typeof v === "number" ? fmtNum(v) : v);

export function toPdf({ title, subtitle = "", footer = "", sections }) {
  const W = 595, H = 842, M = 40, CW = W - 2 * M, BOTTOM = M + 30;
  const pages = [];
  let ops = null, y = 0;
  const newPage = () => { ops = []; pages.push(ops); y = H - M; };
  const need = (h) => { if (y - h < BOTTOM) newPage(); };
  const text = (x, yy, s, size = 9, bold = false) =>
    ops.push(`0 0 0 rg BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${pdfEsc(pdfSafe(s))}) Tj ET`);
  const tw = (s, size, bold) => s.length * size * (bold ? 0.56 : 0.52);
  const fitText = (s, w, size, bold) => {
    const max = Math.max(1, Math.floor((w - 8) / (size * (bold ? 0.56 : 0.52))));
    return s.length > max ? s.slice(0, Math.max(1, max - 2)) + ".." : s;
  };

  newPage();
  text(M, y - 14, title, 16, true);
  y -= 22;
  if (subtitle) { text(M, y - 10, subtitle, 9); y -= 16; }
  y -= 8;

  for (const sec of sections) {
    const headers = sec.headers || [];
    const numeric = new Set(sec.numeric || []);
    const summary = sec.summary || [];
    need(40 + summary.length * 13);
    if (y < H - M - 5) y -= 6;
    text(M, y - 12, sec.title, 12, true);
    y -= 20;
    for (const [l, v] of summary) {
      need(14);
      text(M, y - 9, `${l}`, 9);
      text(M + 200, y - 9, cellText(v), 9, true);
      y -= 13;
    }
    if (summary.length) y -= 8;

    if (headers.length) {
      // Column widths from the content, scaled to the full page width.
      const nat = headers.map((h, i) => Math.max(tw(pdfSafe(h), 8.5, true), ...sec.rows.map((r) => tw(cellText(r[i]), 8.5, false))) + 12);
      const total = nat.reduce((s, w) => s + w, 0) || 1;
      const widths = nat.map((w) => (w * CW) / total);
      const xs = widths.reduce((acc, w, i) => { acc.push(i ? acc[i - 1] + widths[i - 1] : M); return acc; }, []);
      const drawHeader = () => {
        need(18);
        ops.push(`0.9 g ${M} ${(y - 15).toFixed(1)} ${CW} 16 re f`);
        headers.forEach((h, i) => {
          const s = fitText(pdfSafe(h), widths[i], 8.5, true);
          const x = numeric.has(i) ? xs[i] + widths[i] - 6 - tw(s, 8.5, true) : xs[i] + 6;
          text(x, y - 11, s, 8.5, true);
        });
        y -= 17;
      };
      drawHeader();
      if (!sec.rows.length) { need(14); text(M + 6, y - 10, "Nothing to show for this period.", 8.5); y -= 14; }
      sec.rows.forEach((row) => {
        if (y - 14 < BOTTOM) { newPage(); drawHeader(); }
        headers.forEach((_, i) => {
          const raw = cellText(row[i]);
          const s = fitText(raw, widths[i], 8.5, false);
          const x = numeric.has(i) ? xs[i] + widths[i] - 6 - tw(s, 8.5, false) : xs[i] + 6;
          text(x, y - 10, s, 8.5);
        });
        ops.push(`0.85 G ${M} ${(y - 13).toFixed(1)} m ${M + CW} ${(y - 13).toFixed(1)} l S`);
        y -= 14;
      });
    }
    y -= 14;
  }

  // Page numbers and footer on every page.
  const total = pages.length;
  pages.forEach((p, i) => {
    p.push(`0.45 g BT /F1 7.5 Tf ${M} 22 Td (${pdfEsc(pdfSafe(footer))}) Tj ET`);
    p.push(`0.45 g BT /F1 7.5 Tf ${W - M - 60} 22 Td (Page ${i + 1} of ${total}) Tj ET`);
  });

  // Objects: 1 catalog, 2 pages, 3-4 fonts, then page + content pairs.
  const objs = [];
  const kids = pages.map((_, i) => `${5 + 2 * i} 0 R`).join(" ");
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((p, i) => {
    const content = p.join("\n");
    objs[5 + 2 * i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`;
    objs[6 + 2 * i] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(out);
}
