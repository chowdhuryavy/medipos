// Daily backup: all shop data as JSON files inside one zip, emailed each day to the addresses an admin chooses.
// Passwords, keys, sign-in codes and the Google Sheets secret are never included.
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { adminDb } from "./firebase-admin.js";
import { httpError } from "./errors.js";
import { sendMail } from "./mail.js";
import { isDue } from "./report-job.js";

// Collections copied in full. The audit log and sign-in codes are not part of the backup.
const COLLECTIONS = ["products", "batches", "customers", "suppliers", "sales", "purchases", "journal", "expenses", "accounts", "counters", "floats", "users"];
// Single documents copied as they are.
const DOCUMENTS = ["settings/general", "settings/roles", "settings/emails", "settings/integrations", "branding/public"];
// Field names that hold a password, key, token or secret. They are removed from every copy.
const SECRET_KEY = /secret|password|hash|salt|token|pass$|apikey|api_key/i;
// Email providers reject attachments much larger than this once encoded (about a third bigger).
const MAX_ZIP_MB = 15;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Turns Firestore values into plain JSON, with dates as ISO text and secret fields left out. */
export function plain(v) {
  if (v === null || v === undefined) return v;
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (v.constructor?.name === "DocumentReference") return v.path;
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!SECRET_KEY.test(k)) out[k] = plain(x);
    return out;
  }
  return v;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A zip file with each entry deflate-compressed. Entries are [name, Buffer]. */
export function zipDeflated(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [fname, raw] of files) {
    const name = Buffer.from(fname, "utf8");
    const data = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Builds the zip from loaded data. data = { collections: { name: [docs] }, documents: { path: object|null } }. */
export function buildBackupZip(data, { shop, createdAt }) {
  const files = [];
  const manifest = { shop, createdAt, files: [] };
  const add = (name, obj, records) => {
    const body = Buffer.from(JSON.stringify(obj, null, 1), "utf8");
    files.push([name, body]);
    manifest.files.push({ name, records, sha256: createHash("sha256").update(body).digest("hex") });
  };
  for (const [name, docs] of Object.entries(data.collections)) add(`data/${name}.json`, plain(docs), docs.length);
  for (const [path, obj] of Object.entries(data.documents)) {
    if (obj) add(`settings/${path.replace(/\//g, "-")}.json`, plain(obj), 1);
  }
  add("manifest.json", manifest, files.length);
  files.push(["README.txt", Buffer.from(
    `${shop} - MediPOS daily backup\n\nCreated: ${createdAt}\n\n` +
    "data/ holds one JSON file per collection (one record per item in the list).\n" +
    "settings/ holds the shop settings, roles, email templates and branding.\n" +
    "manifest.json lists every file with its record count and SHA-256 checksum.\n\n" +
    "Passwords, API keys, the Google Sheets secret and sign-in codes are never included.\n" +
    "Keep this file private: it contains customer, sales and staff information.\n", "utf8")]);
  return zipDeflated(files);
}

async function loadAll() {
  const db = adminDb();
  const collections = {};
  for (const name of COLLECTIONS) {
    const snap = await db.collection(name).get();
    collections[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  const documents = {};
  for (const path of DOCUMENTS) {
    const snap = await db.doc(path).get();
    documents[path] = snap.exists ? snap.data() : null;
  }
  return { collections, documents };
}

/** Builds the backup now and emails it. Throws a readable error when it cannot be sent. */
export async function runBackup(recipients) {
  const list = [...new Set((recipients || []).map((s) => String(s).trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];
  if (!list.length) throw httpError(400, "Add at least one valid email address for the backup.");
  const general = (await adminDb().doc("settings/general").get()).data() || {};
  const shop = general.shopName || "My Pharmacy";
  const now = new Date();
  const createdAt = now.toISOString();
  const stamp = createdAt.slice(0, 10);
  const data = await loadAll();
  const zip = buildBackupZip(data, { shop, createdAt });
  const sizeMb = zip.length / (1024 * 1024);
  const records = Object.values(data.collections).reduce((s, d) => s + d.length, 0);
  if (sizeMb > MAX_ZIP_MB) {
    throw httpError(413, `The backup is ${sizeMb.toFixed(1)} MB, which is too large to email (limit ${MAX_ZIP_MB} MB). Ask the developer to set up a larger backup destination.`);
  }
  const filename = `${shop.replace(/\W+/g, "-")}-backup-${stamp}.zip`;
  const counts = Object.entries(data.collections).map(([k, v]) => [k, v.length]);
  const rows = counts.map(([k, n]) => `<tr><td style="padding:6px 0;border-bottom:1px solid #e2e8f0;color:#475569">${k}</td><td align="right" style="padding:6px 0;border-bottom:1px solid #e2e8f0;font-weight:bold">${n}</td></tr>`).join("");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a"><p style="font-size:15px">The daily backup for <strong>${shop}</strong> is attached (${sizeMb.toFixed(2)} MB, ${records} records).</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${rows}</table><p style="font-size:12px;color:#64748b">Keep this file private. It contains customer, sales and staff information.</p></div>`;
  const text = `The daily backup for ${shop} is attached (${sizeMb.toFixed(2)} MB, ${records} records).\n\n${counts.map(([k, n]) => `${k}: ${n}`).join("\n")}\n\nKeep this file private.`;
  await sendMail({
    to: list, subject: `${shop} daily backup ${stamp}`, text, html,
    attachments: [{ filename, content: zip }],
  });
  return { to: list, sizeMb: Number(sizeMb.toFixed(2)), records, filename };
}

async function notifyAdmins(title, body) {
  await adminDb().collection("notifications").add({
    roles: ["admin"], title: title.slice(0, 160), body: body.slice(0, 400), kind: "backup", link: "admin",
    readBy: [], createdBy: "system", createdAt: new Date(),
  }).catch(() => {});
}

/** Runs the daily backup when its time has come. Called by the scheduler. */
export async function runDueBackup(now = new Date()) {
  const ref = adminDb().doc("settings/backupSchedule");
  const s = (await ref.get()).data();
  if (!s) return null;
  const due = isDue(s, now);
  if (!due) return null;
  try {
    const sent = await runBackup(s.recipients);
    await ref.set({ lastRunDate: due.today, lastRunStatus: `Sent ${due.today} (${sent.sizeMb} MB)` }, { merge: true });
    await notifyAdmins("Daily backup sent", `Backup emailed to ${sent.to.join(", ")}.`);
    return { ok: true, ...sent };
  } catch (err) {
    // A failure is recorded for the day, so it is not retried every 15 minutes. "Send now" retries it.
    await ref.set({ lastRunDate: due.today, lastRunStatus: `Failed: ${err.message}`.slice(0, 200) }, { merge: true });
    await notifyAdmins("Daily backup failed", err.message);
    return { ok: false, error: err.message };
  }
}

/** Sends the saved backup now, for the "Send backup now" button. */
export async function sendBackupNow() {
  const ref = adminDb().doc("settings/backupSchedule");
  const s = (await ref.get()).data() || {};
  try {
    const sent = await runBackup(s.recipients);
    await ref.set({ lastRunStatus: `Sent manually ${new Date().toISOString().slice(0, 16).replace("T", " ")} (${sent.sizeMb} MB)` }, { merge: true });
    return { ok: true, to: sent.to, sizeMb: sent.sizeMb };
  } catch (err) {
    if (err.expose) throw err;
    throw httpError(502, `The backup could not be sent. ${err.message}`);
  }
}
