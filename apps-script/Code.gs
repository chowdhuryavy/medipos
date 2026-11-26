/**
 * MediPOS → Google Sheets receiver (Google Apps Script web app)
 *
 * SETUP (once):
 *  1. Go to script.google.com → New project → paste this whole file → Save.
 *  2. Project Settings (gear icon) → Script properties → optional: add SHEET_ID = <ID of an existing sheet>
 *     (for example the "MediPOS Reports" sheet). Leave it out to create a new spreadsheet.
 *  3. Run → setupMediPOS → Review permissions → Allow.
 *  4. The execution log prints the shared secret. It is also stored in Script properties as SECRET.
 *  5. Deploy → New deployment → Type: Web app → Execute as: Me → Who has access: Anyone → Deploy.
 *     Copy the URL that ends in /exec.
 *  6. In MediPOS → Administration → Integrations: paste the URL and the SECRET, then save.
 *
 * Each "Send to Google Sheets" from MediPOS replaces the Sales, Products, Stock and Expiry tabs.
 * Run setupMediPOS again at any time; it keeps the same secret and sheet.
 */

var SHEET_TITLE = "MediPOS Reports";
var BRAND = { teal: "#0f766e", muted: "#64748b" };
var TAB_ORDER = ["Start Here", "Dashboard", "Sales", "Products", "Stock", "Expiry"];

// The tabs MediPOS writes to, with the headers MediPOS sends on each sync.
var DATA_TABS = {
  "Sales":    ["Date", "Invoice", "Customer", "Product", "Qty", "Net", "VAT", "Line total", "COGS", "Profit", "Paid by"],
  "Products": ["Product", "Qty", "Revenue", "COGS", "Profit"],
  "Stock":    ["Product", "SKU", "Category", "Stock", "Reorder level", "Cost", "Value"],
  "Expiry":   ["Product", "Batch", "Expiry", "Units left", "Unit cost", "Value", "Status"]
};

/* ───────── one-time setup (run this from the editor) ───────── */

function setupMediPOS() {
  var props = PropertiesService.getScriptProperties();

  var ss = null;
  var id = props.getProperty("SHEET_ID");
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(SHEET_TITLE);
    props.setProperty("SHEET_ID", ss.getId());
  }

  var secret = props.getProperty("SECRET");
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, "");
    props.setProperty("SECRET", secret);
  }

  // Create the tabs in order.
  TAB_ORDER.forEach(function (name, i) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.setTabColor(BRAND.teal);
    sh.activate();
    ss.moveActiveSheet(i + 1);
  });
  var blank = ss.getSheetByName("Sheet1");
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  // Data tabs: write their headers so they look right before the first sync.
  Object.keys(DATA_TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    var headers = DATA_TABS[name];
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleSheet(sh, headers);
  });

  buildStartHere(ss);
  buildDashboard(ss);

  Logger.log("Spreadsheet: " + ss.getUrl());
  Logger.log("Shared secret (paste into MediPOS → Administration → Integrations): " + secret);
  return ss.getUrl();
}

/* ───────── receiving data from MediPOS ───────── */

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty("SECRET");
    if (!secret || body.secret !== secret) {
      return jsonOut({ ok: false, error: "The shared secret does not match the one in this script." });
    }

    var ss = openSpreadsheet(props);
    var name = String(body.sheet || "Data").replace(/[\[\]\*\?:\/\\]/g, "-").slice(0, 99);
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.setTabColor(BRAND.teal);

    var headers = (body.headers || []).map(safe);
    var width = Math.max(headers.length, 1);
    var rows = (body.rows || []).map(function (r) { return pad(r.map(safe), width); });
    var data = [pad(headers, width)].concat(rows);

    sh.clearContents();
    sh.getRange(1, 1, data.length, width).setValues(data);
    styleSheet(sh, headers);
    refreshFilter(sh, data.length, width);
    sh.autoResizeColumns(1, width);
    markSynced(ss, name, rows.length);

    return jsonOut({ ok: true, sheet: name, rows: rows.length });
  } catch (err) {
    return jsonOut({ ok: false, error: String((err && err.message) || err) });
  }
}

// Lets you open the URL in a browser to check that the script is deployed.
function doGet() {
  return jsonOut({ ok: true, app: "MediPOS Reports", note: "Reports are sent here by MediPOS." });
}

/* ───────── sheet layout ───────── */

function styleSheet(sh, headers) {
  var width = headers.length;
  sh.setFrozenRows(1);
  sh.setRowHeight(1, 32);
  sh.getRange(1, 1, 1, width)
    .setFontWeight("bold")
    .setBackground(BRAND.teal)
    .setFontColor("#ffffff")
    .setVerticalAlignment("middle");
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  headers.forEach(function (h, i) {
    var body = sh.getRange(2, i + 1, rows, 1);
    if (isMoney(h)) body.setNumberFormat("#,##0.00");
    else if (isCount(h)) body.setNumberFormat("#,##0");
    else if (isDate(h)) body.setNumberFormat("yyyy-mm-dd");
  });
}

function refreshFilter(sh, rowCount, width) {
  var old = sh.getFilter();
  if (old) old.remove();
  if (rowCount > 1) sh.getRange(1, 1, rowCount, width).createFilter();
}

function markSynced(ss, tab, count) {
  var sh = ss.getSheetByName("Start Here");
  if (!sh) return;
  sh.getRange("B4").setValue(new Date()).setNumberFormat("dd MMM yyyy, HH:mm");
  sh.getRange("B5").setValue(tab + " · " + count + " row" + (count === 1 ? "" : "s"));
}

