import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, sendPasswordResetEmail, updatePassword,
  reauthenticateWithCredential, EmailAuthProvider, setPersistence, browserSessionPersistence,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, runTransaction, serverTimestamp, increment,
  onSnapshot, writeBatch, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Sign-in lasts only for this browser session: closing the browser (or the tab on phones) signs the person out.
setPersistence(auth, browserSessionPersistence).catch((err) => console.warn("Session persistence unavailable:", err.message));

// Re-export the SDK helpers so feature modules import from one place.
export {
  initializeApp, deleteApp, getAuth,
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, sendPasswordResetEmail, updatePassword,
  reauthenticateWithCredential, EmailAuthProvider, setPersistence, browserSessionPersistence,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, runTransaction, serverTimestamp, increment,
  onSnapshot, writeBatch, arrayUnion,
};
