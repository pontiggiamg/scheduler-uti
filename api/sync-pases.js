import { initializeApp, getApps } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAHjLDpf9MZr8I6KA1sg3Ofr0GzN0IYENw",
  authDomain: "residencia-uti-hb.firebaseapp.com",
  projectId: "residencia-uti-hb",
  storageBucket: "residencia-uti-hb.firebasestorage.app",
  messagingSenderId: "404025159387",
  appId: "1:404025159387:web:eab539798b975a00dca6fe",
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);

const DOCS = [
  { fallbackUnit: "Doc 1", docId: "1tI_qLk2KBzsuH9kvLEbXb1CHkEMiOynX" },
  { fallbackUnit: "Doc 2", docId: "1w3DmAlBp_YAaga6l-a4n2EPI-M-qGake" },
  { fallbackUnit: "Doc 3", docId: "1F8k_iEChO2Lfw0JhpnF7F9Gb2wj-7kp7" },
  { fallbackUnit: "Doc 4", docId: "1aqaYd9WC86REwTfKFWE5mJf96aMotUV4" },
];

const UNIT_ORDER = ["UTI 1", "UTI 2", "UTI 3", "UCO", "RECU"];

async function fetchDocText(docId) {
  const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(