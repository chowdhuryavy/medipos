import { adminAuth, adminDb } from "./firebase-admin.js";
import { httpError } from "./errors.js";
import { sendMail } from "./mail.js";
import { sendScheduleNow } from "./report-job.js";

// Sends a short test email to the administrator who asked for it, using the saved email settings.
export async function sendTestEmail(uid) {
  const user = await adminAuth().getUser(uid);
  if (!user.email) throw httpError(400, "Your account has no email address.");
  try {
    await sendMail({
      to: user.email,
      subject: "MediPOS test email",
      text: "This is a test email from MediPOS. Email sending is working.",
      html: `<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a">This is a test email from MediPOS. Email sending is working.</p>`,
    });
  } catch (err) {
    if (err.expose) throw err;
    throw httpError(502, `The test email could not be sent. ${err.message}`);
  }
  return { ok: true, to: user.email };
}

// Sends a saved schedule now, for yesterday, so the admin can check the email before the time comes.
export async function sendReportNow(body) {
  const id = String(body?.scheduleId || "");
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
}
