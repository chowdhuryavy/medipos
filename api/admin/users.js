import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../server/firebase-admin.js";
import { handle, httpError, requireAdmin } from "../../server/http.js";
import { sendMail } from "../../server/mail.js";
import { loadEmailConfig, renderEmail } from "../../server/templates.js";
import { generateTempPassword } from "../../server/secrets.js";

// One admin endpoint for staff logins: create, delete and reset password. Kept in one file to stay within the hosting plan's function limit.
export default handle(async (req) => {
  const admin = await requireAdmin(req);
  const action = req.body?.action;
  if (action === "create") return createUser(admin, req.body);
  if (action === "delete") return deleteUser(admin, req.body);
  if (action === "reset") return resetPassword(admin, req.body);
  throw httpError(400, "Unknown user action.");
});

// Admin creates a staff account. A temporary password is emailed and must be changed at first sign-in.
async function createUser(admin, body) {
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  const role = String(body?.role || "");
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
}

// Admin deletes a staff login: the sign-in and the profile go. Past sales and journal entries keep the name they were made with.
async function deleteUser(admin, body) {
  const uid = String(body?.uid || "");
  if (!uid) throw httpError(400, "Choose a staff member.");
  if (uid === admin.uid) throw httpError(400, "You cannot delete your own account.");

  const profile = (await adminDb().doc(`users/${uid}`).get()).data();
  if (!profile) throw httpError(404, "Staff profile not found.");
  if (profile.role === "admin" && profile.active !== false) {
    const admins = await adminDb().collection("users").where("role", "==", "admin").get();
    const others = admins.docs.filter((d) => d.id !== uid && d.data().active !== false);
    if (!others.length) throw httpError(400, "Keep at least one active administrator.");
  }

  try {
    await adminAuth().deleteUser(uid);
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
  }
  await adminDb().doc(`users/${uid}`).delete();
  await adminDb().collection("audit").add({ action: "user.delete", by: admin.uid, details: { uid, name: profile.name || "" }, at: FieldValue.serverTimestamp() });
  return { ok: true };
}

// Admin resets a staff password: a new temporary password is emailed and must be changed at next sign-in.
async function resetPassword(admin, body) {
  const uid = String(body?.uid || "");
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
}
