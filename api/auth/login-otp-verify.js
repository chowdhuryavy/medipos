import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../server/firebase-admin.js";
import { handle, httpError, requireStaff } from "../../server/http.js";
import { codeMatches } from "../../server/secrets.js";

// Checks the sign-in code. On success the account gets the "otp" claim, which the database rules require.
export default handle(async (req) => {
  const { uid } = await requireStaff(req);
  const code = String(req.body?.code || "").trim();
  if (!/^\d{6}$/.test(code)) throw httpError(400, "Enter the 6-digit code from your email.");

  const ref = adminDb().doc(`loginOtps/${uid}`);
  const rec = (await ref.get()).data();
  if (!rec) throw httpError(400, "No code is waiting. Ask for a new one.");
  if (Date.now() > rec.expiresAt) throw httpError(400, "The code has expired. Ask for a new one.");
  if (rec.attempts >= 5) throw httpError(429, "Too many wrong codes. Ask for a new one.");
  if (!codeMatches(code, rec.salt, rec.hash)) {
    await ref.update({ attempts: FieldValue.increment(1) });
    throw httpError(400, "The code is wrong.");
  }

  await ref.delete();
  await adminAuth().setCustomUserClaims(uid, { otp: true });
  await adminDb().collection("audit").add({ action: "user.signin_code", by: uid, details: {}, at: FieldValue.serverTimestamp() });
  return { ok: true };
});
