import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react";
import { db, auth, googleProvider } from "./firebase";
import { doc, onSnapshot, setDoc, getDoc, deleteDoc, increment, arrayUnion, collection, getDocs, query, orderBy } from "firebase/firestore";
import { signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";

/* ══════════════════ CONFIGURACIÓN ══════════════════ */

const ADMIN_EMAIL = "pontiggiamg@gmail.com";

// Pestañas de nivel superior de la app. El orden por defecto se usa si todavía
// no hay nada guardado en Firestore (scheduler/ui-config); el admin puede
// reordenarlas arrastrando y ese orden se guarda ahí, compartido para todos.
const DEFAULT_TAB_ORDER = ["scheduler", "rotaciones", "pases", "chipa", "academico", "articulo", "registro", "hoy", "accesos"];
const TAB_META = {
  scheduler: { icon: "📅", label: "Semana" },
  rotaciones: { icon: "🔄", label: "Rotaciones y Vacaciones" },
  pases: { icon: "🛏️", label: "Pases" },
  chipa: { icon: "🥐", label: "Chipa" },
  academico: { icon: "📚", label: "Calendario Académico" },
  articulo: { icon: "📄", label: "Artículo de la semana" },
  registro: { icon: "📋", label: "Registro" },
  hoy: { icon: "📱", label: "¿Quién está hoy?" },
  accesos: { icon: "🔐", label: "Accesos", soloAdmin: true },
};

// Ruta pública sin login para compartir a otros servicios del hospital: entra
// directo a "¿Quién está en la UTI hoy?" (hasta Postguardia inclusive), sin
// pasar por la pantalla de login de Google. Como las reglas de Firestore ya
// son de lectura pública, alcanza con esquivar la pantalla de login de esta
// SPA en el propio cliente — no hace falta backend aparte.
const PUBLIC_ROUTE_PATH = "/hoy";
function isPublicRoute() {
  if (typeof window === "undefined") return false;
  return window.location.pathname.replace(/\/+$/, "") === PUBLIC_ROUTE_PATH;
}

const RESIDENTS = {
  R2: ["Maca", "Andy", "Nata", "Nahuel"],
  R3: ["Chris", "Ulloa", "Varoli", "Gian"],
  R4: ["Dani", "Caro", "Leo", "Vani"],
};

const ALL = [...RESIDENTS.R2, ...RESIDENTS.R3, ...RESIDENTS.R4];

// Mapeo residente → email de Google. Se usa para identificar qué cuenta logueada
// corresponde a qué residente (ej. Procedimientos, donde cada uno carga lo suyo).
const RESIDENT_EMAIL = {
  Dani: "dpadillasalcedo@gmail.com",
  Caro: "caro146ro@gmail.com",
  Leo: "leonardohomar1894@gmail.com",
  Vani: "vaninagobatto23@gmail.com",
  Chris: "chrislombardo225@gmail.com",
  Ulloa: "nico24ulloa@gmail.com",
  Varoli: "Nico.a.Varoli@gmail.com",
  Gian: "giancarlomilemacci@gmail.com",
  Maca: "macagonzalezvirgili@gmail.com",
  Andy: "mportilla58@gmail.com",
  Nata: "nataciademoraes@gmail.com",
  Nahuel: "nahuelklahn@gmail.com",
};
const RESIDENT_BY_EMAIL = Object.fromEntries(Object.entries(RESIDENT_EMAIL).map(([name, email]) => [email.toLowerCase(), name]));

// Nombre completo para mostrar en pantallas públicas (por ahora, solo
// "¿Quién está hoy?"). El resto de la app sigue usando el nombre corto de
// siempre como identificador interno (RESIDENTS, LEVEL, COLOR, todas las
// colecciones de Firestore) — este mapeo es puramente de presentación.
const DISPLAY_NAME = {
  Nahuel: "Nahuel",
  Maca: "Macarena",
  Gian: "Giancarlo",
  Nata: "Natacia",
  Andy: "Andrés",
  Leo: "Leonardo",
  Caro: "Carolina",
  Vani: "Vanina",
  Dani: "Daniel",
  Ulloa: "Ulloa",
  Varoli: "Varoli",
  Chris: "Christian",
};
const nombrePublico = (n) => DISPLAY_NAME[n] || n;

// Registro: llegadas tarde, faltas y guardias son eventos con fecha que carga
// el admin a mano (colección registro_eventos, campo "tipo"). Procedimientos
// es aparte: cada residente carga los suyos y el admin los aprueba/rechaza
// (colección "procedimientos"). La lista de procedimientos disponibles vive
// en Firestore (scheduler/registro-config) para que el admin la pueda ajustar
// sin tocar código; esta es solo la lista inicial con la que arranca.
const EVENTO_TIPOS = {
  tarde: { label: "Llegadas tarde", singular: "llegada tarde", icon: "⏰", color: "#B45309", bg: "#FFFBEB", bd: "#FDE68A" },
  falta: { label: "Faltas", singular: "falta", icon: "🚫", color: "#B91C1C", bg: "#FEF2F2", bd: "#FECACA" },
  guardia: { label: "Guardias", singular: "guardia", icon: "🌙", color: "#5B21B6", bg: "#F5F3FF", bd: "#DDD6FE" },
};

const DEFAULT_PROCEDIMIENTOS = [
  "Vía venosa central",
  "Vía arterial",
  "Intubación orotraqueal",
  "Traqueostomía percutánea",
  "Toracocentesis",
  "Avenamiento pleural (tubo de tórax)",
  "Paracentesis",
  "Punción lumbar",
  "Colocación de catéter de hemodiálisis",
  "Cardioversión eléctrica",
  "Broncoscopía",
  "Sonda nasogástrica / nasoyeyunal",
  "Cricotiroidotomía",
  "Pericardiocentesis",
  "Ecografía point-of-care (FAST/POCUS)",
];

// Cobertura de sala por R2/R3 (colección "cobertura_sala"): quién cubrió,
// qué día, y si fue en calidad de "post guardia" o "rotación". Solo aplica a
// R2 y R3 (los R4 no cubren sala de esta forma).
const COBERTURA_RESIDENTS = [...RESIDENTS.R2, ...RESIDENTS.R3];
const COBERTURA_TIPOS = {
  post_guardia: { label: "Post guardia", short: "PG" },
  rotacion: { label: "Rotación", short: "Rot" },
};

// Clases/presentaciones dadas por cada residente (colección "registro_clases"),
// contadas por módulo. Aplica a R2, R3 y R4 (todos).
const MODULOS_CLASE = ["Fisiología", "Shock", "Respiratorio", "Medio Interno", "Neuro intensivo", "Misceláneas"];

// Sub-pestañas de Registro: el orden por defecto se usa si todavía no hay
// nada guardado; el admin puede arrastrarlas para reordenarlas y ese orden
// se guarda compartido para todos (mismo doc que el orden de las pestañas
// principales, campo distinto).
const DEFAULT_REGISTRO_SUB_ORDER = ["tarde", "falta", "guardia", "procedimientos", "cobertura", "clases"];
const REGISTRO_SUB_META = {
  tarde: { ...EVENTO_TIPOS.tarde },
  falta: { ...EVENTO_TIPOS.falta },
  guardia: { ...EVENTO_TIPOS.guardia },
  procedimientos: { label: "Procedimientos", icon: "🩺", color: "#0F766E", bg: "#F0FDFA", bd: "#99F6E4" },
  cobertura: { label: "R2 y R3 que cubrieron sala post guardia o en rotación", icon: "🔁", color: "#1D4ED8", bg: "#EFF6FF", bd: "#BFDBFE" },
  clases: { label: "Cantidad de clases/presentaciones", icon: "🎓", color: "#7C2D12", bg: "#FFF7ED", bd: "#FED7AA" },
};

const LEVEL = Object.fromEntries(
  Object.entries(RESIDENTS).flatMap(([lv, names]) => names.map((n) => [n, lv]))
);

const COLOR = {
  R2: { bg: "#DBEAFE", bd: "#93C5FD", tx: "#1E3A8A", solid: "#3B82F6" },
  R3: { bg: "#D1FAE5", bd: "#6EE7B7", tx: "#065F46", solid: "#10B981" },
  R4: { bg: "#FFEDD5", bd: "#FDBA74", tx: "#9A3412", solid: "#F97316" },
};

const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
// Índice (dentro de DAYS) a partir del cual el día es fin de semana. En sábado
// y domingo no se arma la grilla de camas fija (UTI 1/2/3): esos días la
// cobertura de terapia se cubre de otra forma (guardia + postguardia), así
// que esas tres filas quedan bloqueadas y no se pueden usar.
const WEEKEND_START_IDX = 5;
const isWeekendIdx = (di) => di >= WEEKEND_START_IDX;
const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const WEEKDAYS_FULL = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

// Cada fila de UTI tiene su propio color para distinguirse a simple vista,
// elegidos a propósito lejos del azul de R2 y el verde de R3 (ver COLOR más
// abajo) para que el chip del residente nunca se camufle contra el fondo.
const SLOTS = [
  { key: "uti1", label: "UTI 1", accent: "#0E7490", tint: "#CFFAFE" },
  { key: "uti2", label: "UTI 2", accent: "#BE185D", tint: "#FCE7F3" },
  { key: "uti3", label: "UTI 3", accent: "#A16207", tint: "#FEF3C7" },
  { key: "postguardia", label: "Postguardia", accent: "#A855F7", tint: "#E9D5FF" },
];

const SLOT_KEYS = SLOTS.map((s) => s.key);

/* ══════════════════ FECHAS ══════════════════ */

function mondayOf(date) {
  const d = new Date(date);
  const wd = d.getDay();
  d.setDate(d.getDate() - wd + (wd === 0 ? -6 : 1));
  d.setHours(0, 0, 0, 0);
  return d;
}
const shift = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dm = (d) => `${d.getDate()}/${d.getMonth() + 1}`;
const sameDay = (a, b) => isoDate(a) === isoDate(b);
// Formato legible en hora de Argentina (fija UTC-3, sin horario de verano),
// para que los registros (ej. access_logs) se puedan leer directo en la
// consola de Firebase sin tener que restar horas a mano.
const fechaHoraAR = (d) => new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "medium", timeZone: "America/Argentina/Buenos_Aires" }).format(d);

/* ══════════════════ MODELO SEMANA ══════════════════ */

// Ojo con deGuardia: es un ARRAY de nombres, no un texto. A diferencia de
// uti1/uti2/uti3/postguardia/unavailable —que son excluyentes entre sí dentro
// de un mismo día— la guardia NO es un lugar donde la persona está, sino algo
// que además le toca ese día. Alguien puede estar cubriendo UTI 2 y encima
// quedar de guardia, o estar rotando afuera (no disponible) y quedar de
// guardia igual. Por eso la guardia queda fuera de SLOT_KEYS y no la toca
// detach(): así nunca compite con el resto ni saca a nadie de donde estaba.
// Cada entrada puede ser el nombre corto de un residente o un nombre suelto
// de alguien de afuera (ej. un médico de planta cubriendo).
const emptyDay = () => ({ uti1: [], uti2: [], uti3: [], postguardia: [], unavailable: [], observaciones: "", recordatorios: "", deGuardia: [], feriado: false });
const emptyDiasLibresR4 = () => Object.fromEntries(RESIDENTS.R4.map((n) => [n, ""]));
const emptyWeek = () => ({ days: DAYS.map(() => emptyDay()), diasLibresR4: emptyDiasLibresR4() });

function normalize(raw) {
  const week = emptyWeek();
  if (!raw || typeof raw !== "object") return week;
  const legacyGlobal = Array.isArray(raw.unavailable) ? raw.unavailable : [];
  const src = raw.days || {};
  for (let i = 0; i < DAYS.length; i++) {
    const d = src[i] || {};
    const day = week.days[i];
    for (const k of SLOT_KEYS) {
      const v = d[k];
      day[k] = Array.isArray(v) ? v.filter((n) => LEVEL[n]) : typeof v === "string" && v ? [v] : [];
    }
    day.unavailable = Array.isArray(d.unavailable) ? d.unavailable.filter((n) => LEVEL[n]) : [...legacyGlobal];
    day.observaciones = typeof d.observaciones === "string" ? d.observaciones : "";
    day.recordatorios = typeof d.recordatorios === "string" ? d.recordatorios : "";
    // Migración transparente: las semanas viejas guardaron deGuardia como un
    // texto libre separado por comas ("Lourdes, Chris, Nahuel"). Se convierte
    // al leer, así no hay que tocar nada a mano en Firestore — la próxima vez
    // que se guarde esa semana ya queda como array.
    day.deGuardia = Array.isArray(d.deGuardia)
      ? d.deGuardia.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim())
      : typeof d.deGuardia === "string"
        ? d.deGuardia.split(",").map((n) => n.trim()).filter(Boolean)
        : [];
    // Marcar un día como feriado no cambia cómo se arma la semana: es un dato
    // para poder contar después cuántas guardias de cada residente cayeron en
    // día hábil, fin de semana o feriado.
    day.feriado = d.feriado === true;
  }
  const dl = raw.diasLibresR4 || {};
  for (const n of RESIDENTS.R4) week.diasLibresR4[n] = DAYS.includes(dl[n]) ? dl[n] : "";
  return week;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const isBlank = (w) => w.days.every((d) => SLOT_KEYS.every((k) => d[k].length === 0) && d.unavailable.length === 0 && !d.observaciones.trim() && !d.recordatorios.trim() && d.deGuardia.length === 0 && !d.feriado) && RESIDENTS.R4.every((n) => !w.diasLibresR4[n]);

// Un nombre de guardia puede ser uno de los 12 residentes o alguien de afuera.
const esResidente = (n) => !!LEVEL[n];

/* ══════════════════ MODELO ROTACIONES ══════════════════ */

const emptyRotYear = () => { const m = {}; for (let i = 0; i < 12; i++) m[i] = { assignments: [], notes: "" }; return { months: m }; };

function normalizeRot(raw) {
  const year = emptyRotYear();
  if (!raw || typeof raw !== "object" || !raw.months) return year;
  for (let i = 0; i < 12; i++) { const m = raw.months[i]; if (m) { year.months[i].assignments = Array.isArray(m.assignments) ? m.assignments : []; year.months[i].notes = typeof m.notes === "string" ? m.notes : ""; } }
  return year;
}

/* ══════════════════ MODELO CHIPA DE LA SEMANA ══════════════════ */

// Cada semana vive en su propio documento (id = lunes de esa semana, YYYY-MM-DD)
// dentro de dos colecciones separadas y sin ningún campo que las vincule:
// chipa_votes/{weekId}   → candidatos y recuento de votos (público)
// chipa_voters/{weekId}  → uids que ya votaron esa semana (solo para bloquear el doble voto)
// Así se ve cuántos votos tiene cada uno, pero no quién votó a quién.

function normalizeChipaWeek(raw, weekId) {
  if (!raw || typeof raw !== "object") return { weekStart: weekId, candidates: [], counts: {} };
  return {
    weekStart: typeof raw.weekStart === "string" ? raw.weekStart : weekId,
    candidates: Array.isArray(raw.candidates) ? raw.candidates.filter((n) => LEVEL[n]) : [],
    counts: raw.counts && typeof raw.counts === "object" ? raw.counts : {},
  };
}

/* ══════════════════ MODELO CALENDARIO ACADÉMICO ══════════════════ */

const emptyAcademico = () => ({ activities: [] });

function normalizeAcademico(raw) {
  if (!raw || !Array.isArray(raw.activities)) return emptyAcademico();
  const activities = raw.activities
    .filter((a) => a && typeof a === "object" && typeof a.date === "string" && a.date)
    .map((a) => ({
      id: typeof a.id === "string" && a.id ? a.id : `${a.date}-${Math.random().toString(36).slice(2, 9)}`,
      date: a.date,
      time: typeof a.time === "string" ? a.time : "",
      title: typeof a.title === "string" ? a.title : "",
      docente: typeof a.docente === "string" ? a.docente : "",
      notes: typeof a.notes === "string" ? a.notes : "",
    }));
  return { activities };
}

/* ══════════════════ APP PRINCIPAL ══════════════════ */

// Punto de entrada real. Antes de cualquier hook de autenticación, se fija si
// la URL pedida es la ruta pública /hoy: en ese caso se renderiza solo
// QuienEstaHoyView (sin login, de solo lectura) y ni se monta el resto de la
// app. Esta función no llama ningún hook, así que evaluar la condición acá
// (en vez de adentro de AuthenticatedApp) no rompe las reglas de hooks de
// React.
export default function Root() {
  if (isPublicRoute()) return <QuienEstaHoyView isAdmin={false} embedded={false} />;
  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = no user, object = logged in
  const [tab, setTab] = useState("scheduler");
  const [tabOrder, setTabOrder] = useState(DEFAULT_TAB_ORDER);
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const [acceso, setAcceso] = useState("cargando"); // cargando | ok | pendiente | rechazado
  const [pendientesAcceso, setPendientesAcceso] = useState(0);

  useEffect(() => {
    const ref = doc(db, "scheduler", "ui-config");
    const unsub = onSnapshot(ref, (snap) => {
      const stored = snap.exists() ? snap.data().tabOrder : null;
      if (Array.isArray(stored) && stored.length) {
        const known = stored.filter((k) => DEFAULT_TAB_ORDER.includes(k));
        const missing = DEFAULT_TAB_ORDER.filter((k) => !known.includes(k));
        setTabOrder([...known, ...missing]);
      } else {
        setTabOrder(DEFAULT_TAB_ORDER);
      }
    }, () => {});
    return unsub;
  }, []);

  const persistTabOrder = (next) => {
    setTabOrder(next);
    setDoc(doc(db, "scheduler", "ui-config"), { tabOrder: next }, { merge: true }).catch((e) => console.error("ui-config", e));
  };

  const handleTabDragStart = (i) => (e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; };
  const handleTabDragEnter = (i) => (e) => { e.preventDefault(); if (dragIdx !== null) setOverIdx(i); };
  const handleTabDragOver = (e) => { e.preventDefault(); };
  const handleTabDragEnd = () => { setDragIdx(null); setOverIdx(null); };
  const handleTabDrop = (i) => (e) => {
    e.preventDefault();
    const from = dragIdx;
    setDragIdx(null); setOverIdx(null);
    if (from === null || from === i) return;
    const next = [...tabOrder];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    persistTabOrder(next);
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (u && u.email) {
        try {
          await setDoc(doc(db, "access_logs", `${u.uid}-${Date.now()}`), {
            email: u.email,
            uid: u.uid,
            loginAt: new Date().toISOString(),
            loginAtAR: fechaHoraAR(new Date()),
            displayName: u.displayName || "Sin nombre",
          });
          localStorage.setItem("uti-last-access-log", isoDate(new Date()));
        } catch (e) { console.error("log de acceso", e); }
      }
      setUser(u || null);
    });
    return unsub;
  }, []);

  // El registro de arriba solo se dispara en el login (o al recargar la página),
  // así que si alguien deja la pestaña abierta varios días sin recargar no queda
  // registro de esos días. Pero tampoco queremos contar "pestaña abierta sin
  // tocar" como uso — lo que interesa es actividad real: que la persona haya
  // navegado o tocado algo en la app ese día. Por eso enganchamos cualquier
  // click dentro de la app (cambiar de pestaña, tocar un botón, etc.) y, la
  // primera vez que eso pasa en el día, registramos el ingreso.
  useEffect(() => {
    if (!user || !user.email) return;
    const registrarSiNoHoy = async () => {
      const hoy = isoDate(new Date());
      if (localStorage.getItem("uti-last-access-log") === hoy) return;
      try {
        await setDoc(doc(db, "access_logs", `${user.uid}-${Date.now()}`), {
          email: user.email,
          uid: user.uid,
          loginAt: new Date().toISOString(),
          loginAtAR: fechaHoraAR(new Date()),
          displayName: user.displayName || "Sin nombre",
        });
        localStorage.setItem("uti-last-access-log", hoy);
      } catch (e) { console.error("log de acceso diario", e); }
    };
    document.addEventListener("click", registrarSiNoHoy);
    return () => document.removeEventListener("click", registrarSiNoHoy);
  }, [user]);

  // ── Control de acceso al scheduler privado ───────────────────────────────
  // Cualquiera puede iniciar sesión con Google, pero solo entra si el jefe de
  // residentes lo autorizó. Dos excepciones que entran siempre y nunca piden
  // permiso: la cuenta admin y los 12 residentes ya mapeados en
  // RESIDENT_EMAIL — así un deploy nuevo jamás deja afuera a la gente que ya
  // venía usando la app. Para el resto se crea (una sola vez) un documento en
  // usuarios_autorizados con estado "pendiente" y se dispara el aviso por
  // Telegram. Como quedamos escuchando ese documento con onSnapshot, cuando
  // el admin aprueba desde su celular la app se desbloquea sola, sin que la
  // persona tenga que recargar nada.
  useEffect(() => {
    if (!user || !user.email) { setAcceso("cargando"); return; }
    const email = user.email.toLowerCase();
    if (email === ADMIN_EMAIL.toLowerCase() || RESIDENT_BY_EMAIL[email]) { setAcceso("ok"); return; }

    const ref = doc(db, "usuarios_autorizados", email);
    let pedidoEnviado = false;
    const unsub = onSnapshot(ref, async (snap) => {
      if (!snap.exists()) {
        if (pedidoEnviado) return;
        pedidoEnviado = true;
        setAcceso("pendiente");
        try {
          await setDoc(ref, {
            email: user.email,
            displayName: user.displayName || "",
            photoURL: user.photoURL || "",
            estado: "pendiente",
            solicitadoEn: new Date().toISOString(),
            solicitadoEnAR: fechaHoraAR(new Date()),
          });
          // El aviso es "mejor esfuerzo": si el bot de Telegram no está
          // configurado o falla, la solicitud igual queda registrada y el
          // admin la ve con el badge de la pestaña Accesos.
          fetch("/api/notificar-acceso", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: user.email, displayName: user.displayName || "" }),
          }).catch(() => {});
        } catch (e) { console.error("solicitud de acceso", e); }
        return;
      }
      const estado = snap.data().estado;
      setAcceso(estado === "aprobado" ? "ok" : estado === "rechazado" ? "rechazado" : "pendiente");
    }, (e) => { console.error("acceso", e); setAcceso("pendiente"); });
    return unsub;
  }, [user]);

  // Cantidad de solicitudes sin revisar, para el badge rojo de la pestaña
  // Accesos. Solo lo mira la cuenta admin.
  useEffect(() => {
    if (!user || user.email !== ADMIN_EMAIL) { setPendientesAcceso(0); return; }
    const unsub = onSnapshot(collection(db, "usuarios_autorizados"), (snap) => {
      setPendientesAcceso(snap.docs.filter((d) => d.data().estado === "pendiente").length);
    }, () => {});
    return unsub;
  }, [user]);

  if (user === undefined) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Inter', system-ui, sans-serif", color: "#94A3B8", fontSize: 14 }}>Cargando…</div>;

  if (user === null) return <LoginScreen />;

  const isAdmin = user.email === ADMIN_EMAIL;

  if (acceso === "cargando") return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Inter', system-ui, sans-serif", color: "#94A3B8", fontSize: 14 }}>Verificando acceso…</div>;
  if (acceso !== "ok") return <PantallaEspera user={user} rechazado={acceso === "rechazado"} />;

  return (
    <div style={{ maxWidth: 1500, margin: "0 auto", padding: "14px 12px 40px", fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* User bar */}
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, padding: "6px 12px", background: "#F8FAFC", borderRadius: 10, border: "1px solid #E2E8F0", fontSize: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {user.photoURL && <img src={user.photoURL} alt="" style={{ width: 24, height: 24, borderRadius: "50%" }} />}
          <span style={{ color: "#475569", fontWeight: 500 }}>{user.displayName || user.email}</span>
          {isAdmin && <span style={{ fontSize: 9, fontWeight: 700, background: "#0F172A", color: "#fff", padding: "2px 6px", borderRadius: 4 }}>ADMIN</span>}
          {!isAdmin && <span style={{ fontSize: 9, fontWeight: 600, background: "#E2E8F0", color: "#64748B", padding: "2px 6px", borderRadius: 4 }}>SOLO LECTURA</span>}
        </div>
        <button onClick={() => signOut(auth)} style={{ background: "none", border: "none", color: "#94A3B8", fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: 500 }}>Cerrar sesión</button>
      </div>

      {/* Tabs */}
      {isAdmin && <div className="no-print" style={{ fontSize: 10, color: "#94A3B8", marginBottom: 4, paddingLeft: 2 }}>Arrastrá una pestaña para reordenarlas</div>}
      <div className="no-print" style={{ display: "flex", gap: 0, marginBottom: 14, flexWrap: "wrap" }}>
        {tabOrder.map((key, i) => {
          const meta = TAB_META[key];
          if (!meta) return null;
          if (meta.soloAdmin && !isAdmin) return null;
          return (
            <TabBtn
              key={key}
              active={tab === key}
              onClick={() => setTab(key)}
              badge={key === "accesos" ? pendientesAcceso : 0}
              draggable={isAdmin}
              dragging={dragIdx === i}
              dropTarget={isAdmin && overIdx === i && dragIdx !== null && dragIdx !== i}
              onDragStart={handleTabDragStart(i)}
              onDragEnter={handleTabDragEnter(i)}
              onDragOver={handleTabDragOver}
              onDrop={handleTabDrop(i)}
              onDragEnd={handleTabDragEnd}
            >
              {meta.icon} {meta.label}
            </TabBtn>
          );
        })}
      </div>

      {tab === "scheduler" && <SchedulerView isAdmin={isAdmin} />}
      {tab === "rotaciones" && <RotacionesView isAdmin={isAdmin} />}
      {tab === "pases" && <PasesView isAdmin={isAdmin} />}
      {tab === "chipa" && <ChipaView isAdmin={isAdmin} user={user} />}
      {tab === "academico" && <AcademicoView isAdmin={isAdmin} />}
      {tab === "articulo" && <ArticuloSemanaView isAdmin={isAdmin} />}
      {tab === "registro" && <RegistroView isAdmin={isAdmin} user={user} />}
      {tab === "hoy" && <QuienEstaHoyView isAdmin={isAdmin} embedded />}
      {tab === "accesos" && isAdmin && <AccesosView user={user} />}
    </div>
  );
}

