import { initializeApp } from "firebase/app";
import { initializeFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAHjLDpf9MZr8I6KA1sg3Ofr0GzN0IYENw",
  authDomain: "residencia-uti-hb.firebaseapp.com",
  projectId: "residencia-uti-hb",
  storageBucket: "residencia-uti-hb.firebasestorage.app",
  messagingSenderId: "404025159387",
  appId: "1:404025159387:web:eab539798b975a00dca6fe"
};

const app = initializeApp(firebaseConfig);

export const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
  ignoreUndefinedProperties: true
});