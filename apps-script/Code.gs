/**
 * MediPOS → Google Sheets receiver (Google Apps Script web app).
 *
 * One-time setup (no Google sign-in is needed by the app itself):
 *  1. Create or open the reporting spreadsheet and copy its ID from the URL.
 *  2. In this script: Project Settings → Script properties, add:
 *       SHEET_ID  = <spreadsheet ID>
 *       SECRET    = <a long random string>   (paste the same value in MediPOS → Administration → Google Sheets)
 *  3. Deploy → New deployment → Type: Web app
 *       Execute as: Me
 *       Who has access: Anyone
 *     Copy the URL ending in /exec into MediPOS → Administration → Google Sheets.
 */

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty("SECRET");
    if (!secret || body.secret !== secret) {
      return jsonOut({ ok: false, error: "Unauthorized" });
    }

    const ss = SpreadsheetApp.openById(props.getProperty("SHEET_ID"));
    const name = String(body.sheet || "Data").replace(/[\[\]\*\?:\/\\]/g, "-").slice(0, 99);
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);

    const headers = (body.headers || []).map(safe);
    const width = Math.max(headers.length, 1);
    const rows = (body.rows || []).map((r) => pad(r.map(safe), width));
    const data = [pad(headers, width)].concat(rows);

    sheet.clearContents();
    sheet.getRange(1, 1, data.length, width).setValues(data);
    sheet.getRange(1, 1, 1, width)
      .setFontWeight("bold")
      .setBackground("#0f766e")
      .setFontColor("#ffffff");
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, width);

    return jsonOut({ ok: true, rows: rows.length, sheet: name });
  } catch (err) {
    return jsonOut({ ok: false, error: String((err && err.message) || err) });
  }
}

// Prevents spreadsheet formula injection from user-entered text.
function safe(v) {
  if (typeof v === "number") return v;
  const s = v === null || v === undefined ? "" : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function pad(row, n) {
  const out = row.slice(0, n);
  while (out.length < n) out.push("");
  return out;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
