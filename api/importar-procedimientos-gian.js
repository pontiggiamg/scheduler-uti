import { initializeApp, getApps } from "firebase/app";
import { getFirestore, collection, doc, setDoc, getDoc } from "firebase/firestore";

var firebaseConfig = {
  apiKey: "AIzaSyAHjLDpf9MZr8I6KA1sg3Ofr0GzN0IYENw",
  authDomain: "residencia-uti-hb.firebaseapp.com",
  projectId: "residencia-uti-hb",
  storageBucket: "residencia-uti-hb.firebasestorage.app",
  messagingSenderId: "404025159387",
  appId: "1:404025159387:web:eab539798b975a00dca6fe",
};

var app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
var db = getFirestore(app);

// Carga histórica única de los procedimientos de Gian (2025/2026), pasados
// por el jefe de residentes. Este endpoint es de un solo uso: escribe un
// documento marcador y si ya existe, no vuelve a cargar nada (para evitar
// duplicar todo si se llama sin querer más de una vez). Se puede borrar este
// archivo del repo después de usarlo una sola vez.
var RESIDENTE = "Gian";
var ADMIN_EMAIL = "pontiggiamg@gmail.com";
var MARKER_ID = "import-gian-procedimientos-2025-2026";

var NUEVOS_TIPOS = ["Colocación de EV1000", "Colocación de máscara laríngea"];
var DEFAULT_PROCEDIMIENTOS = [
  "Vía venosa central", "Vía arterial", "Intubación orotraqueal", "Traqueostomía percutánea",
  "Toracocentesis", "Avenamiento pleural (tubo de tórax)", "Paracentesis", "Punción lumbar",
  "Colocación de catéter de hemodiálisis", "Cardioversión eléctrica", "Broncoscopía",
  "Sonda nasogástrica / nasoyeyunal", "Cricotiroidotomía", "Pericardiocentesis",
  "Ecografía point-of-care (FAST/POCUS)",
];

