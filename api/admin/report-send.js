import { adminDb } from "../../server/firebase-admin.js";
import { handle, httpError, requireAdmin } from "../../server/http.js";
import { sendScheduleNow } from "../../server/report-job.js";

// Sends a saved schedule now, for yesterday, so the admin can check the email before the time comes.
export default handle(async (req) => {
  await requireAdmin(req);
  const id = String(req.body?.scheduleId || "");
  const items = (await adminDb().doc("settings/reportSchedules").get()).data()?.items || [];
  const schedule = items.find((s) => s.id === id);
  if (!schedule) throw httpError(404, "Save the schedule first, then send it.");
  if (!schedule.recipients?.length) throw httpError(400, "Add at least one recipient.");
  try {
    const sent = await sendScheduleNow(schedule);
    return { ok: true, to: sent.to, reportDate: sent.reportDate };
  } catch (err) {
    if (err.expose) throw err;
    throw httpError(502, `The report could not be sent. ${err.message}`);
  }
});
