import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../server/firebase-admin.js";
import { handle, httpError } from "../../server/http.js";
import { sendMail } from "../../server/mail.js";
import { loadEmailConfig, renderEmail } from "../../server/templates.js";
import { generateOtp, newSalt, hashCode } from "../../server/secrets.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Step 1 of forgot-password: find the staff account by email and email a 6-digit code.
export default handle(async (req) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw httpError(400, "Enter a valid email address.");

  let user;
  try {
    user = await adminAuth().getUserByEmail(email);
  } catch (err) {
    if (err.code === "auth/user-not-found") throw httpError(404, "No account uses this email.");
    throw err;
  }

  const profile = (await adminDb().doc(`users/${user.uid}`).get()).data();
  if (!profile || profile.active !== true) throw httpError(403, "This account is not active. Ask an administrator.");

  const ref = adminDb().doc(`passwordResets/${user.uid}`);
  const prev = (await ref.get()).data() || {};
  const now = Date.now();
  if (prev.lastSentAt && now - prev.lastSentAt < MINUTE) {
    throw httpError(429, "Please wait a minute before requesting another code.");
  }
  const windowOpen = prev.windowStart && now - prev.windowStart < HOUR;
  if (windowOpen && prev.windowCount >= 5) throw httpError(429, "Too many codes requested. Try again in an hour.");

  const code = generateOtp();
  const salt = newSalt();
  await ref.set({
    salt,
    hash: hashCode(code, salt),
    expiresAt: now + 10 * MINUTE,
    attempts: 0,
    lastSentAt: now,
    windowStart: windowOpen ? prev.windowStart : now,
    windowCount: windowOpen ? prev.windowCount + 1 : 1,
  });

  const mail = renderEmail("otp", await loadEmailConfig(), { name: profile.name || "", email, code });
  await sendMail({ to: email, subject: mail.subject, text: mail.text, html: mail.html });

  return { ok: true, message: "A 6-digit code has been sent to your email." };
});