function LoginScreen() {
  const [error, setError] = useState(null);
  const login = async () => {
    try { await signInWithPopup(auth, googleProvider); } catch (e) { console.error(e); setError("No se pudo iniciar sesión. Intentá de nuevo."); }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ textAlign: "center", padding: "40px 36px", background: "#fff", borderRadius: 16, boxShadow: "0 4px 24px rgba(15,23,42,.1)", border: "1px solid #E2E8F0", maxWidth: 340 }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>🏥</div>
        <div style={{ fontWeight: 800, fontSize: 18, color: "#0F172A", marginBottom: 4 }}>Scheduler UTI</div>
        <div style={{ fontSize: 12, color: "#94A3B8", marginBottom: 24 }}>Hospital Británico</div>
        <button onClick={login} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "11px 16px", borderRadius: 10, border: "1px solid #E2E8F0", background: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", color: "#334155", boxShadow: "0 1px 3px rgba(15,23,42,.08)", transition: "box-shadow .15s" }}>
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>
          Iniciar sesión con Google
        </button>
        {error && <div style={{ color: "#DC2626", fontSize: 11.5, marginTop: 12, fontWeight: 500 }}>{error}</div>}
      </div>
    </div>
  );
}

// Lo que ve alguien que inició sesión pero todavía no fue autorizado (o fue
// rechazado). No muestra ningún dato de la app. Cuando el admin aprueba, el
// onSnapshot de AuthenticatedApp cambia el estado y esta pantalla desaparece
// sola, sin necesidad de recargar.
function PantallaEspera({ user, rechazado }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 20, fontFamily: "'Inter', system-ui, sans-serif", background: "#F1F5F9" }}>
      <div style={{ textAlign: "center", padding: "36px 32px", background: "#fff", borderRadius: 16, boxShadow: "0 4px 24px rgba(15,23,42,.1)", border: "1px solid #E2E8F0", maxWidth: 380 }}>
        <div style={{ fontSize: 38, marginBottom: 10 }}>{rechazado ? "⛔" : "⏳"}</div>
        <div style={{ fontWeight: 800, fontSize: 17, color: "#0F172A", marginBottom: 8 }}>
          {rechazado ? "Acceso no autorizado" : "Esperando autorización"}
        </div>
        <div style={{ fontSize: 12.5, color: "#64748B", lineHeight: 1.6, marginBottom: 18 }}>
          {rechazado ? (
            <>Tu cuenta no tiene acceso a esta aplicación. Si creés que es un error, hablá con el jefe de residentes.</>
          ) : (
            <>Tu solicitud ya fue enviada al jefe de residentes. En cuanto la apruebe, esta pantalla se va a desbloquear sola — no hace falta que recargues ni que vuelvas a entrar.</>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 9, padding: "8px 12px", marginBottom: 16 }}>
          {user.photoURL && <img src={user.photoURL} alt="" style={{ width: 22, height: 22, borderRadius: "50%" }} />}
          <span style={{ fontSize: 11.5, color: "#475569", fontWeight: 600, wordBreak: "break-all" }}>{user.email}</span>
        </div>
        <button onClick={() => signOut(auth)} style={{ background: "none", border: "none", color: "#94A3B8", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Cerrar sesión</button>
      </div>
    </div>
  );
}

