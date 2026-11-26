import nodemailer from "nodemailer";
import { configError } from "./errors.js";

// Chooses the sender from environment variables:
//   RESEND_API_KEY              → sends through Resend (sender must be on a domain you verified)
//   SMTP_USER + SMTP_PASS       → sends through Gmail (or any SMTP host)
let transport = null;

export async function sendMail({ to, subject, text, html }) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  if (process.env.RESEND_API_KEY) {
    if (!from) throw configError("Email is not set up yet: MAIL_FROM is missing in Vercel. Use an address on your verified domain.");
    return sendWithResend({ from, to, subject, text, html });
  }
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    throw configError("Email is not set up yet: add RESEND_API_KEY, or SMTP_USER and SMTP_PASS, in Vercel, then redeploy.");
  }
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }
  await transport.sendMail({ from, to, subject, text, html });
}

async function sendWithResend({ from, to, subject, text, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
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
