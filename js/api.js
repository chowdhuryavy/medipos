import { auth } from "./firebase.js";

/** POSTs JSON to a server function. Adds the signed-in user's token when `secure` is true. */
export async function post(path, body = {}, { secure = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (secure) {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error("Please sign in again.");
    headers.Authorization = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    throw new Error("No connection. Check your internet and try again.");
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}
