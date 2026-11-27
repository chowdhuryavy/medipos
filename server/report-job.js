// Scheduled reports: each schedule the admin saves sends the chosen reports for YESTERDAY (shop time) at its set time, by email.
import { adminDb } from "./firebase-admin.js";

// Tells administrators in the app's bell when a scheduled report went out or failed.
async function notifyAdmins(title, body) {
  await adminDb().collection("notifications").add({
    roles: ["admin"], title: title.slice(0, 160), body: body.slice(0, 400), kind: "report", link: "admin",
    readBy: [], createdBy: "system", createdAt: new Date(),
  }).catch(() => {});
}
import { sendMail } from "./mail.js";
import { loadEmailConfig } from "./templates.js";
import { brandPalette, shell, esc } from "./email-layout.js";
import { buildReportTables, toSections, REPORTS } from "../js/report-tables.js";
import { toPdf, toXlsx } from "../js/export-files.js";

const DEFAULT_TZ = "Asia/Qatar";

/** Today's date and minutes after midnight in a time zone. */
export function localNow(now, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: Number(g("hour")) * 60 + Number(g("minute")) };
}

export const previousDay = (date) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const validTz = (tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } };

/** Due when the set time has passed today and today's report has not gone out yet (catches up after a missed run). */
export function isDue(schedule, now = new Date()) {
  if (!schedule.enabled) return null;
  const at = minutesOf(schedule.time);
  const tz = validTz(schedule.timezone) ? schedule.timezone : DEFAULT_TZ;
  if (at === null) return null;
  const here = localNow(now, tz);
  if (here.minutes < at || schedule.lastRunDate === here.date) return null;
  return { reportDate: previousDay(here.date), today: here.date };
}

async function loadData(from, to) {
  const db = adminDb();
  const [sales, expenses, products, batches] = await Promise.all([
    db.collection("sales").where("date", ">=", from).where("date", "<=", to).get(),
    db.collection("expenses").where("date", ">=", from).where("date", "<=", to).get(),
    db.collection("products").get(),
    db.collection("batches").get(),
  ]);
  return {
    sales: sales.docs.map((d) => d.data()),
    expenses: expenses.docs.map((d) => d.data()),
    products: products.docs.map((d) => ({ id: d.id, ...d.data() })),
    batches: batches.docs.map((d) => d.data()),
  };
}

