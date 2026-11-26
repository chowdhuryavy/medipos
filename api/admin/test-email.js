import { adminAuth } from "../../server/firebase-admin.js";
import { handle, httpError, requireAdmin } from "../../server/http.js";
import { sendMail } from "../../server/mail.js";

// Sends a short test email to the administrator who asked for it, using the saved email settings.
export default handle(async (req) => {
  const admin = await requireAdmin(req);
  const user = await adminAuth().getUser(admin.uid);
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
});
