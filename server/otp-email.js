// Password reset code email (HTML + plain text). All wording, colours and footer come from Settings.
// Placeholders: {{name}} {{code}} {{minutes}} {{shopName}} {{appName}}
import { fill, esc, brandPalette, shell } from "./email-layout.js";

export function renderOtpEmail(cfg, { name, code }) {
  const t = cfg.templates.otp;
  const pal = brandPalette(cfg.brandColor);
  const shopName = cfg.shopName || cfg.appName || "My Pharmacy";
  const appName = cfg.appName || shopName;
  const vars = { name: name || "there", code: String(code), shopName, appName, minutes: cfg.otpExpiryMinutes };

  // The code is always in the subject too, so mail apps such as Gmail can offer their Copy code button.
  const filledSubject = fill(t.subject, vars);
  const subject = filledSubject.includes(vars.code) ? filledSubject : `${vars.code} – ${filledSubject}`;
  const greeting = fill(t.greeting, vars, { html: true });
  const intro = fill(t.intro, vars, { html: true });
  const codeLabel = fill(t.codeLabel, vars, { html: true });
  const expiry = fill(t.expiryNote, vars, { html: true });
  const security = fill(t.securityNote, vars, { html: true }).replace(/\n/g, "<br/>");
  const footerText = esc(fill(cfg.emailFooter, vars)).replace(/\n/g, "<br/>");

  const bodyHtml = `
    <p style="margin:0 0 14px; color:#0f172a; font-size:15px; line-height:1.6;">${greeting}</p>
    <p style="margin:0 0 22px; color:#334155; font-size:15px; line-height:1.6;">${intro}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center" bgcolor="${pal.soft}" style="background:${pal.soft}; border:1px solid ${pal.border}; border-radius:14px; padding:24px 16px;">
        <p style="margin:0; color:${pal.dark}; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:2.2;">${codeLabel} <span class="code" style="display:inline-block; font-family:'Courier New', Courier, monospace; font-size:34px; line-height:1.2; font-weight:700; letter-spacing:8px; color:${pal.dark}; user-select:all; -webkit-user-select:all;">${esc(vars.code)}</span></p>
      </td></tr>
    </table>
    <p style="margin:18px 0 0; color:#0f172a; font-size:14px; line-height:1.6; text-align:center;">${expiry}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px">
      <tr><td bgcolor="#fff7ed" style="background:#fff7ed; border-left:4px solid #f59e0b; border-radius:8px; padding:14px 16px; color:#78350f; font-size:13px; line-height:1.6;">${security}</td></tr>
    </table>`;

  const textParts = [
    shopName,
    fill(t.greeting, vars),
    fill(t.intro, vars),
    `${fill(t.codeLabel, vars)} ${vars.code}`,
    fill(t.expiryNote, vars),
    fill(t.securityNote, vars),
    `-- \n${fill(cfg.emailFooter, vars)}`,
  ];

  return {
    subject,
    text: textParts.join("\n\n") + "\n",
    html: shell({
      cfg, pal, subject,
      preheader: `${fill(t.codeLabel, vars)} ${fill(t.expiryNote, vars)}`,
      icon: "&#128737;",
      eyebrow: fill(t.eyebrow, vars),
      heading: fill(t.heading, vars),
      bodyHtml,
      footerText,
    }),
  };
}
