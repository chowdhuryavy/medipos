import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../server/firebase-admin.js";
import { handle, httpError, requireAdmin } from "../../server/http.js";
import { vercelConfig, vercelRequest } from "../../server/vercel.js";

// Makes an earlier production release the live one. Only the code changes: data and Firestore rules stay as they are.
export default handle(async (req) => {
  const admin = await requireAdmin(req);
  const deploymentId = String(req.body?.deploymentId || "");
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) throw httpError(400, "Choose a valid release.");
  const { projectId } = vercelConfig();
  await vercelRequest(`/v10/projects/${encodeURIComponent(projectId)}/promote/${deploymentId}`, { method: "POST" });
  await adminDb().collection("audit").add({ action: "app.rollback", by: admin.uid, details: { deploymentId }, at: FieldValue.serverTimestamp() });
  return { ok: true };
});