// Panel del admin para autorizar o revocar el acceso al scheduler privado.
// Los 12 residentes y la cuenta admin no aparecen acá: entran siempre por
// código (ver el gate en AuthenticatedApp), así que esta lista es solo para
// cuentas "de afuera" que pidieron entrar.
function AccesosView({ user }) {
  const [solicitudes, setSolicitudes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState(null);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "usuarios_autorizados"), (snap) => {
      setSolicitudes(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, (e) => { console.error(e); setLoading(false); });
    return unsub;
  }, []);

  const revisar = async (id, estado) => {
    try {
      await setDoc(doc(db, "usuarios_autorizados", id), {
        estado,
        revisadoPor: user?.email || "",
        revisadoEn: new Date().toISOString(),
        revisadoEnAR: fechaHoraAR(new Date()),
      }, { merge: true });
    } catch (e) { console.error(e); }
  };

  const eliminar = async (id) => {
    try { await deleteDoc(doc(db, "usuarios_autorizados", id)); } catch (e) { console.error(e); }
    setConfirmId(null);
  };

  const orden = (a, b) => (b.solicitadoEn || "").localeCompare(a.solicitadoEn || "");
  const pendientes = useMemo(() => solicitudes.filter((s) => s.estado === "pendiente").sort(orden), [solicitudes]);
  const aprobados = useMemo(() => solicitudes.filter((s) => s.estado === "aprobado").sort(orden), [solicitudes]);
  const rechazados = useMemo(() => solicitudes.filter((s) => s.estado === "rechazado").sort(orden), [solicitudes]);

  if (loading) return <Skeleton />;

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <span style={{ fontSize: 22 }}>🔐</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Accesos</div>
          <div style={{ fontSize: 10.5, opacity: 0.7 }}>Quién puede entrar al scheduler privado</div>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.55, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: "9px 13px", marginBottom: 14 }}>
        Los 12 residentes y tu cuenta de administrador entran siempre, sin pedir permiso — no aparecen en estas listas. Acá solo caen las cuentas de Google que no están en ese grupo.
      </div>

      <SeccionAccesos titulo={`Pendientes de autorizar (${pendientes.length})`} vacio="No hay solicitudes esperando." items={pendientes} color="#B45309" bg="#FFFBEB" bd="#FDE68A">
        {(s) => (
          <>
            <button onClick={() => revisar(s.id, "aprobado")} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#16A34A", border: "none", borderRadius: 6, padding: "5px 11px", cursor: "pointer", fontFamily: "inherit" }}>✓ Autorizar</button>
            <button onClick={() => revisar(s.id, "rechazado")} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 6, padding: "5px 11px", cursor: "pointer", fontFamily: "inherit" }}>✗ Rechazar</button>
          </>
        )}
      </SeccionAccesos>

      <SeccionAccesos titulo={`Con acceso (${aprobados.length})`} vacio="Todavía no autorizaste ninguna cuenta de afuera." items={aprobados} color="#15803D" bg="#F0FDF4" bd="#BBF7D0">
        {(s) => (
          <button onClick={() => revisar(s.id, "rechazado")} style={{ fontSize: 10.5, fontWeight: 700, color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 6, padding: "5px 11px", cursor: "pointer", fontFamily: "inherit" }}>Quitar acceso</button>
        )}
      </SeccionAccesos>

      <SeccionAccesos titulo={`Rechazados (${rechazados.length})`} vacio="Sin cuentas rechazadas." items={rechazados} color="#B91C1C" bg="#FEF2F2" bd="#FECACA">
        {(s) => (
          <>
            <button onClick={() => revisar(s.id, "aprobado")} style={{ fontSize: 10.5, fontWeight: 700, color: "#15803D", background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 6, padding: "5px 11px", cursor: "pointer", fontFamily: "inherit" }}>✓ Autorizar</button>
            {confirmId === s.id ? (
              <span style={{ display: "flex", gap: 4 }}>
                <button onClick={() => eliminar(s.id)} style={{ fontSize: 10, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 5, padding: "4px 8px", cursor: "pointer", fontFamily: "inherit" }}>Sí, borrar</button>
                <button onClick={() => setConfirmId(null)} style={{ fontSize: 10, fontWeight: 700, color: "#64748B", background: "#F1F5F9", border: "none", borderRadius: 5, padding: "4px 8px", cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
              </span>
            ) : (
              <button onClick={() => setConfirmId(s.id)} title="Borrar el registro (si vuelve a entrar, pide permiso de nuevo)" style={{ background: "none", border: "none", color: "#CBD5E1", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>🗑️</button>
            )}
          </>
        )}
      </SeccionAccesos>
    </div>
  );
}

function SeccionAccesos({ titulo, vacio, items, color, bg, bd, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>{titulo}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "#94A3B8", fontStyle: "italic", padding: "4px 2px" }}>{vacio}</div>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
          {items.map((s, i) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i === items.length - 1 ? "none" : "1px solid #F1F5F9", flexWrap: "wrap" }}>
              {s.photoURL
                ? <img src={s.photoURL} alt="" style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0 }} />
                : <span style={{ width: 26, height: 26, borderRadius: "50%", background: bg, border: `1px solid ${bd}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>👤</span>}
              <div style={{ flex: 1, minWidth: 150 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A" }}>{s.displayName || "Sin nombre"}</div>
                <div style={{ fontSize: 11, color: "#64748B", wordBreak: "break-all" }}>{s.email || s.id}</div>
                <div style={{ fontSize: 10, color: "#94A3B8", marginTop: 1 }}>Pidió acceso: {s.solicitadoEnAR || "—"}</div>
              </div>
              <span style={{ fontSize: 9.5, fontWeight: 700, color, background: bg, border: `1px solid ${bd}`, borderRadius: 999, padding: "2px 9px" }}>{s.estado}</span>
              {children(s)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TabBtn = ({ active, onClick, children, draggable, dragging, dropTarget, badge, onDragStart, onDragEnter, onDragOver, onDrop, onDragEnd }) => (
  <button
    onClick={onClick}
    draggable={draggable}
    onDragStart={onDragStart}
    onDragEnter={onDragEnter}
    onDragOver={onDragOver}
    onDrop={onDrop}
    onDragEnd={onDragEnd}
    title={draggable ? "Arrastrá para reordenar" : undefined}
    style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 22px", fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: draggable ? "grab" : "pointer", background: active ? "#0F172A" : "#E2E8F0", color: active ? "#fff" : "#64748B", border: "none", borderRadius: "10px 10px 0 0", transition: "all .15s", letterSpacing: 0.1, opacity: dragging ? 0.4 : 1, boxShadow: dropTarget ? "inset 3px 0 0 #3B82F6" : "none" }}
  >
    {children}
    {badge > 0 && <span style={{ fontSize: 10, fontWeight: 800, background: "#DC2626", color: "#fff", borderRadius: 999, padding: "1px 7px", minWidth: 18, textAlign: "center" }}>{badge}</span>}
  </button>
);

/* ══════════════════ SCHEDULER VIEW ══════════════════ */

function SchedulerView({ isAdmin }) {
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [week, setWeek] = useState(emptyWeek);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("idle");
  const [sel, setSel] = useState(null);
  const [toast, setToast] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [academico, setAcademico] = useState(emptyAcademico);
  const [guardiaEdit, setGuardiaEdit] = useState(null); // índice del día cuya guardia se está editando
  const [feriadosOpen, setFeriadosOpen] = useState(false);

  const docId = `week-${isoDate(monday)}`;
  const pending = useRef(null);
  const timer = useRef(null);
  const statusTimer = useRef(null);
  const dirty = useRef(false);
  const toastTimer = useRef(null);

  useEffect(() => {
    setLoading(true); setSel(null); dirty.current = false;
    const ref = doc(db, "scheduler", docId);
    const unsub = onSnapshot(ref, { includeMetadataChanges: false }, (snap) => {
      if (snap.metadata.hasPendingWrites || dirty.current) { setLoading(false); return; }
      setWeek(snap.exists() ? normalize(snap.data()) : emptyWeek());
      setLoading(false);
    }, (err) => { console.error("snapshot", err); setStatus("error"); setLoading(false); });
    return () => { unsub(); if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [docId]);

  // Recordatorios se nutre en modo lectura del Calendario académico: la fuente
  // de verdad es esa pestaña, acá solo se refleja si hay clase ese día.
  useEffect(() => {
    const ref = doc(db, "scheduler", "academico");
    const unsub = onSnapshot(ref, (snap) => setAcademico(snap.exists() ? normalizeAcademico(snap.data()) : emptyAcademico()), () => {});
    return unsub;
  }, []);

  const flush = useCallback(async () => {
    const payload = pending.current; if (!payload) return;
    pending.current = null; setStatus("saving");
    try { await setDoc(doc(db, "scheduler", docId), payload); dirty.current = false; setStatus("saved");
      if (statusTimer.current) clearTimeout(statusTimer.current);
      statusTimer.current = setTimeout(() => setStatus("idle"), 1600);
    } catch (e) { console.error("save", e); setStatus("error"); }
  }, [docId]);

  const commit = useCallback((next, delay = 350) => {
    if (!isAdmin) return;
    setWeek(next); dirty.current = true; pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delay);
  }, [flush, isAdmin]);

  useEffect(() => { const h = () => { if (pending.current) flush(); }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, [flush]);

  const flash = (msg) => { setToast(msg); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 2400); };

  const locationOf = (w, name, di) => { const d = w.days[di]; for (const k of SLOT_KEYS) if (d[k].includes(name)) return k; if (d.unavailable.includes(name)) return "unavailable"; return null; };
  const detach = (w, name, di) => { const d = w.days[di]; for (const k of SLOT_KEYS) d[k] = d[k].filter((n) => n !== name); d.unavailable = d.unavailable.filter((n) => n !== name); };

  const pool = useCallback((di) => {
    const d = week.days[di];
    const used = new Set([...SLOT_KEYS.flatMap((k) => d[k]), ...d.unavailable]);
    return ALL.filter((n) => !used.has(n));
  }, [week]);

  const pick = (name, from) => {
    if (!isAdmin) return;
    setSel((cur) => cur && cur.name === name && cur.from?.di === from?.di && cur.from?.key === from?.key ? null : { name, from });
  };

  // Sábado, domingo y feriado comparten el mismo régimen: sin camas fijas.
  const utiBloqueada = (di) => isWeekendIdx(di) || week.days[di].feriado;

  const place = (target, di) => {
    if (!sel || !isAdmin) return;
    if (utiBloqueada(di) && (target === "uti1" || target === "uti2" || target === "uti3")) return; // fin de semana o feriado: UTI 1/2/3 bloqueadas
    const { name, from } = sel; setSel(null);
    if (from && from.di === di && from.key === target) return;
    const next = clone(week);
    if (target === "pool") { detach(next, name, di); commit(next); return; }
    const already = locationOf(next, name, di);
    if (already && already !== from?.key) { const nice = already === "unavailable" ? "no disponible" : already.toUpperCase(); flash(`${name} ya figura el ${DAYS[di]} en ${nice}`); return; }
    if (from) detach(next, name, from.di);
    detach(next, name, di);
    next.days[di][target].push(name);
    commit(next);
  };

  // La guardia se edita aparte del sistema de "seleccionar y ubicar", porque
  // ese sistema es excluyente (mueve a la persona de un lugar a otro) y acá
  // justamente queremos que se superponga con lo que ya tenga ese día.
  const setGuardia = (di, lista) => { if (!isAdmin) return; const next = clone(week); next.days[di].deGuardia = lista; commit(next, 200); };

  const removeChip = (name, di) => { if (!isAdmin) return; const next = clone(week); detach(next, name, di); setSel(null); commit(next); };
  const editText = (di, field, value) => { if (!isAdmin) return; const next = clone(week); next.days[di][field] = value; commit(next, 700); };
  const setDiaLibre = (name, day) => { if (!isAdmin) return; const next = clone(week); next.diasLibresR4[name] = day; commit(next, 300); };

  const copyPrevWeek = async () => {
    if (!isAdmin) return;
    setMenuOpen(false);
    if (!isBlank(week) && !confirm("Esto reemplaza la semana actual. ¿Continuar?")) return;
    try { const prevId = `week-${isoDate(shift(monday, -7))}`; const snap = await getDoc(doc(db, "scheduler", prevId));
      if (!snap.exists()) return flash("La semana anterior está vacía");
      commit(normalize(snap.data()), 0); flash("Semana anterior copiada");
    } catch (e) { console.error(e); flash("No se pudo copiar"); }
  };

  const clearWeek = () => { if (!isAdmin) return; setMenuOpen(false); if (!confirm("¿Vaciar toda la semana?")) return; setSel(null); commit(emptyWeek(), 0); };

  // Un feriado se cubre igual que un fin de semana: no hay grilla fija de
  // camas, solo guardia y postguardia. Por eso al marcarlo se vacían UTI 1/2/3
  // de ese día — si no, quedarían asignaciones invisibles (la fila está
  // bloqueada) pero que igual sacarían a esa gente de "Disponibles", que es
  // justo el tipo de estado fantasma que después nadie entiende. Se avisa
  // antes de borrar nada.
  const toggleFeriado = (di) => {
    if (!isAdmin) return;
    const next = clone(week);
    const d = next.days[di];
    if (!d.feriado) {
      const asignados = ["uti1", "uti2", "uti3"].reduce((n, k) => n + d[k].length, 0);
      if (asignados > 0 && !confirm(`El ${DAYS[di].toLowerCase()} tiene ${asignados} asignación${asignados === 1 ? "" : "es"} en UTI 1/2/3. Al marcarlo como feriado esas filas se bloquean y esas asignaciones se borran. ¿Continuar?`)) return;
      ["uti1", "uti2", "uti3"].forEach((k) => { d[k] = []; });
    }
    d.feriado = !d.feriado;
    commit(next, 200);
  };

  // Imprimir / PDF: se ajusta solo para que todo el calendario (hasta
  // Recordatorios) entre en una sola hoja A4 horizontal. Medimos el bloque
  // imprimible ya con el ancho fijo de la hoja y con los textos completos
  // (no el textarea recortado) para calcular cuánto hay que achicarlo.
  //
  // Usamos "zoom" en vez de "transform: scale()" para achicar el bloque:
  // transform solo cambia lo que se ve, pero el motor de impresión de Chrome
  // calcula los saltos de página con el tamaño ORIGINAL (sin escalar), así
  // que con transform el contenido se seguía recortando aunque visualmente
  // "entrara" en la vista previa. "zoom" en cambio reacomoda el layout de
  // verdad a la escala pedida, así que tanto el cálculo de página como lo
  // que se ve quedan consistentes.
  const printRef = useRef(null);
  const handlePrint = () => {
    setMenuOpen(false);

    // El título de la pestaña lo cambiamos primero y antes que cualquier otra
    // cosa: Chrome usa el título de la pestaña (que se propaga al proceso del
    // navegador de forma asíncrona) para proponer el nombre del PDF al
    // "Guardar como". Si lo cambiamos recién justo antes de imprimir, a veces
    // el navegador todavía no llegó a enterarse del nuevo título y usa el
    // viejo. Por eso lo hacemos ya mismo, y dejamos varios milisegundos antes
    // de abrir el diálogo de impresión.
    const prevTitle = document.title;
    const inicio = shift(monday, 0);
    const fin = shift(monday, DAYS.length - 1);
    const mismoMes = inicio.getMonth() === fin.getMonth();
    const rango = mismoMes
      ? `${inicio.getDate()} al ${fin.getDate()} de ${MONTHS[inicio.getMonth()].toLowerCase()}`
      : `${inicio.getDate()} de ${MONTHS[inicio.getMonth()].toLowerCase()} al ${fin.getDate()} de ${MONTHS[fin.getMonth()].toLowerCase()}`;
    document.title = `Scheduler UTI — Semana del ${rango}`;

    const el = printRef.current;
    if (!el) {
      setTimeout(() => {
        window.print();
        setTimeout(() => { document.title = prevTitle; }, 300);
      }, 150);
      return;
    }

    const PAGE_W = 1050; // ancho aprox. del área imprimible en A4 horizontal (96dpi, margen 8mm)
    const PAGE_H = 700; // alto aprox. del área imprimible en A4 horizontal (96dpi, margen 8mm)

    const noPrintEls = el.querySelectorAll(".no-print");
    const printOnlyEls = el.querySelectorAll(".print-only, .print-only-block");
    const prevNoPrint = Array.from(noPrintEls).map((n) => n.style.display);
    const prevPrintOnly = Array.from(printOnlyEls).map((n) => n.style.display);

    // Simulamos por un instante cómo se va a ver impreso (textos completos en
    // vez de los textarea recortados) para medir el alto real.
    noPrintEls.forEach((n) => { n.style.display = "none"; });
    printOnlyEls.forEach((n) => { n.style.display = n.classList.contains("print-only-block") ? "block" : "inline"; });

    const prevWidth = el.style.width;
    const prevZoom = el.style.zoom;
    el.style.zoom = "1";
    el.style.width = PAGE_W + "px";

    const naturalW = el.scrollWidth;
    const naturalH = el.scrollHeight;
    const scale = Math.min(1, PAGE_W / naturalW, PAGE_H / naturalH);

    // El ancho lo dejamos fijo (así el layout impreso es igual al que medimos)
    // y aplicamos el zoom recién calculado: esto sí reacomoda de verdad el
    // documento a ese tamaño, cosa que "transform" no hacía para la paginación.
    el.style.zoom = String(scale);

    const cleanup = () => {
      el.style.width = prevWidth;
      el.style.zoom = prevZoom;
      document.title = prevTitle;
      noPrintEls.forEach((n, i) => { n.style.display = prevNoPrint[i]; });
      printOnlyEls.forEach((n, i) => { n.style.display = prevPrintOnly[i]; });
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);

    setTimeout(() => window.print(), 150);
  };

  const dates = useMemo(() => DAYS.map((_, i) => shift(monday, i)), [monday]);
  const today = new Date();
  const active = sel != null;

  useEffect(() => { const onKey = (e) => e.key === "Escape" && setSel(null); window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);

  return (
    <div onClick={() => { setSel(null); setMenuOpen(false); }}>
      <SchedulerHeader monday={monday} setMonday={setMonday} status={status} menuOpen={menuOpen} setMenuOpen={setMenuOpen} onCopyPrev={copyPrevWeek} onClear={clearWeek} onPrint={handlePrint} onFeriados={() => { setMenuOpen(false); setFeriadosOpen(true); }} isAdmin={isAdmin} />

      <div style={{ minHeight: 34, marginBottom: 6 }} className="no-print">
        {toast ? <Banner tone="warn">{toast}</Banner> : active ? <Banner tone="info"><b>{sel.name}</b> seleccionado — tocá una celda para ubicarlo, o Esc para cancelar</Banner> : <div style={{ fontSize: 12, color: "#94A3B8", padding: "6px 2px" }}>{isAdmin ? "Tocá un residente para seleccionarlo y después la celda donde va." : "Solo lectura — solo el administrador puede editar."}</div>}
      </div>

      {loading ? <Skeleton /> : (
        <div ref={printRef}>
          <DiasLibresR4 week={week} isAdmin={isAdmin} onChange={setDiaLibre} />
          <div style={{ overflowX: "auto", paddingBottom: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: `104px repeat(${DAYS.length}, minmax(150px, 1fr))`, background: "#fff", borderRadius: "14px 14px 0 0", overflow: "hidden", border: "1px solid #E2E8F0", borderBottom: "none", boxShadow: "0 1px 3px rgba(15,23,42,.06)", minWidth: 104 + DAYS.length * 150 }}>
            <Corner />{DAYS.map((d, i) => <DayHead key={d} name={d} date={dates[i]} isToday={sameDay(dates[i], today)} isWeekend={isWeekendIdx(i)} feriado={week.days[i].feriado} />)}

            {SLOTS.filter((s) => s.key !== "postguardia").map((slot, ri) => (
              <Fragment key={slot.key}>
                <RowLabel label={slot.label} color={slot.accent} />
                {DAYS.map((_, di) => (
                  utiBloqueada(di) ? (
                    <Cell key={di} tint={week.days[di].feriado ? "#FEF9E7" : "#F1F5F9"} lastCol={di === DAYS.length - 1}>
                      <div style={{ textAlign: "center", fontSize: 9.5, color: week.days[di].feriado ? "#B45309" : "#94A3B8", fontStyle: "italic", padding: "13px 2px", lineHeight: 1.3 }}>No aplica<br />{week.days[di].feriado ? "feriado" : "fin de semana"}</div>
                    </Cell>
                  ) : (
                    <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place(slot.key, di); }} tint={slot.tint} ring={active ? slot.accent : null} lastCol={di === DAYS.length - 1}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 40 }}>
                        {week.days[di][slot.key].sort((a, b) => { const order = { R4: 0, R3: 1, R2: 2 }; return (order[LEVEL[a]] || 3) - (order[LEVEL[b]] || 3); }).map((n) => (
                          <Chip key={n} name={n} selected={sel?.name === n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: slot.key }); }} onRemove={isAdmin ? (e) => { e.stopPropagation(); removeChip(n, di); } : null} />
                        ))}
                        {active && <GhostHint color={slot.accent} name={sel.name} />}
                        {!active && week.days[di][slot.key].length === 0 && <Dash />}
                      </div>
                    </Cell>
                  )
                ))}
              </Fragment>
            ))}

            <RowLabel label="De guardia" color="#9F1239" sub="se superpone" />
            {DAYS.map((_, di) => {
              const lista = week.days[di].deGuardia;
              return (
                <Cell key={di} onClick={(e) => { e.stopPropagation(); if (isAdmin) setGuardiaEdit(di); }} tint="#FFF1F2" pad={5} lastCol={di === DAYS.length - 1}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, minHeight: 40, alignContent: "flex-start", cursor: isAdmin ? "pointer" : "default" }}>
                    {lista.length === 0 ? (
                      <div className="no-print" style={{ fontSize: 10, color: "#FDA4AF", fontStyle: "italic", padding: "10px 4px", width: "100%", textAlign: "center" }}>{isAdmin ? "+ elegir guardia" : "—"}</div>
                    ) : lista.map((n) => <ChipGuardia key={n} name={n} />)}
                  </div>
                  <div className="print-only-block" style={{ fontSize: 11.5, lineHeight: 1.4, color: "#881337", fontWeight: 600, padding: "6px 8px" }}>{lista.length ? lista.join(", ") : "—"}</div>
                </Cell>
              );
            })}

            {SLOTS.filter((s) => s.key === "postguardia").map((slot) => (
              <Fragment key={slot.key}>
                <RowLabel label={slot.label} color={slot.accent} />
                {DAYS.map((_, di) => (
                  <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place(slot.key, di); }} tint={slot.tint} ring={active ? slot.accent : null} lastCol={di === DAYS.length - 1}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 40 }}>
                      {week.days[di][slot.key].sort((a, b) => { const order = { R4: 0, R3: 1, R2: 2 }; return (order[LEVEL[a]] || 3) - (order[LEVEL[b]] || 3); }).map((n) => (
                        <Chip key={n} name={n} selected={sel?.name === n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: slot.key }); }} onRemove={isAdmin ? (e) => { e.stopPropagation(); removeChip(n, di); } : null} />
                      ))}
                      {active && <GhostHint color={slot.accent} name={sel.name} />}
                      {!active && week.days[di][slot.key].length === 0 && <Dash />}
                    </div>
                  </Cell>
                ))}
              </Fragment>
            ))}

            <RowLabel label="Observaciones" color="#854D0E" sub="importante" />
            {DAYS.map((_, di) => (
              <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === DAYS.length - 1}>
                <textarea className="no-print" value={week.days[di].observaciones} onChange={(e) => editText(di, "observaciones", e.target.value)} placeholder="Supervisores, pases, avisos…" readOnly={!isAdmin} style={{ ...TEXTAREA, background: "#FEF9C3", borderColor: "#FDE047", color: "#713F12", fontWeight: 600, opacity: isAdmin ? 1 : 0.8, cursor: isAdmin ? "text" : "default" }} />
                <div className="print-only-block" style={{ whiteSpace: "pre-wrap", fontSize: 11.5, lineHeight: 1.4, color: "#713F12", fontWeight: 600, padding: "6px 8px" }}>{week.days[di].observaciones || "—"}</div>
              </Cell>
            ))}

            <RowLabel label="Recordatorios" color="#B45309" sub="+ Académico" />
            {DAYS.map((_, di) => {
              const clases = academico.activities.filter((a) => a.date === isoDate(dates[di]));
              return (
                <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === DAYS.length - 1}>
                  {clases.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 4 }}>
                      {clases.map((a) => (
                        <div key={a.id} title="Sincronizado desde Calendario académico" style={{ fontSize: 10.5, fontWeight: 700, background: "#FEF3C7", color: "#78350F", border: "1px solid #FDE68A", borderRadius: 6, padding: "3px 6px", lineHeight: 1.3 }}>
                          📚 {a.title || "Clase"}{a.time ? ` · ${a.time}` : ""}{a.docente ? ` · ${a.docente}` : ""}
                        </div>
                      ))}
                    </div>
                  )}
                  <textarea className="no-print" value={week.days[di].recordatorios} onChange={(e) => editText(di, "recordatorios", e.target.value)} placeholder="Clases, ateneos, horarios…" readOnly={!isAdmin} style={{ ...TEXTAREA, background: "#FFFBEB", borderColor: "#FDE68A", color: "#78350F", opacity: isAdmin ? 1 : 0.8, cursor: isAdmin ? "text" : "default" }} />
                  <div className="print-only-block" style={{ whiteSpace: "pre-wrap", fontSize: 11.5, lineHeight: 1.4, color: "#78350F", padding: "6px 8px" }}>{week.days[di].recordatorios || "—"}</div>
                </Cell>
              );
            })}
          </div>
          </div>
        </div>
      )}

      {/* Disponibles / No disponibles: solo en pantalla, nunca se imprimen — por
          eso son un segundo grid aparte, fuera de printRef. */}
      {!loading && (
        <div className="no-print" style={{ overflowX: "auto", paddingBottom: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: `104px repeat(${DAYS.length}, minmax(150px, 1fr))`, background: "#fff", borderRadius: "0 0 14px 14px", overflow: "hidden", border: "1px solid #E2E8F0", borderTop: "none", boxShadow: "0 1px 3px rgba(15,23,42,.06)", minWidth: 104 + DAYS.length * 150 }}>
            <RowLabel label="Disponibles" color="#16A34A" />
            {DAYS.map((_, di) => {
              const free = pool(di);
              return (
                <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place("pool", di); }} tint="#F0FDF4" ring={active ? "#22C55E" : null} lastCol={di === DAYS.length - 1}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 50 }}>
                    {active && <div style={{ fontSize: 10, color: "#16A34A", fontWeight: 600, textAlign: "center", padding: "1px 0" }}>↩ liberar el {DAYS[di].toLowerCase()}</div>}
                    {free.length === 0 ? (!active && <div style={{ fontSize: 10.5, color: "#94A3B8", fontStyle: "italic", textAlign: "center", padding: 6 }}>todos asignados</div>) : free.map((n) => <Chip key={n} name={n} selected={sel?.name === n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: "pool" }); }} />)}
                  </div>
                </Cell>
              );
            })}

            <RowLabel label="No disponibles" color="#DC2626" sub="rotación · vacaciones" />
            {DAYS.map((_, di) => (
              <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place("unavailable", di); }} tint="#FEF2F2" ring={active ? "#F87171" : null} lastCol={di === DAYS.length - 1} lastRow>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 40 }}>
                  {week.days[di].unavailable.map((n) => <OutChip key={n} name={n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: "unavailable" }); }} selected={sel?.name === n} />)}
                  {active && <div style={{ fontSize: 10, color: "#EF4444", fontWeight: 600, textAlign: "center", padding: "1px 0" }}>marcar solo el {DAYS[di].toLowerCase()}</div>}
                  {!active && week.days[di].unavailable.length === 0 && <Dash />}
                </div>
              </Cell>
            ))}
          </div>
        </div>
      )}
      <div className="no-print"><Legend /></div>

      {feriadosOpen && isAdmin && (
        <FeriadosEditor
          dates={dates}
          week={week}
          onToggle={toggleFeriado}
          onClose={() => setFeriadosOpen(false)}
        />
      )}

      {guardiaEdit !== null && isAdmin && (
        <GuardiaEditor
          fecha={dates[guardiaEdit]}
          dia={DAYS[guardiaEdit]}
          valor={week.days[guardiaEdit].deGuardia}
          onChange={(lista) => setGuardia(guardiaEdit, lista)}
          onClose={() => setGuardiaEdit(null)}
        />
      )}
    </div>
  );
}

// Marcar feriados de la semana. Vive en el menú "⋯" en vez de tener un control
// en cada celda: es algo que se toca pocas veces al año y no queremos sumarle
// ruido visual a la grilla. Marcar un día NO cambia cómo se arma la semana
// (las camas se siguen asignando igual); es solo el dato que después permite
// contar las guardias de cada residente separadas por hábil, fin de semana y
// feriado.
function FeriadosEditor({ dates, week, onToggle, onClose }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: "18px 20px 20px", width: "100%", maxWidth: 400, maxHeight: "88vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(15,23,42,.28)", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <div style={{ fontWeight: 800, fontSize: 15.5, color: "#0F172A" }}>🎌 Marcar feriado</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#94A3B8", fontSize: 18, cursor: "pointer", fontFamily: "inherit", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          Tocá los días de esta semana que sean feriado. No cambia las asignaciones — sirve para contar después las guardias por tipo de día.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {DAYS.map((d, di) => {
            const on = week.days[di].feriado;
            return (
              <div key={d} onClick={() => onToggle(di)} style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 13px", borderRadius: 10, background: on ? "#FEF3C7" : "#F8FAFC", border: `1.5px solid ${on ? "#FCD34D" : "#E2E8F0"}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 14 }}>{on ? "🎌" : "📅"}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: on ? "#92400E" : "#334155" }}>{d}</div>
                    <div style={{ fontSize: 10.5, color: on ? "#B45309" : "#94A3B8" }}>{dm(dates[di])}</div>
                  </div>
                </div>
                {on && <span style={{ fontSize: 9.5, fontWeight: 800, color: "#92400E", background: "#FDE68A", borderRadius: 999, padding: "3px 10px" }}>FERIADO</span>}
              </div>
            );
          })}
        </div>

        <button onClick={onClose} style={{ width: "100%", marginTop: 16, background: "#16A34A", color: "#fff", border: "none", borderRadius: 10, padding: "11px 16px", fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Listo</button>
      </div>
    </div>
  );
}

// Chip compacto para la fila "De guardia" del calendario. Coloreado por nivel
// si es residente, gris si es alguien de afuera (planta, otro servicio).
const ChipGuardia = ({ name }) => {
  const c = esResidente(name) ? COLOR[LEVEL[name]] : { bg: "#F1F5F9", bd: "#CBD5E1", tx: "#475569", solid: "#94A3B8" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2.5px 6px", borderRadius: 6, background: c.bg, border: `1.5px solid ${c.bd}`, color: c.tx, fontWeight: 600, fontSize: 10.5, lineHeight: 1.25 }}>
      {name}
      <span style={{ fontSize: 7, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: c.solid, color: "#fff" }}>{esResidente(name) ? LEVEL[name] : "—"}</span>
    </span>
  );
};

