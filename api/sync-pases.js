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

async function fetchDocText(docId) {
  var url = "https://docs.google.com/document/d/" + docId + "/export?format=txt";
  var r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  var text = await r.text();
  if (text.slice(0, 400).match(/<html/i)) throw new Error("Doc no publico");
  return text;
}

export default async function handler(req, res) {
  try {
    var started = Date.now();
    var results = {};
    var errors = [];
    for (var i = 0; i < DOCS.length; i++) {
      var d = DOCS[i];
      try {
        var raw = await fetchDocText(d.docId);
        results[d.fallbackUnit] = raw.length + " chars, " + raw.split("\n").length + " lines";
      } catch (e) {
        errors.push({ unit: d.fallbackUnit, error: e.message });
      }
    }
    return res.status(200).json({ ok: true, ms: Date.now() - started, results: results, errors: errors });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
