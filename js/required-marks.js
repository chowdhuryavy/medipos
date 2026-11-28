// Every required field in every form shows a red star after its label. Runs on the whole page, including dialogs,
// so forms added later get the star too. Fields marked required in the HTML are the ones starred.
const STAR = '<span class="req-star" aria-hidden="true"> *</span>';

function markRequired(root) {
  root.querySelectorAll("label").forEach((label) => {
    if (label.dataset.reqDone || !label.querySelector("[required]")) return;
    label.dataset.reqDone = "1";
    const text = [...label.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!text) return;
    // Wrap the label text and the star together so the grid layout keeps them on one line.
    const wrap = document.createElement("span");
    wrap.className = "req-text";
    wrap.textContent = text.textContent.trim();
    wrap.insertAdjacentHTML("beforeend", STAR);
    text.replaceWith(wrap);
  });
}

markRequired(document.body);
new MutationObserver((records) => {
  if (records.some((r) => r.addedNodes.length)) markRequired(document.body);
}).observe(document.body, { childList: true, subtree: true });
