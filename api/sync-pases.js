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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (/<html/i.test(text.slice(0, 400))) throw new Error("No compartido públicamente");
    return text;
  } catch (e) {
    throw new Error(`Error fetching ${fallbackUnit}: ${e.message}`);
  }
}

export default async function handler(req, res) {
  try {
    const started = Date.now();
    const units = {};
    const errors = [];

    for (const { fallbackUnit, docId } of DOCS) {
      try {
        const raw = await fetchDocText(docId);
        units[fallbackUnit] = { pacientes: raw.split("\n").length };
      } catch (e) {
        errors.push({ unit: fallbackUnit, error: e.message });
      }
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      units,
      errors,
      totalLines: Object.values(units).reduce((n, u) => n + (u.pacientes || 0), 0),
    };

    await setDoc(doc(db, "scheduler", "pases-latest"), payload);

    return res.status(200).json({
      ok: true,
      ms: Date.now() - started,
      units,
      errors,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}