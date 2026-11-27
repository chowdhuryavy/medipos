import { handle, httpError, requireAdmin } from "../../server/http.js";
import { sendReportNow, sendTestEmail } from "../../server/admin-mail.js";
import { sendBackupNow } from "../../server/backup-job.js";

// One admin endpoint for email actions, to stay within the hosting plan's function limit.
export default handle(async (req) => {
  const admin = await requireAdmin(req);
  const action = req.body?.action;
  if (action === "test") return sendTestEmail(admin.uid);
  if (action === "report") return sendReportNow(req.body);
  if (action === "backup") return sendBackupNow();
  throw httpError(400, "Unknown email action.");
});
