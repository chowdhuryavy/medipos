import { adminAuth, adminDb } from "./firebase-admin.js";

import { HttpError, httpError } from "./errors.js";
export { HttpError, httpError };

/** Wraps an endpoint: POST only, JSON in/out, no internal error details leak to the browser. */
export function handle(fn) {
  return async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
    try {
      const out = await fn(req);
      return res.status(200).json(out || { ok: true });
    } catch (err) {
      if (err instanceof HttpError || err.expose) return res.status(err.status || 500).json({ error: err.message });
      console.error(err);
      return res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  };
}

/** Requires a valid Firebase ID token from an active administrator who has already changed their password. */
export async function requireAdmin(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!m) throw httpError(401, "Sign in first.");
  const decoded = await adminAuth().verifyIdToken(m[1]);
  const snap = await adminDb().doc(`users/${decoded.uid}`).get();
  const p = snap.data();
  if (!p || p.active !== true || p.role !== "admin") throw httpError(403, "Administrators only.");
  if (p.mustChangePassword === true) throw httpError(403, "Change your password before continuing.");
  return { uid: decoded.uid, name: p.name || decoded.email || "admin" };
}