/** Builds the files and the email for one schedule and one day, and sends it. */
export async function sendReportFor(schedule, reportDate, today) {
  const general = (await adminDb().doc("settings/general").get()).data() || {};
  const currency = general.currency || "QAR";
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 });
  const money = (n) => fmt.format(Number(n) || 0);
  const data = await loadData(reportDate, reportDate);
  const tables = buildReportTables(data, {
    from: reportDate, to: reportDate, today: today || reportDate,
    soon: addDays(today || reportDate, Number(general.expiryWarnDays) || 60), group: "day", money,
  });
  const keys = schedule.reports?.length ? schedule.reports : REPORTS.map(([k]) => k);
  const sections = toSections(tables, keys);
  const shop = general.shopName || "My Pharmacy";
  const title = "Daily reports";
  const subtitle = `Sales day ${reportDate}${data.sales.length === 0 ? " · No sales recorded" : ""} · Sent ${new Date().toLocaleString("en-GB", { timeZone: schedule.timezone || DEFAULT_TZ })}`;
  const cfg = await loadEmailConfig();
  const brand = { shop, color: cfg.brandColor, subtitle };
  const files = [];
  const formats = schedule.formats?.length ? schedule.formats : ["pdf"];
  const sentAt = new Date().toLocaleString("en-GB", { timeZone: schedule.timezone || DEFAULT_TZ });
  const slug = (t) => String(t).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const shopSlug = shop.replace(/\W+/g, "-");
  const noSalesNote = data.sales.length === 0 ? " · No sales recorded" : "";
  // One file per chosen report, so two reports give two attachments for each format.
  // The files show the tables only: the KPI cards are for the screen, not the printed report.
  for (const sec of sections) {
    const one = [{ ...sec, summary: [] }];
    const base = `${shopSlug}-${slug(sec.title)}-${reportDate}`;
    if (formats.includes("pdf")) {
      files.push({
        filename: `${base}.pdf`,
        content: toPdf({ title: sec.title, subtitle: `Sales day ${reportDate}${noSalesNote} · Sent ${sentAt}`, footer: shop, sections: one, brand }),
      });
    }
    if (formats.includes("xlsx")) {
      files.push({ filename: `${base}.xlsx`, content: toXlsx(one, brand) });
    }
  }

  // Email body: what was sent, the attached file names, then the key figures of each chosen report.
  const pal = brandPalette(cfg.brandColor);
  const noSales = data.sales.length === 0;
  const attached = files.length ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">
      <tr><td style="background:${pal.soft};border:1px solid ${pal.border};border-radius:12px;padding:14px 16px">
        <p style="margin:0 0 8px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:bold;color:${pal.dark}">Attached files</p>
        ${files.map((f) => `<p style="margin:6px 0;font-size:14px;color:#0f172a"><strong style="color:${pal.dark}">${f.filename.endsWith(".pdf") ? "PDF" : "Excel"}</strong>&nbsp;&nbsp;${esc(f.filename)}</p>`).join("")}
      </td></tr>
    </table>` : "";
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155">Here are the reports for <strong>${esc(reportDate)}</strong>.${noSales ? " No sales were recorded on this day, so the sales figures are zero." : ""} Stock and expiry are as of the time this was sent.</p>
    ${attached}
    ${sections.map((s) => `
      <h3 style="margin:20px 0 8px;font-size:15px;color:${pal.dark}">${esc(s.title)}</h3>
      <table role="presentation" width="100%" cellpadding="8" cellspacing="0" style="font-size:14px;border-collapse:collapse">
        ${s.summary.map(([l, v]) => `<tr><td style="border-bottom:1px solid #e2e8f0;color:#475569">${esc(l)}</td><td align="right" style="border-bottom:1px solid #e2e8f0;font-weight:bold;color:#0f172a">${esc(v)}</td></tr>`).join("")}
      </table>`).join("")}`;
  const html = shell({
    cfg, pal, subject: `${shop} reports for ${reportDate}`, preheader: `Reports for ${reportDate} · ${files.length} attached`,
    icon: "&#128202;", eyebrow: esc(cfg.shopName || shop), heading: `Reports for ${reportDate}`,
    bodyHtml, footerText: cfg.emailFooter,
  });
  // Plain-text version: the same attachment names and figures, so both versions say the same thing.
  const text = [
    `${shop} reports for ${reportDate}`,
    noSales ? "No sales were recorded on this day." : "",
    files.length ? `Attached files:\n${files.map((f) => `- ${f.filename}`).join("\n")}` : "",
    ...sections.map((s) => `${s.title}\n${s.summary.map(([l, v]) => `${l}: ${v}`).join("\n")}`),
  ].filter(Boolean).join("\n\n");
  await sendMail({
    to: schedule.recipients, subject: `${shop} reports for ${reportDate}`, text, html, attachments: files,
  });
  return { to: schedule.recipients, reportDate, files: files.map((f) => f.filename), sections: sections.length };
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Runs every schedule that is due. Marks each as sent for today so it does not repeat. */
export async function runDueSchedules(now = new Date()) {
  const ref = adminDb().doc("settings/reportSchedules");
  const snap = await ref.get();
  const items = (snap.data()?.items || []).map((s) => ({ ...s }));
  const results = [];
  for (const s of items) {
    const due = isDue(s, now);
    if (!due) continue;
    try {
      const sent = await sendReportFor(s, due.reportDate, due.today);
      s.lastRunDate = due.today;
      s.lastRunStatus = `Sent ${sent.reportDate}`;
      results.push({ id: s.id, ok: true, ...sent });
      await notifyAdmins(`Report sent: ${s.name}`, `Reports for ${due.reportDate} were emailed to ${s.recipients.join(", ")}.`);
    } catch (err) {
      // A failed send is recorded and retried on the next run that day.
      s.lastRunStatus = `Failed: ${err.message}`.slice(0, 200);
      results.push({ id: s.id, ok: false, error: err.message });
      await notifyAdmins(`Report failed: ${s.name}`, `${err.message}`.slice(0, 300));
    }
  }
  if (results.length) await ref.set({ items }, { merge: true });
  return results;
}

/** Sends one schedule now, for yesterday in its time zone. Used for "send now" from Administration. */
export async function sendScheduleNow(schedule, now = new Date()) {
  const tz = validTz(schedule.timezone) ? schedule.timezone : DEFAULT_TZ;
  const today = localNow(now, tz).date;
  return sendReportFor(schedule, previousDay(today), today);
}
