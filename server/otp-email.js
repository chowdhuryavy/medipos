// Password reset code email (HTML + plain text).
// Tables and inline styles for Gmail, Outlook and Apple Mail. The <style> block only adds
// subtle motion where supported; everything reads well without it.
// Placeholders: {{name}} {{code}} {{shopName}} {{appName}} {{logoBlock}} {{year}}
import { APP_URL } from "./mail.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const OTP_SUBJECT = "Your Password Reset Code – {{shopName}}";

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>Password Reset Code – {{shopName}}</title>
<style>
  body { margin:0; padding:0; width:100% !important; background:#eef2f5; -webkit-text-size-adjust:100%; }
  table { border-collapse:collapse; }
  @media only screen and (max-width:600px) {
    .card { width:100% !important; border-radius:0 !important; }
    .pad { padding:26px 20px !important; }
    .code { font-size:30px !important; letter-spacing:6px !important; }
  }
  @media (prefers-reduced-motion: no-preference) {
    .fade { animation: otpFade .7s ease-out both; }
    .ring { animation: otpPulse 2.6s ease-in-out infinite; }
    @keyframes otpFade { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
    @keyframes otpPulse { 0%,100% { box-shadow:0 0 0 0 rgba(20,184,166,.45); } 50% { box-shadow:0 0 0 12px rgba(20,184,166,0); } }
  }
</style>
</head>
<body style="margin:0; padding:0; background:#eef2f5; font-family:Arial, Helvetica, sans-serif;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">Your verification code is {{code}}. It expires in 10 minutes.</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2f5" style="background:#eef2f5;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" class="card fade" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px; max-width:560px; background:#ffffff; border-radius:18px; overflow:hidden; border:1px solid #dbe4ea;">

        <!-- Header -->
        <tr>
          <td bgcolor="#0b4f4a" style="background:#0b4f4a; background-image:linear-gradient(135deg,#0b4f4a 0%,#0f766e 60%,#14b8a6 100%); padding:22px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding-right:12px;">{{logoBlock}}</td>
                <td valign="middle" style="color:#ffffff; font-family:Georgia, 'Times New Roman', serif; font-size:20px; font-weight:700; letter-spacing:.3px;">{{shopName}}</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td class="pad" style="padding:34px 36px 8px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 18px;">
              <tr>
                <td class="ring" align="center" valign="middle" width="64" height="64" bgcolor="#ecfdf5" style="width:64px; height:64px; border-radius:32px; background:#ecfdf5; border:1px solid #99f6e4; text-align:center; font-size:30px; line-height:64px;">&#128737;</td>
              </tr>
            </table>

            <h1 style="margin:0 0 12px; text-align:center; color:#0f172a; font-family:Georgia, 'Times New Roman', serif; font-size:24px; line-height:1.3; font-weight:700;">Password reset request</h1>
            <p style="margin:0 0 22px; color:#334155; font-size:15px; line-height:1.6; text-align:center;">Hello {{name}}, we received a request to reset the password for your {{appName}} account.</p>

            <!-- OTP block: plain text, six digits, no spaces or decoration -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#f0fdfa" style="background:#f0fdfa; border:1px solid #99f6e4; border-radius:14px; padding:24px 16px;">
                  <p style="margin:0; color:#0f766e; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:2.2;">Your verification code is <span class="code" style="display:inline-block; font-family:'Courier New', Courier, monospace; font-size:34px; line-height:1.2; font-weight:700; letter-spacing:8px; color:#0b4f4a; user-select:all; -webkit-user-select:all;">{{code}}</span></p>
                </td>
              </tr>
            </table>

            <p style="margin:18px 0 0; color:#0f172a; font-size:14px; line-height:1.6; text-align:center;">This code expires in <strong>10 minutes</strong>. Enter it on the reset page to choose a new password.</p>
          </td>
        </tr>

        <!-- Security notice -->
        <tr>
          <td class="pad" style="padding:20px 36px 30px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="#fff7ed" style="background:#fff7ed; border-left:4px solid #f59e0b; border-radius:8px; padding:14px 16px; color:#78350f; font-size:13px; line-height:1.6;">
                  <strong>Keep this code private.</strong> Never share it with anyone, including shop staff. We will never ask you for it by phone or message.<br/>
                  If you did not request a password reset, you can safely ignore this email. Your password will not change.
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:18px 36px 26px; border-top:1px solid #e2e8f0; color:#64748b; font-size:12px; line-height:1.6; text-align:center;">
            {{shopName}} · Sent by {{appName}}<br/>
            This is an automated security message. Please do not reply.<br/>
            &copy; {{year}} {{shopName}}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

const TEXT = `{{shopName}} – Password Reset

Hello {{name}},

We received a request to reset the password for your {{appName}} account.

Your verification code is {{code}}

This code expires in 10 minutes. Enter it on the reset page to choose a new password.

Keep this code private. Never share it with anyone, including shop staff. We will never ask you for it by phone or message.

If you did not request a password reset, you can safely ignore this email. Your password will not change.

--
{{shopName}} · Sent by {{appName}}
This is an automated security message. Please do not reply.
`;

// Fills {{key}} tokens. HTML values are escaped; logoBlock is trusted markup built below.
function fill(template, values, { html }) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in values)) return m;
    return html && k !== "logoBlock" ? esc(values[k]) : String(values[k]);
  });
}

/**
 * Builds the subject, HTML and plain-text parts for a reset code email.
 * cfg: { appName, shopName, hasLogo }   values: { name, code }
 */
export function renderOtpEmail(cfg, { name, code }) {
  const shopName = cfg.shopName || cfg.appName || "My Pharmacy";
  const appName = cfg.appName || shopName;
  const logoBlock = cfg.hasLogo
    ? `<img src="${esc(APP_URL)}/api/logo" width="40" height="40" alt="${esc(shopName)} logo" style="display:block; width:40px; height:40px; border:0; border-radius:10px; background:#ffffff;" />`
    : "";
  const values = {
    name: name || "there",
    code: String(code),
    shopName,
    appName,
    year: new Date().getFullYear(),
    logoBlock,
  };
  return {
    subject: fill(OTP_SUBJECT, values, { html: false }),
    html: fill(HTML, values, { html: true }),
    text: fill(TEXT, values, { html: false }),
  };
}
