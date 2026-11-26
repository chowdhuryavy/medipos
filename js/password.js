// Password rules shared by staff creation and password reset.
// Firebase Authentication → Settings → Password policy should use the same rules, so the server enforces them too.

export const PASSWORD_MIN_LENGTH = 8;

export const PASSWORD_RULES = [
  { key: "length", label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (p) => p.length >= PASSWORD_MIN_LENGTH },
  { key: "upper", label: "An uppercase letter (A–Z)", test: (p) => /[A-Z]/.test(p) },
  { key: "lower", label: "A lowercase letter (a–z)", test: (p) => /[a-z]/.test(p) },
  { key: "digit", label: "A number (0–9)", test: (p) => /[0-9]/.test(p) },
  { key: "symbol", label: "A symbol (e.g. ! @ # $ %)", test: (p) => /[^A-Za-z0-9\s]/.test(p) },
];

/** Returns each rule with whether the password passes it. */
export function checkPassword(password) {
  const p = String(password || "");
  return PASSWORD_RULES.map((r) => ({ key: r.key, label: r.label, ok: r.test(p) }));
}

/** Returns an error message, or "" when the password meets every rule. */
export function passwordProblem(password) {
  const failed = checkPassword(password).filter((r) => !r.ok);
  return failed.length ? `Password needs: ${failed.map((r) => r.label.toLowerCase()).join(", ")}.` : "";
}