function buildStartHere(ss) {
  var sh = ss.getSheetByName("Start Here");
  sh.clear();
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 150);
  sh.setColumnWidth(2, 380);
  sh.getRange("A1").setValue("MediPOS Reports").setFontSize(22).setFontWeight("bold").setFontColor(BRAND.teal);
  sh.getRange("A2").setValue("Live figures from your pharmacy. Updated when an admin presses Send to Google Sheets in MediPOS.").setFontColor(BRAND.muted);
  sh.getRange("A4:A5").setValues([["Last sync"], ["Last tab sent"]]).setFontWeight("bold");
  sh.getRange("B4:B5").setValue("—").setFontColor(BRAND.muted);
  sh.getRange("A7").setValue("How it works").setFontSize(13).setFontWeight("bold").setFontColor(BRAND.teal);
  sh.getRange("A8").setValue("Sales, Products, Stock and Expiry are replaced every time an admin presses Send to Google Sheets in MediPOS.");
  sh.getRange("A9").setValue("The Dashboard recalculates by itself. Do not type in the data tabs; they are overwritten on each sync.");
  sh.getRange("A11").setValue("Connect MediPOS").setFontSize(13).setFontWeight("bold").setFontColor(BRAND.teal);
  sh.getRange("A12").setValue("1. Apps Script → Deploy → Web app URL (ends in /exec).");
  sh.getRange("A13").setValue("2. MediPOS → Administration → Integrations: paste the URL and the shared secret (Script properties → SECRET).");
  sh.getRange("A14").setValue("3. On the Reports page, press Send to Google Sheets.");
}

function buildDashboard(ss) {
  var sh = ss.getSheetByName("Dashboard");
  sh.clear();
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 280);
  sh.setColumnWidth(2, 150);
  sh.setColumnWidths(3, 3, 120);

  sh.getRange("A1").setValue("MediPOS Dashboard").setFontSize(20).setFontWeight("bold").setFontColor(BRAND.teal);
  sh.getRange("A2").setValue("Figures recalculate by themselves after each sync.").setFontColor(BRAND.muted);

  sh.getRange("A3:B3").setValues([["Key figure", "Value"]])
    .setFontWeight("bold").setBackground(BRAND.teal).setFontColor("#ffffff");

  var kpis = [
    ["Revenue collected", "=SUM(Sales!H:H)", "money"],
    ["Net sales (excl. VAT)", "=SUM(Sales!F:F)", "money"],
    ["VAT collected", "=SUM(Sales!G:G)", "money"],
    ["Gross profit", "=SUM(Sales!J:J)", "money"],
    ["Gross margin", "=IFERROR(B7/B5,0)", "pct"],
    ["Items sold", "=SUM(Sales!E:E)", "count"],
    ["Stock value", "=SUM(Stock!G:G)", "money"],
    ["Products at or below reorder level", '=SUMPRODUCT((Stock!A2:A<>"")*(Stock!D2:D<=Stock!E2:E))', "count"],
    ["Expired batches", '=COUNTIF(Expiry!G:G,"Expired")', "count"],
    ["Batches expiring soon", '=COUNTIF(Expiry!G:G,"Expiring soon")', "count"]
  ];
  kpis.forEach(function (k, i) {
    var row = 4 + i;
    sh.getRange(row, 1).setValue(k[0]);
    sh.getRange(row, 2).setFormula(k[1]).setNumberFormat(
      k[2] === "pct" ? "0.0%" : k[2] === "money" ? "#,##0.00" : "#,##0");
  });

  sh.getRange("A15").setValue("Top products by revenue").setFontSize(13).setFontWeight("bold").setFontColor(BRAND.teal);
  sh.getRange("A16").setFormula(`=IFERROR(QUERY(Products!A:E,"select A,B,C,D,E where A is not null order by C desc limit 10",1),"")`);
  sh.getRange("A16:E16").setFontWeight("bold").setBackground(BRAND.teal).setFontColor("#ffffff");
  sh.getRange("C17:E26").setNumberFormat("#,##0.00");

  sh.getRange("A28").setValue("How customers paid").setFontSize(13).setFontWeight("bold").setFontColor(BRAND.teal);
  sh.getRange("A29").setFormula(`=IFERROR(QUERY(Sales!A:K,"select K, sum(H) where K is not null group by K label K 'Payment', sum(H) 'Amount' order by sum(H) desc",1),"")`);
  sh.getRange("A29:B29").setFontWeight("bold").setBackground(BRAND.teal).setFontColor("#ffffff");
  sh.getRange("B30:B40").setNumberFormat("#,##0.00");
}

/* ───────── helpers ───────── */

function openSpreadsheet(props) {
  var id = props.getProperty("SHEET_ID");
  if (!id) throw new Error("Run setupMediPOS() once from the Apps Script editor first.");
  return SpreadsheetApp.openById(id);
}

function isMoney(h) { return /net|vat|total|cogs|profit|revenue|cost|value|price/i.test(String(h)); }
function isCount(h) { return /qty|stock|units|reorder|bills|items|sold/i.test(String(h)); }
function isDate(h)  { return /date|expiry/i.test(String(h)); }

// Stops spreadsheet formula injection from text that starts with = + - @
function safe(v) {
  if (typeof v === "number") return v;
  var s = v === null || v === undefined ? "" : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function pad(row, n) {
  var out = row.slice(0, n);
  while (out.length < n) out.push("");
  return out;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