var ENTRADAS = [{"tipo":"Vía venosa central","fecha":"2025-09-02","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2025-09-07","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2025-09-07","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2025-09-17","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2025-09-20","nota":"No se detalla región"},{"tipo":"Vía venosa central","fecha":"2025-09-30","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2025-10-10","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2025-10-15","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2025-10-19","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2025-10-23","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2025-10-25","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2025-10-29","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2025-11-01","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2025-11-02","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2025-11-11","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2025-11-17","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2025-11-17","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2025-11-20","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2025-11-24","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2025-12-03","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2025-12-13","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2025-12-23","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2025-12-25","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-01-26","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-02-03","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-02-14","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-03-15","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-03-15","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-03-15","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-03-15","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-03-15","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-04-03","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-04-07","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-04-16","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-04-25","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-04-30","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-05-03","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-05-03","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-05-13","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-05-09","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-05-18","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-05-25","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-06-01","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-06-15","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-06-17","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-06-23","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-06-23","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-06-30","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-07-02","nota":"Yugular"},{"tipo":"Vía venosa central","fecha":"2026-07-03","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-07-05","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-07-13","nota":"Femoral"},{"tipo":"Vía venosa central","fecha":"2026-07-15","nota":"Yugular"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2025-09-04","nota":""},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2025-09-16","nota":"Yugular"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2025-10-18","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2025-11-19","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2025-11-22","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2025-11-28","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2025-12-10","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2025-12-25","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-01-20","nota":"Yugular"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-02-03","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-02-13","nota":"Yugular"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-02-23","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-02-28","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-03-15","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-03-15","nota":"Yugular"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-03-25","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-03-30","nota":"Yugular"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-03-30","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-04-09","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-04-11","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-04-24","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-05-27","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-06-19","nota":"Yugular"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-07-07","nota":"Yugular"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-07-23","nota":"Femoral"},{"tipo":"Colocación de catéter de hemodiálisis","fecha":"2026-07-29","nota":"Femoral"},{"tipo":"Intubación orotraqueal","fecha":"2025-09-01","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-09-01","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-09-01","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-09-01","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-11-02","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-11-24","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-01","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-01","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-01","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-01","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-02","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-02","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-02","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-03","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-09","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-09","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-10","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-10","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-12","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-12","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-12","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-15","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-15","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-15","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-15","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-16","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-16","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-17","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-17","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-18","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-18","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-18","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2025-12-18","nota":""},{"tipo":"Intubación orotraqueal","fecha":"2026-01-20","nota":""},{"tipo":"Colocación de máscara laríngea","fecha":"2025-12-01","nota":""},{"tipo":"Vía arterial","fecha":"2025-09-01","nota":""},{"tipo":"Vía arterial","fecha":"2025-09-01","nota":""},{"tipo":"Vía arterial","fecha":"2025-09-01","nota":""},{"tipo":"Vía arterial","fecha":"2025-11-24","nota":""},{"tipo":"Vía arterial","fecha":"2025-11-01","nota":""},{"tipo":"Vía arterial","fecha":"2025-11-01","nota":""},{"tipo":"Vía arterial","fecha":"2025-12-01","nota":"Femoral"},{"tipo":"Vía arterial","fecha":"2025-12-01","nota":"Femoral"},{"tipo":"Vía arterial","fecha":"2025-12-01","nota":"Radial"},{"tipo":"Vía arterial","fecha":"2025-12-01","nota":"Radial"},{"tipo":"Vía arterial","fecha":"2026-01-01","nota":"Femoral"},{"tipo":"Vía arterial","fecha":"2026-01-01","nota":"Femoral"},{"tipo":"Vía arterial","fecha":"2026-03-01","nota":"Femoral"},{"tipo":"Vía arterial","fecha":"2026-03-01","nota":"Radial"},{"tipo":"Vía arterial","fecha":"2026-03-01","nota":"Femoral"},{"tipo":"Vía arterial","fecha":"2026-03-01","nota":"Femoral"},{"tipo":"Vía arterial","fecha":"2026-03-01","nota":"Femoral"},{"tipo":"Vía arterial","fecha":"2026-04-01","nota":"Radial"},{"tipo":"Vía arterial","fecha":"2026-05-01","nota":"Femoral"},{"tipo":"Vía arterial","fecha":"2026-05-01","nota":"Radial"},{"tipo":"Vía arterial","fecha":"2026-06-01","nota":"Radial"},{"tipo":"Vía arterial","fecha":"2026-07-01","nota":"Radial"},{"tipo":"Vía arterial","fecha":"2026-07-01","nota":"Radial"},{"tipo":"Vía arterial","fecha":"2026-07-01","nota":"Radial"},{"tipo":"Colocación de EV1000","fecha":"2026-02-01","nota":""},{"tipo":"Colocación de EV1000","fecha":"2026-03-01","nota":""},{"tipo":"Colocación de EV1000","fecha":"2026-06-01","nota":""},{"tipo":"Colocación de EV1000","fecha":"2026-06-01","nota":""},{"tipo":"Punción lumbar","fecha":"2025-10-01","nota":""},{"tipo":"Punción lumbar","fecha":"2025-12-01","nota":""},{"tipo":"Punción lumbar","fecha":"2026-02-01","nota":""},{"tipo":"Punción lumbar","fecha":"2026-03-01","nota":""},{"tipo":"Punción lumbar","fecha":"2026-03-01","nota":""},{"tipo":"Punción lumbar","fecha":"2026-04-01","nota":""},{"tipo":"Punción lumbar","fecha":"2026-05-01","nota":""},{"tipo":"Punción lumbar","fecha":"2026-07-01","nota":""}];

export default async function handler(req, res) {
  try {
    var markerRef = doc(db, "scheduler", MARKER_ID);
    var markerSnap = await getDoc(markerRef);
    if (markerSnap.exists()) {
      return res.status(409).json({ ok: false, error: "Esta importación ya se ejecutó antes (marcador scheduler/" + MARKER_ID + " ya existe). No se cargó nada de nuevo." });
    }

    var cfgRef = doc(db, "scheduler", "registro-config");
    var cfgSnap = await getDoc(cfgRef);
    var current = cfgSnap.exists() && Array.isArray(cfgSnap.data().procedimientosList) && cfgSnap.data().procedimientosList.length
      ? cfgSnap.data().procedimientosList
      : DEFAULT_PROCEDIMIENTOS;
    var missing = NUEVOS_TIPOS.filter(function (n) { return current.indexOf(n) < 0; });
    if (missing.length) {
      await setDoc(cfgRef, { procedimientosList: current.concat(missing) }, { merge: true });
    }

    var now = new Date().toISOString();
    var count = 0;
    for (var i = 0; i < ENTRADAS.length; i++) {
      var e = ENTRADAS[i];
      var ref = doc(collection(db, "procedimientos"));
      await setDoc(ref, {
        residente: RESIDENTE,
        tipo: e.tipo,
        fecha: e.fecha,
        nota: e.nota || "",
        estado: "aprobado",
        creadoPor: ADMIN_EMAIL,
        creadoEn: now,
        revisadoPor: ADMIN_EMAIL,
        revisadoEn: now,
        importado: true,
      });
      count++;
    }

    await setDoc(markerRef, { importadoEn: now, total: count, residente: RESIDENTE });

    return res.status(200).json({ ok: true, total: count, tiposAgregados: missing });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
