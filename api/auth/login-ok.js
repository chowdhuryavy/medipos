import { adminDb } from "../../server/firebase-admin.js";
import { handle, requireStaff } from "../../server/http.js";

// A correct sign-in clears the wrong-password count.
export default handle(async (req) => {
  const { uid } = await requireStaff(req);
  await adminDb().doc(`users/${uid}`).update({ failedLogins: 0 });
  return { ok: true };
});
