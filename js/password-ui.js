import { PASSWORD_RULES, checkPassword } from "./password.js";
import { icon, esc } from "./core.js";

/**
 * Renders a new-password field (and optional confirm field) with an eye toggle and live rule checks.
 * Returns { valid(), value() } so the caller can enable its submit button.
 */
export function passwordFields(host, { confirm = true, label = "New password" } = {}) {
  host.innerHTML = `
    <label class="field"><span class="field-label">${esc(label)}</span>
      <span class="input-wrap">${icon("lock")}
        <input type="password" name="password" autocomplete="new-password" placeholder="New password" required />
        <button type="button" class="eye" data-eye aria-label="Show password">${icon("eye")}</button>
      </span></label>
    ${confirm ? `
    <label class="field"><span class="field-label">Confirm new password</span>
      <span class="input-wrap">${icon("lock")}
        <input type="password" name="confirm" autocomplete="new-password" placeholder="Confirm new password" required />
        <button type="button" class="eye" data-eye aria-label="Show password">${icon("eye")}</button>
      </span></label>` : ""}
    <ul class="rules" aria-live="polite">
      ${PASSWORD_RULES.map((r) => `<li data-rule="${r.key}">${esc(r.label)}</li>`).join("")}
    </ul>
    ${confirm ? `<p class="match" data-match></p>` : ""}`;

  const pw = host.querySelector('[name="password"]');
  const cf = host.querySelector('[name="confirm"]');
  const match = host.querySelector("[data-match]");

  const update = () => {
    for (const c of checkPassword(pw.value)) {
      host.querySelector(`[data-rule="${c.key}"]`)?.classList.toggle("ok", c.ok);
    }
    if (cf && match) {
      const filled = cf.value.length > 0;
      match.textContent = !filled ? "" : cf.value === pw.value ? "Passwords match" : "Passwords do not match";
      match.className = `match ${!filled ? "" : cf.value === pw.value ? "ok" : "bad"}`;
    }
    host.dispatchEvent(new CustomEvent("pwchange"));
  };
  pw.addEventListener("input", update);
  cf?.addEventListener("input", update);

  host.querySelectorAll("[data-eye]").forEach((btn) => btn.addEventListener("click", () => {
    const input = btn.parentElement.querySelector("input");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.innerHTML = icon(show ? "eyeOff" : "eye");
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  }));

  update();
  return {
    value: () => pw.value,
    valid: () => checkPassword(pw.value).every((c) => c.ok) && (!cf || cf.value === pw.value),
  };
}
