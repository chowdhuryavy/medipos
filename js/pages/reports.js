import { onAction } from "../core.js";
import { db, collection, query, where, getDocs } from "../firebase.js";
import { session, money, esc, icon, toast, todayISO, monthStartISO, daysFromNowISO, downloadCSV, audit, settings } from "../core.js";
import { pushToSheets } from "../sheets.js";
import { printReport } from "../print.js";
import { REPORTS, buildReportTables, toSections } from "../report-tables.js";
import { toPdf, toXlsx, rasterLogo } from "../export-files.js";
import { branding } from "../branding.js";

const GROUPS = [["day", "Day"], ["month", "Month"], ["year", "Year"]];
// Only admins can read the Sheets secret (settings/integrations), so only they can send reports.
const CAN_SYNC = ["admin"];

export async function render(el) {
  el.innerHTML = `
    <section class="card">
      <div class="toolbar wrap">
        <div class="seg" id="r-kind" role="radiogroup">
          ${REPORTS.map(([k, l], i) => `<label><input type="radio" name="kind" value="${k}" ${i === 0 ? "checked" : ""} /><span>${l}</span></label>`).join("")}
        </div>
        <label class="inline">From<input type="date" id="r-from" value="${monthStartISO()}" /></label>
        <label class="inline">To<input type="date" id="r-to" value="${todayISO()}" /></label>
        <label class="inline">Expiry window
          <select id="r-days">
            ${(settings.expiryDayOptions || [30, 60, 90, 180]).map((d) => `<option value="${d}" ${d === settings.expiryWarnDays ? "selected" : ""}>${d} days</option>`).join("")}
          </select>
        </label>
        <label class="inline" id="r-group-wrap">Group by
          <select id="r-group">${GROUPS.map(([v, l]) => `<option value="${v}" ${v === "month" ? "selected" : ""}>${l}</option>`).join("")}</select>
        </label>
      </div>
      <div class="toolbar wrap">
        <div class="grow"></div>
        <button class="btn ghost" id="r-pdf">${icon("download")}<span>PDF</span></button>
        <button class="btn ghost" id="r-xlsx">${icon("download")}<span>Excel</span></button>
        <button class="btn ghost" id="r-csv">${icon("download")}<span>CSV</span></button>
        <button class="btn ghost" id="r-print">${icon("print")}<span>Print A4</span></button>
        <button class="btn primary" id="r-all-pdf">${icon("download")}<span>All reports · PDF</span></button>
        <button class="btn primary" id="r-all-xlsx">${icon("download")}<span>All reports · Excel</span></button>
        ${CAN_SYNC.includes(session.role) ? `<button class="btn ghost" id="r-sync">${icon("sync")}<span>Send to Google Sheets</span></button>` : ""}
      </div>
    </section>
    <div id="r-out"></div>`;

  let tables = null;
  const out = el.querySelector("#r-out");
  const kind = () => el.querySelector('input[name="kind"]:checked').value;
  const range = () => ({ from: el.querySelector("#r-from").value, to: el.querySelector("#r-to").value });
  const label = (k) => REPORTS.find(([key]) => key === k)[1];

  // Reads the raw records once; every table is then calculated from them the same way the scheduled email does.
  async function load() {
    out.innerHTML = `<div class="skeleton"></div>`;
    const { from, to } = range();
    const [salesSnap, retSnap, expSnap, prodSnap, batchSnap] = await Promise.all([
      getDocs(query(collection(db, "sales"), where("date", ">=", from), where("date", "<=", to))),
      getDocs(query(collection(db, "returns"), where("date", ">=", from), where("date", "<=", to))),
      getDocs(query(collection(db, "expenses"), where("date", ">=", from), where("date", "<=", to))),
      getDocs(collection(db, "products")),
      getDocs(collection(db, "batches")),
    ]);
    tables = buildReportTables({
      sales: salesSnap.docs.map((d) => d.data()),
      returns: retSnap.docs.map((d) => d.data()),
      expenses: expSnap.docs.map((d) => d.data()),
      products: prodSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      batches: batchSnap.docs.map((d) => d.data()),
    }, {
      from, to, today: todayISO(), soon: daysFromNowISO(Number(el.querySelector("#r-days").value)),
      group: el.querySelector("#r-group").value, money,
    });
    paint();
  }

  function paint() {
    const k = kind();
    el.querySelector("#r-group-wrap").hidden = !["pl", "expenses"].includes(k);
    const d = tables[k];
    const daily = tables.charts?.daily || [];
    const dMax = Math.max(1, ...daily.map(([, v]) => v));
    out.innerHTML = `
      ${k === "daily" && daily.length ? `
      <section class="card">
        <header class="card-head"><h3>Daily revenue</h3><span class="muted">${daily.length} day${daily.length === 1 ? "" : "s"} with sales</span></header>
        <div class="chart">
          ${daily.map(([date, v]) => `
            <div class="bar-col" title="${esc(date)}: ${esc(money(v))}">
              <span class="bar-value">${Math.round(v).toLocaleString()}</span>
              <div class="bar" style="--h:${Math.max(3, Math.round((v / dMax) * 100))}%"></div>
              <span class="bar-label">${esc(date.slice(5))}</span>
            </div>`).join("")}
        </div>
      </section>` : ""}
      ${d.summary ? `<section class="kpi-grid">${d.summary.map(([l, v], i) => `
        <article class="card kpi hover-lift" style="--d:${i * 60}ms"><div class="kpi-ico">${icon("reports")}</div><div><small>${esc(l)}</small><strong>${esc(v)}</strong></div></article>`).join("")}</section>` : ""}
      <section class="card">
        <div class="table-wrap"><table class="stack-mobile">
          <thead><tr>${d.headers.map((h, i) => `<th class="${d.numeric.includes(i) ? "r" : ""}">${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>${d.rows.map((r, ri) => `<tr class="row-in" style="--i:${Math.min(ri, 15)}">${r.map((v, i) =>
            `<td data-label="${esc(d.headers[i])}" class="${d.numeric.includes(i) ? "r" : ""}">${d.numeric.includes(i) && typeof v === "number" ? money(v) : esc(v)}</td>`).join("")}</tr>`).join("")
            || `<tr><td colspan="${d.headers.length}" class="muted center">Nothing to show for this period.</td></tr>`}</tbody>
        </table></div>
      </section>`;
  }

  // File name: report, period, and the date it was made.
  const slug = (t) => String(t).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";
  const fileName = (base, ext) => `${slug(settings.shopName || "MediPOS")}_${slug(base)}_${range().from}_to_${range().to}_made_${todayISO()}.${ext}`;
  const download = (name, bytes, type) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const sectionsFor = (keys) => toSections(tables, keys).map((s) => ({ ...s, title: s.title }));
  const shopTitle = () => `${settings.shopName || "MediPOS"}`;
  const subtitle = () => `${range().from} to ${range().to} · Made ${new Date().toLocaleString()}`;
  const brand = () => ({ shop: settings.shopName || "MediPOS", color: branding.brandColor, subtitle: subtitle() });
  const makePdf = async (keys, title) => toPdf({ title, subtitle: subtitle(), footer: `${shopTitle()} · MediPOS`, sections: sectionsFor(keys), brand: { ...brand(), logo: await rasterLogo(branding.logoUrl) } });
  const makeXlsx = (keys) => toXlsx(sectionsFor(keys), brand());
  const allKeys = () => REPORTS.map(([k]) => k);

  el.querySelector("#r-kind").addEventListener("change", paint);
  ["#r-from", "#r-to", "#r-days"].forEach((s) => el.querySelector(s).addEventListener("change", load));
  el.querySelector("#r-group").addEventListener("change", load);

  el.querySelector("#r-pdf").addEventListener("click", async () => {
    const k = kind();
    download(fileName(label(k), "pdf"), await makePdf([k], label(k)), "application/pdf");
  });
  el.querySelector("#r-xlsx").addEventListener("click", () => {
    const k = kind();
    download(fileName(label(k), "xlsx"), makeXlsx([k]), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
  el.querySelector("#r-all-pdf").addEventListener("click", async () => {
    download(fileName("All reports", "pdf"), await makePdf(allKeys(), `${shopTitle()} · All reports`), "application/pdf");
  });
  el.querySelector("#r-all-xlsx").addEventListener("click", () => {
    download(fileName("All reports", "xlsx"), makeXlsx(allKeys()), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
  el.querySelector("#r-print").addEventListener("click", () => {
    const k = kind();
    const d = tables[k];
    printReport({
      title: `${label(k)} report`,
      from: range().from, to: range().to,
      summary: d.summary || [], headers: d.headers, rows: d.rows, numeric: d.numeric || [],
    });
  });
  el.querySelector("#r-csv").addEventListener("click", () => {
    const d = tables[kind()];
    downloadCSV(`${kind()}-${todayISO()}.csv`, [d.headers, ...d.rows]);
  });

  const syncBtn = el.querySelector("#r-sync");
  if (syncBtn) onAction(syncBtn, async () => {
    const btn = syncBtn;
    try {
      for (const [k, name] of REPORTS) {
        await pushToSheets(name, tables[k].headers, tables[k].rows);
      }
      await audit("sheets.sync", range());
      toast("Reports sent to Google Sheets", "success");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  });

  load();
}
