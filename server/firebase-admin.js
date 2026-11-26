import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// The service-account key is read from the FIREBASE_SERVICE_ACCOUNT environment variable on Vercel.
// It is never stored in the repository.
function ensureApp() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set in Vercel.");
  initializeApp({ credential: cert(JSON.parse(raw)) });
}

export const adminAuth = () => (ensureApp(), getAuth());
export const adminDb = () => (ensureApp(), getFirestore());
