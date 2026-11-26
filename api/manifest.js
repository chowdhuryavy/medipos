import { adminDb } from "../server/firebase-admin.js";

// Web app manifest: the installed app's name and icon on phones and desktops come from the saved shop name and logo.
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  let b = {};
  try {
    b = (await adminDb().doc("branding/public").get()).data() || {};
  } catch (err) {
    console.error(err);
  }
  const name = String(b.shopName || b.appName || "MediPOS").slice(0, 40);
  const icons = b.logoUrl
    ? [192, 512].map((s) => ({ src: "/api/logo", sizes: `${s}x${s}`, type: "image/png", purpose: "any" }))
    : [];
  res.setHeader("Content-Type", "application/manifest+json");
  res.setHeader("Cache-Control", "no-cache");
  return res.status(200).send(JSON.stringify({
    name,
    short_name: name.slice(0, 12),
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0f766e",
    icons,
  }));
}
