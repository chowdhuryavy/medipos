// Notifications: a bell in the header with live updates (Firestore listener), read per person, and "Mark all read".
// A notification is shown to every role listed in its roles field. Admins always receive them.
import { db, collection, doc, getDocs, setDoc, query, where, limit, onSnapshot, writeBatch, arrayUnion, updateDoc, serverTimestamp } from "./firebase.js";
import { session, roles, icon, esc, toast } from "./core.js";

const KIND_ICON = { stock: "inventory", sale: "cart", float: "currency", report: "reports", expiry: "alert", system: "admin" };
let unsub = null;
let items = [];
let ready = false;
let open = false;

const ms = (t) => (t && t.toMillis ? t.toMillis() : t ? new Date(t).getTime() : Date.now());
const isUnread = (n) => !(n.readBy || []).includes(session.uid);
// "Clear" hides everything created before this moment, for this person on this device.
const clearedKey = () => `notif-cleared-${session.uid}`;
const clearedAt = () => Number(localStorage.getItem(clearedKey()) || 0);
const visible = () => items.filter((x) => ms(x.createdAt) > clearedAt());
const unreadCount = () => visible().filter(isUnread).length;

/** Roles that can open a page. Used to choose who a notification goes to. */
export const rolesWith = (page) => Object.keys(roles).filter((k) => k === "admin" || roles[k]?.pages?.includes(page));

/** Creates a notification for the given roles. */
export async function notify({ roleKeys, title, body = "", kind = "system", link = "" }) {
  const targets = [...new Set(["admin", ...(roleKeys || [])])];
  await setDoc(doc(collection(db, "notifications")), {
    roles: targets, title: String(title).slice(0, 160), body: String(body).slice(0, 400), kind, link,
    readBy: [], createdBy: session.uid, createdAt: serverTimestamp(),
  });
}

/** Creates a notification once: a fixed id means the same alert is not repeated on the same day. */
export async function notifyOnce(id, payload) {
  try {
    await setDoc(doc(db, "notifications", id), {
      roles: [...new Set(["admin", ...(payload.roleKeys || [])])], title: payload.title, body: payload.body || "",
      kind: payload.kind || "system", link: payload.link || "", readBy: [], createdBy: session.uid, createdAt: serverTimestamp(),
    });
  } catch {
    // Already sent today (the rules do not allow overwriting), so nothing to do.
  }
}

/** Starts the live listener for this person's notifications. Stops itself when the screen is gone. */
export function startNotifications() {
  if (unsub) unsub();
  const q = query(collection(db, "notifications"), where("roles", "array-contains", session.role), limit(200));
  unsub = onSnapshot(q, (snap) => {
    if (!document.getElementById("bell-btn")) { unsub(); unsub = null; return; }
    // The first result can come from the local cache, which may be stale. Wait for the server before showing counts.
    const fromCache = snap.metadata.fromCache;
    const fresh = ready && !fromCache ? snap.docChanges().filter((c) => c.type === "added").map((c) => c.doc.id) : [];
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    if (fromCache) return;
    ready = true;
    paintBadge();
    if (open) paintPanel();
    fresh.forEach((id) => {
      const n = items.find((x) => x.id === id);
      if (n && isUnread(n)) toast(`${n.title}`, "info");
    });
  }, (err) => console.warn("Notifications unavailable:", err.message));
}

function paintBadge() {
  const btn = document.getElementById("bell-btn");
  if (!btn) return;
  const n = unreadCount();
  const badge = document.getElementById("bell-count");
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? "99+" : String(n);
  btn.classList.toggle("has-new", n > 0);
  btn.setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications");
}

