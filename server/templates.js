import { adminDb } from "./firebase-admin.js";
import { APP_URL } from "./mail.js";
import { DEFAULT_TEMPLATES, DEFAULT_EMAIL_FOOTER, DEFAULT_OTP_MINUTES } from "../js/email-defaults.js";
import { esc, fill, brandPalette, shell, spellNumber } from "./email-layout.js";

export { DEFAULT_TEMPLATES };

const ICONS = { welcome: "&#127881;", reset: "&#128273;" };
const DEFAULT_ICON = "&#9993;";

/** Loads branding, the general settings (footer, OTP minutes) and the admin's email texts. */
export async function loadEmailConfig() {
  const db = adminDb();
  const [brand, general, stored] = await Promise.all([
    db.doc("branding/public").get(),
    db.doc("settings/general").get(),
    db.doc("settings/emails").get(),
  ]);
  const b = brand.data() || {};
  const g = general.data() || {};
  const s = stored.data() || {};
  const templates = {};
  for (const key of Object.keys(DEFAULT_TEMPLATES)) {
    templates[key] = { ...DEFAULT_TEMPLATES[key], ...(s[key] || {}) };
  }
  const minutes = Math.min(60, Math.max(1, Math.round(Number(g.otpExpiryMinutes) || DEFAULT_OTP_MINUTES)));
  return {
    appName: b.shopName || b.appName || "MediPOS",
    shopName: b.shopName || g.shopName || "My Pharmacy",
    hasLogo: !!b.logoUrl,
    brandColor: b.brandColor,
    emailFooter: g.emailFooter || DEFAULT_EMAIL_FOOTER,
    otpExpiryMinutes: minutes,
    templates,
  };
}

// The button in the new staff account email opens the shop's own web address.
const WELCOME_BUTTON_URL = "https://pharmacy.perfection.my/";

/** Builds the subject, HTML and plain-text version of one email. Values are escaped in the HTML. */
export function renderEmail(key, cfg, values) {
  const t = cfg.templates[key];
  const buttonUrl = key === "welcome" ? WELCOME_BUTTON_URL : APP_URL;
  const pal = brandPalette(cfg.brandColor);
  const vars = { appName: cfg.appName, shopName: cfg.shopName, loginUrl: APP_URL, minutes: cfg.otpExpiryMinutes, ...values };
  vars.minutes = spellNumber(vars.minutes);
  // Sign-in codes stay plain text (Gmail reads them better); the boxed style is kept for the other emails.
  const boxed = key !== "login";
  const subject = fill(t.subject, vars);
  const text = fill(t.body, vars);
  const button = t.button ? fill(t.button, vars) : "";
  const heading = fill(t.heading || subject, vars);
  const eyebrow = fill(t.eyebrow || "", vars);

  // Passwords get a highlighted card. Markers survive escaping, then become HTML.
  const marked = fill(t.body, Object.fromEntries(Object.entries(vars).map(([k, v]) =>
    [k, boxed && k === "password" && v ? `\u0001${k}\u0002${v}\u0003` : v])));
  const paragraphs = esc(marked)
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:1.65">${para
      .replace(/\n/g, "<br/>")
      .replace(/\u0001(\w+)\u0002([^\u0003]*)\u0003/g, (_, k, v) =>
        `<span style="display:inline-block;margin:6px 0;padding:10px 18px;border-radius:12px;background:${pal.soft};border:1px dashed ${pal.base};font-family:'Courier New',Courier,monospace;font-size:17px;font-weight:700;letter-spacing:1px;color:${pal.dark};user-select:all">${v}</span>`)}</p>`)
    .join("");

  const btn = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 6px"><tr><td bgcolor="${pal.base}" style="background:${pal.base};border-radius:12px"><a href="${esc(buttonUrl)}" style="display:inline-block;padding:13px 26px;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:15px">${esc(button)}</a></td></tr></table>`
    : "";

  const footerText = esc(fill(cfg.emailFooter, vars)).replace(/\n/g, "<br/>");
  const html = shell({
    cfg, pal, subject,
    preheader: (t.preheader ? fill(t.preheader, vars) : (values?.password ? text.split(String(values.password)).join("") : text)).replace(/\s+/g, " ").slice(0, 110),
    icon: ICONS[key] || DEFAULT_ICON,
    eyebrow, heading,
    bodyHtml: `${paragraphs}${btn}`,
    footerText,
  });

  return { subject, text, html };
}
