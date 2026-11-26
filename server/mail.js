import nodemailer from "nodemailer";

// Gmail (or any SMTP host) via environment variables:
// SMTP_USER, SMTP_PASS (App Password), MAIL_FROM, optional SMTP_HOST and SMTP_PORT.
let transport = null;

export async function sendMail({ to, subject, text, html }) {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) throw new Error("Email is not configured: set SMTP_USER and SMTP_PASS in Vercel.");
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }
  await transport.sendMail({ from: process.env.MAIL_FROM || user, to, subject, text, html });
}

export const APP_URL = process.env.APP_URL || "https://medipos-delta.vercel.app";

export function emailShell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:480px;margin:24px auto;background:#ffffff;border-radius:16px;overflow:hidden">
    <div style="background:#0f766e;color:#fff;padding:18px 22px;font-size:18px;font-weight:700">MediPOS</div>
    <div style="padding:22px;color:#0f172a;line-height:1.5">
      <h2 style="margin:0 0 10px;font-size:18px">${title}</h2>${bodyHtml}
      <p style="color:#64748b;font-size:12px;margin-top:22px">If you did not expect this email, contact your administrator.</p>
    </div></div></body></html>`;
}
