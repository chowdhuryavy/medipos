import nodemailer from "nodemailer";
import { configError } from "./errors.js";
import { adminDb } from "./firebase-admin.js";

// Mail settings are saved by an administrator in Administration → Integrations (settings/integrations).
// Environment variables are used for any field left empty, so older Vercel setups keep working.
export async function mailConfig() {
  const snap = await adminDb().doc("settings/integrations").get();
  const s = snap.data() || {};
  const env = process.env;
  return {
    provider: s.emailProvider || "",
    resendApiKey: s.resendApiKey || env.RESEND_API_KEY || "",
    from: s.mailFrom || env.MAIL_FROM || "",
    smtpHost: s.smtpHost || env.SMTP_HOST || "smtp.gmail.com",
    smtpPort: Number(s.smtpPort || env.SMTP_PORT || 465),
    smtpUser: s.smtpUser || env.SMTP_USER || "",
    smtpPass: s.smtpPass || env.SMTP_PASS || "",
  };
}

export async function sendMail({ to, subject, text, html }) {
  const c = await mailConfig();
  const useResend = c.provider === "resend" || (!c.provider && !!c.resendApiKey);
  if (useResend) {
    if (!c.resendApiKey) throw configError("Resend is selected but no API key is saved. Add it in Administration → Integrations.");
    if (!c.from) throw configError("Set the sender address in Administration → Integrations. Use an address on your verified Resend domain.");
    return sendWithResend({ apiKey: c.resendApiKey, from: c.from, to, subject, text, html });
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
  await transport.sendMail({ from: c.from || c.smtpUser, to, subject, text, html });
}

async function sendWithResend({ apiKey, from, to, subject, text, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Resend rejected the email (${res.status}). ${detail}`);
  }
}

export const APP_URL = process.env.APP_URL || "https://medipos-delta.vercel.app";
