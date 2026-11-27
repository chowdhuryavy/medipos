import { timingSafeEqual } from "node:crypto";
import { runDueSchedules } from "../../server/report-job.js";
import { runDueBackup } from "../../server/backup-job.js";

// Called by Vercel Cron. Vercel sends "Authorization: Bearer <CRON_SECRET>", so nobody else can trigger it.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(String(req.headers.authorization || ""));
  const want = Buffer.from(`Bearer ${secret || ""}`);
  if (!secret || given.length !== want.length || !timingSafeEqual(given, want)) {
    return res.status(401).json({ error: "Not allowed." });
  }
  try {
    const results = await runDueSchedules(new Date());
    const backup = await runDueBackup(new Date());
    return res.status(200).json({ ok: true, ran: results.length, results, backup });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Scheduled reports could not run. Check the server logs." });
  }
}
