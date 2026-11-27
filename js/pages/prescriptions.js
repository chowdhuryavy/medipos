// Prescription and controlled-drug register. Each prescription is recorded once and cannot be edited or deleted,
// so the register stays a reliable record. Recording a prescription does not change stock: the sale does that.
import { db, collection, doc, getDocs, addDoc, query, orderBy, limit, serverTimestamp } from "../firebase.js";
import { session, audit, toast, esc, icon, onSubmit, todayISO, canWrite } from "../core.js";

const MAX_ITEMS = 30;

export async function render(el) {
  const [rxSnap, docSnap] = await Promise.all([
    getDocs(query(collection(db, "prescriptions"), orderBy("createdAt", "desc"), limit(200))),
    getDocs(query(collection(db, "doctors"), orderBy("name"), limit(300))),
  ]);
  const rx = rxSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const doctors = docSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const canAct = canWrite("pos");

  el.innerHTML = `
    <div class="rx-page stack">
      ${canAct ? recordForm(doctors) : `<p class="muted small">You can view the register. Only a sales user can record prescriptions.</p>`}
      <section class="card">
        <header class="card-head"><h3>${icon("reports")} Register</h3>
          <label class="inline">Show <select id="rx-filter"><option value="all">All</option><option value="controlled">Controlled drugs only</option></select></label>
        </header>
        <div id="rx-list">${listHtml(rx, "all")}</div>
      </section>
      <section class="card">
        <header class="card-head"><h3>${icon("partners")} Doctors and clinics</h3></header>
        ${canAct ? doctorForm() : ""}
        <div class="table-wrap"><table>
          <thead><tr><th>Doctor</th><th>Clinic</th><th>Reg. no.</th><th>Phone</th></tr></thead>
          <tbody>${doctors.length ? doctors.map((d) => `<tr><td data-label="Doctor">${esc(d.name)}</td><td data-label="Clinic">${esc(d.clinic || "")}</td><td data-label="Reg. no.">${esc(d.regNo || "")}</td><td data-label="Phone">${esc(d.phone || "")}</td></tr>`).join("") : `<tr><td colspan="4" class="muted">No doctors yet.</td></tr>`}</tbody>
        </table></div>
      </section>
    </div>`;

  el.querySelector("#rx-filter").addEventListener("change", (e) => {
    el.querySelector("#rx-list").innerHTML = listHtml(rx, e.target.value);
  });

  if (canAct) {
    const itemsBox = el.querySelector("#rx-items");
    const addRow = () => {
      if (itemsBox.children.length >= MAX_ITEMS) return toast(`A prescription can hold up to ${MAX_ITEMS} items.`, "error");
      const row = document.createElement("div");
      row.className = "rx-item";
      row.innerHTML = `
        <input name="itemName" placeholder="Medicine" required maxlength="120" />
        <input name="itemQty" type="number" min="1" step="1" placeholder="Qty" required />
        <label class="inline"><input name="itemControlled" type="checkbox" /> Controlled</label>
        <button type="button" class="btn ghost sm" data-rm>Remove</button>`;
      row.querySelector("[data-rm]").addEventListener("click", () => row.remove());
      itemsBox.appendChild(row);
    };
    el.querySelector("#rx-add").addEventListener("click", addRow);
    addRow();

    const dsel = el.querySelector("#rx-doctor");
    dsel.addEventListener("change", () => { /* selection read on save */ });

    onSubmit(el.querySelector("#rx-form"), async (e) => {
      const fd = new FormData(e.target);
      const rxNo = String(fd.get("rxNo") || "").trim();
      const patient = String(fd.get("patient") || "").trim();
      if (!rxNo) throw new Error("Enter the prescription number.");
      if (!patient) throw new Error("Enter the patient name.");
      const rows = [...itemsBox.querySelectorAll(".rx-item")];
      const items = rows.map((r) => ({
        name: r.querySelector('[name="itemName"]').value.trim(),
        qty: Math.max(1, parseInt(r.querySelector('[name="itemQty"]').value, 10) || 0),
        controlled: r.querySelector('[name="itemControlled"]').checked,
      })).filter((i) => i.name);
      if (!items.length) throw new Error("Add at least one medicine.");
      const docId = fd.get("doctorId") || "";
      const d = doctors.find((x) => x.id === docId);
      if (rx.some((x) => x.rxNo === rxNo)) throw new Error("This prescription number is already in the register.");
      await addDoc(collection(db, "prescriptions"), {
        rxNo, date: String(fd.get("date") || todayISO()),
        patient, patientPhone: String(fd.get("phone") || "").trim(),
        doctorId: d ? d.id : null, doctorName: d ? d.name : "", clinic: d ? (d.clinic || "") : "",
        items, controlled: items.some((i) => i.controlled),
        notes: String(fd.get("notes") || "").trim(),
        recordedBy: session.name, recordedByUid: session.uid, createdAt: serverTimestamp(),
      });
      await audit("prescription.record", { rxNo, controlled: items.some((i) => i.controlled) });
      toast("Prescription recorded", "success");
      render(el);
    });

    onSubmit(el.querySelector("#dr-form"), async (e) => {
      const fd = new FormData(e.target);
      const name = String(fd.get("name") || "").trim();
      if (!name) throw new Error("Enter the doctor's name.");
      await addDoc(collection(db, "doctors"), {
        name, clinic: String(fd.get("clinic") || "").trim(), regNo: String(fd.get("regNo") || "").trim(),
        phone: String(fd.get("phone") || "").trim(), createdBy: session.name, createdByUid: session.uid, createdAt: serverTimestamp(),
      });
      await audit("doctor.add", { name });
      toast("Doctor saved", "success");
      render(el);
    });
  }
}

