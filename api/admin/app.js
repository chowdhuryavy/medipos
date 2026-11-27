import { handle, httpError, requireAdmin } from "../../server/http.js";
import { listReleases, rollbackTo } from "../../server/app-versions.js";

// One admin endpoint for app versions, to stay within the hosting plan's function limit.
export default handle(async (req) => {
  const admin = await requireAdmin(req);
  const action = req.body?.action;
  if (action === "versions") return listReleases();
  if (action === "rollback") return rollbackTo(admin.uid, String(req.body?.deploymentId || ""));
  throw httpError(400, "Unknown app action.");
});
