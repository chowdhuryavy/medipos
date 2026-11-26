import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../server/firebase-admin.js";
import { handle, httpError, requireAdmin } from "../../server/http.js";

// Admin deletes a staff login: the sign-in and the profile go. Past sales and journal entries keep the name they were made with.
export default handle(async (req) => {
  const admin = await requireAdmin(req);
  const uid = String(req.body?.uid || "");
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
});
