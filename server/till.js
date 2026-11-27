// Till actions that must not run in the browser: returns, voids and discount approvals.
// Each one checks the signed-in cashier's permissions and an administrator's password on the server.
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "./firebase-admin.js";
import { httpError } from "./errors.js";
import { firebaseConfig } from "../js/config.js";
import { localNow } from "./report-job.js";
import { planReturn, applyAgg, summarize, returnJournal, fullyReturned, round2, ACCOUNTS } from "./till-calc.js";

export const DISCOUNT_APPROVAL_SECONDS = 300;
const DEFAULT_TZ = "Asia/Qatar";

/** The signed-in staff member, checked the same way the app checks it: active, password changed, sign-in code done. */
export async function tillStaff(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!m) throw httpError(401, "Sign in first.");
  const decoded = await adminAuth().verifyIdToken(m[1]);
  const profile = (await adminDb().doc(`users/${decoded.uid}`).get()).data();
  if (!profile || profile.active !== true) throw httpError(403, "This account is not active.");
  if (profile.mustChangePassword === true) throw httpError(403, "Change your password before continuing.");
  if (profile.requireOtp === true && decoded.otp !== true) throw httpError(403, "Enter your sign-in code first.");
  return { uid: decoded.uid, name: profile.name || decoded.email || "staff", profile };
}

/** Throws unless the staff member may use this page, and may write to this area when one is given. */
async function staffCan(staff, page, writeArea) {
  if (staff.profile.role === "admin") return;
  const roles = (await adminDb().doc("settings/roles").get()).data() || {};
  const access = staff.profile.access || null;
  const pages = access?.pages ?? roles[staff.profile.role]?.pages ?? [];
  const writes = access?.write ?? roles[staff.profile.role]?.write ?? [];
  if (!pages.includes(page)) throw httpError(403, "Your role does not allow this.");
  if (writeArea && !writes.includes(writeArea)) throw httpError(403, "Your role does not allow this.");
}

/**
 * Checks an administrator's email and password with Firebase Auth, without signing anyone in here.
 * Only an active administrator who does not need an email sign-in code can approve.
 */
export async function verifyApprover(email, password) {
  const e = String(email || "").trim().toLowerCase();
  const p = String(password || "");
  if (!e || !p) throw httpError(400, "Enter the administrator's email and password to approve this.");
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: e, password: p, returnSecureToken: false }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (String(body.error?.message || "").includes("TOO_MANY_ATTEMPTS")) throw httpError(429, "Too many attempts. Wait a few minutes and try again.");
    throw httpError(401, "The administrator's email or password is wrong.");
  }
  const { localId } = await res.json();
  const profile = (await adminDb().doc(`users/${localId}`).get()).data();
  if (!profile || profile.active !== true || profile.role !== "admin") throw httpError(403, "Only an active administrator can approve this.");
  if (profile.mustChangePassword === true) throw httpError(403, "That administrator must change their temporary password first.");
  if (profile.requireOtp === true) {
    throw httpError(403, "That administrator uses an email sign-in code, which cannot be checked for approvals. Turn off the sign-in code for this administrator in Users, or use another administrator.");
  }
  return { uid: localId, name: profile.name || e };
}

