import { handle, requireAdmin } from "../../server/http.js";
import { vercelConfig, vercelRequest } from "../../server/vercel.js";

// Lists recent production releases, newest first, so an administrator can see what can be restored.
// The version number comes from the release commit message, which ends with it, for example "(1.1.47)".
const versionOf = (text) => (String(text).match(/\((\d+\.\d+\.\d+)\)/) || [])[1] || "";

export default handle(async (req) => {
  await requireAdmin(req);
  const { projectId } = vercelConfig();
  const qs = new URLSearchParams({ projectId, target: "production", limit: "15" });
  const data = await vercelRequest(`/v6/deployments?${qs}`);
  const seen = new Set();
  const deployments = (data.deployments || [])
    .filter((d) => d.state === "READY" || d.readyState === "READY")
    .map((d) => {
      const message = String(d.meta?.githubCommitMessage || "");
      return {
        id: d.uid,
        created: d.created || d.createdAt || 0,
        version: versionOf(message),
        commit: message.split("\n")[0].slice(0, 120),
      };
    })
    // One row per version: the newest deployment of each version.
    .filter((d) => { const key = d.version || d.id; if (seen.has(key)) return false; seen.add(key); return true; });
  return { deployments };
});
