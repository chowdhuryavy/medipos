import { adminDb } from "../server/firebase-admin.js";

// Serves the shop logo as a real image so it can appear inside emails.
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  try {
    const b = (await adminDb().doc("branding/public").get()).data() || {};
    const m = String(b.logoUrl || "").match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if (!m) return res.status(404).end();
    const bytes = Buffer.from(m[2], "base64");
    res.setHeader("Content-Type", m[1]);
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).send(bytes);
  } catch (err) {
    console.error(err);
    return res.status(500).end();
  }
}
