import { db, doc, getDoc } from "./firebase.js";

/**
 * Replaces the contents of one tab in the reporting Google Sheet.
 * Uses the Apps Script web-app URL configured in Administration → Integrations.
 * No Google sign-in is involved: the script runs with a shared secret.
 */
export async function pushToSheets(sheet, headers, rows) {
  const snap = await getDoc(doc(db, "settings", "integrations"));
  const cfg = snap.exists() ? snap.data() : {};
  if (!cfg.sheetsUrl) throw new Error("Google Sheets is not connected yet. Ask the administrator to set it up in Administration → Integrations.");

  const body = {
    secret: cfg.sheetsSecret || "",
    sheet,
    headers,
    rows: rows.map((r) => r.map((v) => (v === undefined || v === null ? "" : typeof v === "number" ? v : String(v)))),
  };

  let res;
  try {
    res = await fetch(cfg.sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error("Could not reach Google Sheets. Check the internet connection.");
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("Unexpected reply from the Sheets script. Check its deployment access setting."); }
  if (!json.ok) throw new Error(json.error || "Sheets sync failed.");
  return json;
}
