import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin.js";
import { httpError } from "./errors.js";
import { vercelConfig, vercelRequest } from "./vercel.js";

// The version number comes from the release commit message, which ends with it, for example "(1.1.47)".
const versionOf = (text) => (String(text).match(/\((\d+\.\d+\.\d+)\)/) || [])[1] || "";

// Recent production releases, newest first, one row per version.
export async function listReleases() {
  const { projectId } = vercelConfig();
  const qs = new URLSearchParams({ projectId, target: "production", limit: "15" });
  const data = await vercelRequest(`/v6/deployments?${qs}`);
  const seen = new Set();
  const deployments = (data.deployments || [])
    .filter((d) => d.state === "READY" || d.readyState === "READY")
    .map((d) => {
      const message = String(d.meta?.githubCommitMessage || "");
      return { id: d.uid, created: d.created || d.createdAt || 0, version: versionOf(message), commit: message.split("\n")[0].slice(0, 120) };
    })
    .filter((d) => { const key = d.version || d.id; if (seen.has(key)) return false; seen.add(key); return true; });
  return { deployments };
}

// Makes an earlier production release live. Only the code changes: data and Firestore rules stay as they are.
export async function rollbackTo(adminUid, deploymentId) {
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) throw httpError(400, "Choose a valid release.");
  const { projectId } = vercelConfig();
  await vercelRequest(`/v10/projects/${encodeURIComponent(projectId)}/promote/${deploymentId}`, { method: "POST" });
  await adminDb().collection("audit").add({ action: "app.rollback", by: adminUid, details: { deploymentId }, at: FieldValue.serverTimestamp() });
  return { ok: true };
}
