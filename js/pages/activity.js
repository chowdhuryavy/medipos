// Staff activity log: the audit trail of who did what, newest first. Administrators only.
import { db, collection, getDocs, query, orderBy, limit } from "../firebase.js";
import { esc, icon } from "../core.js";

function when(ts) {
  return ts?.toDate ? ts.toDate().toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
}
function detailsText(d) {
  if (!d || typeof d !== "object") return "";
  return Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(" · ");
}

export async function render(el) {
  const snap = await getDocs(query(collection(db, "audit"), orderBy("at", "desc"), limit(300)));
  const all = snap.docs.map((d) => d.data());
  el.innerHTML = `
    <div class="stack">
      <section class="card">
        <header class="card-head"><h3>${icon("partners")} Staff activity</h3></header>
        <label>Search<input id="act-q" type="search" placeholder="Name, action or detail" /></label>
        <div id="act-list" class="table-wrap"></div>
      </section>
    </div>`;
  const list = el.querySelector("#act-list");
  const paint = (q) => {
    const s = q.trim().toLowerCase();
    const rows = all.filter((a) => !s || [a.by, a.action, detailsText(a.details)].join(" ").toLowerCase().includes(s));
    list.innerHTML = rows.length ? `<table>
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
      <tbody>${rows.map((a) => `<tr>
        <td data-label="When">${esc(when(a.at))}</td>
        <td data-label="Who">${esc(a.by || "")}</td>
        <td data-label="Action">${esc(a.action || "")}</td>
        <td data-label="Details">${esc(detailsText(a.details))}</td>
      </tr>`).join("")}</tbody></table>` : `<p class="muted">No activity matches.</p>`;
  };
  el.querySelector("#act-q").addEventListener("input", (e) => paint(e.target.value));
  paint("");
}
