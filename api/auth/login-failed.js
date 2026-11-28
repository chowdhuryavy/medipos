import { adminAuth, adminDb } from "../../server/firebase-admin.js";
import { handle, httpError } from "../../server/http.js";

// After 5 wrong passwords the staff profile is locked until an administrator unlocks it.
// Locking sets active to false, so the database rules also refuse that account.
const MAX_WRONG = 5;

// Called by the sign-in page after a wrong email or password. It never says whether an email exists.
export default handle(async (req) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return { ok: true };
  let user;
  try {
    user = await adminAuth().getUserByEmail(email);
  } catch {
    return { ok: true };
  }
  const ref = adminDb().doc(`users/${user.uid}`);
  const p = (await ref.get()).data();
  if (!p || p.active !== true) return { ok: true, locked: Boolean(p?.lockedAt) };
  const next = (p.failedLogins || 0) + 1;
  if (next >= MAX_WRONG) {
    await ref.update({ failedLogins: next, active: false, lockedAt: Date.now(), lockedReason: `${MAX_WRONG} wrong passwords` });
    return { ok: true, locked: true };
  }
  await ref.update({ failedLogins: next });
  return { ok: true, locked: false };
});
