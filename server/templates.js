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
    appName: b.appName || "MediPOS",
    shopName: b.shopName || "My Pharmacy",
    hasLogo: !!b.logoUrl,
    templates,
  };
}

function fill(text, vars) {
  return String(text || "").replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Builds the subject, HTML and plain-text version of one email. Values are escaped in the HTML. */
export function renderEmail(key, cfg, values) {
  const t = cfg.templates[key];
  const vars = { appName: cfg.appName, shopName: cfg.shopName, loginUrl: APP_URL, ...values };
  const subject = fill(t.subject, vars);
  const text = fill(t.body, vars);
  const button = t.button ? fill(t.button, vars) : "";

  // Codes and passwords get a highlighted box. Markers survive escaping, then become HTML.
  const marked = fill(t.body, Object.fromEntries(Object.entries(vars).map(([k, v]) =>
    [k, ["code", "password"].includes(k) && v ? `\u0001${k}\u0002${v}\u0003` : v])));
  const html = esc(marked)
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 14px;color:#0f172a;font-size:15px;line-height:1.6">${para
      .replace(/\n/g, "<br/>")
      .replace(/\u0001(\w+)\u0002([^\u0003]*)\u0003/g, (_, k, v) =>
        `<span style="display:inline-block;margin:6px 0;padding:10px 16px;border-radius:10px;background:#ecfdf5;border:1px solid #99f6e4;font-family:'Courier New',monospace;font-size:${k === "code" ? 26 : 16}px;font-weight:700;letter-spacing:${k === "code" ? 6 : 1}px;color:#0f766e">${v}</span>`)}</p>`)
    .join("");

  const logo = cfg.hasLogo
    ? `<img src="${APP_URL}/api/logo" alt="" height="36" style="display:block;height:36px;border:0" />`
    : `<span style="font-size:26px;line-height:36px">🔐</span>`;
  const btn = button
    ? `<p style="margin:22px 0 6px"><a href="${esc(APP_URL)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">${esc(button)}</a></p>`
    : "";

  const shell = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#eef2f5;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
    <tr><td style="background:linear-gradient(135deg,#0b4f4a,#0f766e);padding:18px 24px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;padding-right:12px">${logo}</td>
        <td style="vertical-align:middle;color:#ffffff;font-size:18px;font-weight:700">${esc(cfg.appName)}</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:26px 24px 8px">
      <h2 style="margin:0 0 14px;color:#0f172a;font-size:19px">${esc(subject.replace(/\u0001|\u0002|\u0003/g, ""))}</h2>
      ${html}
      ${btn}
    </td></tr>
    <tr><td style="padding:18px 24px 24px;color:#64748b;font-size:12px;line-height:1.5;border-top:1px solid #e2e8f0">
      ${esc(cfg.shopName)} · Sent by ${esc(cfg.appName)}<br/>If you did not expect this email, contact your administrator.
    </td></tr>
  </table></body></html>`;

  return { subject, text, html: shell };
}
