import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../server/firebase-admin.js";
import { handle, httpError, requireAdmin } from "../../server/http.js";
import { sendMail } from "../../server/mail.js";
import { loadEmailConfig, renderEmail } from "../../server/templates.js";
import { generateTempPassword } from "../../server/secrets.js";


// Admin creates a staff account. A temporary password is emailed and must be changed at first sign-in.
export default handle(async (req) => {
  const admin = await requireAdmin(req);
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const role = String(req.body?.role || "");
  if (!name) throw httpError(400, "Enter the staff member's name.");
  if (!/^\S+@\S+\.\S+$/.test(email)) throw httpError(400, "Enter a valid email address.");
  const roleDoc = (await adminDb().doc("settings/roles").get()).data() || {};
  if (!role || !(role in roleDoc)) throw httpError(400, "Choose a valid role.");

  const tempPassword = generateTempPassword();
  let created;
  try {
    created = await adminAuth().createUser({ email, password: tempPassword, displayName: name });
  } catch (err) {
    if (err.code === "auth/email-already-exists") throw httpError(409, "Another login already uses this email.");
    throw err;
  }

  try {
    const mail = renderEmail("welcome", await loadEmailConfig(), { name, email, password: tempPassword });
    await sendMail({ to: email, subject: mail.subject, text: mail.text, html: mail.html });
  } catch (err) {
    // Do not leave an account nobody can sign in to.
    await adminAuth().deleteUser(created.uid);
    if (err.expose) throw err;
    throw httpError(502, `The welcome email could not be sent, so the account was not created. ${err.message}`);
  }

  await adminDb().doc(`users/${created.uid}`).set({
    name, email, role, active: true, mustChangePassword: true, createdAt: FieldValue.serverTimestamp(),
  });
  await adminDb().collection("audit").add({ action: "user.create", by: admin.uid, details: { email, role }, at: FieldValue.serverTimestamp() });
  return { ok: true, uid: created.uid };
});
