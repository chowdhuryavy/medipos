// Expense categories. The administrator creates them. Each category gets its own expense account in the ledger,
// so every expense is posted to the right place.
import { db, collection, getDocs, doc, setDoc, serverTimestamp } from "./firebase.js";
import { settings, session, esc, icon, toast, openModal, confirmBox, audit, onSubmit } from "./core.js";

/** The categories in use: the saved list, or (before any is created) every expense account. */
export function expenseCategories(expenseAccounts = []) {
  const saved = Array.isArray(settings.expenseCategories) ? settings.expenseCategories : [];
  if (saved.length) return saved;
  return expenseAccounts.map((a) => ({ name: a.name, account: a.code }));
}

// Next free expense account code in the 6000 range (for example 6110, 6120…).
function nextExpenseCode(accounts) {
  const used = new Set(accounts.map((a) => String(a.code)));
  let n = Math.max(6100, ...accounts.filter((a) => a.type === "expense").map((a) => Number(a.code)).filter((c) => c >= 6000 && c < 7000));
  do { n += 10; } while (used.has(String(n)));
  return String(n);
}

async function saveCategories(list) {
  await setDoc(doc(db, "settings", "general"), { expenseCategories: list, updatedAt: serverTimestamp() }, { merge: true });
  settings.expenseCategories = list;
  await audit("expense.categories", { count: list.length });
}

/** Admin dialog to create and remove expense categories. Other roles see the list only. */
export async function manageExpenseCategories(onChange) {
  const accSnap = await getDocs(collection(db, "accounts"));
  const accounts = accSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const isAdmin = session.role === "admin";
  const current = () => expenseCategories(accounts.filter((a) => a.type === "expense"));

  const listHtml = () => current().map((c, i) => `
    <li class="pill">
      <span><strong>${esc(c.name)}</strong> <small class="muted">· ledger ${esc(c.account)}</small></span>
      ${isAdmin ? `<button class="icon-btn sm hover-danger" type="button" data-rm="${i}" aria-label="Remove ${esc(c.name)}">${icon("x")}</button>` : ""}
    </li>`).join("") || `<li class="muted">No categories yet. Add the first one below.</li>`;

  openModal("Expense categories", `
    <p class="muted small">Each category has its own expense account, so expenses are posted and reported correctly.</p>
    <ul class="alert-list" id="ec-list">${listHtml()}</ul>
    ${isAdmin
      ? `<form id="ec-form" class="order-add"><input name="name" placeholder="New category, e.g. Electricity" required autocomplete="off" /><button class="btn primary" type="submit">${icon("plus")}<span>Add category</span></button></form>`
      : `<p class="muted small">Only the administrator can add or remove categories.</p>`}`, (body) => {
    const refresh = () => { body.querySelector("#ec-list").innerHTML = listHtml(); };

    if (isAdmin) {
      onSubmit(body.querySelector("#ec-form"), async (e) => {
        e.preventDefault();
        const name = String(new FormData(e.target).get("name") || "").trim();
        if (!name) return toast("Type a category name", "error");
        const base = current();
        if (base.some((c) => c.name.toLowerCase() === name.toLowerCase())) return toast("That category already exists", "error");
        try {
          const code = nextExpenseCode(accounts);
          const account = { code, name, type: "expense", createdAt: serverTimestamp() };
          await setDoc(doc(db, "accounts", code), account);
          accounts.push({ id: code, ...account });
          await saveCategories([...base, { name, account: code }]);
          e.target.reset();
          toast(`${name} added. Ledger account ${code} created.`, "success");
          refresh();
          onChange?.();
        } catch (err) {
          toast(err.message, "error");
        }
      });

      body.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-rm]");
        if (!b) return;
        const base = current();
        const c = base[Number(b.dataset.rm)];
        if (!(await confirmBox(`Remove "${c.name}" from the category list? Past expenses keep this category, and its ledger account is kept.`))) return;
        try {
          await saveCategories(base.filter((_, i) => i !== Number(b.dataset.rm)));
          toast("Category removed", "success");
          refresh();
          onChange?.();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    }
  });
}
