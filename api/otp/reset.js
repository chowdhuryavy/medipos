import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../server/firebase-admin.js";
import { handle, httpError } from "../../server/http.js";
import { codeMatches } from "../../server/secrets.js";
import { passwordProblem } from "../../js/password.js";

// Step 2 of forgot-password: check the code and set the new password.
export default handle(async (req) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const code = String(req.body?.code || "").trim();
  const password = String(req.body?.password || "");
  if (!/^\d{6}$/.test(code)) throw httpError(400, "Enter the 6-digit code from your email.");
  const problem = passwordProblem(password);
  if (problem) throw httpError(400, problem);

  let user;
  try {
    user = await adminAuth().getUserByEmail(email);
  } catch {
    throw httpError(400, "The code is not valid. Request a new one.");
  }

  const ref = adminDb().doc(`passwordResets/${user.uid}`);
  const rec = (await ref.get()).data();
  if (!rec) throw httpError(400, "The code is not valid. Request a new one.");
  if (Date.now() > rec.expiresAt) throw httpError(400, "The code has expired. Request a new one.");
  if (rec.attempts >= 5) throw httpError(429, "Too many wrong codes. Request a new one.");

  if (!codeMatches(code, rec.salt, rec.hash)) {
    await ref.update({ attempts: FieldValue.increment(1) });
    throw httpError(400, "The code is wrong.");
  }

  await adminAuth().updateUser(user.uid, { password });
  await adminAuth().revokeRefreshTokens(user.uid);
  await ref.delete();
  await adminDb().doc(`users/${user.uid}`).set({ mustChangePassword: false, passwordChangedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});
