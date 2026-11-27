// Copies bills that are not yet in Google Drive and Sheets. Runs from the scheduled cron.
// The server reads the Sheets address and secret with full rights, so staff never see the secret.
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin.js";

const BATCH = 20;

export async function runBillCopies() {
  const db = adminDb();
  const cfgSnap = await db.doc("settings/integrations").get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  if (!cfg.sheetsUrl) return { copied: 0, skipped: "Google Sheets is not connected." };

  const pending = await db.collectionGroup("bills").where("copied", "==", false).limit(BATCH).get();
  let copied = 0;
  const failed = [];
  for (const d of pending.docs) {
    const parent = d.ref.parent.parent;
    const kind = d.ref.parent.parent.parent.id === "expenses" ? "Expense" : "Purchase";
    const p = (await parent.get()).data() || {};
    const bill = d.data();
    try {
      const res = await fetch(cfg.sheetsUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "bill",
          secret: cfg.sheetsSecret || "",
          bill: { name: bill.name, data: bill.data },
          meta: {
            date: p.date || "",
            jv: p.jvNo || p.purNo || "",
            kind,
            party: kind === "Expense" ? p.payee || p.accountName || "" : p.supplierName || "",
            amount: kind === "Expense" ? p.amount : p.total,
            uploadedBy: bill.uploadedBy || "",
          },
        }),
      });
      const json = JSON.parse(await res.text());
      if (!json.ok) throw new Error(json.error || "The Sheets script refused the bill.");
      await d.ref.update({ copied: true, copiedAt: FieldValue.serverTimestamp(), driveUrl: json.url || "" });
      copied++;
    } catch (err) {
      failed.push({ id: d.id, error: String(err.message || err) });
    }
  }
  return { copied, failed };
}
