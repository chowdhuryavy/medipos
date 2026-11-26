// Writes PDF, Excel (.xlsx) and zip files with plain code: no libraries, so the same file runs in the browser and on the server.
// Input is a list of report sections: { title, summary: [[label, value]], headers, rows, numeric: [columnIndexes], sheetName? }.
// Optional brand: { shop, color, subtitle } puts the shop name, brand colour and period on every file.

const enc = new TextEncoder();
export const DEFAULT_COLOR = "#0f766e";

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

/* ───────── brand colours (shared by PDF and Excel) ───────── */

const safeHex = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || "")) ? String(c).toLowerCase() : DEFAULT_COLOR);
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const mix = (rgb, to, t) => rgb.map((v, i) => v + (to[i] - v) * t);
function palette(color) {
  const hex = safeHex(color);
  const main = hexRgb(hex);
  return {
    hex,
    main,
    dark: mix(main, [0, 0, 0], 0.35),
    soft: mix(main, [1, 1, 1], 0.9),
    tint: [0.965, 0.97, 0.975],
    ink: [0.09, 0.12, 0.16],
    grey: [0.42, 0.45, 0.5],
    line: [0.88, 0.9, 0.92],
    white: [1, 1, 1],
  };
}
const hex2 = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
const argb = (c) => ("FF" + c.map(hex2).join("")).toUpperCase();
const rgbOp = (c) => c.map((v) => v.toFixed(3)).join(" ");

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

// Cell style numbers, in the order they are written into styles.xml below.
const STY = { normal: 0, num: 1, bold: 2, title: 3, sub: 4, head: 5, zebra: 6, zebraNum: 7, totalText: 8, totalNum: 9, section: 10 };

