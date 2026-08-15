import { initializeApp, getApps } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";
import { parsePase } from "./parse-pase.js";

/* ═══════════════════════════════════════════════════════════
   CONFIGURACIÓN — PEGAR ACÁ LOS IDs DE CADA GOOGLE DOC

   El ID es la parte larga de la URL del documento:
   https://docs.google.com/document/d/  ESTE_PEDAZO_ES_EL_ID  /edit

   Cada doc tiene que estar compartido como
   "Cualquier persona con el enlace → Lector".
   ═══════════════════════════════════════════════════════════ */

const DOCS = [
  { unit: "UTI 1", docId: 1w3DmAlBp_YAaga6l-a4n2EPI-M-qGake },
  { unit: "UTI 2", docId: 1F8k_iEChO2Lfw0JhpnF7F9Gb2wj-7kp7 }, // este doc trae UTI 2 y UCO
  { unit: "UTI 3", docId: 1aqaYd9WC86REwTfKFWE5mJf96aMotUV4 },
  { unit: "RECU", docId: 1tI_qLk2KBzsuH9kvLEbXb1CHkEMiOynX },
];

const UNIT_ORDER = ["UTI 1", "UTI 2", "UTI 3", "UCO", "RECU"];

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

async function fetchDocText(docId) {
  const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  // Si el doc no es público, Google devuelve una página de login en HTML
  if (/<html/i.test(text.slice(0, 400))) {
    throw new Error("El documento no es accesible públicamente (revisar permisos de compartir)");
  }
  return text;
}

export default async function handler(req, res) {
  const started = Date.now();
  const units = {};
  const errors = [];

  for (const { unit, docId } of DOCS) {
    if (!docId || docId.startsWith("PEGAR_ID")) {
      errors.push({ unit, error: "Falta configurar el ID del documento" });
      continue;
    }
    try {
      const raw = await fetchDocText(docId);
      const patients = parsePase(raw, unit);
      // Un mismo doc puede traer más de una unidad (ej. UTI 2 + UCO)
      for (const p of patients) {
        const u = p.unit || unit;
        if (!units[u]) units[u] = [];
        units[u].push(p);
      }
      if (!patients.length) errors.push({ unit, error: "El documento no tenía pacientes cargados" });
    } catch (e) {
      errors.push({ unit, error: e.message || String(e) });
    }
  }

  // Ordenar camas dentro de cada unidad
  for (const u of Object.keys(units)) {
    units[u].sort((a, b) =>
      a.bed.localeCompare(b.bed, "es", { numeric: true, sensitivity: "base" })
    );
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    unitOrder: UNIT_ORDER.filter((u) => units[u]?.length).concat(
      Object.keys(units).filter((u) => !UNIT_ORDER.includes(u))
    ),
    units,
    errors,
    totalPatients: Object.values(units).reduce((n, arr) => n + arr.length, 0),
  };

  try {
    await setDoc(doc(db, "scheduler", "pases-latest"), payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "No se pudo guardar en Firestore: " + e.message });
  }

  return res.status(200).json({
    ok: true,
    ms: Date.now() - started,
    totalPatients: payload.totalPatients,
    units: Object.fromEntries(Object.entries(units).map(([k, v]) => [k, v.length])),
    errors,
  });
}
