import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

/** Temporary password: 12 characters with at least one upper, lower, digit and symbol. */
export function generateTempPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digit = "23456789";
  const symbol = "!@#$%&*?";
  const all = upper + lower + digit + symbol;
  const chars = [upper, lower, digit, symbol].map((set) => set[randomInt(set.length)]);
  while (chars.length < 12) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Six-digit reset code. */
export const generateOtp = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** Salted hash so a stored code cannot be read back from the database. */
export function hashCode(code, salt) {
  return scryptSync(code, salt, 32).toString("hex");
}

export function newSalt() {
  return randomBytes(16).toString("hex");
}

export function codeMatches(code, salt, expectedHash) {
  const a = Buffer.from(hashCode(code, salt), "hex");
  const b = Buffer.from(String(expectedHash || ""), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
