import { configError, httpError } from "./errors.js";

// Reads the Vercel settings that version history needs. The token stays on the server and is never sent to a browser.
export function vercelConfig() {
  const token = process.env.VERCEL_TOKEN || "";
  const projectId = process.env.VERCEL_PROJECT_ID || "";
  const teamId = process.env.VERCEL_TEAM_ID || "";
  if (!token) throw configError("Version history needs VERCEL_TOKEN. Create a token at vercel.com/account/tokens, add it in Vercel → Project → Settings → Environment Variables, then redeploy.");
  if (!projectId) throw configError("VERCEL_PROJECT_ID is missing from the Vercel environment variables.");
  return { token, projectId, teamId };
}

// One call to the Vercel REST API. Plan limits and errors become readable messages.
export async function vercelRequest(path, { method = "GET" } = {}) {
  const { token, teamId } = vercelConfig();
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.vercel.com${path}${teamId ? `${sep}teamId=${encodeURIComponent(teamId)}` : ""}`;
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON: keep the status message */ }
  if (!res.ok) {
    if (res.status === 402) throw httpError(402, "Your Vercel plan does not allow going back from MediPOS. Use Instant Rollback in the Vercel dashboard instead.");
    throw httpError(502, `Vercel answered ${res.status}. ${json?.error?.message || ""}`.trim());
  }
  return json;
}
