// ─────────────────────────────────────────────────────────────────────
// MediPOS configuration.
// Paste the web-app config from: Firebase Console → Project settings →
// Your apps → Web app → SDK setup and configuration.
// These values identify your project; they are not secrets. Access is
// enforced by firestore.rules, so deploy those rules before go-live.
// ─────────────────────────────────────────────────────────────────────
export const firebaseConfig = {
  apiKey: "AIzaSyDNBggZZJj_E61ju8knopwE06_M_HHkA_I",
  authDomain: "medipos-ae1ed.firebaseapp.com",
  projectId: "medipos-ae1ed",
  storageBucket: "medipos-ae1ed.firebasestorage.app",
  messagingSenderId: "456867198543",
  appId: "1:456867198543:web:693f874a0067237b729c3a",
};

export const APP_NAME = "MediPOS";

// ISO 4217 code used for money formatting (change to your currency).
export const CURRENCY = "QAR";