function stylesXml(p) {
  const font = (inner) => `<font>${inner}<name val="Calibri"/></font>`;
  const fonts = [
    font(`<sz val="10"/><color rgb="FF171F29"/>`),
    font(`<b/><sz val="10"/><color rgb="FF171F29"/>`),
    font(`<b/><sz val="15"/><color rgb="${argb(p.main)}"/>`),
    font(`<i/><sz val="9"/><color rgb="FF6B7280"/>`),
    font(`<b/><sz val="10"/><color rgb="FFFFFFFF"/>`),
    font(`<b/><sz val="12"/><color rgb="${argb(p.dark)}"/>`),
  ];
  const fill = (c) => `<fill><patternFill patternType="solid"><fgColor rgb="${argb(c)}"/><bgColor indexed="64"/></patternFill></fill>`;
  const fills = [
    `<fill><patternFill patternType="none"/></fill>`,
    `<fill><patternFill patternType="gray125"/></fill>`,
    fill(p.main),
    fill(p.tint),
  ];
  // numFmtId 4 is the built-in #,##0.00
  const xf = (num, fontId, fillId) => `<xf numFmtId="${num}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>`;
  const xfs = [
    xf(0, 0, 0), xf(4, 0, 0), xf(0, 1, 0), xf(0, 2, 0), xf(0, 3, 0), xf(0, 4, 2), xf(0, 0, 3), xf(4, 0, 3),
    xf(0, 1, 0), xf(4, 1, 0), xf(0, 5, 0),
  ];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs></styleSheet>`;
}

function sheetXml(sec, brand) {
  const numeric = new Set(sec.numeric || []);
  const headers = sec.headers || [];
  const cols = Math.max(headers.length, 2);
  const rows = [];
  const put = (cells) => { const r = rows.length + 1; rows.push({ r, cells }); return r; };
  const shop = brand.shop || "";

  if (shop) put([{ v: shop, s: STY.title }]);
  put([{ v: sec.title, s: STY.section }]);
  if (brand.subtitle) put([{ v: brand.subtitle, s: STY.sub }]);
  put([]);
  if (sec.summary?.length) {
    sec.summary.forEach(([l, v]) => put([{ v: l, s: STY.normal }, { v, s: STY.bold }]));
    put([]);
  }
  const headerRow = put(headers.map((h) => ({ v: h, s: STY.head })));
  sec.rows.forEach((row, ri) => {
    const total = /^total/i.test(String(row[0] ?? ""));
    const zebra = ri % 2 === 1 && !total;
    put(headers.map((_, i) => {
      const v = row[i];
      const isNum = typeof v === "number" && numeric.has(i);
      const s = total
        ? (isNum ? STY.totalNum : STY.totalText)
        : zebra ? (isNum ? STY.zebraNum : STY.zebra) : (isNum ? STY.num : STY.normal);
      return { v, s };
    }));
  });

  // Column widths from the table and summary (the title lines are left out, so they do not widen column A).
  const measured = rows.filter((row) => row.cells.length > 1);
  const widths = Array.from({ length: cols }, (_, i) => {
    let longest = 10;
    for (const row of measured) longest = Math.max(longest, String(row.cells[i]?.v ?? "").length);
    return Math.min(48, longest + 2);
  });

  const body = rows.map((row) => {
    const cells = row.cells.map((c, i) => {
      const ref = `${colName(i)}${row.r}`;
      if (typeof c.v === "number" && Number.isFinite(c.v)) return `<c r="${ref}" s="${c.s}"><v>${c.v}</v></c>`;
      if (c.v === undefined || c.v === null || c.v === "") return "";
      return `<c r="${ref}" s="${c.s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
    }).join("");
    return `<row r="${row.r}">${cells}</row>`;
  }).join("");
  const colsXml = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const footer = `${shop ? `${xmlEsc(shop)} · ` : ""}MediPOS`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${headerRow - 1}" topLeftCell="A${headerRow}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${colsXml}</cols><sheetData>${body}</sheetData><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>${footer}&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter></worksheet>`;
}

/** brand: { shop, color, subtitle } — optional. */
export function toXlsx(sections, brand = {}) {
  const b = { shop: "", color: DEFAULT_COLOR, subtitle: "", ...brand };
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
  files.push({ name: "xl/styles.xml", data: enc.encode(stylesXml(palette(b.color))) });
  sections.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s, b)) }));
  return zip(files);
}

/* ───────── PDF (A4, Helvetica, branded header band, summary cards, striped tables) ───────── */

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

/** brand: { shop, color } — the shop name and brand colour shown in the header band. */
export function toPdf({ title, subtitle = "", footer = "", sections, brand = {} }) {
  const P = palette(brand.color);
  const shop = brand.shop || "MediPOS";
  const W = 595, H = 842, M = 40, CW = W - 2 * M, BOTTOM = 60, BAND = 92;
  const pages = [];
  let ops = null, y = 0;

  const rect = (x, yy, w, h, c) => ops.push(`${rgbOp(c)} rg ${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`);
  const hline = (x1, x2, yy, c) => ops.push(`${rgbOp(c)} RG 0.5 w ${x1.toFixed(1)} ${yy.toFixed(1)} m ${x2.toFixed(1)} ${yy.toFixed(1)} l S`);
  const text = (x, yy, s, size = 9, bold = false, c = P.ink) =>
    ops.push(`${rgbOp(c)} rg BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${pdfEsc(pdfSafe(s))}) Tj ET`);
  const tw = (s, size, bold) => pdfSafe(s).length * size * (bold ? 0.56 : 0.52);
  const right = (xr, yy, s, size, bold, c) => text(xr - tw(s, size, bold), yy, s, size, bold, c);
  const fitText = (s, w, size, bold) => {
    const t = pdfSafe(s);
    const max = Math.max(1, Math.floor((w - 8) / (size * (bold ? 0.56 : 0.52))));
    return t.length > max ? t.slice(0, Math.max(1, max - 2)) + ".." : t;
  };
  const maxWidth = (texts, size, bold) => {
    let m = 0;
    for (const s of texts) m = Math.max(m, tw(s, size, bold));
    return m;
  };

  // First page: full brand band. Later pages: a slim band with the shop name and report title.
  const newPage = () => {
    ops = []; pages.push(ops);
    if (pages.length === 1) {
      rect(0, H - BAND, W, BAND, P.main);
      rect(0, H - BAND - 3, W, 3, P.dark);
      text(M, H - 38, shop, 18, true, P.white);
      text(M, H - 58, title, 11.5, false, P.white);
      if (subtitle) text(M, H - 74, subtitle, 8, false, P.soft);
      y = H - BAND - 30;
    } else {
      rect(0, H - 30, W, 30, P.main);
      text(M, H - 19, shop, 9, true, P.white);
      right(W - M, H - 19, title, 8, false, P.white);
      y = H - 30 - 26;
    }
  };
  const need = (h) => { if (y - h < BOTTOM) newPage(); };

  newPage();
  for (const sec of sections) {
    const headers = sec.headers || [];
    const numeric = new Set(sec.numeric || []);
    const summary = sec.summary || [];

    need(60);
    rect(M, y - 14, 3, 15, P.main);
    text(M + 10, y - 11, sec.title, 12, true, P.dark);
    y -= 26;

    if (summary.length) {
      const per = Math.min(4, summary.length);
      const gap = 8, cw = (CW - gap * (per - 1)) / per, ch = 44;
      for (let k = 0; k < summary.length; k += per) {
        need(ch + 8);
        summary.slice(k, k + per).forEach(([l, v], j) => {
          const x = M + j * (cw + gap);
          rect(x, y - ch, cw, ch, P.soft);
          rect(x, y - ch, 3, ch, P.main);
          text(x + 10, y - 16, fitText(l, cw - 14, 7.5, false), 7.5, false, P.grey);
          text(x + 10, y - 34, fitText(cellText(v), cw - 14, 10.5, true), 10.5, true, P.ink);
        });
        y -= ch + 8;
      }
      y -= 6;
    }

    if (headers.length) {
      // Column widths from the content, scaled to the full page width.
      const nat = headers.map((h, i) => Math.max(tw(h, 8.5, true), maxWidth(sec.rows.map((r) => cellText(r[i])), 8.5, false)) + 14);
      const total = nat.reduce((s, w) => s + w, 0) || 1;
      const widths = nat.map((w) => (w * CW) / total);
      const xs = [];
      widths.reduce((x, w, i) => { xs[i] = x; return x + w; }, M);

      const drawHead = () => {
        need(20);
        rect(M, y - 19, CW, 19, P.main);
        headers.forEach((h, i) => {
          const s = fitText(h, widths[i], 8.5, true);
          if (numeric.has(i)) right(xs[i] + widths[i] - 7, y - 12, s, 8.5, true, P.white);
          else text(xs[i] + 7, y - 12, s, 8.5, true, P.white);
        });
        y -= 19;
      };
      drawHead();
      if (!sec.rows.length) { need(20); text(M + 7, y - 13, "Nothing to show for this period.", 8.5, false, P.grey); y -= 20; }
      sec.rows.forEach((row, ri) => {
        if (y - 16 < BOTTOM) { newPage(); drawHead(); }
        const total = /^total/i.test(String(row[0] ?? ""));
        if (total) rect(M, y - 16, CW, 16, P.soft);
        else if (ri % 2 === 1) rect(M, y - 16, CW, 16, P.tint);
        headers.forEach((_, i) => {
          const s = fitText(cellText(row[i]), widths[i], 8.5, total);
          if (numeric.has(i)) right(xs[i] + widths[i] - 7, y - 11, s, 8.5, total);
          else text(xs[i] + 7, y - 11, s, 8.5, total);
        });
        hline(M, M + CW, y - 16, P.line);
        y -= 16;
      });
    }
    y -= 18;
  }

  // Footer and page numbers on every page.
  const count = pages.length;
  pages.forEach((p, i) => {
    ops = p;
    hline(M, W - M, 40, P.line);
    text(M, 26, footer || `${shop} · MediPOS`, 7.5, false, P.grey);
    right(W - M, 26, `Page ${i + 1} of ${count}`, 7.5, false, P.grey);
  });

  // Objects: 1 catalog, 2 pages, 3-4 fonts, then page + content pairs.
  const objs = [];
  const kids = pages.map((_, i) => `${5 + 2 * i} 0 R`).join(" ");
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`;
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
