import nodemailer from "nodemailer";
import { configError } from "./errors.js";
import { adminDb } from "./firebase-admin.js";

// Mail settings are saved by an administrator in Administration → Integrations (settings/integrations).
// Environment variables are used for any field left empty, so older Vercel setups keep working.
export async function mailConfig() {
  const [snap, sec] = await Promise.all([adminDb().doc("settings/integrations").get(), adminDb().doc("settings/secrets").get()]);
  const s = snap.data() || {};
  const secrets = sec.data() || {};
  const env = process.env;
  return {
    provider: s.emailProvider || "",
    resendApiKey: secrets.resendApiKey || s.resendApiKey || env.RESEND_API_KEY || "",
    from: s.mailFrom || env.MAIL_FROM || "",
    smtpHost: s.smtpHost || env.SMTP_HOST || "smtp.gmail.com",
    smtpPort: Number(s.smtpPort || env.SMTP_PORT || 465),
    smtpUser: s.smtpUser || env.SMTP_USER || "",
    smtpPass: secrets.smtpPass || s.smtpPass || env.SMTP_PASS || "",
  };
}

// attachments: [{ filename, content: Uint8Array }]. to may be one address or a list.
export async function sendMail({ to, subject, text, html, attachments = [] }) {
  const c = await mailConfig();
  const useResend = c.provider === "resend" || (!c.provider && !!c.resendApiKey);
  if (useResend) {
    if (!c.resendApiKey) throw configError("Resend is selected but no API key is saved. Add it in Administration → Integrations.");
    if (!c.from) throw configError("Set the sender address in Administration → Integrations. Use an address on your verified Resend domain.");
    return sendWithResend({ apiKey: c.resendApiKey, from: c.from, to, subject, text, html, attachments });
  }
  if (!c.smtpUser || !c.smtpPass) {
    throw configError("Email is not set up yet. Choose Resend or SMTP in Administration → Integrations and save it.");
  }
  const transport = nodemailer.createTransport({
    host: c.smtpHost,
    port: c.smtpPort,
    secure: c.smtpPort === 465,
    auth: { user: c.smtpUser, pass: c.smtpPass },
  });
  await transport.sendMail({
    from: c.from || c.smtpUser, to: [].concat(to).join(","), subject, text, html,
    attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content) })),
  });
}

async function sendWithResend({ apiKey, from, to, subject, text, html, attachments = [] }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from, to: [].concat(to), subject, text, html,
      attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64") })),
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Resend rejected the email (${res.status}). ${detail}`);
  }
}

export const APP_URL = process.env.APP_URL || "https://medipos-delta.vercel.app";
