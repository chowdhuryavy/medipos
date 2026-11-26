import { adminDb } from "./firebase-admin.js";
import { APP_URL } from "./mail.js";

import { DEFAULT_TEMPLATES } from "../js/email-defaults.js";

export { DEFAULT_TEMPLATES };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Loads branding (app name, shop name, logo flag) and the admin's email texts. */
export async function loadEmailConfig() {
  const db = adminDb();
  const [brand, stored] = await Promise.all([
    db.doc("branding/public").get(),
    db.doc("settings/emails").get(),
  ]);
  const b = brand.data() || {};
  const s = stored.data() || {};
  const templates = {};
  for (const key of Object.keys(DEFAULT_TEMPLATES)) {
    templates[key] = { ...DEFAULT_TEMPLATES[key], ...(s[key] || {}) };
  }
  return {
    appName: b.shopName || b.appName || "MediPOS",
    shopName: b.shopName || "My Pharmacy",
    hasLogo: !!b.logoUrl,
    templates,
  };
}

function fill(text, vars) {
  return String(text || "").replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// Look per email type. The brand teal stays; each type has its own icon and accent.
const THEMES = {
  welcome: { icon: "&#127881;", accent: "#0f766e", soft: "#ecfdf5", border: "#99f6e4", eyebrow: "Welcome" },
  reset: { icon: "&#128273;", accent: "#b45309", soft: "#fffbeb", border: "#fcd34d", eyebrow: "Account update" },
};
const DEFAULT_THEME = { icon: "&#9993;", accent: "#0f766e", soft: "#f0fdfa", border: "#99f6e4", eyebrow: "Notice" };

/** Builds the subject, HTML and plain-text version of one email. Values are escaped in the HTML. */
export function renderEmail(key, cfg, values) {
  const t = cfg.templates[key];
  const theme = THEMES[key] || DEFAULT_THEME;
  const vars = { appName: cfg.appName, shopName: cfg.shopName, loginUrl: APP_URL, ...values };
  const subject = fill(t.subject, vars);
  const text = fill(t.body, vars);
  const button = t.button ? fill(t.button, vars) : "";

  // Passwords get a highlighted card. Markers survive escaping, then become HTML.
  const marked = fill(t.body, Object.fromEntries(Object.entries(vars).map(([k, v]) =>
    [k, ["code", "password"].includes(k) && v ? `\u0001${k}\u0002${v}\u0003` : v])));
  const paragraphs = esc(marked)
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:1.65">${para
      .replace(/\n/g, "<br/>")
      .replace(/\u0001(\w+)\u0002([^\u0003]*)\u0003/g, (_, k, v) => k === "code"
        ? `<span style="display:inline-block;margin:6px 0;padding:12px 22px;border-radius:12px;background:${theme.soft};border:1px solid ${theme.border};font-family:'Courier New',Courier,monospace;font-size:30px;font-weight:700;letter-spacing:7px;color:${theme.accent};user-select:all">${v}</span>`
        : `<span style="display:inline-block;margin:6px 0;padding:10px 18px;border-radius:12px;background:${theme.soft};border:1px dashed ${theme.accent};font-family:'Courier New',Courier,monospace;font-size:17px;font-weight:700;letter-spacing:1px;color:${theme.accent};user-select:all">${v}</span>`)}</p>`)
    .join("");

  const logo = cfg.hasLogo
    ? `<img src="${esc(APP_URL)}/api/logo" width="40" height="40" alt="${esc(cfg.appName)} logo" style="display:block;width:40px;height:40px;border:0;border-radius:10px;background:#ffffff" />`
    : `<span style="display:inline-block;width:40px;height:40px;line-height:40px;text-align:center;border-radius:10px;background:rgba(255,255,255,.18);font-size:20px">&#127973;</span>`;
  const btn = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 6px"><tr><td bgcolor="${theme.accent}" style="background:${theme.accent};border-radius:12px"><a href="${esc(APP_URL)}" style="display:inline-block;padding:13px 26px;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:15px">${esc(button)}</a></td></tr></table>`
    : "";
  const preheader = text.replace(/\s+/g, " ").slice(0, 110);

  const shell = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${esc(subject)}</title>
<style>
  body { margin:0; padding:0; width:100% !important; background:#eef2f5; -webkit-text-size-adjust:100%; }
  table { border-collapse:collapse; }
  @media only screen and (max-width:600px) {
    .card { width:100% !important; border-radius:0 !important; }
    .pad { padding:26px 20px !important; }
  }
  @media (prefers-reduced-motion: no-preference) {
    .fade { animation: mFade .7s ease-out both; }
    .ring { animation: mPulse 2.6s ease-in-out infinite; }
    @keyframes mFade { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
    @keyframes mPulse { 0%,100% { box-shadow:0 0 0 0 ${theme.border}; } 50% { box-shadow:0 0 0 12px rgba(0,0,0,0); } }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#eef2f5;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2f5" style="background:#eef2f5">
  <tr><td align="center" style="padding:32px 12px">
    <table role="presentation" class="card fade" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #dbe4ea">

      <tr><td bgcolor="#0b4f4a" style="background:#0b4f4a;background-image:linear-gradient(135deg,#0b4f4a 0%,#0f766e 60%,#14b8a6 100%);padding:22px 28px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="middle" style="padding-right:12px">${logo}</td>
          <td valign="middle">
            <div style="color:#ffffff;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700;letter-spacing:.3px">${esc(cfg.appName)}</div>
            <div style="color:#ccfbf1;font-size:11px;letter-spacing:1.5px;text-transform:uppercase">${esc(cfg.shopName)}</div>
          </td>
        </tr></table>
      </td></tr>

      <tr><td class="pad" style="padding:34px 36px 10px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 18px"><tr>
          <td class="ring" align="center" valign="middle" width="64" height="64" bgcolor="${theme.soft}" style="width:64px;height:64px;border-radius:32px;background:${theme.soft};border:1px solid ${theme.border};text-align:center;font-size:28px;line-height:64px">${theme.icon}</td>
        </tr></table>
        <p style="margin:0 0 6px;text-align:center;color:${theme.accent};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase">${esc(theme.eyebrow)}</p>
        <h1 style="margin:0 0 20px;text-align:center;color:#0f172a;font-family:Georgia,'Times New Roman',serif;font-size:23px;line-height:1.3;font-weight:700">${esc(subject)}</h1>
        ${paragraphs}
        ${btn}
      </td></tr>

      <tr><td style="padding:20px 36px 26px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.6;text-align:center">
        ${esc(cfg.shopName)} &middot; Sent by ${esc(cfg.appName)}<br/>
        This is an automated message. If you did not expect it, contact your administrator.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  return { subject, text, html: shell };
}
