import { db, collection, doc, getDocs, addDoc, updateDoc, deleteDoc, runTransaction, serverTimestamp } from "../firebase.js";
import { settings, money, esc, icon, toast, openModal, confirmBox, round2, buildJournal, audit, ACCOUNTS, can, session } from "../core.js";

export async function render(el) {
  const showSuppliers = can("purchasing");
  el.innerHTML = `
    <div class="tabs" role="tablist">
      <button class="tab active" data-type="customers">Customers</button>
      ${showSuppliers ? `<button class="tab" data-type="suppliers">Suppliers</button>` : ""}
    </div>
    <section class="card" id="pt-body"></section>`;

  el.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.type)));
  show("customers");

  async function show(type) {
    el.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.type === type));
    const body = el.querySelector("#pt-body");
    body.innerHTML = `<div class="skeleton"></div>`;
    const snap = await getDocs(collection(db, type));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
    paint(body, type, list, () => show(type));
  }
}

function paint(body, type, list, reload) {
  const isCustomer = type === "customers";
  const canDelete = session.role === "admin";
  body.innerHTML = `
    <div class="toolbar">
      <div class="search-bar">${icon("search")}<input id="pt-q" type="search" placeholder="Search by name or phone" /></div>
      <div class="grow"></div>
      <button class="btn primary" id="pt-new">${icon("plus")}<span>New ${isCustomer ? "customer" : "supplier"}</span></button>
    </div>
    <div class="table-wrap"><table class="stack-mobile">
      <thead><tr><th>Name</th><th>Phone</th><th>${isCustomer ? "Credit limit" : "Terms"}</th><th class="r">${isCustomer ? "Owes you" : "You owe"}</th><th></th></tr></thead>
      <tbody id="pt-rows"></tbody>
    </table></div>`;

  const tbody = body.querySelector("#pt-rows");
  const draw = () => {
    const q = body.querySelector("#pt-q").value.trim().toLowerCase();
    const rows = list.filter((r) => !q || [r.name, r.phone].some((v) => String(v || "").toLowerCase().includes(q)));
    tbody.innerHTML = rows.map((r, i) => `
      <tr class="row-in" style="--i:${Math.min(i, 15)}">
        <td data-label="Name"><strong>${esc(r.name)}</strong></td>
        <td data-label="Phone">${esc(r.phone || "—")}</td>
        <td data-label="${isCustomer ? "Credit limit" : "Terms"}">${isCustomer ? money(r.creditLimit || 0) : esc(r.terms || "—")}</td>
        <td data-label="Balance" class="r"><span class="badge ${(r.balance || 0) > 0 ? "warn" : "ok"}">${money(r.balance || 0)}</span></td>
        <td class="actions">
          ${(r.balance || 0) > 0 ? `<button class="btn ghost sm" data-settle="${esc(r.id)}">${isCustomer ? "Receive" : "Pay"}</button>` : ""}
          <button class="icon-btn sm" data-edit="${esc(r.id)}" aria-label="Edit">${icon("edit")}</button>
          ${canDelete ? `<button class="icon-btn sm hover-danger" data-del="${esc(r.id)}" aria-label="Delete">${icon("trash")}</button>` : ""}
        </td>
      </tr>`).join("") || `<tr><td colspan="5" class="muted center">Nothing here yet. Tap “New” to add one.</td></tr>`;
  };
  draw();
  body.querySelector("#pt-q").addEventListener("input", draw);
  body.querySelector("#pt-new").addEventListener("click", () => openForm(type, null, reload));

  tbody.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.edit) return openForm(type, list.find((r) => r.id === b.dataset.edit), reload);
    if (b.dataset.settle) return openSettle(type, list.find((r) => r.id === b.dataset.settle), reload);
    if (b.dataset.del) {
      const p = list.find((r) => r.id === b.dataset.del);
      if (!(await confirmBox(`Delete "${p.name}"? Past records remain in the books.`))) return;
      await deleteDoc(doc(db, type, p.id));
      await audit("partner.delete", { type, name: p.name });
      toast("Deleted", "success");
      reload();
    }
  });
}

