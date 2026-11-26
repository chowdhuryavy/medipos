// ─────────────────────────────────────────────────────────────────────
// MediPOS configuration.
// Paste the web-app config from: Firebase Console → Project settings →
// Your apps → Web app → SDK setup and configuration.
// These values identify your project; they are not secrets. Access is
// enforced by firestore.rules, so deploy those rules before go-live.
// ─────────────────────────────────────────────────────────────────────
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

export const APP_NAME = "MediPOS";

// ISO 4217 code used for money formatting (change to your currency).
export const CURRENCY = "QAR";