const ago = (t) => {
  const m = Math.max(0, Math.round((Date.now() - ms(t)) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

function paintPanel() {
  const panel = document.getElementById("notif-panel");
  if (!panel) return;
  const n = unreadCount();
  const list = visible();
  panel.querySelector(".np-list").innerHTML = list.length
    ? list.slice(0, 80).map((x) => `
      <button class="np-item ${isUnread(x) ? "unread" : ""}" data-id="${esc(x.id)}">
        <span class="np-ico kind-${esc(x.kind || "system")}">${icon(KIND_ICON[x.kind] || "alert")}</span>
        <span class="np-text"><strong>${esc(x.title)}</strong>${x.body ? `<small>${esc(x.body)}</small>` : ""}<em>${esc(ago(x.createdAt))}</em></span>
        ${isUnread(x) ? `<span class="np-dot" aria-label="Unread"></span>` : ""}
      </button>`).join("")
    : `<div class="np-empty">${icon("check")}<p>You are all caught up.</p></div>`;
  panel.querySelector("[data-readall]").disabled = n === 0;
  panel.querySelector(".np-count").textContent = n ? `${n} unread` : "All read";
}

async function markRead(ids) {
  const todo = ids.filter((id) => items.find((x) => x.id === id && isUnread(x)));
  for (let i = 0; i < todo.length; i += 400) {
    const batch = writeBatch(db);
    todo.slice(i, i + 400).forEach((id) => batch.update(doc(db, "notifications", id), { readBy: arrayUnion(session.uid) }));
    await batch.commit();
  }
}

function closePanel() {
  open = false;
  document.getElementById("notif-panel")?.remove();
  document.removeEventListener("pointerdown", outside, true);
}
function outside(e) {
  const panel = document.getElementById("notif-panel");
  if (panel && !panel.contains(e.target) && !document.getElementById("bell-btn").contains(e.target)) closePanel();
}

export function toggleNotifications() {
  if (open) return closePanel();
  open = true;
  const panel = document.createElement("div");
  panel.id = "notif-panel";
  panel.className = "notif-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Notifications");
  panel.innerHTML = `
    <header class="np-head">
      <div><strong>Notifications</strong><small class="np-count"></small></div>
      <div class="np-actions">
        <button class="btn ghost sm" data-readall>${icon("check")}<span>Mark all read</span></button>
        <button class="btn ghost sm" data-clear>${icon("trash")}<span>Clear</span></button>
        <button class="icon-btn sm" data-close aria-label="Close">${icon("x")}</button>
      </div>
    </header>
    <div class="np-list"></div>`;
  document.body.appendChild(panel);
  paintPanel();
  // Opening the panel counts as having seen them, so the badge does not come back on the next load.
  markRead(visible().filter(isUnread).map((x) => x.id)).catch((err) => console.warn("Could not mark notifications read:", err.message));
  panel.querySelector("[data-close]").addEventListener("click", closePanel);
  panel.querySelector("[data-clear]").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await markRead(visible().filter(isUnread).map((x) => x.id));
      localStorage.setItem(clearedKey(), String(Date.now()));
      items = items.filter((x) => ms(x.createdAt) > clearedAt());
      paintBadge();
      paintPanel();
      toast("Notifications cleared", "success");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
  panel.querySelector("[data-readall]").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await markRead(visible().filter(isUnread).map((x) => x.id));
      toast("All notifications marked as read", "success");
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
    }
  });
  panel.querySelector(".np-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-id]");
    if (!b) return;
    const n = items.find((x) => x.id === b.dataset.id);
    if (!n) return;
    if (isUnread(n)) await markRead([n.id]).catch((err) => toast(err.message, "error"));
    if (n.link) { closePanel(); location.hash = `#/${n.link}`; }
  });
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
}

/** Once a day per alert: low stock, out of stock, and batches that expire soon. Runs when staff with stock access open the app. */
export async function runStockChecks() {
  if (!rolesWith("inventory").includes(session.role) && session.role !== "admin") return;
  const today = new Date().toLocaleDateString("en-CA");
  const soon = new Date(Date.now() + 30 * 86400000).toLocaleDateString("en-CA");
  try {
    const [prodSnap, batchSnap] = await Promise.all([
      getDocs(collection(db, "products")),
      getDocs(query(collection(db, "batches"), where("remaining", ">", 0))),
    ]);
    const inv = rolesWith("inventory");
    for (const d of prodSnap.docs) {
      const p = d.data();
      if (p.active === false) continue;
      const stock = Number(p.stock) || 0;
      if (stock <= 0) {
        await notifyOnce(`out-${d.id}-${today}`, { roleKeys: inv, kind: "stock", title: `Out of stock: ${p.name}`, body: "Reorder now.", link: "inventory" });
      } else if ((Number(p.reorderLevel) || 0) > 0 && stock <= Number(p.reorderLevel)) {
        await notifyOnce(`low-${d.id}-${today}`, { roleKeys: inv, kind: "stock", title: `Low stock: ${p.name}`, body: `${stock} left, reorder level ${p.reorderLevel}.`, link: "inventory" });
      }
    }
    const expiring = batchSnap.docs.map((b) => b.data()).filter((b) => b.expiry && b.expiry <= soon);
    if (expiring.length) {
      const expired = expiring.filter((b) => b.expiry < today).length;
      await notifyOnce(`expiry-${today}`, {
        roleKeys: inv, kind: "expiry", title: `${expiring.length} batch${expiring.length === 1 ? "" : "es"} expiring within 30 days`,
        body: expired ? `${expired} already expired. Check Reports → Expiry.` : "Check Reports → Expiry.", link: "reports",
      });
    }
  } catch (err) {
    console.warn("Stock checks skipped:", err.message);
  }
}

