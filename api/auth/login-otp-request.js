import { adminAuth, adminDb } from "../../server/firebase-admin.js";
import { handle, httpError, requireStaff } from "../../server/http.js";
import { sendMail } from "../../server/mail.js";
import { loadEmailConfig, renderEmail } from "../../server/templates.js";
import { generateOtp, newSalt, hashCode } from "../../server/secrets.js";

const MINUTE = 60_000;
const maskEmail = (e) => String(e).replace(/^(.).*(@.*)$/, "$1***$2");

// Sends a sign-in code to a staff member whose account asks for one at every sign-in.
// The "otp" claim is cleared here, so the account cannot read data until the code is entered.
export default handle(async (req) => {
  const { uid, email, profile } = await requireStaff(req);
  if (profile.requireOtp !== true) throw httpError(400, "This account does not use sign-in codes.");

  const ref = adminDb().doc(`loginOtps/${uid}`);
  const prev = (await ref.get()).data() || {};
  if (prev.lastSentAt && Date.now() - prev.lastSentAt < MINUTE) {
    throw httpError(429, "A code was sent a moment ago. Please wait a minute before asking for another.");
  }

  const cfg = await loadEmailConfig();
  const code = generateOtp();
  const salt = newSalt();
  await ref.set({
    salt, hash: hashCode(code, salt), expiresAt: Date.now() + cfg.otpExpiryMinutes * MINUTE, attempts: 0, lastSentAt: Date.now(),
  });
  await adminAuth().setCustomUserClaims(uid, { otp: false });

  const mail = renderEmail("login", cfg, { name: profile.name || "", password: code, minutes: cfg.otpExpiryMinutes });
  try {
    await sendMail({ to: email, subject: mail.subject, text: mail.text, html: mail.html });
  } catch (err) {
    if (err.expose) throw err;
    throw httpError(502, `The sign-in code could not be sent by email. ${err.message}`);
  }
  return { ok: true, sentTo: maskEmail(email) };
});
