// TEMPORARY diagnostic (administrators only): sends three test emails with a dummy code to the signed-in
// administrator's own address, so we can see how Gmail treats each format. Remove once the fix is approved.
// Uses the saved Resend key and sender as-is. Logs only the status and the Resend email ID, never keys or codes.
import { adminAuth } from "./firebase-admin.js";
import { mailConfig, senderHeader } from "./mail.js";
import { loadEmailConfig } from "./templates.js";
import { renderOtpEmail } from "./otp-email.js";
import { httpError } from "./http.js";

const TEST_CODE = "123456"; // dummy code, never a real sign-in code

async function resendSend({ apiKey, from, to, subject, text, html }) {
  const body = { from, to: [to], subject, text };
  if (html) body.html = html;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json = {};
  try { json = JSON.parse(raw); } catch { /* not JSON */ }
  const result = { status: res.status, id: json.id || null, error: res.ok ? "" : String(json.message || raw).slice(0, 160) };
  console.log(JSON.stringify({ diagnostic: subject, status: result.status, resendId: result.id }));
  return result;
}

export async function sendEmailDiagnostics(uid) {
  const user = await adminAuth().getUser(uid);
  if (!user.email) throw httpError(400, "Your account has no email address.");
  const c = await mailConfig();
  if (c.provider !== "resend" || !c.resendApiKey || !c.from) {
    throw httpError(400, "Choose Resend in Administration → Integrations, with a sender address, before running this test.");
  }
  const cfg = await loadEmailConfig();
  const from = senderHeader(c.from, c.shopName);
  const plain = `Your verification code is ${TEST_CODE}`;
  const otp = renderOtpEmail(cfg, { name: "Test", code: TEST_CODE });

  const formats = [
    { format: "A", label: "Plain text only", subject: "MediPOS diagnostic A: plain text", text: `${plain}\n`, html: undefined },
    { format: "B", label: "Minimal HTML + plain text", subject: "MediPOS diagnostic B: minimal HTML", text: `${plain}\n`,
      html: `<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a">Your verification code is <strong>${TEST_CODE}</strong></p>` },
    { format: "C", label: "Branded HTML + plain text (current template)", subject: `MediPOS diagnostic C: ${otp.subject}`, text: otp.text, html: otp.html },
  ];

  const results = [];
  for (const f of formats) {
    const sent = await resendSend({ apiKey: c.resendApiKey, from, to: user.email, subject: f.subject, text: f.text, html: f.html });
    results.push({
      format: f.format,
      label: f.label,
      subject: f.subject,
      textHasCode: f.text.includes(TEST_CODE),
      htmlHasCode: f.html ? f.html.includes(TEST_CODE) : null,
      status: sent.status,
      resendId: sent.id,
      error: sent.error,
    });
  }
  return { sentTo: user.email, results };
}
