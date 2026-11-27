// Shared layout for app emails: brand colours, logo and name header, animated card, footer.
// Tables and inline styles for Gmail, Outlook and Apple Mail. The <style> block only adds motion where allowed.
import { APP_URL } from "./mail.js";
import { DEFAULT_BRAND_COLOR } from "../js/email-defaults.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Replaces {{key}} tokens. Unknown tokens stay as typed. html: true escapes the values. */
export function fill(text, values, { html = false } = {}) {
  return String(text ?? "").replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in values)) return m;
    return html ? esc(values[k]) : String(values[k]);
  });
}

const mixHex = (a, b, t) => "#" + [1, 3, 5].map((i) => {
  const x = parseInt(a.slice(i, i + 2), 16);
  const y = parseInt(b.slice(i, i + 2), 16);
  return Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
}).join("");

/** Brand colour from Settings → Branding, with darker, lighter and border shades worked out from it. */
export function brandPalette(color) {
  const base = /^#[0-9a-f]{6}$/i.test(String(color || "")) ? String(color).toLowerCase() : DEFAULT_BRAND_COLOR;
  return { base, dark: mixHex(base, "#000000", 0.45), soft: mixHex(base, "#ffffff", 0.9), border: mixHex(base, "#ffffff", 0.6) };
}

function logoBlock(cfg) {
  if (cfg.hasLogo) {
    return `<img src="${esc(APP_URL)}/api/logo" width="40" height="40" alt="${esc(cfg.appName)} logo" style="display:block;width:40px;height:40px;border:0;border-radius:10px;background:#ffffff" />`;
  }
  const initial = esc(String(cfg.appName || "?").trim().charAt(0).toUpperCase());
  return `<span style="display:inline-block;width:40px;height:40px;line-height:40px;text-align:center;border-radius:10px;background:rgba(255,255,255,.18);color:#ffffff;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700">${initial}</span>`;
}

/** Full HTML page. bodyHtml and footerText must already be escaped/HTML. */
export function shell({ cfg, pal, subject, preheader, icon, eyebrow, heading, bodyHtml, footerText }) {
  return `<!doctype html>
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
    .code { font-size:30px !important; letter-spacing:6px !important; }
  }
  @media (prefers-reduced-motion: no-preference) {
    .fade { animation: mFade .7s ease-out both; }
    .ring { animation: mPulse 2.6s ease-in-out infinite; }
    @keyframes mFade { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
    @keyframes mPulse { 0%,100% { box-shadow:0 0 0 0 ${pal.border}; } 50% { box-shadow:0 0 0 12px rgba(0,0,0,0); } }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#eef2f5;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2f5" style="background:#eef2f5">
  <tr><td align="center" style="padding:32px 12px">
    <table role="presentation" class="card fade" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #dbe4ea">

      <tr><td bgcolor="${pal.dark}" style="background:${pal.dark};background-image:linear-gradient(135deg,${pal.dark} 0%,${pal.base} 60%,${pal.border} 100%);padding:22px 28px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="middle" style="padding-right:12px">${logoBlock(cfg)}</td>
          <td valign="middle">
            <div style="color:#ffffff;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700;letter-spacing:.3px">${esc(cfg.appName)}</div>
            ${cfg.shopName && String(cfg.shopName).trim().toLowerCase() !== String(cfg.appName || "").trim().toLowerCase() ? `<div style="color:#ffffff;opacity:.85;font-size:11px;letter-spacing:1.5px;text-transform:uppercase">${esc(cfg.shopName)}</div>` : ""}
          </td>
        </tr></table>
      </td></tr>

      <tr><td class="pad" style="padding:34px 36px 10px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 18px"><tr>
          <td class="ring" align="center" valign="middle" width="64" height="64" bgcolor="${pal.soft}" style="width:64px;height:64px;border-radius:32px;background:${pal.soft};border:1px solid ${pal.border};text-align:center;font-size:28px;line-height:64px">${icon}</td>
        </tr></table>
        ${eyebrow ? `<p style="margin:0 0 6px;text-align:center;color:${pal.base};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase">${esc(eyebrow)}</p>` : ""}
        <h1 style="margin:0 0 20px;text-align:center;color:#0f172a;font-family:Georgia,'Times New Roman',serif;font-size:23px;line-height:1.3;font-weight:700">${esc(heading)}</h1>
        ${bodyHtml}
      </td></tr>

      <tr><td style="padding:20px 36px 26px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.6;text-align:center">
        ${esc(cfg.shopName)} · ${footerText}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// Spells out a small whole number, e.g. 10 -> "ten", 25 -> "twenty-five", so the OTP emails carry no digits near the code.
const SPELLED_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const SPELLED_TENS = ["", "", "twenty", "thirty", "forty", "fifty"];
export function spellNumber(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 0) return String(n);
  if (v < 20) return SPELLED_ONES[v];
  if (v < 60) return SPELLED_TENS[Math.floor(v / 10)] + (v % 10 ? `-${SPELLED_ONES[v % 10]}` : "");
  return String(v);
}
