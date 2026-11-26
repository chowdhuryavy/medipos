import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../server/firebase-admin.js";
import { handle, httpError, requireAdmin } from "../../server/http.js";
import { sendMail } from "../../server/mail.js";
import { loadEmailConfig, renderEmail } from "../../server/templates.js";
import { generateTempPassword } from "../../server/secrets.js";

// Admin resets a staff password: a new temporary password is emailed and must be changed at next sign-in.
export default handle(async (req) => {
  const admin = await requireAdmin(req);
  const uid = String(req.body?.uid || "");
  if (!uid) throw httpError(400, "Choose a staff member.");

  const profile = (await adminDb().doc(`users/${uid}`).get()).data();
  if (!profile) throw httpError(404, "Staff profile not found.");
  const user = await adminAuth().getUser(uid);

  const tempPassword = generateTempPassword();
  await adminAuth().updateUser(uid, { password: tempPassword });
  await adminAuth().revokeRefreshTokens(uid);
  await adminDb().doc(`users/${uid}`).set({ mustChangePassword: true }, { merge: true });

  const mail = renderEmail("reset", await loadEmailConfig(), { name: profile.name || "", email: user.email, password: tempPassword });
  try {
    await sendMail({ to: user.email, subject: mail.subject, text: mail.text, html: mail.html });
  } catch (err) {
    if (err.expose) throw err;
    throw httpError(502, `The reset email could not be sent, so the password was not changed. ${err.message}`);
  }
  await adminDb().collection("audit").add({ action: "user.password_reset", by: admin.uid, details: { uid }, at: FieldValue.serverTimestamp() });
  return { ok: true };
});