// Editor de la guardia de un día. Se abre tocando la celda y es independiente
// del sistema de seleccionar-y-ubicar: acá se marcan residentes sin sacarlos
// de la UTI donde ya estén ni de "no disponibles". Además permite sumar a
// alguien que no es residente (planta, otro servicio) escribiendo el nombre.
function GuardiaEditor({ fecha, dia, valor, onChange, onClose }) {
  const [nuevo, setNuevo] = useState("");
  const seleccion = valor || [];
  const invitados = seleccion.filter((n) => !esResidente(n));

  const toggle = (n) => onChange(seleccion.includes(n) ? seleccion.filter((x) => x !== n) : [...seleccion, n]);
  const quitar = (n) => onChange(seleccion.filter((x) => x !== n));
  const agregarInvitado = () => {
    const v = nuevo.trim();
    if (!v) return;
    if (!seleccion.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...seleccion, v]);
    setNuevo("");
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: "18px 20px 20px", width: "100%", maxWidth: 460, maxHeight: "88vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(15,23,42,.28)", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <div style={{ fontWeight: 800, fontSize: 15.5, color: "#0F172A" }}>🌙 De guardia</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#94A3B8", fontSize: 18, cursor: "pointer", fontFamily: "inherit", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 14 }}>{dia} {dm(fecha)}</div>

        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 6, letterSpacing: 0.3 }}>RESIDENTES</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {ALL.map((n) => {
            const on = seleccion.includes(n);
            const c = COLOR[LEVEL[n]];
            return (
              <div key={n} onClick={() => toggle(n)} style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 5, padding: "6px 11px", borderRadius: 8, background: on ? c.solid : "#F8FAFC", border: `1.5px solid ${on ? c.solid : "#E2E8F0"}`, color: on ? "#fff" : "#64748B", fontWeight: 600, fontSize: 12.5 }}>
                {on && "✓ "}{n}
                <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: on ? "rgba(255,255,255,.28)" : c.solid, color: "#fff" }}>{LEVEL[n]}</span>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 10.5, color: "#94A3B8", lineHeight: 1.45, marginBottom: 16 }}>
          Marcar a alguien acá no lo saca de la UTI que tenga asignada ese día ni de "no disponibles" — la guardia se superpone con el resto.
        </div>

        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 6, letterSpacing: 0.3 }}>OTRA PERSONA (PLANTA, OTRO SERVICIO)</div>
        {invitados.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {invitados.map((n) => (
              <div key={n} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 6px 5px 11px", borderRadius: 8, background: "#F1F5F9", border: "1.5px solid #CBD5E1", color: "#475569", fontWeight: 600, fontSize: 12.5 }}>
                {n}
                <button onClick={() => quitar(n)} style={{ background: "none", border: "none", color: "#94A3B8", cursor: "pointer", fontSize: 14, fontFamily: "inherit", lineHeight: 1, padding: 0 }}>×</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          <input value={nuevo} onChange={(e) => setNuevo(e.target.value)} placeholder="Nombre y apellido…" onKeyDown={(e) => e.key === "Enter" && agregarInvitado()} style={{ ...INPUT, flex: 1, fontSize: 12.5, padding: "8px 10px" }} />
          <button onClick={agregarInvitado} style={{ background: "#0F172A", color: "#fff", border: "none", borderRadius: 7, padding: "8px 15px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>+ Agregar</button>
        </div>

        <button onClick={onClose} style={{ width: "100%", marginTop: 18, background: "#16A34A", color: "#fff", border: "none", borderRadius: 10, padding: "11px 16px", fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Listo</button>
      </div>
    </div>
  );
}

/* ══════════════════ ROTACIONES VIEW ══════════════════ */

function RotacionesView({ isAdmin }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState(emptyRotYear);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("idle");
  const [editing, setEditing] = useState(null);
  const [expanded, setExpanded] = useState({});

  const docId = `rotaciones-${year}`;
  const pending = useRef(null);
  const timer = useRef(null);
  const statusTimer = useRef(null);

  useEffect(() => {
    setLoading(true);
    const ref = doc(db, "scheduler", docId);
    const unsub = onSnapshot(ref, (snap) => {
      setData(snap.exists() ? normalizeRot(snap.data()) : emptyRotYear());
      setLoading(false);
    }, () => { setLoading(false); });
    return () => { unsub(); if (timer.current) clearTimeout(timer.current); };
  }, [docId]);

  const save = useCallback(async (next) => {
    if (!isAdmin) return;
    setData(next); pending.current = next; setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { await setDoc(doc(db, "scheduler", docId), pending.current); setStatus("saved");
        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus("idle"), 1600);
      } catch (e) { console.error(e); setStatus("error"); }
    }, 400);
  }, [docId, isAdmin]);

  const addAssignment = (mi) => { if (!isAdmin) return; setEditing({ month: mi, mode: "new", resident: "", place: "" }); };

  const saveAssignment = (mi, resident, place, idx) => {
    if (!resident.trim() || !place.trim()) return;
    const next = clone(data);
    if (idx !== undefined && idx !== null) { next.months[mi].assignments[idx] = { resident: resident.trim(), place: place.trim() }; }
    else { next.months[mi].assignments.push({ resident: resident.trim(), place: place.trim() }); }
    save(next); setEditing(null);
  };

  const removeAssignment = (mi, idx) => { if (!isAdmin) return; const next = clone(data); next.months[mi].assignments.splice(idx, 1); save(next); };

  const editNotes = (mi, val) => { if (!isAdmin) return; const next = clone(data); next.months[mi].notes = val; save(next); };

  const toggleMonth = (mi) => setExpanded((cur) => ({ ...cur, [mi]: !isMonthOpen(mi) }));
  const isMonthOpen = (mi) => {
    if (expanded[mi] !== undefined) return expanded[mi];
    const m = data.months[mi];
    return m.assignments.length > 0 || !!m.notes.trim();
  };

  const S = { saving: { t: "Guardando…", c: "#CBD5E1" }, saved: { t: "✓ Guardado", c: "#86EFAC" }, error: { t: "⚠ Error", c: "#FCA5A5" } }[status];

  if (loading) return <Skeleton />;

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🔄</span>
          <div><div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Rotaciones y Vacaciones</div><div style={{ fontSize: 10.5, opacity: 0.55 }}>Hospital Británico</div></div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => setYear(y => y - 1)} style={NAV}>◀</button>
          <div style={{ fontWeight: 700, fontSize: 18, minWidth: 60, textAlign: "center" }}>{year}</div>
          <button onClick={() => setYear(y => y + 1)} style={NAV}>▶</button>
        </div>
        <div>{S && <div style={{ fontSize: 10.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: "rgba(255,255,255,.12)", color: S.c }}>{S.t}</div>}</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {MONTHS.map((mName, mi) => {
          const month = data.months[mi];
          const isCurrentMonth = new Date().getFullYear() === year && new Date().getMonth() === mi;
          const hasData = month.assignments.length > 0 || !!month.notes.trim();
          const isOpen = isMonthOpen(mi);
          return (
            <div key={mi} style={{ background: "#fff", borderRadius: 12, border: isCurrentMonth ? "2px solid #3B82F6" : "1px solid #E2E8F0", overflow: "hidden", boxShadow: isCurrentMonth ? "0 0 0 3px #3B82F633" : "0 1px 3px rgba(15,23,42,.04)" }}>
              <div onClick={() => toggleMonth(mi)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: isCurrentMonth ? "#EFF6FF" : "#F8FAFC", borderBottom: isOpen ? "1px solid #E2E8F0" : "none", cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontSize: 9, color: "#94A3B8", display: "inline-block", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
                  <div style={{ fontWeight: 700, fontSize: 13, color: isCurrentMonth ? "#1D4ED8" : hasData ? "#0F172A" : "#94A3B8" }}>{mName}</div>
                  {!hasData && <span style={{ fontSize: 10, color: "#CBD5E1", fontStyle: "italic" }}>vacío</span>}
                </div>
                {isOpen && isAdmin && <button onClick={(e) => { e.stopPropagation(); addAssignment(mi); }} style={{ background: "#E2E8F0", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", color: "#475569", fontFamily: "inherit" }}>+ Agregar</button>}
              </div>
              {isOpen && (
                <div style={{ padding: "8px 14px" }}>
                  {month.assignments.length === 0 && !(editing && editing.month === mi) ? (
                    <div style={{ fontSize: 11.5, color: "#94A3B8", fontStyle: "italic", padding: "6px 0" }}>Sin rotaciones este mes</div>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: month.assignments.length > 0 ? 8 : 0 }}>
                      {month.assignments.map((a, idx) => {
                        const lv = LEVEL[a.resident];
                        const c = lv ? COLOR[lv] : { bg: "#F1F5F9", bd: "#CBD5E1", tx: "#475569", solid: "#64748B" };
                        const isEditingThis = editing && editing.month === mi && editing.idx === idx;
                        if (isEditingThis) {
                          return <EditForm key={idx} resident={editing.resident} place={editing.place} onResChange={(v) => setEditing({ ...editing, resident: v })} onPlaceChange={(v) => setEditing({ ...editing, place: v })} onSave={() => saveAssignment(mi, editing.resident, editing.place, idx)} onCancel={() => setEditing(null)} />;
                        }
                        return (
                          <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, background: c.bg, border: `1.5px solid ${c.bd}`, fontSize: 12 }}>
                            <span style={{ fontWeight: 700, color: c.tx }}>{a.resident}</span>
                            <span style={{ color: "#64748B", fontWeight: 500 }}>({a.place})</span>
                            {lv && <span style={{ fontSize: 8, fontWeight: 800, background: c.solid, color: "#fff", padding: "1px 4px", borderRadius: 3 }}>{lv}</span>}
                            {isAdmin && <span onClick={() => setEditing({ month: mi, idx, resident: a.resident, place: a.place })} style={{ cursor: "pointer", fontSize: 11, opacity: 0.4 }} title="Editar">✏️</span>}
                            {isAdmin && <span onClick={() => removeAssignment(mi, idx)} style={{ cursor: "pointer", fontSize: 11, opacity: 0.4 }} title="Eliminar">✕</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {editing && editing.month === mi && editing.mode === "new" && (
                    <EditForm resident={editing.resident} place={editing.place} onResChange={(v) => setEditing({ ...editing, resident: v })} onPlaceChange={(v) => setEditing({ ...editing, place: v })} onSave={() => saveAssignment(mi, editing.resident, editing.place)} onCancel={() => setEditing(null)} />
                  )}
                  <textarea value={month.notes} onChange={(e) => editNotes(mi, e.target.value)} placeholder="Vacaciones del mes…" readOnly={!isAdmin} style={{ ...TEXTAREA, minHeight: 32, marginTop: 4, fontSize: 11, fontStyle: month.notes ? "normal" : "italic", color: month.notes ? "#92400E" : "#94A3B8", background: month.notes ? "#FFFBEB" : "#FAFAFA", borderColor: month.notes ? "#FDE68A" : "#E2E8F0", opacity: isAdmin ? 1 : 0.8, cursor: isAdmin ? "text" : "default" }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const EditForm = ({ resident, place, onResChange, onPlaceChange, onSave, onCancel }) => (
  <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0" }}>
    <select value={resident} onChange={(e) => onResChange(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", background: "#fff", color: "#0F172A" }}>
      <option value="">Residente…</option>
      {ALL.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
    </select>
    <input value={place} onChange={(e) => onPlaceChange(e.target.value)} placeholder="Lugar (ej: Fernandez, Ecocardio)" onKeyDown={(e) => e.key === "Enter" && onSave()} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", flex: 1, minWidth: 140, color: "#0F172A" }} />
    <button onClick={onSave} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓</button>
    <button onClick={onCancel} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✕</button>
  </div>
);

/* ══════════════════ PASES VIEW ══════════════════ */

const PASE_FIELDS = [
  ["req", "Requerimientos / Intercurrencias"],
  ["ea", "Enfermedad actual"],
  ["ap", "Antecedentes"],
  ["tto", "Tratamiento"],
  ["accesos", "Accesos"],
  ["cultivos", "Cultivos"],
  ["estudios", "Complementarios"],
  ["labo", "Laboratorio"],
  ["eab", "EAB"],
  ["pendiente", "Pendientes"],
];

function timeAgo(iso) {
  if (!iso) return "nunca";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "recién";
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

function PasesView({ isAdmin }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [unit, setUnit] = useState(null);
  const [open, setOpen] = useState({});
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [q, setQ] = useState("");
  // Resumen por IA de cada paciente: se genera solo a demanda (al tocar el
  // botón), no automático, y queda en memoria mientras la pestaña está
  // abierta — no se guarda en Firestore.
  const [aiState, setAiState] = useState({}); // { [bed]: { loading, error, resumen, perlas, fuentes } }

  const generarResumenIA = async (p) => {
    setAiState((s) => ({ ...s, [p.bed]: { loading: true } }));
    try {
      const r = await fetch("/api/resumen-paciente", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paciente: p }),
      });
      const j = await r.json();
      if (j.ok) {
        setAiState((s) => ({ ...s, [p.bed]: { ...j.resumen, loading: false } }));
      } else {
        setAiState((s) => ({ ...s, [p.bed]: { loading: false, error: j.error || "Error al generar el resumen." } }));
      }
    } catch (e) {
      setAiState((s) => ({ ...s, [p.bed]: { loading: false, error: "No se pudo conectar con el servidor." } }));
    }
  };

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "scheduler", "pases-latest"), (snap) => {
      setData(snap.exists() ? snap.data() : null);
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, []);

  const order = data?.unitOrder?.length ? data.unitOrder : Object.keys(data?.units || {});
  const activeUnit = unit && order.includes(unit) ? unit : order[0];
  const patients = (data?.units?.[activeUnit] || []).filter((p) => {
    if (!q.trim()) return true;
    const hay = `${p.bed} ${p.name} ${p.mi} ${p.status}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  const sync = async () => {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await fetch("/api/sync-pases");
      const j = await r.json();
      if (j.ok) {
        setSyncMsg(`✓ ${j.totalPatients} pacientes actualizados`);
        if (j.errors?.length) setSyncMsg(`✓ ${j.totalPatients} pacientes · ${j.errors.length} doc con problema`);
      } else setSyncMsg("⚠ " + (j.error || "Error al sincronizar"));
    } catch (e) {
      setSyncMsg("⚠ No se pudo conectar con el servidor");
    }
    setSyncing(false);
    setTimeout(() => setSyncMsg(null), 5000);
  };

  if (loading) return <Skeleton />;

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🛏️</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Resumen de pases</div>
            <div style={{ fontSize: 10.5, opacity: 0.55 }}>
              Actualizado {timeAgo(data?.updatedAt)}
              {data?.totalPatients ? ` · ${data.totalPatients} pacientes` : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {syncMsg && <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.9 }}>{syncMsg}</span>}
          {isAdmin && (
            <button onClick={sync} disabled={syncing} style={{ ...NAV, width: "auto", padding: "6px 12px", fontSize: 11, opacity: syncing ? 0.5 : 1 }}>
              {syncing ? "Sincronizando…" : "↻ Sincronizar"}
            </button>
          )}
        </div>
      </div>

      {data?.errors?.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {data.errors.map((e, i) => (
            <div key={i} style={{ background: "#FEF2F2", border: "1px solid #FECACA", color: "#991B1B", padding: "7px 12px", borderRadius: 9, fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>
              ⚠ <b>{e.unit}</b>: {e.error}
            </div>
          ))}
        </div>
      )}

      {!data || !order.length ? (
        <div style={{ textAlign: "center", padding: "50px 20px", color: "#94A3B8", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
          Todavía no se sincronizó ningún pase.
          {isAdmin && <div style={{ fontSize: 11.5, marginTop: 8 }}>Tocá "Sincronizar" para traerlos de los documentos.</div>}
        </div>
      ) : (
        <>
          {/* Selector de unidad */}
          <div className="no-print" style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8, marginBottom: 8 }}>
            {order.map((u) => {
              const n = data.units[u]?.length || 0;
              const on = u === activeUnit;
              return (
                <button key={u} onClick={() => { setUnit(u); setOpen({}); }} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 999, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, background: on ? "#0F172A" : "#E2E8F0", color: on ? "#fff" : "#64748B", display: "flex", alignItems: "center", gap: 6 }}>
                  {u}
                  <span style={{ fontSize: 10, fontWeight: 800, background: on ? "rgba(255,255,255,.22)" : "#CBD5E1", color: on ? "#fff" : "#475569", padding: "1px 6px", borderRadius: 999 }}>{n}</span>
                </button>
              );
            })}
          </div>

          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por cama, nombre o diagnóstico…" className="no-print" style={{ width: "100%", padding: "9px 12px", borderRadius: 10, border: "1px solid #E2E8F0", fontSize: 12.5, fontFamily: "inherit", marginBottom: 10, outline: "none", boxSizing: "border-box", color: "#0F172A" }} />

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {patients.length === 0 ? (
              <div style={{ textAlign: "center", padding: 30, color: "#94A3B8", fontSize: 12.5, background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0" }}>
                {q ? "Ningún paciente coincide con la búsqueda" : "Sin pacientes en esta unidad"}
              </div>
            ) : patients.map((p) => {
              const isOpen = !!open[p.bed];
              return (
                <div key={p.bed} style={{ background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0", overflow: "hidden", boxShadow: "0 1px 3px rgba(15,23,42,.04)" }}>
                  <div onClick={() => setOpen((o) => ({ ...o, [p.bed]: !o[p.bed] }))} style={{ padding: "11px 13px", cursor: "pointer", display: "flex", gap: 11, alignItems: "flex-start" }}>
                    <div style={{ flexShrink: 0, minWidth: 40, textAlign: "center", background: "#0F172A", color: "#fff", borderRadius: 8, padding: "5px 7px", fontWeight: 800, fontSize: 13, lineHeight: 1.2 }}>{p.bed}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 700, fontSize: 13.5, color: "#0F172A" }}>{p.name || "—"}</span>
                        {p.age && <span style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600 }}>{p.age} a</span>}
                      </div>
                      {p.flags?.length > 0 && (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                          {p.flags.map((f, i) => (
                            <span key={i} style={{ fontSize: 9.5, fontWeight: 700, background: "#FEF2F2", color: "#B91C1C", border: "1px solid #FECACA", padding: "2px 6px", borderRadius: 5 }}>{f}</span>
                          ))}
                        </div>
                      )}
                      {p.mi && <div style={{ fontSize: 12, color: "#1D4ED8", fontWeight: 600, marginTop: 4, lineHeight: 1.35 }}>{p.mi}</div>}
                      {p.status && <div style={{ fontSize: 11.5, color: "#475569", marginTop: 5, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: isOpen ? "unset" : 2, WebkitBoxOrient: "vertical", overflow: isOpen ? "visible" : "hidden" }}>{p.status}</div>}
                    </div>
                    <div style={{ flexShrink: 0, color: "#CBD5E1", fontSize: 12, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▼</div>
                  </div>

                  {isOpen && (
                    <div style={{ borderTop: "1px solid #F1F5F9", padding: "4px 13px 12px" }}>
                      {PASE_FIELDS.filter(([k]) => p.fields?.[k]).map(([k, label]) => (
                        <div key={k} style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
                          <div style={{ fontSize: 11.5, color: "#334155", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{p.fields[k]}</div>
                        </div>
                      ))}
                      <ResumenIAPaciente p={p} state={aiState[p.bed]} onGenerar={() => generarResumenIA(p)} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Resumen de un paciente en particular generado por IA, a demanda (nunca
// automático). Se arma con toda la información cargada en el pase de ese
// paciente y devuelve un resumen clínico formal + 5 perlas basadas en MBE
// revisada por pares, con citas si corresponde.
function ResumenIAPaciente({ p, state, onGenerar }) {
  if (!state) {
    return (
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #E2E8F0" }}>
        <button onClick={(e) => { e.stopPropagation(); onGenerar(); }} style={{ display: "flex", alignItems: "center", gap: 6, background: "#EEF2FF", color: "#3730A3", border: "1px solid #C7D2FE", borderRadius: 8, padding: "7px 13px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          🤖 Generar resumen de este paciente en IA
        </button>
      </div>
    );
  }

  if (state.loading) {
    return (
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #E2E8F0", fontSize: 11.5, color: "#6366F1", fontWeight: 600 }}>
        🤖 Generando resumen clínico y perlas basadas en evidencia… puede tardar unos segundos.
      </div>
    );
  }

  if (state.error) {
    return (
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #E2E8F0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, background: "#FEF2F2", border: "1px solid #FECACA", color: "#991B1B", padding: "6px 12px", borderRadius: 9, fontSize: 11.5, fontWeight: 500, marginBottom: 8 }}>
          ⛔ {state.error}
        </div>
        <button onClick={(e) => { e.stopPropagation(); onGenerar(); }} style={{ background: "#EEF2FF", color: "#3730A3", border: "1px solid #C7D2FE", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #E2E8F0" }} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: "#3730A3", letterSpacing: 0.4, textTransform: "uppercase" }}>🤖 Resumen clínico generado por IA</div>
        <button onClick={onGenerar} style={{ background: "none", border: "none", color: "#94A3B8", fontSize: 10.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>↻ Regenerar</button>
      </div>

      {state.resumen && <div style={{ fontSize: 11.5, color: "#1E1B4B", lineHeight: 1.6, whiteSpace: "pre-wrap", marginBottom: 12 }}>{state.resumen}</div>}

      {state.perlas?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 5 }}>Perlas clínicas · MBE</div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {state.perlas.map((perla, i) => (
              <li key={i} style={{ fontSize: 11.5, color: "#334155", lineHeight: 1.55, marginBottom: 6 }}>{perla}</li>
            ))}
          </ol>
        </div>
      )}

      {state.fuentes?.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 5 }}>Fuentes citadas</div>
          {state.fuentes.map((f, i) => (
            <div key={i} style={{ fontSize: 10.5, color: "#64748B", lineHeight: 1.5, marginBottom: 2 }}>
              {f.referencia}{f.url ? <> — <a href={f.url} target="_blank" rel="noreferrer" style={{ color: "#4F46E5" }}>{f.url}</a></> : ""}
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 10, color: "#94A3B8", fontStyle: "italic", lineHeight: 1.4 }}>
        Generado por IA como apoyo — no reemplaza el juicio clínico. Verificá siempre las citas antes de usarlas.
      </div>
    </div>
  );
}

/* ══════════════════ CHIPA DE LA SEMANA VIEW ══════════════════ */

function ChipaView({ isAdmin, user }) {
  const realMonday = useMemo(() => mondayOf(new Date()), []);
  const realWeekId = isoDate(realMonday);
  const [monday, setMonday] = useState(() => realMonday);
  const weekId = isoDate(monday);
  const isRealWeek = weekId === realWeekId;

  const [week, setWeek] = useState({ weekStart: weekId, candidates: [], counts: {} });
  const [loading, setLoading] = useState(true);
  const [voted, setVoted] = useState(null); // null = todavía no se sabe, true/false ya resuelto
  const [status, setStatus] = useState("idle");
  const [editingCandidates, setEditingCandidates] = useState(false);
  const [pickerSel, setPickerSel] = useState([]);
  const [voting, setVoting] = useState(false);
  const [history, setHistory] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const ref = doc(db, "chipa_votes", weekId);
    const unsub = onSnapshot(ref, (snap) => {
      setWeek(snap.exists() ? normalizeChipaWeek(snap.data(), weekId) : { weekStart: weekId, candidates: [], counts: {} });
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, [weekId]);

  useEffect(() => {
    if (!user?.uid) return;
    const ref = doc(db, "chipa_voters", weekId);
    const unsub = onSnapshot(ref, (snap) => {
      const list = snap.exists() && Array.isArray(snap.data().voted) ? snap.data().voted : [];
      setVoted(list.includes(user.uid));
    }, () => setVoted(false));
    return unsub;
  }, [weekId, user?.uid]);

  useEffect(() => { setEditingCandidates(false); }, [weekId]);

  const openPicker = () => { setPickerSel(week.candidates); setEditingCandidates(true); };
  const toggleCandidate = (n) => setPickerSel((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]));

  const saveCandidates = async () => {
    if (!isAdmin) return;
    setStatus("saving");
    try {
      await setDoc(doc(db, "chipa_votes", weekId), { weekStart: weekId, candidates: pickerSel }, { merge: true });
      setStatus("saved"); setTimeout(() => setStatus("idle"), 1500);
    } catch (e) { console.error(e); setStatus("error"); }
    setEditingCandidates(false);
  };

  const castVote = async (name) => {
    if (!user?.uid || voted || voting || !week.candidates.includes(name)) return;
    setVoting(true);
    try {
      await setDoc(doc(db, "chipa_votes", weekId), { weekStart: weekId, counts: { [name]: increment(1) } }, { merge: true });
      await setDoc(doc(db, "chipa_voters", weekId), { voted: arrayUnion(user.uid) }, { merge: true });
    } catch (e) { console.error("voto chipa", e); }
    setVoting(false);
  };

  const loadHistory = async () => {
    if (history) { setShowHistory((v) => !v); return; }
    setHistoryLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "chipa_votes"), orderBy("weekStart", "desc")));
      const weeks = snap.docs.map((d) => normalizeChipaWeek(d.data(), d.id)).filter((w) => w.weekStart < realWeekId && w.candidates.length > 0);
      setHistory(weeks);
      setShowHistory(true);
    } catch (e) { console.error(e); }
    setHistoryLoading(false);
  };

  const S = { saving: { t: "Guardando…", c: "#CBD5E1" }, saved: { t: "✓ Guardado", c: "#86EFAC" }, error: { t: "⚠ Error", c: "#FCA5A5" } }[status];

  if (loading) return <Skeleton />;

  const maxVotes = Math.max(0, ...week.candidates.map((n) => week.counts[n] || 0));
  const totalVotes = week.candidates.reduce((s, n) => s + (week.counts[n] || 0), 0);

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#7C2D12,#9A3412 60%,#C2410C)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🥐</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Chipa de la semana</div>
            <div style={{ fontSize: 10.5, opacity: 0.7 }}>{totalVotes} voto{totalVotes === 1 ? "" : "s"}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={() => setMonday(shift(monday, -7))} style={{ ...NAV, background: "rgba(255,255,255,.14)" }}>◀</button>
          <div style={{ textAlign: "center", minWidth: 90 }}>
            <div style={{ fontWeight: 700, fontSize: 12.5 }}>{dm(monday)} — {dm(shift(monday, 6))}</div>
          </div>
          <button onClick={() => setMonday(shift(monday, 7))} style={{ ...NAV, background: "rgba(255,255,255,.14)" }}>▶</button>
          {!isRealWeek && <button onClick={() => setMonday(realMonday)} style={{ ...NAV, width: "auto", padding: "6px 11px", fontSize: 11, fontWeight: 600 }}>Hoy</button>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {S && <div style={{ fontSize: 10.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: "rgba(255,255,255,.16)", color: S.c }}>{S.t}</div>}
          {isAdmin && !editingCandidates && <button onClick={openPicker} style={{ ...NAV, width: "auto", padding: "6px 12px", fontSize: 11, background: "rgba(255,255,255,.18)" }}>✏️ Elegir candidatos</button>}
        </div>
      </div>

      {!isRealWeek && (
        <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "5px 10px", marginBottom: 10 }}>
          📍 Estás viendo otra semana, no la actual — lo que edites o votes acá corresponde a esa semana.
        </div>
      )}

      {editingCandidates ? (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "#64748B", fontWeight: 600, marginBottom: 10 }}>Tocá para agregar o sacar candidatos de esta semana:</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
            {ALL.map((n) => {
              const on = pickerSel.includes(n);
              const c = COLOR[LEVEL[n]];
              return (
                <div key={n} onClick={() => toggleCandidate(n)} style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 8, background: on ? c.solid : "#F1F5F9", border: `1.5px solid ${on ? c.solid : "#E2E8F0"}`, color: on ? "#fff" : "#64748B", fontWeight: 600, fontSize: 12 }}>
                  {on && "✓ "}{n}
                  <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: on ? "rgba(255,255,255,.28)" : c.solid, color: "#fff" }}>{LEVEL[n]}</span>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={saveCandidates} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 8, padding: "7px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓ Guardar candidatos</button>
            <button onClick={() => setEditingCandidates(false)} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 8, padding: "7px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
          </div>
        </div>
      ) : week.candidates.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 20px", color: "#94A3B8", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
          🥐 Todavía no se eligieron los candidatos de esta semana.
          {isAdmin && <div style={{ fontSize: 11.5, marginTop: 8 }}>Tocá "Elegir candidatos" para arrancar la votación.</div>}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
            {week.candidates.map((n) => {
              const count = week.counts[n] || 0;
              const isWinner = maxVotes > 0 && count === maxVotes;
              return <CandidateCard key={n} name={n} count={count} isWinner={isWinner} disabled={!!voted || voting} onVote={() => castVote(n)} />;
            })}
          </div>
          <div style={{ textAlign: "center", padding: "8px 4px", fontSize: 12, fontWeight: 600, color: voted ? "#16A34A" : "#94A3B8" }}>
            {voted ? "✓ Ya votaste esta semana — gracias 🍞" : "Tocá a un candidato para votarlo. El voto es anónimo y no se puede cambiar."}
          </div>
        </>
      )}

      <div style={{ marginTop: 18 }}>
        <button className="no-print" onClick={loadHistory} disabled={historyLoading} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, color: "#64748B", padding: "4px 2px", marginBottom: 8, opacity: historyLoading ? 0.5 : 1 }}>
          <span style={{ display: "inline-block", transform: showHistory ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
          {historyLoading ? "Cargando historial…" : `Historial${history ? ` (${history.length})` : ""}`}
        </button>
        {showHistory && history && (
          history.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "#94A3B8", fontStyle: "italic", padding: "4px 2px" }}>Sin semanas anteriores todavía.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {history.map((w) => <ChipaHistoryRow key={w.weekStart} week={w} />)}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function CandidateCard({ name, count, isWinner, disabled, onVote }) {
  const c = COLOR[LEVEL[name]];
  return (
    <div onClick={disabled ? undefined : onVote} style={{ cursor: disabled ? "default" : "pointer", userSelect: "none", flex: "1 1 130px", maxWidth: 180, textAlign: "center", padding: "16px 10px", borderRadius: 14, background: isWinner ? "#FFFBEB" : "#fff", border: `2px solid ${isWinner ? "#FBBF24" : "#E2E8F0"}`, boxShadow: isWinner ? "0 0 0 3px #FBBF2433" : "0 1px 3px rgba(15,23,42,.04)", transition: "transform .1s", opacity: disabled ? 0.75 : 1 }}>
      <div style={{ fontSize: 26, marginBottom: 4 }}>{isWinner && count > 0 ? "🏆" : "🥐"}</div>
      <div style={{ fontWeight: 800, fontSize: 14, color: "#0F172A" }}>{name}</div>
      <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 5px", borderRadius: 3, background: c.solid, color: "#fff", letterSpacing: 0.2 }}>{LEVEL[name]}</span>
      <div style={{ marginTop: 8, fontSize: 20, fontWeight: 800, color: isWinner ? "#B45309" : "#334155" }}>{count}</div>
      <div style={{ fontSize: 9.5, color: "#94A3B8", fontWeight: 600 }}>voto{count === 1 ? "" : "s"}</div>
    </div>
  );
}

function ChipaHistoryRow({ week }) {
  const monday = new Date(`${week.weekStart}T12:00:00`);
  const maxVotes = Math.max(0, ...week.candidates.map((n) => week.counts[n] || 0));
  const winners = maxVotes > 0 ? week.candidates.filter((n) => (week.counts[n] || 0) === maxVotes) : [];
  const sorted = [...week.candidates].sort((a, b) => (week.counts[b] || 0) - (week.counts[a] || 0));
  return (
    <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E2E8F0", padding: "9px 13px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
        <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600 }}>{dm(monday)} — {dm(shift(monday, 6))}</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#B45309" }}>
          {winners.length === 0 ? "Sin votos" : `🏆 ${winners.join(" y ")}`}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#64748B", marginTop: 4 }}>
        {sorted.map((n) => `${n} (${week.counts[n] || 0})`).join(" · ")}
      </div>
    </div>
  );
}

/* ══════════════════ CALENDARIO ACADÉMICO VIEW ══════════════════ */

function AcademicoView({ isAdmin }) {
  const [data, setData] = useState(emptyAcademico);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("idle");
  const [editing, setEditing] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  const docId = "academico";
  const pending = useRef(null);
  const timer = useRef(null);
  const statusTimer = useRef(null);

  useEffect(() => {
    setLoading(true);
    const ref = doc(db, "scheduler", docId);
    const unsub = onSnapshot(ref, (snap) => {
      setData(snap.exists() ? normalizeAcademico(snap.data()) : emptyAcademico());
      setLoading(false);
    }, () => setLoading(false));
    return () => { unsub(); if (timer.current) clearTimeout(timer.current); };
  }, []);

  const save = useCallback((next) => {
    if (!isAdmin) return;
    setData(next); pending.current = next; setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { await setDoc(doc(db, "scheduler", docId), pending.current); setStatus("saved");
        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus("idle"), 1600);
      } catch (e) { console.error(e); setStatus("error"); }
    }, 400);
  }, [isAdmin]);

  const addActivity = () => { if (!isAdmin) return; setEditing({ mode: "new", date: isoDate(new Date()), time: "", title: "", docente: "", notes: "" }); };
  const editActivity = (a) => { if (!isAdmin) return; setEditing({ mode: "edit", id: a.id, date: a.date, time: a.time, title: a.title, docente: a.docente, notes: a.notes }); };

  const saveActivity = () => {
    if (!editing || !editing.date.trim() || !editing.title.trim()) return;
    const next = clone(data);
    const record = { id: editing.mode === "edit" ? editing.id : `${editing.date}-${Math.random().toString(36).slice(2, 9)}`, date: editing.date, time: editing.time.trim(), title: editing.title.trim(), docente: editing.docente.trim(), notes: editing.notes.trim() };
    if (editing.mode === "edit") { const idx = next.activities.findIndex((a) => a.id === editing.id); if (idx >= 0) next.activities[idx] = record; }
    else next.activities.push(record);
    save(next); setEditing(null);
  };

  const removeActivity = (id) => { if (!isAdmin) return; if (!confirm("¿Eliminar esta actividad?")) return; const next = clone(data); next.activities = next.activities.filter((a) => a.id !== id); save(next); };

  const S = { saving: { t: "Guardando…", c: "#CBD5E1" }, saved: { t: "✓ Guardado", c: "#86EFAC" }, error: { t: "⚠ Error", c: "#FCA5A5" } }[status];

  if (loading) return <Skeleton />;

  const now = new Date();
  const nowKey = `${isoDate(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const key = (a) => `${a.date} ${a.time || "00:00"}`;

  const upcoming = data.activities.filter((a) => key(a) >= nowKey).sort((x, y) => key(x).localeCompare(key(y)));
  const past = data.activities.filter((a) => key(a) < nowKey).sort((x, y) => key(y).localeCompare(key(x)));

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>📚</span>
          <div><div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Calendario académico</div><div style={{ fontSize: 10.5, opacity: 0.55 }}>Hospital Británico</div></div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {S && <div style={{ fontSize: 10.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: "rgba(255,255,255,.12)", color: S.c }}>{S.t}</div>}
          {isAdmin && <button onClick={addActivity} style={{ ...NAV, width: "auto", padding: "6px 12px", fontSize: 11 }}>+ Agregar actividad</button>}
        </div>
      </div>

      {editing && editing.mode === "new" && (
        <div style={{ marginBottom: 8 }}>
          <AcademicoEditForm editing={editing} setEditing={setEditing} onSave={saveActivity} onCancel={() => setEditing(null)} />
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {upcoming.length === 0 && !(editing && editing.mode === "new") ? (
          <div style={{ textAlign: "center", padding: 30, color: "#94A3B8", fontSize: 12.5, background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0" }}>Sin actividades próximas{isAdmin ? " — tocá \"Agregar actividad\" para cargar la primera." : "."}</div>
        ) : upcoming.map((a) => (
          editing && editing.mode === "edit" && editing.id === a.id
            ? <AcademicoEditForm key={a.id} editing={editing} setEditing={setEditing} onSave={saveActivity} onCancel={() => setEditing(null)} />
            : <AcademicoCard key={a.id} activity={a} isAdmin={isAdmin} onEdit={() => editActivity(a)} onRemove={() => removeActivity(a.id)} />
        ))}
      </div>

      {past.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <button className="no-print" onClick={() => setShowHistory((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, color: "#64748B", padding: "4px 2px", marginBottom: 8 }}>
            <span style={{ display: "inline-block", transform: showHistory ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
            Historial ({past.length})
          </button>
          {showHistory && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {past.map((a) => (
                editing && editing.mode === "edit" && editing.id === a.id
                  ? <AcademicoEditForm key={a.id} editing={editing} setEditing={setEditing} onSave={saveActivity} onCancel={() => setEditing(null)} />
                  : <AcademicoCard key={a.id} activity={a} isAdmin={isAdmin} onEdit={() => editActivity(a)} onRemove={() => removeActivity(a.id)} dimmed />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AcademicoCard({ activity, isAdmin, onEdit, onRemove, dimmed }) {
  const d = new Date(`${activity.date}T${activity.time || "00:00"}:00`);
  const dateLabel = `${WEEKDAYS_FULL[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()].toLowerCase()}`;
  return (
    <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(15,23,42,.04)", padding: "11px 14px", display: "flex", gap: 12, alignItems: "flex-start", opacity: dimmed ? 0.6 : 1 }}>
      <div style={{ flexShrink: 0, minWidth: 58, textAlign: "center", background: dimmed ? "#F1F5F9" : "#0F172A", color: dimmed ? "#64748B" : "#fff", borderRadius: 8, padding: "6px 7px" }}>
        <div style={{ fontWeight: 800, fontSize: 14, lineHeight: 1.15 }}>{d.getDate()}</div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", opacity: 0.8 }}>{MONTHS[d.getMonth()].slice(0, 3)}</div>
        {activity.time && <div style={{ fontSize: 9.5, fontWeight: 700, marginTop: 3, opacity: 0.85 }}>{activity.time}</div>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10.5, color: "#94A3B8", fontWeight: 600, marginBottom: 2 }}>{dateLabel}</div>
        <div style={{ fontWeight: 700, fontSize: 13.5, color: dimmed ? "#64748B" : "#0F172A" }}>{activity.title || "(sin nombre)"}</div>
        {activity.docente && <div style={{ fontSize: 12, color: dimmed ? "#94A3B8" : "#1D4ED8", fontWeight: 600, marginTop: 2 }}>{activity.docente}</div>}
        {activity.notes && <div style={{ fontSize: 11.5, color: "#475569", marginTop: 4, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{activity.notes}</div>}
      </div>
      {isAdmin && (
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <span onClick={onEdit} title="Editar" style={{ cursor: "pointer", fontSize: 12, opacity: 0.4 }}>✏️</span>
          <span onClick={onRemove} title="Eliminar" style={{ cursor: "pointer", fontSize: 12, opacity: 0.4 }}>✕</span>
        </div>
      )}
    </div>
  );
}

const AcademicoEditForm = ({ editing, setEditing, onSave, onCancel }) => (
  <div style={{ background: "#F8FAFC", border: "1.5px solid #CBD5E1", borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <input type="date" value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} style={INPUT} />
      <input type="time" value={editing.time} onChange={(e) => setEditing({ ...editing, time: e.target.value })} style={INPUT} />
      <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="Nombre de la clase" style={{ ...INPUT, flex: 1, minWidth: 160 }} />
      <input value={editing.docente} onChange={(e) => setEditing({ ...editing, docente: e.target.value })} placeholder="Docente" style={{ ...INPUT, minWidth: 130 }} />
    </div>
    <textarea value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} placeholder="Observaciones…" style={{ ...TEXTAREA, minHeight: 40 }} />
    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
      <button onClick={onSave} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓ Guardar</button>
      <button onClick={onCancel} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
    </div>
  </div>
);

/* ══════════════════ ARTÍCULO DE LA SEMANA ══════════════════ */

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || "";
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(file);
  });
}

function formatFechaHora(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const fecha = `${WEEKDAYS_FULL[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()].toLowerCase()}`;
  const hora = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${fecha} · ${hora}`;
}

function ArticuloSemanaView({ isAdmin }) {
  const [articulos, setArticulos] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [driveUrl, setDriveUrl] = useState("");
  const fileRef = useRef(null);

  useEffect(() => {
    setLoading(true);
    const q = query(collection(db, "articulos_semana"), orderBy("generatedAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      setArticulos(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, (err) => { console.error(err); setLoading(false); });
    return () => unsub();
  }, []);

  // El más reciente arranca desplegado; si llega uno nuevo, pasa a ser ese.
  useEffect(() => {
    if (articulos && articulos.length > 0) setOpenId((cur) => cur ?? articulos[0].id);
  }, [articulos]);

  const eliminarArticulo = async (id) => {
    if (!confirm("¿Eliminar este artículo? Se borra el resumen, las preguntas y el link — no se puede deshacer.")) return;
    try { await deleteDoc(doc(db, "articulos_semana", id)); } catch (e) { console.error(e); }
  };

  const guardarPdfUrl = async (id, url) => {
    try { await setDoc(doc(db, "articulos_semana", id), { pdfUrl: url.trim() || null }, { merge: true }); } catch (e) { console.error(e); }
  };

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    if (file.type !== "application/pdf") { setError("El archivo tiene que ser un PDF."); return; }
    if (file.size > 4.3 * 1024 * 1024) { setError("El PDF es demasiado grande (máx. ~4MB). Probá con un extracto más corto."); return; }
    setError(""); setUploading(true);
    try {
      const pdfBase64 = await fileToBase64(file);
      const res = await fetch("/api/resumen-articulo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pdfBase64, filename: file.name, pdfUrl: driveUrl.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "No se pudo generar el resumen.");
      setDriveUrl("");
      setOpenId(null); // se va a abrir el nuevo (el más reciente) apenas llegue por onSnapshot
    } catch (err) {
      setError(err.message || "Error inesperado al generar el resumen.");
    } finally {
      setUploading(false);
    }
  };

  if (loading) return <Skeleton />;

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <span style={{ fontSize: 22 }}>📄</span>
        <div><div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Artículo de la semana</div><div style={{ fontSize: 10.5, opacity: 0.55 }}>Hospital Británico</div></div>
      </div>

      {isAdmin && (
        <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 12, padding: "12px 14px", marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
            <div style={{ fontSize: 12, color: "#475569" }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: "#0F172A", marginBottom: 2 }}>Subir un artículo nuevo</div>
              Subí el PDF del artículo de la semana y la IA genera un resumen y preguntas para discutir en el pase. Los anteriores quedan guardados abajo como historial.
            </div>
            <label style={{ ...NAV, background: uploading ? "#94A3B8" : "#0F172A", color: "#fff", width: "auto", padding: "8px 16px", fontSize: 12, opacity: uploading ? 0.7 : 1, cursor: uploading ? "default" : "pointer" }}>
              {uploading ? "Generando resumen…" : "📤 Subir PDF"}
              <input ref={fileRef} type="file" accept="application/pdf" onChange={handleFile} disabled={uploading} style={{ display: "none" }} />
            </label>
          </div>
          <div>
            <input
              value={driveUrl}
              onChange={(e) => setDriveUrl(e.target.value)}
              placeholder="Opcional: pegá acá el link para compartir del PDF en tu Google Drive (para que los residentes lo puedan descargar)"
              disabled={uploading}
              style={{ ...INPUT, width: "100%", boxSizing: "border-box" }}
            />
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="warn">{error}</Banner>
        </div>
      )}

      {!articulos || articulos.length === 0 ? (
        <div style={{ textAlign: "center", padding: 30, color: "#94A3B8", fontSize: 12.5, background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0" }}>
          Todavía no se cargó ningún artículo{isAdmin ? " — tocá \"Subir PDF\" para generar el primero." : "."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {articulos.map((a, i) => (
            <ArticuloCard key={a.id} articulo={a} isOpen={openId === a.id} isLatest={i === 0} isAdmin={isAdmin} onToggle={() => setOpenId((cur) => (cur === a.id ? null : a.id))} onDelete={() => eliminarArticulo(a.id)} onSavePdfUrl={(url) => guardarPdfUrl(a.id, url)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArticuloCard({ articulo, isOpen, isLatest, isAdmin, onToggle, onDelete, onSavePdfUrl }) {
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlValue, setUrlValue] = useState(articulo.pdfUrl || "");

  const startEditUrl = (e) => { e.stopPropagation(); setUrlValue(articulo.pdfUrl || ""); setEditingUrl(true); };
  const saveUrl = (e) => { e.stopPropagation(); onSavePdfUrl(urlValue); setEditingUrl(false); };
  const cancelUrl = (e) => { e.stopPropagation(); setEditingUrl(false); };

  return (
    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(15,23,42,.04)", overflow: "hidden" }}>
      <div onClick={onToggle} style={{ cursor: "pointer", padding: "14px 18px", borderBottom: isOpen ? "1px solid #F1F5F9" : "none", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span className="no-print" style={{ display: "inline-block", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s", color: "#94A3B8", fontSize: 12 }}>▶</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 14.5, color: "#0F172A", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>📄 {articulo.filename || "Artículo"}</div>
            <div style={{ fontSize: 10.5, color: "#94A3B8", marginTop: 2 }}>{formatFechaHora(articulo.generatedAt)}{isLatest && <span style={{ marginLeft: 6, fontWeight: 700, color: "#16A34A" }}>· más reciente</span>}</div>
          </div>
        </div>
        <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {articulo.pdfUrl && (
            <a href={articulo.pdfUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: "#0F172A", color: "#fff", textDecoration: "none" }}>📄 Ver PDF</a>
          )}
          {isAdmin && (
            <button onClick={startEditUrl} title={articulo.pdfUrl ? "Editar link del PDF" : "Agregar link del PDF"} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: "#F1F5F9", color: "#475569", border: "1px solid #E2E8F0", cursor: "pointer", fontFamily: "inherit" }}>
              🔗 {articulo.pdfUrl ? "Editar link" : "Agregar link"}
            </button>
          )}
          <div style={{ fontSize: 10.5, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: "#EEF2FF", color: "#4338CA", border: "1px solid #C7D2FE" }}>🤖 Generado por IA</div>
          {isAdmin && (
            <button onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Eliminar artículo" style={{ background: "none", border: "none", color: "#CBD5E1", cursor: "pointer", fontSize: 14, fontFamily: "inherit", padding: "2px 2px" }}>🗑️</button>
          )}
        </div>
      </div>

      {isAdmin && editingUrl && (
        <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6, alignItems: "center", padding: "10px 18px", background: "#F8FAFC", borderBottom: "1px solid #F1F5F9", flexWrap: "wrap" }}>
          <input
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            placeholder="Link para compartir del PDF en Google Drive…"
            onKeyDown={(e) => e.key === "Enter" && saveUrl(e)}
            style={{ ...INPUT, flex: 1, minWidth: 200, boxSizing: "border-box" }}
          />
          <button onClick={saveUrl} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓ Guardar</button>
          <button onClick={cancelUrl} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
        </div>
      )}

      {isOpen && (
        <>
          <div style={{ padding: "16px 18px" }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: "#334155", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>Resumen</div>
            <div style={{ fontSize: 13, color: "#1E293B", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{articulo.resumen || "—"}</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, borderTop: "1px solid #F1F5F9" }}>
            <div style={{ padding: "14px 18px", borderRight: "1px solid #F1F5F9" }}>
              <div style={{ fontWeight: 700, fontSize: 11.5, color: "#1D4ED8", marginBottom: 8 }}>❓ Preguntas para R2</div>
              <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}>
                {(articulo.preguntasR2 || []).map((q, i) => (
                  <li key={i} style={{ fontSize: 12.5, color: "#334155", lineHeight: 1.5 }}>{q}</li>
                ))}
              </ol>
            </div>
            <div style={{ padding: "14px 18px" }}>
              <div style={{ fontWeight: 700, fontSize: 11.5, color: "#B45309", marginBottom: 8 }}>❓ Preguntas para R3 y R4</div>
              <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}>
                {(articulo.preguntasR3R4 || []).map((q, i) => (
                  <li key={i} style={{ fontSize: 12.5, color: "#334155", lineHeight: 1.5 }}>{q}</li>
                ))}
              </ol>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ══════════════════ REGISTRO (llegadas tarde / faltas / guardias / procedimientos) ══════════════════ */

function fechaCorta(fecha) {
  if (!fecha) return "—";
  const [, m, d] = fecha.split("-");
  return `${d}/${m}`;
}

function downloadCSV(filename, headers, rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fechaLarga(fecha) {
  if (!fecha) return "—";
  const [y, m, d] = fecha.split("-").map(Number);
  return `${String(d).padStart(2, "0")} de ${(MONTHS[m - 1] || "").toLowerCase()} de ${y}`;
}

// Agrupa procedimientos por tipo (solo los tipos que el residente efectivamente
// tiene cargados quedan visibles), en el orden de la lista maestra `procList`,
// y dentro de cada tipo ordena las entradas por fecha (más reciente primero).
function agruparPorTipo(procs, procList) {
  const map = {};
  procs.forEach((p) => { (map[p.tipo] = map[p.tipo] || []).push(p); });
  const enLista = (procList || []).filter((t) => map[t]);
  const extras = Object.keys(map).filter((t) => !enLista.includes(t)).sort((a, b) => a.localeCompare(b));
  return [...enLista, ...extras].map((tipo) => ({
    tipo,
    items: [...map[tipo]].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")),
  }));
}

// Solo interesa el mes y el año en que se hizo cada procedimiento (no el día
// exacto): agrupa una lista de procedimientos de un mismo tipo por mes/año,
// más reciente primero.
function agruparPorMes(items) {
  const map = {};
  items.forEach((p) => {
    const clave = p.fecha ? p.fecha.slice(0, 7) : "sin-fecha";
    (map[clave] = map[clave] || []).push(p);
  });
  return Object.keys(map).sort((a, b) => b.localeCompare(a)).map((clave) => ({
    clave,
    label: clave === "sin-fecha" ? "Sin fecha" : mesLargo(clave),
    items: map[clave],
  }));
}

function mesLargo(clave) {
  const [y, m] = clave.split("-").map(Number);
  return `${MONTHS[m - 1] || ""} ${y}`;
}

// Abre una ventana nueva con el registro de procedimientos de un residente,
// ya agrupado por tipo, y dispara el diálogo de impresión (el residente elige
// "Guardar como PDF"). Mismo patrón que la impresión del calendario semanal:
// título dinámico seteado antes de imprimir para que el nombre de archivo
// sugerido ya venga armado.
function descargarPDFProcedimientos(residente, grupos) {
  const total = grupos.reduce((n, g) => n + g.items.length, 0);
  const win = window.open("", "_blank");
  if (!win) return;
  const filas = grupos.map((g) => {
    const meses = agruparPorMes(g.items);
    return `
      <h3>${g.tipo} <span class="cnt">(${g.items.length})</span></h3>
      <table>
        <thead><tr><th>Mes</th><th>Cantidad</th><th>Región (detalle opcional)</th></tr></thead>
        <tbody>
          ${meses.map((m) => {
            const notas = m.items.map((p) => p.nota).filter(Boolean);
            const detalle = notas.length ? notas.join(", ").replace(/</g, "&lt;") : "—";
            return `<tr><td class="mes">${m.label}</td><td class="cant">${m.items.length}</td><td class="det">${detalle}</td></tr>`;
          }).join("")}
        </tbody>
      </table>
    `;
  }).join("");
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8" />
    <title>Registro de procedimientos — ${residente}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: 'Inter', system-ui, sans-serif; color: #0F172A; padding: 28px 34px; }
      h1 { font-size: 19px; margin: 0 0 2px; }
      .sub { font-size: 12px; color: #64748B; margin: 0 0 22px; }
      h3 { font-size: 13px; color: #0F766E; border-bottom: 1.5px solid #99F6E4; padding-bottom: 4px; margin: 20px 0 6px; }
      .cnt { color: #94A3B8; font-weight: 500; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
      th { text-align: left; font-size: 10.5px; color: #94A3B8; font-weight: 700; padding: 4px 6px; }
      td { font-size: 12px; padding: 4px 6px; border-top: 1px solid #F1F5F9; }
      td.mes { white-space: nowrap; color: #334155; font-weight: 600; width: 150px; text-transform: capitalize; }
      td.cant { width: 70px; color: #0F766E; font-weight: 700; }
      td.det { color: #64748B; }
      @media print { body { padding: 14mm; } }
    </style>
    </head><body>
    <h1>Registro de procedimientos — ${residente}</h1>
    <p class="sub">Scheduler UTI · Hospital Británico · Total: ${total} procedimiento${total === 1 ? "" : "s"}</p>
    ${filas || "<p>Todavía no hay procedimientos cargados.</p>"}
    </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 200);
}

function RegistroView({ isAdmin, user }) {
  const [subOrder, setSubOrder] = useState(DEFAULT_REGISTRO_SUB_ORDER);
  const [sub, setSub] = useState("tarde");
  const [eventos, setEventos] = useState([]);
  const [procedimientos, setProcedimientos] = useState([]);
  const [procList, setProcList] = useState(DEFAULT_PROCEDIMIENTOS);
  const [cobertura, setCobertura] = useState([]);
  const [clases, setClases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "registro_eventos"), (snap) => {
      setEventos(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "procedimientos"), (snap) => {
      setProcedimientos(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, () => {});
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "cobertura_sala"), (snap) => {
      setCobertura(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, () => {});
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "registro_clases"), (snap) => {
      setClases(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, () => {});
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "scheduler", "registro-config"), (snap) => {
      const list = snap.exists() && Array.isArray(snap.data().procedimientosList) ? snap.data().procedimientosList : null;
      setProcList(list && list.length ? list : DEFAULT_PROCEDIMIENTOS);
    }, () => {});
    return unsub;
  }, []);

  useEffect(() => {
    const ref = doc(db, "scheduler", "ui-config");
    const unsub = onSnapshot(ref, (snap) => {
      const stored = snap.exists() ? snap.data().registroSubOrder : null;
      if (Array.isArray(stored) && stored.length) {
        const known = stored.filter((k) => DEFAULT_REGISTRO_SUB_ORDER.includes(k));
        const missing = DEFAULT_REGISTRO_SUB_ORDER.filter((k) => !known.includes(k));
        setSubOrder([...known, ...missing]);
      } else {
        setSubOrder(DEFAULT_REGISTRO_SUB_ORDER);
      }
    }, () => {});
    return unsub;
  }, []);

  const persistSubOrder = (next) => {
    setSubOrder(next);
    setDoc(doc(db, "scheduler", "ui-config"), { registroSubOrder: next }, { merge: true }).catch((e) => console.error("ui-config registroSubOrder", e));
  };

  const handleSubDragStart = (i) => (e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; };
  const handleSubDragEnter = (i) => (e) => { e.preventDefault(); if (dragIdx !== null) setOverIdx(i); };
  const handleSubDragOver = (e) => { e.preventDefault(); };
  const handleSubDragEnd = () => { setDragIdx(null); setOverIdx(null); };
  const handleSubDrop = (i) => (e) => {
    e.preventDefault();
    const from = dragIdx;
    setDragIdx(null); setOverIdx(null);
    if (from === null || from === i) return;
    const next = [...subOrder];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    persistSubOrder(next);
  };

  const misResidente = RESIDENT_BY_EMAIL[(user?.email || "").toLowerCase()] || null;

  if (loading) return <Skeleton />;

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <span style={{ fontSize: 22 }}>📋</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Registro</div>
          <div style={{ fontSize: 10.5, opacity: 0.7 }}>Llegadas tarde, faltas, guardias, procedimientos y cobertura de sala</div>
        </div>
      </div>

      {isAdmin && <div className="no-print" style={{ fontSize: 10, color: "#94A3B8", marginBottom: 4, paddingLeft: 2 }}>Arrastrá una sub-pestaña para reordenarlas</div>}
      <div className="no-print" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {subOrder.map((key, i) => {
          const s = REGISTRO_SUB_META[key];
          if (!s) return null;
          const dropTarget = isAdmin && overIdx === i && dragIdx !== null && dragIdx !== i;
          return (
            <button
              key={key}
              onClick={() => setSub(key)}
              draggable={isAdmin}
              onDragStart={handleSubDragStart(i)}
              onDragEnter={handleSubDragEnter(i)}
              onDragOver={handleSubDragOver}
              onDrop={handleSubDrop(i)}
              onDragEnd={handleSubDragEnd}
              title={isAdmin ? "Arrastrá para reordenar" : undefined}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 9, border: `1.5px solid ${sub === key ? s.color : "#E2E8F0"}`, background: sub === key ? s.color : "#fff", color: sub === key ? "#fff" : "#64748B", fontWeight: 700, fontSize: 12.5, cursor: isAdmin ? "grab" : "pointer", fontFamily: "inherit", opacity: dragIdx === i ? 0.4 : 1, boxShadow: dropTarget ? "inset 3px 0 0 #3B82F6" : "none" }}
            >
              <span>{s.icon}</span>{s.label}
            </button>
          );
        })}
      </div>

      {sub === "procedimientos" ? (
        <ProcedimientosSection procedimientos={procedimientos} procList={procList} isAdmin={isAdmin} user={user} misResidente={misResidente} />
      ) : sub === "cobertura" ? (
        <CoberturaSection cobertura={cobertura} isAdmin={isAdmin} user={user} />
      ) : sub === "clases" ? (
        <ClasesSection clases={clases} isAdmin={isAdmin} user={user} />
      ) : (
        <EventosSection key={sub} tipo={sub} eventos={eventos} isAdmin={isAdmin} user={user} />
      )}
    </div>
  );
}

function EventosSection({ tipo, eventos, isAdmin, user }) {
  const meta = EVENTO_TIPOS[tipo];
  const [residente, setResidente] = useState(ALL[0]);
  const [fecha, setFecha] = useState(() => isoDate(new Date()));
  const [nota, setNota] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState(null);

  const lista = useMemo(() => eventos.filter((e) => e.tipo === tipo).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")), [eventos, tipo]);
  const totales = useMemo(() => {
    const t = {};
    lista.forEach((e) => { t[e.residente] = (t[e.residente] || 0) + 1; });
    return t;
  }, [lista]);

  const agregar = async () => {
    if (!residente || !fecha || saving) return;
    setSaving(true);
    try {
      await setDoc(doc(collection(db, "registro_eventos")), {
        residente, tipo, fecha, nota: nota.trim(),
        creadoPor: user?.email || "", creadoEn: new Date().toISOString(),
      });
      setNota("");
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const eliminar = async (id) => {
    try { await deleteDoc(doc(db, "registro_eventos", id)); } catch (e) { console.error(e); }
    setConfirmId(null);
  };

  const exportar = () => {
    downloadCSV(`registro-${tipo}.csv`, ["Residente", "Fecha", "Nota"], lista.map((e) => [e.residente, e.fecha, e.nota || ""]));
  };

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {ALL.map((n) => {
          const c = totales[n] || 0;
          const lv = COLOR[LEVEL[n]];
          return (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 9, background: "#fff", border: "1px solid #E2E8F0" }}>
              <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: lv.solid, color: "#fff" }}>{LEVEL[n]}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>{n}</span>
              <span style={{ fontSize: 12, fontWeight: 800, color: c > 0 ? meta.color : "#CBD5E1", background: c > 0 ? meta.bg : "#F8FAFC", borderRadius: 999, padding: "1px 8px", minWidth: 18, textAlign: "center" }}>{c}</span>
            </div>
          );
        })}
      </div>

      {isAdmin && (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 12, marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>RESIDENTE</div>
            <select value={residente} onChange={(e) => setResidente(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {ALL.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>FECHA</div>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>NOTA (OPCIONAL)</div>
            <input value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Detalle…" style={{ width: "100%", fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", boxSizing: "border-box" }} />
          </div>
          <button onClick={agregar} disabled={saving} style={{ background: meta.color, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1 }}>
            + Agregar {meta.singular}
          </button>
        </div>
      )}

      {isAdmin && lista.length > 0 && (
        <button onClick={exportar} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "#64748B", padding: "2px 2px", marginBottom: 8 }}>
          ⬇️ Exportar CSV
        </button>
      )}

      {lista.length === 0 ? (
        <div style={{ textAlign: "center", padding: "30px 20px", color: "#94A3B8", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
          {meta.icon} Todavía no hay {meta.label.toLowerCase()} registradas.
        </div>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
          {lista.map((e, i) => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i === lista.length - 1 ? "none" : "1px solid #F1F5F9" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, background: meta.bg, border: `1px solid ${meta.bd}`, borderRadius: 6, padding: "2px 7px", minWidth: 42, textAlign: "center" }}>{fechaCorta(e.fecha)}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A", minWidth: 60 }}>{e.residente}</span>
              {e.nota && <span style={{ fontSize: 11.5, color: "#64748B", flex: 1 }}>{e.nota}</span>}
              {isAdmin && (
                confirmId === e.id ? (
                  <span style={{ display: "flex", gap: 4 }}>
                    <button onClick={() => eliminar(e.id)} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Sí, borrar</button>
                    <button onClick={() => setConfirmId(null)} style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", background: "#F1F5F9", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmId(e.id)} title="Eliminar" style={{ background: "none", border: "none", color: "#CBD5E1", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>🗑️</button>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CoberturaSection({ cobertura, isAdmin, user }) {
  const [residente, setResidente] = useState(COBERTURA_RESIDENTS[0]);
  const [fecha, setFecha] = useState(() => isoDate(new Date()));
  const [modalidad, setModalidad] = useState("post_guardia");
  const [nota, setNota] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState(null);

  const lista = useMemo(() => [...cobertura].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")), [cobertura]);
  const totales = useMemo(() => {
    const t = {};
    lista.forEach((e) => { t[e.residente] = (t[e.residente] || 0) + 1; });
    return t;
  }, [lista]);

  const agregar = async () => {
    if (!residente || !fecha || saving) return;
    setSaving(true);
    try {
      await setDoc(doc(collection(db, "cobertura_sala")), {
        residente, fecha, modalidad, nota: nota.trim(),
        creadoPor: user?.email || "", creadoEn: new Date().toISOString(),
      });
      setNota("");
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const eliminar = async (id) => {
    try { await deleteDoc(doc(db, "cobertura_sala", id)); } catch (e) { console.error(e); }
    setConfirmId(null);
  };

  const exportar = () => {
    downloadCSV("cobertura-sala.csv", ["Residente", "Fecha", "Modalidad", "Nota"], lista.map((e) => [e.residente, e.fecha, COBERTURA_TIPOS[e.modalidad]?.label || e.modalidad, e.nota || ""]));
  };

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {COBERTURA_RESIDENTS.map((n) => {
          const c = totales[n] || 0;
          const lv = COLOR[LEVEL[n]];
          return (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 9, background: "#fff", border: "1px solid #E2E8F0" }}>
              <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: lv.solid, color: "#fff" }}>{LEVEL[n]}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>{n}</span>
              <span style={{ fontSize: 12, fontWeight: 800, color: c > 0 ? "#1D4ED8" : "#CBD5E1", background: c > 0 ? "#EFF6FF" : "#F8FAFC", borderRadius: 999, padding: "1px 8px", minWidth: 18, textAlign: "center" }}>{c}</span>
            </div>
          );
        })}
      </div>

      {isAdmin && (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 12, marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>RESIDENTE (R2/R3)</div>
            <select value={residente} onChange={(e) => setResidente(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {COBERTURA_RESIDENTS.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>FECHA</div>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>MODALIDAD</div>
            <select value={modalidad} onChange={(e) => setModalidad(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {Object.entries(COBERTURA_TIPOS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>NOTA (OPCIONAL)</div>
            <input value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Detalle…" style={{ width: "100%", fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", boxSizing: "border-box" }} />
          </div>
          <button onClick={agregar} disabled={saving} style={{ background: "#1D4ED8", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1 }}>
            + Agregar cobertura
          </button>
        </div>
      )}

      {isAdmin && lista.length > 0 && (
        <button onClick={exportar} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "#64748B", padding: "2px 2px", marginBottom: 8 }}>
          ⬇️ Exportar CSV
        </button>
      )}

      {lista.length === 0 ? (
        <div style={{ textAlign: "center", padding: "30px 20px", color: "#94A3B8", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
          🔁 Todavía no hay coberturas de sala registradas.
        </div>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
          {lista.map((e, i) => {
            const mod = COBERTURA_TIPOS[e.modalidad] || COBERTURA_TIPOS.post_guardia;
            const lv = COLOR[LEVEL[e.residente]] || COLOR.R2;
            return (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i === lista.length - 1 ? "none" : "1px solid #F1F5F9", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#1D4ED8", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 6, padding: "2px 7px", minWidth: 42, textAlign: "center" }}>{fechaCorta(e.fecha)}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999, background: lv?.bg, border: `1px solid ${lv?.bd}`, color: lv?.tx, fontSize: 12, fontWeight: 700 }}>
                  {e.residente}
                  <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: lv?.solid, color: "#fff" }}>{LEVEL[e.residente]}</span>
                </span>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: e.modalidad === "rotacion" ? "#0369A1" : "#9F1239", background: e.modalidad === "rotacion" ? "#F0F9FF" : "#FFF1F2", borderRadius: 999, padding: "2px 9px" }}>{mod.label}</span>
                {e.nota && <span style={{ fontSize: 11.5, color: "#64748B", flex: 1 }}>{e.nota}</span>}
                {isAdmin && (
                  confirmId === e.id ? (
                    <span style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => eliminar(e.id)} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Sí, borrar</button>
                      <button onClick={() => setConfirmId(null)} style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", background: "#F1F5F9", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmId(e.id)} title="Eliminar" style={{ background: "none", border: "none", color: "#CBD5E1", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>🗑️</button>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ClasesSection({ clases, isAdmin, user }) {
  const [residente, setResidente] = useState(ALL[0]);
  const [modulo, setModulo] = useState(MODULOS_CLASE[0]);
  const [fecha, setFecha] = useState(() => isoDate(new Date()));
  const [tema, setTema] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState(null);

  const lista = useMemo(() => [...clases].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")), [clases]);

  const matriz = useMemo(() => {
    const m = {};
    ALL.forEach((n) => { m[n] = { total: 0 }; MODULOS_CLASE.forEach((mo) => { m[n][mo] = 0; }); });
    lista.forEach((c) => {
      if (!m[c.residente]) return;
      m[c.residente][c.modulo] = (m[c.residente][c.modulo] || 0) + 1;
      m[c.residente].total += 1;
    });
    return m;
  }, [lista]);

  const agregar = async () => {
    if (!residente || !modulo || !fecha || saving) return;
    setSaving(true);
    try {
      await setDoc(doc(collection(db, "registro_clases")), {
        residente, modulo, fecha, tema: tema.trim(),
        creadoPor: user?.email || "", creadoEn: new Date().toISOString(),
      });
      setTema("");
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const eliminar = async (id) => {
    try { await deleteDoc(doc(db, "registro_clases", id)); } catch (e) { console.error(e); }
    setConfirmId(null);
  };

  const exportar = () => {
    downloadCSV("clases-presentaciones.csv", ["Residente", "Módulo", "Fecha", "Tema"], lista.map((c) => [c.residente, c.modulo, c.fecha, c.tema || ""]));
  };

  return (
    <div>
      {/* Matriz de totales: residente × módulo */}
      <div style={{ overflowX: "auto", marginBottom: 14 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", background: "#fff", borderRadius: 14, overflow: "hidden", border: "1px solid #E2E8F0", fontSize: 11.5 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "8px 10px", background: "#F8FAFC", borderBottom: "2px solid #E2E8F0", borderRight: "1px solid #F1F5F9", fontWeight: 700, color: "#334155" }}>Residente</th>
              {MODULOS_CLASE.map((mo) => (
                <th key={mo} style={{ padding: "8px 6px", background: "#F8FAFC", borderBottom: "2px solid #E2E8F0", borderRight: "1px solid #F1F5F9", fontWeight: 700, color: "#7C2D12", whiteSpace: "nowrap" }}>{mo}</th>
              ))}
              <th style={{ padding: "8px 10px", background: "#F8FAFC", borderBottom: "2px solid #E2E8F0", fontWeight: 800, color: "#0F172A" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {ALL.map((n, i) => {
              const lv = COLOR[LEVEL[n]];
              const row = matriz[n];
              return (
                <tr key={n}>
                  <td style={{ padding: "7px 10px", borderBottom: i === ALL.length - 1 ? "none" : "1px solid #F1F5F9", borderRight: "1px solid #F1F5F9", fontWeight: 700, color: "#0F172A", whiteSpace: "nowrap" }}>
                    <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: lv.solid, color: "#fff", marginRight: 5 }}>{LEVEL[n]}</span>
                    {n}
                  </td>
                  {MODULOS_CLASE.map((mo) => (
                    <td key={mo} style={{ textAlign: "center", padding: "7px 6px", borderBottom: i === ALL.length - 1 ? "none" : "1px solid #F1F5F9", borderRight: "1px solid #F1F5F9", color: row[mo] > 0 ? "#7C2D12" : "#CBD5E1", fontWeight: row[mo] > 0 ? 700 : 500 }}>{row[mo] || 0}</td>
                  ))}
                  <td style={{ textAlign: "center", padding: "7px 10px", borderBottom: i === ALL.length - 1 ? "none" : "1px solid #F1F5F9", fontWeight: 800, color: row.total > 0 ? "#0F172A" : "#CBD5E1" }}>{row.total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 12, marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>RESIDENTE</div>
            <select value={residente} onChange={(e) => setResidente(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {ALL.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>MÓDULO</div>
            <select value={modulo} onChange={(e) => setModulo(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {MODULOS_CLASE.map((mo) => <option key={mo} value={mo}>{mo}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>FECHA</div>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>TEMA (OPCIONAL)</div>
            <input value={tema} onChange={(e) => setTema(e.target.value)} placeholder="Título de la clase…" style={{ width: "100%", fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", boxSizing: "border-box" }} />
          </div>
          <button onClick={agregar} disabled={saving} style={{ background: "#7C2D12", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1 }}>
            + Agregar clase
          </button>
        </div>
      )}

      {isAdmin && lista.length > 0 && (
        <button onClick={exportar} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "#64748B", padding: "2px 2px", marginBottom: 8 }}>
          ⬇️ Exportar CSV
        </button>
      )}

      {lista.length === 0 ? (
        <div style={{ textAlign: "center", padding: "30px 20px", color: "#94A3B8", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
          🎓 Todavía no hay clases ni presentaciones registradas.
        </div>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
          {lista.map((c, i) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i === lista.length - 1 ? "none" : "1px solid #F1F5F9", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#7C2D12", background: "#FFF7ED", border: "1px solid #FED7AA", borderRadius: 6, padding: "2px 7px", minWidth: 42, textAlign: "center" }}>{fechaCorta(c.fecha)}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A", minWidth: 60 }}>{c.residente}</span>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: "#7C2D12", background: "#FFF7ED", borderRadius: 999, padding: "2px 9px" }}>{c.modulo}</span>
              {c.tema && <span style={{ fontSize: 11.5, color: "#64748B", flex: 1 }}>{c.tema}</span>}
              {isAdmin && (
                confirmId === c.id ? (
                  <span style={{ display: "flex", gap: 4 }}>
                    <button onClick={() => eliminar(c.id)} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Sí, borrar</button>
                    <button onClick={() => setConfirmId(null)} style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", background: "#F1F5F9", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmId(c.id)} title="Eliminar" style={{ background: "none", border: "none", color: "#CBD5E1", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>🗑️</button>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MonthRow({ label, items, ESTADO_META, confirmId, setConfirmId, eliminar, lastRow }) {
  const [open, setOpen] = useState(false);
  const hayRegion = items.some((p) => p.nota);
  return (
    <div style={{ borderBottom: lastRow ? "none" : "1px solid #F1F5F9" }}>
      <button onClick={() => setOpen((v) => !v)} disabled={!hayRegion && !eliminar} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "#fff", border: "none", cursor: hayRegion || eliminar ? "pointer" : "default", fontFamily: "inherit", padding: "8px 14px 8px 32px", textAlign: "left" }}>
        <span style={{ display: "inline-block", width: 10, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 9, color: hayRegion || eliminar ? "#CBD5E1" : "transparent" }}>▶</span>
        <span style={{ fontSize: 12.5, color: "#334155", flex: 1, textTransform: "capitalize" }}>{label}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#0F766E", background: "#F0FDFA", border: "1px solid #99F6E4", borderRadius: 999, padding: "1px 9px", minWidth: 20, textAlign: "center" }}>{items.length}</span>
      </button>
      {open && (
        <div style={{ padding: "0 14px 8px 52px", display: "flex", flexDirection: "column", gap: 4 }}>
          {items.map((p) => {
            const em = ESTADO_META[p.estado] || ESTADO_META.pendiente;
            return (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }}>
                <span style={{ color: "#94A3B8", minWidth: 34 }}>{fechaCorta(p.fecha)}</span>
                <span style={{ color: p.nota ? "#475569" : "#CBD5E1", fontStyle: p.nota ? "normal" : "italic", flex: 1 }}>{p.nota || "sin región"}</span>
                <span style={{ fontSize: 9.5, fontWeight: 700, color: em.color, background: em.bg, borderRadius: 999, padding: "1px 7px" }}>{em.label}</span>
                {eliminar && (
                  confirmId === p.id ? (
                    <span style={{ display: "flex", gap: 3 }}>
                      <button onClick={() => eliminar(p.id)} style={{ fontSize: 9.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 5, padding: "2px 7px", cursor: "pointer", fontFamily: "inherit" }}>Sí</button>
                      <button onClick={() => setConfirmId(null)} style={{ fontSize: 9.5, fontWeight: 700, color: "#64748B", background: "#F1F5F9", border: "none", borderRadius: 5, padding: "2px 7px", cursor: "pointer", fontFamily: "inherit" }}>×</button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmId(p.id)} title="Eliminar" style={{ background: "none", border: "none", color: "#CBD5E1", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>🗑️</button>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TipoGroup({ tipo, items, ESTADO_META, confirmId, setConfirmId, eliminar, lastGroup }) {
  const [open, setOpen] = useState(false);
  const meses = useMemo(() => agruparPorMes(items), [items]);
  return (
    <div style={{ borderBottom: lastGroup ? "none" : "1px solid #F1F5F9" }}>
      <button onClick={() => setOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "#F8FAFC", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "7px 14px", textAlign: "left" }}>
        <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 9.5, color: "#94A3B8" }}>▶</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: "#0F766E", flex: 1 }}>{tipo}</span>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8" }}>({items.length})</span>
      </button>
      {open && meses.map((m, i) => (
        <MonthRow
          key={m.clave}
          label={m.label}
          items={m.items}
          ESTADO_META={ESTADO_META}
          confirmId={confirmId}
          setConfirmId={setConfirmId}
          eliminar={eliminar}
          lastRow={i === meses.length - 1}
        />
      ))}
    </div>
  );
}

function ResidentProcAccordion({ residente, procs, procList, ESTADO_META, confirmId, setConfirmId, eliminar, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const grupos = useMemo(() => agruparPorTipo(procs, procList), [procs, procList]);

  return (
    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <button onClick={() => setOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "10px 14px", textAlign: "left" }}>
          <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 11, color: "#94A3B8" }}>▶</span>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A", flex: 1 }}>{residente}</span>
          <span style={{ fontSize: 11, fontWeight: 800, color: procs.length > 0 ? "#0F766E" : "#CBD5E1", background: procs.length > 0 ? "#F0FDFA" : "#F8FAFC", borderRadius: 999, padding: "1px 9px", minWidth: 22, textAlign: "center" }}>{procs.length}</span>
        </button>
        {procs.length > 0 && (
          <button onClick={() => descargarPDFProcedimientos(residente, grupos)} title="Descargar registro en PDF" style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 700, color: "#64748B", padding: "8px 14px" }}>
            ⬇️ PDF
          </button>
        )}
      </div>
      {open && (
        <div style={{ borderTop: "1px solid #F1F5F9" }}>
          {procs.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "#94A3B8", fontStyle: "italic", padding: "10px 14px" }}>Sin procedimientos cargados.</div>
          ) : (
            grupos.map((g, gi) => (
              <TipoGroup
                key={g.tipo}
                tipo={g.tipo}
                items={g.items}
                ESTADO_META={ESTADO_META}
                confirmId={confirmId}
                setConfirmId={setConfirmId}
                eliminar={eliminar}
                lastGroup={gi === grupos.length - 1}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ProcedimientosSection({ procedimientos, procList, isAdmin, user, misResidente }) {
  const [tipo, setTipo] = useState(procList[0] || "");
  const [fecha, setFecha] = useState(() => isoDate(new Date()));
  const [nota, setNota] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingList, setEditingList] = useState(false);
  const [nuevoProc, setNuevoProc] = useState("");
  const [confirmId, setConfirmId] = useState(null);

  useEffect(() => { if (!procList.includes(tipo)) setTipo(procList[0] || ""); }, [procList]); // eslint-disable-line

  const enviar = async () => {
    if (!misResidente || !tipo || !fecha || saving) return;
    setSaving(true);
    try {
      await setDoc(doc(collection(db, "procedimientos")), {
        residente: misResidente, tipo, fecha, nota: nota.trim(),
        estado: "pendiente", creadoPor: user?.email || "", creadoEn: new Date().toISOString(),
        revisadoPor: null, revisadoEn: null,
      });
      setNota("");
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const revisar = async (id, estado) => {
    try { await setDoc(doc(db, "procedimientos", id), { estado, revisadoPor: user?.email || "", revisadoEn: new Date().toISOString() }, { merge: true }); } catch (e) { console.error(e); }
  };

  const eliminar = async (id) => {
    try { await deleteDoc(doc(db, "procedimientos", id)); } catch (e) { console.error(e); }
    setConfirmId(null);
  };

  const agregarAlaLista = async () => {
    const v = nuevoProc.trim();
    if (!v || procList.includes(v)) { setNuevoProc(""); return; }
    try { await setDoc(doc(db, "scheduler", "registro-config"), { procedimientosList: [...procList, v] }, { merge: true }); } catch (e) { console.error(e); }
    setNuevoProc("");
  };

  const sacarDeLaLista = async (v) => {
    try { await setDoc(doc(db, "scheduler", "registro-config"), { procedimientosList: procList.filter((p) => p !== v) }, { merge: true }); } catch (e) { console.error(e); }
  };

  const mios = useMemo(() => procedimientos.filter((p) => p.residente === misResidente), [procedimientos, misResidente]);
  const misGrupos = useMemo(() => agruparPorTipo(mios, procList), [mios, procList]);
  const pendientes = useMemo(() => procedimientos.filter((p) => p.estado === "pendiente").sort((a, b) => (a.fecha || "").localeCompare(b.fecha || "")), [procedimientos]);
  const aprobados = useMemo(() => procedimientos.filter((p) => p.estado === "aprobado"), [procedimientos]);

  const porResidente = useMemo(() => {
    const g = {};
    procedimientos.forEach((p) => { (g[p.residente] = g[p.residente] || []).push(p); });
    return g;
  }, [procedimientos]);
  const residentesConDatos = useMemo(() => ALL.filter((n) => porResidente[n]?.length), [porResidente]);

  const totalesAprobados = useMemo(() => {
    const t = {};
    aprobados.forEach((p) => { t[p.residente] = (t[p.residente] || 0) + 1; });
    return t;
  }, [aprobados]);

  const ESTADO_META = {
    pendiente: { label: "Pendiente", color: "#B45309", bg: "#FFFBEB" },
    aprobado: { label: "Aprobado", color: "#15803D", bg: "#F0FDF4" },
    rechazado: { label: "Rechazado", color: "#B91C1C", bg: "#FEF2F2" },
  };

  const exportar = () => {
    downloadCSV("procedimientos.csv", ["Residente", "Procedimiento", "Fecha", "Estado", "Nota"], procedimientos.map((p) => [p.residente, p.tipo, p.fecha, ESTADO_META[p.estado]?.label || p.estado, p.nota || ""]));
  };

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {ALL.map((n) => {
          const c = totalesAprobados[n] || 0;
          const lv = COLOR[LEVEL[n]];
          return (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 9, background: "#fff", border: "1px solid #E2E8F0" }}>
              <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: lv.solid, color: "#fff" }}>{LEVEL[n]}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>{n}</span>
              <span style={{ fontSize: 12, fontWeight: 800, color: c > 0 ? "#0F766E" : "#CBD5E1", background: c > 0 ? "#F0FDFA" : "#F8FAFC", borderRadius: 999, padding: "1px 8px", minWidth: 18, textAlign: "center" }}>{c}</span>
            </div>
          );
        })}
      </div>

      {misResidente ? (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 12, marginBottom: 14 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "#0F766E", marginBottom: 8 }}>Cargar procedimiento propio ({misResidente})</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>PROCEDIMIENTO</div>
              <select value={tipo} onChange={(e) => setTipo(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", maxWidth: 240 }}>
                {procList.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>FECHA</div>
              <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", marginBottom: 3 }}>NOTA (OPCIONAL)</div>
              <input value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Detalle…" style={{ width: "100%", fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", boxSizing: "border-box" }} />
            </div>
            <button onClick={enviar} disabled={saving || !tipo} style={{ background: "#0F766E", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1 }}>
              + Enviar para aprobar
            </button>
          </div>
        </div>
      ) : (
        !isAdmin && (
          <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "6px 10px", marginBottom: 14 }}>
            Tu cuenta de Google todavía no está vinculada a ningún residente — avisale al jefe de residentes para poder cargar tus procedimientos.
          </div>
        )
      )}

      {misResidente && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", flex: 1 }}>Mis procedimientos</div>
            {mios.length > 0 && (
              <button onClick={() => descargarPDFProcedimientos(misResidente, misGrupos)} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 700, color: "#64748B" }}>
                ⬇️ Descargar PDF
              </button>
            )}
          </div>
          {mios.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "#94A3B8", fontStyle: "italic", padding: "4px 2px" }}>Todavía no cargaste ninguno.</div>
          ) : (
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
              {misGrupos.map((g, gi) => (
                <TipoGroup
                  key={g.tipo}
                  tipo={g.tipo}
                  items={g.items}
                  ESTADO_META={ESTADO_META}
                  lastGroup={gi === misGrupos.length - 1}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {pendientes.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>Pendientes de aprobar ({pendientes.length})</div>
          <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
            {pendientes.map((p, i) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i === pendientes.length - 1 ? "none" : "1px solid #F1F5F9", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 6, padding: "2px 7px", minWidth: 42, textAlign: "center" }}>{fechaCorta(p.fecha)}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A", minWidth: 60 }}>{p.residente}</span>
                <span style={{ fontSize: 12.5, color: "#334155", flex: 1 }}>{p.tipo}{p.nota ? ` — ${p.nota}` : ""}</span>
                {isAdmin && (
                  <>
                    <button onClick={() => revisar(p.id, "aprobado")} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#16A34A", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>✓ Aprobar</button>
                    <button onClick={() => revisar(p.id, "rechazado")} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>✗ Rechazar</button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <button onClick={exportar} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "#64748B", padding: "2px 2px", marginBottom: 8 }}>
        ⬇️ Exportar todo a CSV
      </button>

      <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 8, marginTop: 4 }}>Historial por residente</div>
      {residentesConDatos.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "#94A3B8", fontStyle: "italic", padding: "4px 2px", marginBottom: 18 }}>Todavía no hay procedimientos cargados.</div>
      ) : (
        <div style={{ marginBottom: 18 }}>
          {residentesConDatos.map((n) => (
            <ResidentProcAccordion
              key={n}
              residente={n}
              procs={porResidente[n] || []}
              procList={procList}
              ESTADO_META={ESTADO_META}
              confirmId={confirmId}
              setConfirmId={setConfirmId}
              eliminar={isAdmin ? eliminar : null}
            />
          ))}
        </div>
      )}

      {isAdmin && (
        <>
          <button onClick={() => setEditingList((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "#64748B", padding: "2px 2px", marginBottom: 8 }}>
            <span style={{ display: "inline-block", transform: editingList ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span> Editar lista de procedimientos
          </button>
          {editingList && (
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 12 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                {procList.map((p) => (
                  <div key={p} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 5px 4px 10px", borderRadius: 8, background: "#F1F5F9", fontSize: 11.5, color: "#334155", fontWeight: 600 }}>
                    {p}
                    <button onClick={() => sacarDeLaLista(p)} style={{ background: "none", border: "none", color: "#94A3B8", cursor: "pointer", fontSize: 13, fontFamily: "inherit", lineHeight: 1 }}>×</button>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input value={nuevoProc} onChange={(e) => setNuevoProc(e.target.value)} placeholder="Nuevo procedimiento…" onKeyDown={(e) => e.key === "Enter" && agregarAlaLista()} style={{ flex: 1, fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
                <button onClick={agregarAlaLista} style={{ background: "#0F766E", color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>+ Agregar</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ══════════════════ ¿QUIÉN ESTÁ HOY? (vista pública, sin login) ══════════════════ */

// Convierte un Date de JS (donde domingo = 0) al índice usado en DAYS y en
// week.days (donde lunes = 0 … domingo = 6), para poder leer el día
// correcto dentro del documento semanal que ya arma SchedulerView.
function diOfDate(d) {
  return (d.getDay() + 6) % 7;
}

// Deja solo los dígitos de un teléfono cargado a mano, para armar el link de
// wa.me (que no acepta espacios, guiones ni el signo +).
function limpiarTelefono(raw) {
  return (raw || "").replace(/[^\d]/g, "");
}

// Se usa en dos lugares con el MISMO componente: como pestaña "¿Quién está
// hoy?" dentro de la app logueada (embedded=true, con controles de edición
// si isAdmin) y como el contenido completo de la ruta pública /hoy
// (embedded=false, isAdmin siempre false, sin ningún control de edición —
// ver Root() más arriba, que ni siquiera monta el login para esa ruta).
// Muestra el día actual y el siguiente, hasta Postguardia inclusive (no
// incluye Observaciones ni Recordatorios del calendario semanal — esta
// pantalla tiene su propio campo de observaciones, independiente).
// Cuánto tiempo se guarda el teléfono de un "invitado" (alguien de guardia
// que escribieron en el texto libre y que no es ninguno de los 12
// residentes — ej. un médico de planta cubriendo, o un nombre suelto) antes
// de descartarse solo, para no ir acumulando contactos viejos para siempre.
const INVITADO_VIGENCIA_MS = 15 * 24 * 60 * 60 * 1000; // 15 días

// El texto de "De guardia" es libre (lo escribe el admin a mano en el
// calendario semanal), pero en la práctica siempre termina siendo una lista
// de nombres separados por coma — los mismos nombres que ya aparecen como
// chips en UTI 1/2/3 y Postguardia. Esta función intenta reconocer cada
// nombre contra la lista de residentes (por nombre corto o por el nombre
// público completo, sin importar mayúsculas) para poder mostrarlo como chip
// clickeable igual que los demás; lo que no matchea con ningún residente
// queda marcado como "invitado" (chip gris, sin nivel R2/R3/R4).
function parseDeGuardia(lista) {
  // Tolera tanto el array actual como el texto libre separado por comas de las
  // semanas viejas, por si alguna todavía no pasó por normalize().
  const nombres = Array.isArray(lista)
    ? lista
    : String(lista || "").split(",").map((s) => s.trim()).filter(Boolean);
  return nombres.map((raw) => {
    const bajo = String(raw).trim().toLowerCase();
    const residente = ALL.find((n) => n.toLowerCase() === bajo || nombrePublico(n).toLowerCase() === bajo);
    if (residente) return { tipo: "residente", key: residente, nombre: nombrePublico(residente) };
    return { tipo: "invitado", key: bajo, nombre: String(raw).trim() };
  });
}

function QuienEstaHoyView({ isAdmin, embedded }) {
  const hoy = useMemo(() => new Date(), []);
  const manana = useMemo(() => shift(hoy, 1), [hoy]);
  const mondayHoy = useMemo(() => mondayOf(hoy), [hoy]);
  const mondayManana = useMemo(() => mondayOf(manana), [manana]);
  const idHoy = isoDate(mondayHoy);
  const idManana = isoDate(mondayManana);
  const mismaSemana = idHoy === idManana;

  const [weekHoy, setWeekHoy] = useState(null);
  const [weekManana, setWeekManana] = useState(null);
  const [telefonosDoc, setTelefonosDoc] = useState({ numeros: {}, invitados: {} });
  const [nota, setNota] = useState("");
  const [loading, setLoading] = useState(true);

  const [openPerson, setOpenPerson] = useState(null); // { tipo, key, nombre }
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [editingNota, setEditingNota] = useState(false);
  const [notaDraft, setNotaDraft] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const ref = doc(db, "scheduler", `week-${idHoy}`);
    const unsub = onSnapshot(ref, (snap) => { setWeekHoy(snap.exists() ? normalize(snap.data()) : emptyWeek()); setLoading(false); }, () => setLoading(false));
    return unsub;
  }, [idHoy]);

  useEffect(() => {
    if (mismaSemana) { setWeekManana(null); return; }
    const ref = doc(db, "scheduler", `week-${idManana}`);
    const unsub = onSnapshot(ref, (snap) => setWeekManana(snap.exists() ? normalize(snap.data()) : emptyWeek()), () => {});
    return unsub;
  }, [idManana, mismaSemana]);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "scheduler", "telefonos"), (snap) => {
      const d = snap.exists() ? snap.data() : {};
      setTelefonosDoc({ numeros: d.numeros || {}, invitados: d.invitados || {} });
    }, () => {});
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "scheduler", "quien-esta-hoy"), (snap) => setNota(snap.exists() && typeof snap.data().observaciones === "string" ? snap.data().observaciones : ""), () => {});
    return unsub;
  }, []);

  // Limpieza de invitados vencidos (>15 días): solo la dispara la sesión de
  // admin dentro de la app (nunca la ruta pública /hoy, para que un visitante
  // externo jamás escriba en Firestore). Si no hay nada vencido, no hace
  // ninguna escritura — así no repite el mismo trabajo en cada snapshot.
  useEffect(() => {
    if (!(embedded && isAdmin)) return;
    const invitados = telefonosDoc.invitados || {};
    const ahora = Date.now();
    const vigentes = {};
    let huboVencidos = false;
    Object.entries(invitados).forEach(([k, v]) => {
      const creado = v && v.creadoEn ? new Date(v.creadoEn).getTime() : NaN;
      if (!creado || ahora - creado > INVITADO_VIGENCIA_MS) { huboVencidos = true; return; }
      vigentes[k] = v;
    });
    if (huboVencidos) {
      setDoc(doc(db, "scheduler", "telefonos"), { invitados: vigentes }, { merge: true }).catch((e) => console.error("limpieza de invitados vencidos", e));
    }
  }, [telefonosDoc, embedded, isAdmin]);

  const diaHoy = weekHoy ? weekHoy.days[diOfDate(hoy)] : null;
  const diaManana = mismaSemana ? (weekHoy ? weekHoy.days[diOfDate(manana)] : null) : (weekManana ? weekManana.days[diOfDate(manana)] : null);

  const guardarTelefono = async (persona, valor) => {
    try {
      if (persona.tipo === "residente") {
        const nuevo = { ...(telefonosDoc.numeros || {}), [persona.key]: valor.trim() };
        await setDoc(doc(db, "scheduler", "telefonos"), { numeros: nuevo }, { merge: true });
      } else {
        const nuevo = { ...(telefonosDoc.invitados || {}), [persona.key]: { nombre: persona.nombre, telefono: valor.trim(), creadoEn: new Date().toISOString() } };
        await setDoc(doc(db, "scheduler", "telefonos"), { invitados: nuevo }, { merge: true });
      }
    } catch (e) { console.error(e); }
  };

  const guardarNota = async (valor) => {
    try { await setDoc(doc(db, "scheduler", "quien-esta-hoy"), { observaciones: valor.trim() }, { merge: true }); } catch (e) { console.error(e); }
  };

  const telefonoDe = (persona) => (persona.tipo === "residente" ? (telefonosDoc.numeros || {})[persona.key] : (telefonosDoc.invitados || {})[persona.key]?.telefono) || "";

  const abrirPersona = (persona) => { setOpenPerson(persona); setEditingPhone(false); setPhoneDraft(telefonoDe(persona)); };
  const cerrarPersona = () => { setOpenPerson(null); setEditingPhone(false); };

  const copiarLink = async () => {
    const url = `${window.location.origin}${PUBLIC_ROUTE_PATH}`;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2200); }
    catch (e) { window.prompt("Copiá el link:", url); }
  };

  return (
    <div style={{ minHeight: embedded ? "auto" : "100vh", background: embedded ? "transparent" : "#CBD5E1" }}>
      <div style={{ maxWidth: embedded ? "none" : 560, margin: embedded ? 0 : "0 auto", padding: embedded ? 0 : "14px 12px 40px", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>📱</span>
            <div><div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>¿Quién está en la UTI hoy?</div><div style={{ fontSize: 10.5, opacity: 0.55 }}>Hospital Británico</div></div>
          </div>
          <button onClick={copiarLink} style={{ ...NAV, width: "auto", padding: "6px 12px", fontSize: 11 }}>{copied ? "✓ Copiado" : "🔗 Copiar link"}</button>
        </div>

        {/* Pista discreta: sin esto no es obvio que los chips son tocables. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11.5, color: "#475569", marginBottom: 12 }}>
          <span style={{ fontSize: 12 }}>💬</span>
          <span style={{ fontStyle: "italic" }}>Presioná en el nombre para enviar un WhatsApp</span>
        </div>

        {loading ? <Skeleton /> : (
          <>
            {(nota.trim() || (embedded && isAdmin)) && (
              <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 12, padding: "10px 14px", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: "#B45309", letterSpacing: 0.4, textTransform: "uppercase" }}>📌 Observaciones</div>
                  {embedded && isAdmin && !editingNota && (
                    <button onClick={() => { setNotaDraft(nota); setEditingNota(true); }} style={{ background: "none", border: "none", color: "#B45309", fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{nota.trim() ? "✏️ Editar" : "+ Agregar"}</button>
                  )}
                </div>
                {editingNota ? (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                    <textarea value={notaDraft} onChange={(e) => setNotaDraft(e.target.value)} placeholder="Nota visible en esta pantalla, independiente de las Observaciones del calendario semanal…" style={{ ...TEXTAREA, minHeight: 60, background: "#fff" }} />
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button onClick={() => { guardarNota(notaDraft); setEditingNota(false); }} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓ Guardar</button>
                      <button onClick={() => setEditingNota(false)} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
                    </div>
                  </div>
                ) : nota.trim() ? (
                  <div style={{ fontSize: 12.5, color: "#78350F", lineHeight: 1.5, marginTop: 4, whiteSpace: "pre-wrap" }}>{nota}</div>
                ) : (
                  <div style={{ fontSize: 11.5, color: "#CBD5E1", fontStyle: "italic", marginTop: 4 }}>Sin observaciones cargadas.</div>
                )}
              </div>
            )}

            <DiaCard label="Hoy" emoji="🔵" fecha={hoy} dia={diaHoy} onPick={abrirPersona} />
            <DiaCard label="Mañana" emoji="🌙" fecha={manana} dia={diaManana} onPick={abrirPersona} />
          </>
        )}
      </div>

      {openPerson && (
        <PersonaModal
          persona={openPerson}
          telefono={telefonoDe(openPerson)}
          isAdmin={embedded && isAdmin}
          editing={editingPhone}
          draft={phoneDraft}
          onDraftChange={setPhoneDraft}
          onEdit={() => setEditingPhone(true)}
          onSave={() => { guardarTelefono(openPerson, phoneDraft); setEditingPhone(false); }}
          onCancelEdit={() => setEditingPhone(false)}
          onClose={cerrarPersona}
        />
      )}
    </div>
  );
}

function DiaCard({ label, emoji, fecha, dia, onPick }) {
  const di = diOfDate(fecha);
  const weekend = isWeekendIdx(di);
  const feriado = !!(dia && dia.feriado);
  // Un feriado se cubre igual que un fin de semana: sin camas fijas.
  const sinCamas = weekend || feriado;
  const fechaLabel = `${WEEKDAYS_FULL[fecha.getDay()]} ${fecha.getDate()} de ${MONTHS[fecha.getMonth()].toLowerCase()}`;

  if (!dia) {
    return (
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 16, marginBottom: 12, textAlign: "center", color: "#94A3B8", fontSize: 12.5 }}>
        {emoji} {label} — todavía no hay calendario cargado para esta semana.
      </div>
    );
  }

  return (
    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(15,23,42,.04)", overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "11px 16px", background: "#F8FAFC", borderBottom: "1px solid #F1F5F9", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: "#0F172A" }}>{emoji} {label}</div>
          <div style={{ fontSize: 10.5, color: "#94A3B8", marginTop: 1, textTransform: "capitalize" }}>{fechaLabel}</div>
        </div>
        {feriado
          ? <span style={{ fontSize: 9.5, fontWeight: 800, color: "#92400E", background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 999, padding: "2px 9px" }}>🎌 FERIADO</span>
          : weekend && <span style={{ fontSize: 9.5, fontWeight: 800, color: "#64748B", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 999, padding: "2px 9px" }}>FIN DE SEMANA</span>}
      </div>

      <div style={{ padding: "10px 16px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        <FilaDeGuardia lista={dia.deGuardia} onPick={onPick} />

        {sinCamas ? (
          <div style={{ fontSize: 11.5, color: "#94A3B8", fontStyle: "italic" }}>UTI 1, UTI 2 y UTI 3 no aplican {feriado ? "los feriados" : "los fines de semana"} — cobertura por guardia y postguardia.</div>
        ) : (
          SLOTS.filter((s) => s.key !== "postguardia").map((slot) => (
            <FilaResidentes key={slot.key} label={slot.label} color={slot.accent} nombres={dia[slot.key]} onPick={onPick} />
          ))
        )}

        <FilaResidentes label="Postguardia" color="#A855F7" nombres={dia.postguardia} onPick={onPick} />
      </div>
    </div>
  );
}

// La fila de "De guardia" es la más importante de la pantalla (es a quién
// hay que llamar primero), así que se destaca con una tarjeta propia en vez
// de ir mezclada con el resto — más contraste de color, borde e ícono más
// grande que las demás filas. Los nombres se parsean del texto libre del
// calendario (parseDeGuardia) para que también sean chips clickeables, con
// el mismo aspecto que los de UTI/Postguardia para los residentes
// reconocidos, y un chip gris aparte para cualquier nombre que no matchee
// con ningún residente (típicamente alguien cubriendo desde otro servicio).
function FilaDeGuardia({ lista, onPick }) {
  const personas = useMemo(() => parseDeGuardia(lista), [lista]);
  return (
    <div style={{ background: "#FFF1F2", border: "1.5px solid #FECDD3", borderRadius: 12, padding: "9px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 800, color: "#9F1239", letterSpacing: 0.4, textTransform: "uppercase" }}>
          <span style={{ fontSize: 13 }}>🌙</span> De guardia
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: "#BE586B" }}>(a partir de las 16:00 hs)</span>
      </div>
      {personas.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "#FDA4AF", fontStyle: "italic" }}>Sin cargar.</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {personas.map((p, i) => (
            <ChipPersona key={`${p.key}-${i}`} persona={p} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilaResidentes({ label, color, nombres, onPick }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 800, color, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 5 }}>{label}</div>
      {nombres && nombres.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {nombres.map((n) => (
            <ChipPersona key={n} persona={{ tipo: "residente", key: n, nombre: nombrePublico(n) }} onPick={onPick} />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: "#CBD5E1", fontStyle: "italic" }}>Sin asignar.</div>
      )}
    </div>
  );
}

// Chip chico y clickeable para una persona: coloreado por nivel (R2/R3/R4)
// si es un residente reconocido, o gris neutro si es un "invitado" que no
// matchea con ningún residente (ver parseDeGuardia). Más chico que los chips
// grandes del calendario semanal — acá lo que importa es poder tocarlo
// rápido desde el celular, no la lectura a distancia.
function ChipPersona({ persona, onPick }) {
  const esResidente = persona.tipo === "residente";
  const c = esResidente ? (COLOR[LEVEL[persona.key]] || COLOR.R2) : { bg: "#F1F5F9", bd: "#CBD5E1", tx: "#475569", solid: "#94A3B8" };
  return (
    <button onClick={() => onPick(persona)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 9px", borderRadius: 999, background: c.bg, border: `1.5px solid ${c.bd}`, color: c.tx, fontWeight: 700, fontSize: 11.5, cursor: "pointer", fontFamily: "inherit" }}>
      {persona.nombre}
      <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: c.solid, color: "#fff" }}>{esResidente ? LEVEL[persona.key] : "—"}</span>
    </button>
  );
}

function PersonaModal({ persona, telefono, isAdmin, editing, draft, onDraftChange, onEdit, onSave, onCancelEdit, onClose }) {
  const esResidente = persona.tipo === "residente";
  const c = esResidente ? (COLOR[LEVEL[persona.key]] || COLOR.R2) : { bg: "#F1F5F9", bd: "#CBD5E1", tx: "#475569", solid: "#94A3B8" };
  const limpio = limpiarTelefono(telefono);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "18px 18px 0 0", padding: "18px 20px 26px", width: "100%", maxWidth: 420, boxShadow: "0 -8px 30px rgba(15,23,42,.25)" }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "#E2E8F0", margin: "0 auto 14px" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 17, color: "#0F172A" }}>{persona.nombre}</div>
          <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4, background: c.solid, color: "#fff" }}>{esResidente ? LEVEL[persona.key] : "INVITADO/A"}</span>
        </div>

        {isAdmin && editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            <input value={draft} onChange={(e) => onDraftChange(e.target.value)} placeholder="Ej: 5491122334455 (con 549 adelante, sin espacios ni guiones)" style={{ ...INPUT, width: "100%", boxSizing: "border-box" }} />
            {!esResidente && <div style={{ fontSize: 10.5, color: "#94A3B8", lineHeight: 1.4 }}>Este contacto no es ninguno de los 12 residentes, así que se guarda solo 15 días y después se borra solo, para no acumular números viejos.</div>}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button onClick={onSave} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 7, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓ Guardar</button>
              <button onClick={onCancelEdit} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 7, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: 14 }}>
            {telefono ? (
              <div style={{ fontSize: 13, color: "#334155", fontWeight: 600 }}>📞 {telefono}</div>
            ) : (
              <div style={{ fontSize: 12.5, color: "#94A3B8", fontStyle: "italic" }}>Todavía no hay un teléfono cargado para {persona.nombre}.</div>
            )}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {limpio && !editing && (
            <a href={`https://wa.me/${limpio}`} target="_blank" rel="noopener noreferrer" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "#16A34A", color: "#fff", textDecoration: "none", borderRadius: 12, padding: "13px 16px", fontWeight: 700, fontSize: 14.5 }}>
              💬 Enviar WhatsApp
            </a>
          )}
          {isAdmin && !editing && (
            <button onClick={onEdit} style={{ background: "#F1F5F9", color: "#475569", border: "1px solid #E2E8F0", borderRadius: 12, padding: "11px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>✏️ {telefono ? "Editar teléfono" : "Agregar teléfono"}</button>
          )}
          <button onClick={onClose} style={{ background: "none", color: "#94A3B8", border: "none", padding: "8px 16px", fontWeight: 600, fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" }}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════ DÍAS LIBRES R4 ══════════════════ */

const DIAS_LIBRES_OPCIONES = ["Lunes", "Miércoles", "Viernes"];

function DiasLibresR4({ week, isAdmin, onChange }) {
  const any = RESIDENTS.R4.some((n) => week.diasLibresR4[n]);
  if (!isAdmin && !any) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, padding: "8px 12px", marginBottom: 10, borderRadius: 10, background: "#FFF7ED", border: "1px solid #FED7AA" }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "#9A3412" }}>🗓️ Días libres R4 esta semana:</span>
      {RESIDENTS.R4.map((n) => (
        <div key={n} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: "#7C2D12" }}>{n}</span>
          {isAdmin ? (
            <>
              <select className="no-print" value={week.diasLibresR4[n]} onChange={(e) => onChange(n, e.target.value)} style={{ fontSize: 11, padding: "2px 5px", borderRadius: 5, border: "1px solid #FDBA74", background: "#fff", color: "#7C2D12", fontFamily: "inherit" }}>
                <option value="">—</option>
                {DIAS_LIBRES_OPCIONES.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <span className="print-only" style={{ fontSize: 11, fontWeight: 700, background: "#FDBA74", color: "#7C2D12", padding: "1px 7px", borderRadius: 999 }}>{week.diasLibresR4[n] || "—"}</span>
            </>
          ) : (
            week.diasLibresR4[n] && <span style={{ fontSize: 11, fontWeight: 700, background: "#FDBA74", color: "#7C2D12", padding: "1px 7px", borderRadius: 999 }}>{week.diasLibresR4[n]}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/* ══════════════════ SCHEDULER HEADER ══════════════════ */

function SchedulerHeader({ monday, setMonday, status, menuOpen, setMenuOpen, onCopyPrev, onClear, onPrint, onFeriados, isAdmin }) {
  const S = { saving: { t: "Guardando…", c: "#CBD5E1", b: "rgba(255,255,255,.12)" }, saved: { t: "✓ Guardado", c: "#86EFAC", b: "rgba(34,197,94,.18)" }, error: { t: "⚠ Sin conexión", c: "#FCA5A5", b: "rgba(239,68,68,.18)" } }[status];
  return (
    <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22 }}>🏥</span>
        <div><div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Scheduler UTI</div><div style={{ fontSize: 10.5, opacity: 0.55, letterSpacing: 0.2 }}>Hospital Británico</div></div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={(e) => { e.stopPropagation(); setMonday(shift(monday, -7)); }} style={NAV}>◀</button>
        <div style={{ textAlign: "center", minWidth: 172 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{dm(monday)} — {dm(shift(monday, DAYS.length - 1))}</div>
          <input type="date" value={isoDate(monday)} onClick={(e) => e.stopPropagation()} onChange={(e) => e.target.value && setMonday(mondayOf(new Date(e.target.value + "T12:00:00")))} style={{ background: "rgba(255,255,255,.14)", border: "none", borderRadius: 6, color: "#fff", padding: "3px 7px", fontSize: 10.5, marginTop: 3, cursor: "pointer", fontFamily: "inherit" }} />
        </div>
        <button onClick={(e) => { e.stopPropagation(); setMonday(shift(monday, 7)); }} style={NAV}>▶</button>
        <button onClick={(e) => { e.stopPropagation(); setMonday(mondayOf(new Date())); }} style={{ ...NAV, width: "auto", padding: "6px 11px", fontSize: 11, fontWeight: 600 }}>Hoy</button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
        {S && <div style={{ fontSize: 10.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: S.b, color: S.c }}>{S.t}</div>}
        {isAdmin && <button onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }} style={{ ...NAV, width: "auto", padding: "6px 10px" }}>⋯</button>}
        {menuOpen && isAdmin && (
          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, background: "#fff", borderRadius: 10, boxShadow: "0 10px 30px rgba(15,23,42,.22)", border: "1px solid #E2E8F0", overflow: "hidden", zIndex: 40, minWidth: 210 }}>
            <MenuItem onClick={onCopyPrev}>📋 Copiar semana anterior</MenuItem>
            <MenuItem onClick={onFeriados}>🎌 Marcar feriado</MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); onPrint(); }}>🖨️ Imprimir / PDF</MenuItem>
            <MenuItem onClick={onClear} danger>🗑️ Vaciar semana</MenuItem>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════ COMPONENTES COMPARTIDOS ══════════════════ */

const MenuItem = ({ children, onClick, danger }) => (<button onClick={onClick} style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", border: "none", background: "transparent", fontSize: 12.5, fontFamily: "inherit", cursor: "pointer", color: danger ? "#DC2626" : "#334155", fontWeight: 500 }} onMouseEnter={(e) => (e.currentTarget.style.background = danger ? "#FEF2F2" : "#F8FAFC")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>{children}</button>);

const Banner = ({ tone, children }) => { const c = tone === "warn" ? { bg: "#FEF2F2", bd: "#FECACA", tx: "#991B1B", icon: "⛔" } : { bg: "#EFF6FF", bd: "#BFDBFE", tx: "#1E40AF", icon: "👆" }; return (<div style={{ display: "flex", alignItems: "center", gap: 7, background: c.bg, border: `1px solid ${c.bd}`, color: c.tx, padding: "6px 12px", borderRadius: 9, fontSize: 12, fontWeight: 500 }}><span>{c.icon}</span><span>{children}</span></div>); };

const Corner = () => (<div style={{ background: "#F8FAFC", borderBottom: "2px solid #E2E8F0", borderRight: "2px solid #E2E8F0" }} />);

const DayHead = ({ name, date, isToday, isWeekend, feriado }) => (<div style={{ padding: "9px 4px", textAlign: "center", background: feriado ? "#FEF3C7" : isToday ? "#EFF6FF" : isWeekend ? "#F1F5F9" : "#F8FAFC", borderBottom: "2px solid #E2E8F0", borderRight: "1px solid #F1F5F9" }}><div style={{ fontWeight: 700, fontSize: 12.5, color: feriado ? "#92400E" : isToday ? "#1D4ED8" : isWeekend ? "#94A3B8" : "#0F172A" }}>{name}</div><div style={{ fontSize: 10.5, color: feriado ? "#B45309" : isToday ? "#3B82F6" : "#94A3B8", fontWeight: isToday ? 700 : 500 }}>{dm(date)}</div>{feriado && <div style={{ fontSize: 8, fontWeight: 800, color: "#92400E", background: "#FDE68A", borderRadius: 999, padding: "1px 6px", marginTop: 2, display: "inline-block", letterSpacing: 0.3 }}>🎌 FERIADO</div>}</div>);

const RowLabel = ({ label, color, sub, className }) => (<div className={className} style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end", textAlign: "right", padding: "8px 10px", background: "#F8FAFC", borderRight: "2px solid #E2E8F0", borderBottom: "2px solid #D1D5DB", borderTop: "2px solid #D1D5DB" }}><div style={{ fontWeight: 700, fontSize: 11, color, letterSpacing: 0.1 }}>{label}</div>{sub && <div style={{ fontSize: 8.5, color: "#94A3B8", marginTop: 1 }}>{sub}</div>}</div>);

const Cell = ({ children, onClick, tint, ring, pad = 4, lastCol, lastRow, className }) => (<div className={className} onClick={onClick} style={{ padding: pad, minHeight: 46, display: "flex", flexDirection: "column", gap: 3, background: tint, borderRight: lastCol ? "none" : "1px solid #F1F5F9", borderBottom: lastRow ? "none" : "1px solid #F1F5F9", boxShadow: ring ? `inset 0 0 0 1.5px ${ring}66` : "none", cursor: ring ? "pointer" : "default", transition: "background .12s, box-shadow .12s" }}>{children}</div>);

function Chip({ name, selected, onPick, onRemove }) {
  const lv = LEVEL[name]; const c = COLOR[lv];
  return (<div onClick={onPick} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3.5px 6px 3.5px 8px", borderRadius: 7, background: selected ? c.solid : c.bg, border: `1.5px solid ${selected ? c.solid : c.bd}`, color: selected ? "#fff" : c.tx, fontWeight: 600, fontSize: 11.5, cursor: "pointer", userSelect: "none", boxShadow: selected ? `0 0 0 3px ${c.solid}33` : "none", transition: "all .12s" }}>
    <span style={{ flex: 1, lineHeight: 1.3 }}>{name}</span>
    <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 3.5px", borderRadius: 3, background: selected ? "rgba(255,255,255,.28)" : c.solid, color: "#fff", letterSpacing: 0.2 }}>{lv}</span>
    {onRemove && <span onClick={onRemove} title="Quitar" style={{ fontSize: 11, lineHeight: 1, opacity: 0.45, cursor: "pointer", padding: "0 1px" }}>×</span>}
  </div>);
}

const OutChip = ({ name, onPick, selected }) => (<div onClick={onPick} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 7px", borderRadius: 6, background: selected ? "#94A3B8" : "#E2E8F0", border: `1.5px solid ${selected ? "#94A3B8" : "#CBD5E1"}`, color: selected ? "#fff" : "#64748B", fontSize: 10.5, fontWeight: 600, textDecoration: "line-through", cursor: "pointer", userSelect: "none" }}><span style={{ flex: 1 }}>{name}</span><span style={{ fontSize: 7.5, fontWeight: 800, background: "#94A3B8", color: "#fff", padding: "1px 3px", borderRadius: 2.5 }}>{LEVEL[name]}</span></div>);

const GhostHint = ({ color, name }) => (<div style={{ fontSize: 10, color, opacity: 0.75, fontStyle: "italic", textAlign: "center", padding: "1px 0" }}>+ {name}</div>);
const Dash = () => (<div style={{ color: "#CBD5E1", fontSize: 11, textAlign: "center", padding: "10px 0" }}>—</div>);
const Skeleton = () => (<div style={{ height: 460, borderRadius: 14, background: "linear-gradient(90deg,#F1F5F9 25%,#E2E8F0 50%,#F1F5F9 75%)", backgroundSize: "200% 100%", animation: "sk 1.2s infinite", display: "flex", alignItems: "center", justifyContent: "center", color: "#94A3B8", fontSize: 13 }}>Cargando…<style>{`@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style></div>);

const Legend = () => (<div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
  {Object.entries(COLOR).map(([lv, c]) => (<div key={lv} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748B", fontWeight: 500 }}><span style={{ width: 11, height: 11, borderRadius: 3.5, background: c.bg, border: `1.5px solid ${c.bd}` }} />{lv}</div>))}
  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748B", fontWeight: 500 }}><span style={{ width: 11, height: 11, borderRadius: 3.5, background: "#E9D5FF", border: "1.5px solid #D8B4FE" }} />Postguardia</div>
</div>);

/* ══════════════════ ESTILOS ══════════════════ */

const NAV = { background: "rgba(255,255,255,.14)", border: "none", borderRadius: 7, color: "#fff", padding: "6px 10px", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", lineHeight: 1.2 };

const INPUT = { padding: "6px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", background: "#fff", color: "#0F172A" };

const TEXTAREA = { width: "100%", minHeight: 52, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", background: "#fff", fontSize: 11.5, lineHeight: 1.45, color: "#1F2937", fontWeight: 500, fontFamily: "'Inter', system-ui, sans-serif", resize: "vertical", outline: "none", boxSizing: "border-box" };