function openForm(type, p, reload) {
  const isCustomer = type === "customers";
  openModal(p ? `Edit ${p.name}` : `New ${isCustomer ? "customer" : "supplier"}`, `
    <form id="ptf" class="form-grid">
      <label class="span-2">Name<input name="name" required value="${esc(p?.name || "")}" /></label>
      <label>Phone<input name="phone" type="tel" inputmode="tel" value="${esc(p?.phone || "")}" /></label>
      <label>Email<input name="email" type="email" inputmode="email" value="${esc(p?.email || "")}" /></label>
      <label class="span-2">Address<input name="address" value="${esc(p?.address || "")}" /></label>
      ${isCustomer
        ? `<label>Credit limit<input name="creditLimit" type="number" inputmode="decimal" min="0" step="0.01" value="${p?.creditLimit ?? 0}" /></label>`
        : `<label>Payment terms<input name="terms" placeholder="e.g. 30 days" value="${esc(p?.terms || "")}" /></label>`}
      <div class="form-actions span-2">
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>`, (body, close) => {
    body.querySelector("[data-cancel]").addEventListener("click", close);
    body.querySelector("#ptf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = {
        name: String(fd.get("name") || "").trim(),
        phone: String(fd.get("phone") || "").trim(),
        email: String(fd.get("email") || "").trim(),
        address: String(fd.get("address") || "").trim(),
        updatedAt: serverTimestamp(),
      };
      if (!data.name) return toast("Name is required", "error");
      if (isCustomer) data.creditLimit = Number(fd.get("creditLimit")) || 0;
      else data.terms = String(fd.get("terms") || "").trim();
      try {
        if (p) await updateDoc(doc(db, type, p.id), data);
        else await addDoc(collection(db, type), { ...data, balance: 0, createdAt: serverTimestamp() });
        await audit("partner.save", { type, name: data.name });
        toast("Saved", "success");
        close();
        reload();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

function openSettle(type, p, reload) {
  const isCustomer = type === "customers";
  const methods = settings.paymentMethods.filter((m) => !m.credit);
  openModal(isCustomer ? `Receive from ${p.name}` : `Pay ${p.name}`, `
    <form id="sf" class="form-grid">
      <p class="span-2 muted">Balance: <strong>${money(p.balance || 0)}</strong></p>
      <label>Amount<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" max="${p.balance || 0}" value="${p.balance || 0}" required /></label>
      <label>${isCustomer ? "Received in" : "Paid from"}
        <select name="method">${methods.map((m) => `<option value="${esc(m.account)}">${esc(m.label)}</option>`).join("")}</select>
      </label>
      <div class="form-actions span-2">
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" type="submit">${isCustomer ? "Record receipt" : "Record payment"}</button>
      </div>
    </form>`, (body, close) => {
    body.querySelector("[data-cancel]").addEventListener("click", close);
    body.querySelector("#sf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const amount = round2(Number(fd.get("amount")) || 0);
      const cashAccount = String(fd.get("method"));
      if (!(amount > 0)) return toast("Enter an amount above 0", "error");
      try {
        await settle({ type, id: p.id, name: p.name, amount, cashAccount });
        toast("Recorded", "success");
        close();
        reload();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

async function settle({ type, id, name, amount, cashAccount }) {
  const isCustomer = type === "customers";
  const ref = doc(db, type, id);
  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error("Record not found");
    const bal = Number(s.data().balance) || 0;
    if (amount > bal + 0.005) throw new Error(`Amount is more than the balance (${money(bal)})`);
    tx.update(ref, { balance: round2(bal - amount), updatedAt: serverTimestamp() });
    tx.set(doc(collection(db, "journal")), buildJournal({
      memo: isCustomer ? `Receipt from ${name}` : `Payment to ${name}`,
      ref: `PMT-${Date.now()}`,
      lines: isCustomer
        ? [{ account: cashAccount, debit: amount }, { account: ACCOUNTS.AR, credit: amount }]
        : [{ account: ACCOUNTS.AP, debit: amount }, { account: cashAccount, credit: amount }],
    }));
  });
  await audit(isCustomer ? "customer.receipt" : "supplier.payment", { id, amount });
}