/** Records a return or a void. Stock and money go back in one transaction, and the journal gets a numbered reversal. */
export async function processReturn(staff, body) {
  await staffCan(staff, "returns", "pos");
  const kind = body.kind === "void" ? "void" : "return";
  const reason = String(body.reason || "").trim();
  if (reason.length < 3) throw httpError(400, "Write the reason for this (at least 3 letters).");
  const saleId = String(body.saleId || "");
  if (!saleId) throw httpError(400, "Choose the sale first.");
  const approver = await verifyApprover(body.approverEmail, body.approverPassword);

  const db = adminDb();
  const general = (await db.doc("settings/general").get()).data() || {};
  const shopDate = localNow(new Date(), general.timezone || DEFAULT_TZ).date;
  const saleRef = db.collection("sales").doc(saleId);
  const aggRef = db.collection("saleReturns").doc(saleId);
  const counterRef = db.doc("counters/main");
  const retRef = db.collection("returns").doc();
  const jvRef = db.collection("journal").doc();
  const shop = general.shopName || "";

  return db.runTransaction(async (tx) => {
    const sSnap = await tx.get(saleRef);
    if (!sSnap.exists) throw httpError(404, "Sale not found.");
    const sale = sSnap.data();
    if (sale.status === "voided") throw httpError(400, "This sale was already voided.");
    const aSnap = await tx.get(aggRef);
    const agg = aSnap.exists ? aSnap.data() : {};
    const method = (general.paymentMethods || []).find((m) => m.key === sale.payment) || { account: sale.paymentAccount, credit: sale.payment === "credit" };
    const paymentAccount = sale.paymentAccount || method.account;
    if (!paymentAccount) throw httpError(400, "This sale has no payment account recorded, so it cannot be reversed.");

    let want;
    if (kind === "void") {
      want = (sale.items || []).map((it, i) => ({ index: i, qty: it.qty - (agg.items?.[i] || 0) })).filter((l) => l.qty > 0);
      if (!want.length) throw httpError(400, "Everything on this sale has already been returned.");
    } else {
      want = Array.isArray(body.lines) ? body.lines : [];
    }
    if (kind === "void" && (sale.items || []).some((it) => it.kind === "service")) {
      throw httpError(400, "This sale has mobile-money or service lines, so it cannot be voided here. Reverse it in Accounting.");
    }
    const plan = planReturn(sale, agg, want);

    // Every read happens before the first write, as transactions require.
    const productSnaps = {};
    for (const p of plan) {
      if (!productSnaps[p.productId]) productSnaps[p.productId] = await tx.get(db.collection("products").doc(p.productId));
    }
    const batchSnaps = {};
    for (const p of plan) for (const r of p.restores) {
      if (!batchSnaps[r.batchId]) batchSnaps[r.batchId] = await tx.get(db.collection("batches").doc(r.batchId));
    }
    // Every account this return posts to must be active.
    for (const code of [ACCOUNTS.SALES, ACCOUNTS.VAT_PAYABLE, ACCOUNTS.INVENTORY, ACCOUNTS.COGS, paymentAccount]) {
      const aSnap2 = await tx.get(db.collection("accounts").doc(code));
      if (!aSnap2.exists) throw httpError(400, `Account ${code} does not exist in the chart of accounts.`);
      const acc = aSnap2.data();
      if (acc.status && acc.status !== "active") {
        throw httpError(400, `Account ${code} · ${acc.name || ""} is ${acc.status}, so this return cannot be posted. Make it active in Chart of accounts first.`);
      }
    }
    const customerRef = sale.customerId ? db.collection("customers").doc(sale.customerId) : null;
    const cSnap = customerRef ? await tx.get(customerRef) : null;
    const counter = await tx.get(counterRef);

    // Stock back into products and batches.
    const productAdd = {};
    const batchAdd = {};
    for (const p of plan) {
      const ps = productSnaps[p.productId];
      if (!ps.exists) throw httpError(400, `"${p.name}" no longer exists, so its stock cannot be returned.`);
      productAdd[p.productId] = (productAdd[p.productId] || 0) + p.pieces;
      for (const r of p.restores) {
        if (!batchSnaps[r.batchId].exists) throw httpError(400, `The batch for ${p.name} no longer exists, so its stock cannot be returned.`);
        batchAdd[r.batchId] = (batchAdd[r.batchId] || 0) + r.pieces;
      }
    }

    const totals = summarize(plan);
    const nextAgg = applyAgg(agg, plan);
    const nextJv = (Number(counter.data()?.jv) || 0) + 1;
    const jvNo = `JV-${String(nextJv).padStart(6, "0")}`;
    const memo = `${kind === "void" ? "Void" : "Return"} of ${sale.invoiceNo}${reason ? ` · ${reason}` : ""}`;
    const entry = returnJournal({ ...totals, paymentAccount, memo, ref: sale.invoiceNo });
    const isFull = kind === "void" || fullyReturned(sale, nextAgg);
    const newStatus = kind === "void" ? "voided" : isFull ? "returned" : "partly returned";

    for (const [pid, add] of Object.entries(productAdd)) {
      const cur = Number(productSnaps[pid].data().stock) || 0;
      tx.update(db.collection("products").doc(pid), { stock: cur + add, updatedAt: FieldValue.serverTimestamp() });
    }
    for (const [bid, add] of Object.entries(batchAdd)) {
      const cur = Number(batchSnaps[bid].data().remaining) || 0;
      tx.update(db.collection("batches").doc(bid), { remaining: cur + add });
    }
    if (method.credit && cSnap?.exists) {
      const bal = Number(cSnap.data().balance) || 0;
      tx.update(customerRef, { balance: round2(bal - totals.total), updatedAt: FieldValue.serverTimestamp() });
    }
    tx.set(counterRef, { jv: nextJv }, { merge: true });
    tx.set(jvRef, {
      ...entry, date: shopDate, jvNo, type: kind, status: "posted",
      by: staff.name, byUid: staff.uid, createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(retRef, {
      type: kind, saleId, invoiceNo: sale.invoiceNo, date: shopDate,
      lines: plan.map((p) => ({ index: p.index, name: p.name, productId: p.productId, qty: p.qty, pieces: p.pieces, net: p.net, vat: p.vat, total: p.total, cogs: p.cogs })),
      net: totals.net, vat: totals.vat, total: totals.total, cogs: totals.cogs,
      paymentKey: sale.payment || "", paymentAccount, customerId: sale.customerId || null, customerName: sale.customerName || "Walk-in",
      reason, jvNo, journalId: jvRef.id,
      staffUid: staff.uid, staffName: staff.name, approverUid: approver.uid, approverName: approver.name,
      shop, createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(aggRef, nextAgg);
    tx.update(saleRef, { status: newStatus, returnedTotal: nextAgg.refunded, updatedAt: FieldValue.serverTimestamp() });
    tx.set(db.collection("audit").doc(), {
      action: kind === "void" ? "sale.void" : "sale.return", by: staff.name, byUid: staff.uid,
      details: { invoiceNo: sale.invoiceNo, total: totals.total, approvedBy: approver.name, jvNo, reason },
      at: FieldValue.serverTimestamp(),
    });
    return { ok: true, returnId: retRef.id, jvNo, refund: totals.total, status: newStatus, approvedBy: approver.name };
  });
}

/** Records that an administrator approved a discount above the staff limit. The sale must use it within a few minutes. */
export async function approveDiscount(staff, body) {
  await staffCan(staff, "pos", "pos");
  const pct = Number(body.discountPct);
  if (!(pct > 0 && pct <= 100)) throw httpError(400, "Enter a discount between 0 and 100.");
  const approver = await verifyApprover(body.approverEmail, body.approverPassword);
  const ref = adminDb().collection("approvals").doc();
  await ref.set({
    kind: "discount", pct, requestedBy: staff.uid, requestedByName: staff.name,
    approverUid: approver.uid, approverName: approver.name,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + DISCOUNT_APPROVAL_SECONDS * 1000),
  });
  await adminDb().collection("audit").add({
    action: "discount.approved", by: staff.name, byUid: staff.uid, details: { pct, approvedBy: approver.name }, at: FieldValue.serverTimestamp(),
  });
  return { approvalId: ref.id, expiresInSeconds: DISCOUNT_APPROVAL_SECONDS, approvedBy: approver.name };
}
