import { adminAuth, adminDb } from "../../server/firebase-admin.js";
import { handle, httpError, requireStaff } from "../../server/http.js";

// One endpoint for the sign-in lock (the Hobby plan allows 12 functions per deployment).
// action "failed": called after a wrong email or password (no sign-in needed). After 5 wrong passwords the
// profile is locked until an administrator unlocks it. Locking sets active to false, so the database rules refuse it too.
// action "ok": called after a correct sign-in (must be signed in). Clears the wrong-password count.
const MAX_WRONG = 5;

export default handle(async (req) => {
  const action = req.body?.action;

  if (action === "ok") {
    const { uid } = await requireStaff(req);
    await adminDb().doc(`users/${uid}`).update({ failedLogins: 0 });
    return { ok: true };
  }

  if (action !== "failed") throw httpError(400, "Unknown request.");
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return { ok: true };
  let user;
  try {
    user = await adminAuth().getUserByEmail(email);
  } catch {
    return { ok: true }; // unknown email: say nothing
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