function recordForm(doctors) {
  return `
    <section class="card">
      <header class="card-head"><h3>${icon("cart")} Record a prescription</h3></header>
      <form id="rx-form" class="form-grid">
        <label>Prescription no.<input name="rxNo" required maxlength="40" /></label>
        <label>Date<input name="date" type="date" value="${todayISO()}" /></label>
        <label>Patient name<input name="patient" required maxlength="120" /></label>
        <label>Patient phone<input name="phone" inputmode="tel" maxlength="30" /></label>
        <label class="span-2">Doctor<select id="rx-doctor" name="doctorId"><option value="">— Not stated —</option>${doctors.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}${d.clinic ? ` · ${esc(d.clinic)}` : ""}</option>`).join("")}</select></label>
        <div class="span-2 stack">
          <span class="small muted">Medicines on the prescription</span>
          <div id="rx-items" class="stack"></div>
          <div><button type="button" class="btn ghost sm" id="rx-add">+ Add medicine</button></div>
        </div>
        <label class="span-2">Notes<input name="notes" maxlength="300" /></label>
        <div class="form-actions span-2"><button class="btn primary" type="submit">${icon("check")}<span>Save prescription</span></button></div>
      </form>
    </section>`;
}

function doctorForm() {
  return `
    <form id="dr-form" class="form-grid">
      <label>Doctor name<input name="name" required maxlength="120" /></label>
      <label>Clinic<input name="clinic" maxlength="120" /></label>
      <label>Registration no.<input name="regNo" maxlength="40" /></label>
      <label>Phone<input name="phone" inputmode="tel" maxlength="30" /></label>
      <div class="form-actions span-2"><button class="btn ghost" type="submit">${icon("check")}<span>Add doctor</span></button></div>
    </form>`;
}

function listHtml(rx, filter) {
  const rows = rx.filter((r) => filter === "all" || r.controlled);
  if (!rows.length) return `<div class="empty-state small">${icon("reports")}<p>No prescriptions to show.</p></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Rx no.</th><th>Patient</th><th>Doctor</th><th>Medicines</th><th>Controlled</th><th>Recorded by</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td data-label="Date">${esc(r.date || "")}</td>
      <td data-label="Rx no.">${esc(r.rxNo)}</td>
      <td data-label="Patient">${esc(r.patient)}</td>
      <td data-label="Doctor">${esc(r.doctorName || "")}</td>
      <td data-label="Medicines">${(r.items || []).map((i) => `${esc(i.name)} × ${esc(i.qty)}`).join("<br>")}</td>
      <td data-label="Controlled">${r.controlled ? `<span class="badge danger">Yes</span>` : ""}</td>
      <td data-label="Recorded by">${esc(r.recordedBy || "")}</td>
    </tr>`).join("")}</tbody></table></div>`;
}
