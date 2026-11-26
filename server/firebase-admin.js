import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { configError } from "./errors.js";

// The service-account key is read from the FIREBASE_SERVICE_ACCOUNT environment variable on Vercel.
// It is never stored in the repository.
function ensureApp() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw configError("Server setup: FIREBASE_SERVICE_ACCOUNT is missing in Vercel. Add it and redeploy.");
  let account;
  try {
    account = JSON.parse(raw);
  } catch {
    throw configError("Server setup: FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole file again.");
  }
  initializeApp({ credential: cert(account) });
}

export const adminAuth = () => (ensureApp(), getAuth());
export const adminDb = () => (ensureApp(), getFirestore());
