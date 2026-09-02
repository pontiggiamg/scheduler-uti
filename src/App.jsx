import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react";
import { db, auth, googleProvider } from "./firebase";
import { doc, onSnapshot, setDoc, getDoc, deleteDoc, increment, arrayUnion, collection, getDocs, query, orderBy } from "firebase/firestore";
import { signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";
import Lab, { isLabRoute } from "./Lab";

/* ══════════════════ CONFIGURACIÓN ══════════════════ */

const ADMIN_EMAIL = "pontiggiamg@gmail.com";

// Pestañas de nivel superior de la app. El orden por defecto se usa si todavía
// no hay nada guardado en Firestore (scheduler/ui-config); el admin puede
// reordenarlas arrastrando y ese orden se guarda ahí, compartido para todos.
const DEFAULT_TAB_ORDER = ["scheduler", "rotaciones", "pases", "paseapp", "chipa", "academico", "articulo", "registro", "hoy", "accesos", "impresiones"];
// La pestaña se llamaba "borradores" y pasó a llamarse "impresiones": lo que
// sale de ahí es definitivo salvo que se lo marque expresamente como borrador.
// El orden de pestañas guardado en Firestore puede tener todavía el nombre
// viejo, así que se traduce al leerlo en vez de pedirle a nadie que lo
// reordene de nuevo.
const TAB_RENOMBRADAS = { borradores: "impresiones" };
const TAB_META = {
  scheduler: { icon: "📅", label: "Semana" },
  rotaciones: { icon: "🔄", label: "Rotaciones y Vacaciones" },
  pases: { icon: "🛏️", label: "Pases" },
  // Pase App: el pase de guardia editable. Cada residente tiene su propia copia
  // guardada en su cuenta, así que la pestaña la ve cualquiera que entró a la
  // app, no solo la jefatura.
  paseapp: { icon: "🩺", label: "Pase App", tag: "Alpha" },
  // El 🥐 es el ícono de la pestaña y le corresponde a la chipa; el ✨ va pegado
  // a "Aura" en la etiqueta para que cada votación tenga su símbolo a la vista.
  chipa: { icon: "🥐", label: "Chipa y Aura ✨" },
  academico: { icon: "📚", label: "Calendario Académico" },
  articulo: { icon: "📄", label: "Artículo de la semana" },
  registro: { icon: "📋", label: "Registro" },
  hoy: { icon: "📱", label: "¿Quién está hoy?" },
  accesos: { icon: "🔐", label: "Accesos", soloAdmin: true },
  impresiones: { icon: "🖨️", label: "Ver cronogramas, guardias e Imprimir" },
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

// El jefe de residentes no es un residente más: no hace procedimientos, no
// vota la Chipa, no da clases del programa ni tiene cupo de guardias. Pero sí
// puede cubrir una sala cuando falta un superior o un inferior, así que existe
// como ficha propia en el calendario y nada más. Por eso ALL (los 12) y
// ASIGNABLES (los 12 + el jefe) son listas distintas: todo lo que es "carrera
// de residencia" usa ALL; solo la grilla usa ASIGNABLES.
const JEFE = "Gonzalo";
const ASIGNABLES = [...ALL, JEFE];

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
// Las estadísticas del servicio (guardias hechas y cobertura de sala) arrancan
// en septiembre de 2026. Lo anterior existió mientras se armaba la app y no
// representa cómo funciona el servicio, así que no se cuenta ni se muestra.
// El artículo de la semana, los procedimientos y el calendario académico NO se
// cortan: ahí el historial completo sí sirve.
const INICIO_ESTADISTICAS = "2026-09-01";
const MES_INICIO_ESTADISTICAS = { anio: 2026, mes: 8 };

const DEFAULT_REGISTRO_SUB_ORDER = ["tarde", "falta", "guardias_mes", "procedimientos", "cobertura", "clases"];
const REGISTRO_SUB_META = {
  tarde: { ...EVENTO_TIPOS.tarde },
  falta: { ...EVENTO_TIPOS.falta },
  guardias_mes: { label: "Guardias por residente", icon: "🌙", color: "#9F1239", bg: "#FFF1F2", bd: "#FECDD3" },
  procedimientos: { label: "Procedimientos", icon: "🩺", color: "#0F766E", bg: "#F0FDFA", bd: "#99F6E4" },
  cobertura: { label: "R2 y R3 que cubrieron sala post guardia o en rotación", icon: "🔁", color: "#1D4ED8", bg: "#EFF6FF", bd: "#BFDBFE" },
  clases: { label: "Cantidad de clases/presentaciones", icon: "🎓", color: "#7C2D12", bg: "#FFF7ED", bd: "#FED7AA" },
};

const LEVEL = {
  ...Object.fromEntries(Object.entries(RESIDENTS).flatMap(([lv, names]) => names.map((n) => [n, lv]))),
  [JEFE]: "JR",
};

const COLOR = {
  // Dorado para el jefe: bien lejos del azul/verde/naranja de los tres niveles,
  // para que se distinga de un vistazo que esa cobertura es una excepción.
  JR: { bg: "#FEF3C7", bd: "#FCD34D", tx: "#78350F", solid: "#D97706" },
  R2: { bg: "#DBEAFE", bd: "#93C5FD", tx: "#1E3A8A", solid: "#3B82F6" },
  R3: { bg: "#D1FAE5", bd: "#6EE7B7", tx: "#065F46", solid: "#10B981" },
  R4: { bg: "#FFEDD5", bd: "#FDBA74", tx: "#9A3412", solid: "#F97316" },
};

/* ── Pantalla chica ────────────────────────────────────────────────────────
   La app se usa sobre todo desde el celular, parado, con una mano y en
   vertical. Este hook dice si estamos en esa situación para que cada pantalla
   pueda cambiar de forma —no sólo achicarse— cuando el ancho no alcanza.

   El corte en 640 px es el habitual: por debajo entra un celular en vertical;
   por encima, uno apaisado, una tablet o la PC. Se escucha el resize porque
   girar el teléfono no recarga la página. */
const PA_CORTE_CEL = 640;
function useChico(corte = PA_CORTE_CEL) {
  const [chico, setChico] = useState(
    typeof window !== "undefined" ? window.innerWidth < corte : false);
  useEffect(() => {
    const onResize = () => setChico(window.innerWidth < corte);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, [corte]);
  return chico;
}

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
// La fila de guardia no es un slot de sala pero necesita sus mismos colores.
const FILA_GUARDIA = { accent: "#9F1239", tint: "#FFF1F2", rotulo: "#FECDD3" };

const SLOT_KEYS = SLOTS.map((s) => s.key);

// Orden en que se muestran los chips dentro de una celda: del más senior al
// menos. Ojo con el detalle que hacía que los R4 aparecieran últimos: si el
// primer nivel vale 0, un `order[x] || 9` lo convierte en 9 porque el cero es
// falsy en JavaScript. Por eso se usa ?? y no ||.
const ORDEN_JERARQUIA = { JR: 0, R4: 1, R3: 2, R2: 3 };
const porJerarquia = (a, b) => (ORDEN_JERARQUIA[LEVEL[a]] ?? 9) - (ORDEN_JERARQUIA[LEVEL[b]] ?? 9);


// "Skin" del jefe de residentes: degradado dorado con brillo diagonal, para
// que su ficha se distinga al instante de las de los tres niveles. Se aplica
// encima del estilo normal del chip, así el resto del layout no cambia.
const SKIN_JR = {
  background: "linear-gradient(115deg,#7C2D12 0%,#B45309 32%,#D97706 50%,#B45309 68%,#7C2D12 100%)",
  borderColor: "#FCD34D",
  color: "#FFFBEB",
  textShadow: "0 1px 2px rgba(69,26,3,.75)",
  boxShadow: "0 0 0 1px rgba(252,211,77,.5), 0 2px 7px rgba(120,53,15,.45)",
};



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
    // que se guarde esa semana ya queda como array. De paso se canoniza cada
    // nombre al del residente correspondiente (ver canonizarGuardia), para que
    // "Daniel" y "Dani" no cuenten como dos personas distintas.
    day.deGuardia = normalizarListaGuardia(
      Array.isArray(d.deGuardia)
        ? d.deGuardia.filter((n) => typeof n === "string")
        : typeof d.deGuardia === "string"
          ? d.deGuardia.split(",")
          : []
    );
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

// Los nombres de guardia se escribieron históricamente a mano, así que la
// misma persona puede aparecer como "Dani" (nombre corto interno) o "Daniel"
// (nombre público). Esto resuelve cualquiera de las dos formas al residente
// real; devuelve null si es alguien de afuera.
function resolverResidente(raw) {
  const bajo = String(raw || "").trim().toLowerCase();
  if (!bajo) return null;
  return ASIGNABLES.find((n) => n.toLowerCase() === bajo || nombrePublico(n).toLowerCase() === bajo) || null;
}

// Guarda siempre el nombre corto cuando se trata de un residente. Es clave
// para poder contar guardias por persona: si un día quedó escrito "Daniel" y
// otro "Dani", serían dos personas distintas al sumar.
const canonizarGuardia = (raw) => resolverResidente(raw) || String(raw || "").trim();

function normalizarListaGuardia(lista) {
  const vistos = new Set();
  const out = [];
  (lista || []).forEach((raw) => {
    const n = canonizarGuardia(raw);
    if (!n) return;
    const clave = n.toLowerCase();
    if (vistos.has(clave)) return;
    vistos.add(clave);
    out.push(n);
  });
  return out;
}

/* ══════════════════ MODELO ROTACIONES ══════════════════ */

// `vacaciones` es un array de nombres, separado del texto libre de `notes`.
// Las notas siguen sirviendo para el detalle ("3 primeras semanas", "vacaciones
// de invierno"), pero para poder marcar a alguien como no disponible hace falta
// un dato estructurado: adivinar nombres dentro de una nota en prosa se rompe
// en cuanto alguien escribe algo como "Chris cubre las vacaciones de Ulloa".
const emptyRotYear = () => { const m = {}; for (let i = 0; i < 12; i++) m[i] = { assignments: [], notes: "", vacaciones: [], semanasLibres: { navidad: [], anioNuevo: [] } }; return { months: m }; };

function normalizeRot(raw) {
  const year = emptyRotYear();
  if (!raw || typeof raw !== "object" || !raw.months) return year;
  for (let i = 0; i < 12; i++) {
    const m = raw.months[i];
    if (m) {
      year.months[i].assignments = Array.isArray(m.assignments)
        ? m.assignments.map((a) => ({ resident: a.resident, place: a.place, exterior: a.exterior === true }))
        : [];
      year.months[i].notes = typeof m.notes === "string" ? m.notes : "";
      // Migración: antes era un array de nombres sueltos. Un nombre suelto
      // pasa a ser "todo el mes", que es lo que significaba entonces.
      year.months[i].vacaciones = Array.isArray(m.vacaciones)
        ? m.vacaciones
            .map((v) => (typeof v === "string" ? { nombre: v, tramo: "mes" } : { nombre: v.nombre, tramo: v.tramo || "mes" }))
            .filter((v) => LEVEL[v.nombre])
        : [];
      // Solo se usa en diciembre: quién queda libre la semana de Navidad y
      // quién la de Año nuevo. Por ahora es puramente informativo — todavía no
      // deja a nadie fuera de la grilla.
      const sl = m.semanasLibres || {};
      year.months[i].semanasLibres = {
        navidad: Array.isArray(sl.navidad) ? sl.navidad.filter((n) => LEVEL[n]) : [],
        anioNuevo: Array.isArray(sl.anioNuevo) ? sl.anioNuevo.filter((n) => LEVEL[n]) : [],
      };
    }
  }
  return year;
}

// Las semanas del mes, por criterio de mayoría: una semana "es" de este mes si
// al menos 4 de sus 7 días caen en él. Hace falta porque las semanas cruzan
// meses — septiembre 2026 arranca un martes, así que mirar solo el lunes
// dejaría afuera la primera semana entera.
function lunesDelMes(anio, mes) {
  const diasDelMes = (l) => {
    let n = 0;
    for (let i = 0; i < DAYS.length; i++) { const d = shift(l, i); if (d.getMonth() === mes && d.getFullYear() === anio) n++; }
    return n;
  };
  const out = [];
  let cur = mondayOf(new Date(anio, mes, 1));
  const fin = new Date(anio, mes + 1, 0);
  while (cur <= fin) { if (diasDelMes(cur) >= 4) out.push(new Date(cur)); cur = shift(cur, 7); }
  return out;
}

// Todas las semanas que TOCAN el mes, aunque sea por un día. Distinto de
// lunesDelMes, que usa el criterio de mayoría para decidir a qué mes
// pertenece cada semana: eso sirve para los equipos o el día libre, pero para
// imprimir un calendario hay que mostrar el mes completo. Si no, un mes que
// termina martes se queda sin sus últimos días.
function lunesQueTocanElMes(anio, mes) {
  const out = [];
  let cur = mondayOf(new Date(anio, mes, 1));
  const fin = new Date(anio, mes + 1, 0);
  while (cur <= fin) { out.push(new Date(cur)); cur = shift(cur, 7); }
  return out;
}

// Los R4 se toman el mes entero; los R2 y R3, tres semanas seguidas que pueden
// arrancar la primera o la segunda semana del mes.
// Verano: mes entero (R4) o tres semanas seguidas (R2 y R3).
// Invierno: una sola semana, la que corresponda del mes.
const TRAMOS_VACACIONES = {
  mes: { label: "Todo el mes", corto: "mes", tipo: "verano", semanas: null },
  "1-3": { label: "1ª a 3ª semana", corto: "1ª-3ª", tipo: "verano", semanas: [0, 1, 2] },
  "2-4": { label: "2ª a 4ª semana", corto: "2ª-4ª", tipo: "verano", semanas: [1, 2, 3] },
  "inv-1": { label: "Primera semana", corto: "1ª sem", tipo: "invierno", semanas: [0] },
  "inv-2": { label: "Segunda semana", corto: "2ª sem", tipo: "invierno", semanas: [1] },
  "inv-3": { label: "Tercera semana", corto: "3ª sem", tipo: "invierno", semanas: [2] },
  "inv-4": { label: "Cuarta semana", corto: "4ª sem", tipo: "invierno", semanas: [3] },
};
const tramoPorDefecto = (nombre) => (LEVEL[nombre] === "R4" ? "mes" : "1-3");
// Texto para los avisos: "de vacaciones de invierno (primera semana)".
const textoTramo = (t) => `de vacaciones de ${t.tipo} (${t.label.toLowerCase()})`;

// ¿Está esta persona de vacaciones ese día? Hay que mirar dos meses: el del
// propio día y el de la semana a la que pertenece, porque no siempre coinciden
// (el 31 de agosto cae en una semana que es de septiembre).
function vacacionesEseDia(name, fecha, rotPorAnio) {
  const candidatos = new Map();
  candidatos.set(`${fecha.getFullYear()}-${fecha.getMonth()}`, [fecha.getFullYear(), fecha.getMonth()]);
  const [ys, ms] = mesDeLaSemana(mondayOf(fecha)).split("-").map(Number);
  candidatos.set(`${ys}-${ms - 1}`, [ys, ms - 1]);

  for (const [anio, mes] of candidatos.values()) {
    const rotAnio = rotPorAnio[anio];
    if (!rotAnio) continue;
    const datosMes = rotAnio.months[mes];
    if (!datosMes) continue;
    const v = (datosMes.vacaciones || []).find((x) => x.nombre === name);
    if (!v) continue;
    const tramo = TRAMOS_VACACIONES[v.tramo] || TRAMOS_VACACIONES.mes;
    if (!tramo.semanas) {
      if (fecha.getMonth() === mes && fecha.getFullYear() === anio) return tramo;
      continue;
    }
    const lista = lunesDelMes(anio, mes);
    const idx = lista.findIndex((l) => isoDate(l) === isoDate(mondayOf(fecha)));
    if (idx >= 0 && tramo.semanas.includes(idx)) return tramo;
  }
  return null;
}

// ── Semanas libres de Navidad y Año nuevo ─────────────────────────────────
// A fin de año el servicio se parte en dos: unos trabajan la semana de Navidad
// y quedan libres la de Año nuevo, y al revés. Quién queda libre en cada una se
// carga en diciembre (campo semanasLibres), y de ahí se deduce el día.
//
// Las dos semanas se calculan solas, no se guardan: la de Navidad es la que
// contiene el 25 de diciembre y la de Año nuevo la que contiene el 1 de enero
// siguiente. Nunca coinciden, porque hay exactamente siete días entre ambas
// fechas. Se mira también el diciembre del año anterior, porque la semana de
// Año nuevo arranca en diciembre pero se estira hasta los primeros días de
// enero, que ya son del año siguiente.
function semanaLibreEseDia(name, fecha, rotPorAnio) {
  // Va de lunes a viernes, no la semana entera: Navidad es del lunes 21 al
  // viernes 25 y Año nuevo del lunes 28 al viernes 1. El sábado y el domingo
  // siguientes quedan disponibles, también para guardia.
  if (diOfDate(fecha) >= WEEKEND_START_IDX) return null;
  const lunes = isoDate(mondayOf(fecha));
  for (const anio of [fecha.getFullYear(), fecha.getFullYear() - 1]) {
    const rotAnio = rotPorAnio[anio];
    if (!rotAnio) continue;
    const dic = rotAnio.months[11];
    if (!dic) continue;
    const sl = dic.semanasLibres || {};
    if (isoDate(mondayOf(new Date(anio, 11, 25))) === lunes && (sl.navidad || []).includes(name)) return "Navidad";
    if (isoDate(mondayOf(new Date(anio + 1, 0, 1))) === lunes && (sl.anioNuevo || []).includes(name)) return "Año nuevo";
  }
  return null;
}

// ── No disponibilidad automática para sala ────────────────────────────────
// Cuatro cosas dejan a alguien fuera de la grilla de camas sin que haya que
// marcarlo a mano: estar rotando en otro servicio ese mes, estar de vacaciones
// ese mes, tener la semana libre de Navidad o de Año nuevo, o —en el caso de
// los R4— que sea su día libre de la semana. Se calcula al vuelo desde
// Rotaciones y desde el día libre, nunca se guarda duplicado: así, si se
// corrige una rotación, todas las semanas se actualizan solas y nunca queda un
// dato viejo contradiciendo al nuevo.
// Devuelve el motivo (texto listo para mostrar) o null si está disponible.
function motivoNoDisponible(name, date, rotPorAnio, diaLibre) {
  if (diaLibre) return `${name} tiene su día libre los ${diaLibre.toLowerCase()}`;
  const vac = vacacionesEseDia(name, date, rotPorAnio);
  if (vac) return `${name} está ${textoTramo(vac)}`;
  const libre = semanaLibreEseDia(name, date, rotPorAnio);
  if (libre) return `${name} tiene su semana libre de ${libre}`;
  const rotAnio = rotPorAnio[date.getFullYear()];
  if (!rotAnio) return null;
  const mes = rotAnio.months[date.getMonth()];
  if (!mes) return null;
  const rot = (mes.assignments || []).find((a) => a.resident === name);
  if (rot) return `${name} está rotando en ${rot.place} este mes`;
  return null;
}

// Quiénes están en el servicio durante una semana dada. Se usa para armar solos
// los candidatos de la chipa y del aura: no tiene sentido votar a alguien que
// está de vacaciones, rotando afuera o con su semana libre de fin de año.
//
// Alcanza con que esté UN día hábil de la semana. Alguien que vuelve de
// vacaciones el jueves estuvo en el servicio esa semana y puede ser candidato.
// El día libre semanal de los R4 no cuenta como ausencia: es un solo día.
function disponiblesEsaSemana(lunes, rotPorAnio) {
  return ALL.filter((n) =>
    [0, 1, 2, 3, 4].some((i) => !motivoNoDisponible(n, shift(lunes, i), rotPorAnio, null))
  );
}

/* ══════════════════ MODELO CHIPA DE LA SEMANA ══════════════════ */

// Cada semana vive en su propio documento (id = lunes de esa semana, YYYY-MM-DD)
// dentro de dos colecciones separadas y sin ningún campo que las vincule:
// chipa_votes/{weekId}   → candidatos y recuento de votos (público)
// chipa_voters/{weekId}  → uids que ya votaron esa semana (solo para bloquear el doble voto)
// Así se ve cuántos votos tiene cada uno, pero no quién votó a quién.
//
// Son DOS votaciones sobre la misma lista de candidatos: la chipa (castigo) y
// el aura (premio). Comparten documento y se distinguen por el campo: los votos
// van en `counts` y `countsAura`, y los votantes en `voted` y `votedAura`. Se
// hizo así, y no con documentos separados, para no migrar nada: el historial de
// chipa que ya existía sigue leyéndose igual y las semanas viejas simplemente
// no tienen aura.

function normalizeChipaWeek(raw, weekId) {
  if (!raw || typeof raw !== "object") return { weekStart: weekId, candidates: [], counts: {}, countsAura: {} };
  return {
    weekStart: typeof raw.weekStart === "string" ? raw.weekStart : weekId,
    candidates: Array.isArray(raw.candidates) ? raw.candidates.filter((n) => LEVEL[n]) : [],
    counts: raw.counts && typeof raw.counts === "object" ? raw.counts : {},
    countsAura: raw.countsAura && typeof raw.countsAura === "object" ? raw.countsAura : {},
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
  // Laboratorio de versiones: ruta oculta, no enlazada desde ninguna pestaña.
  if (isLabRoute()) return <Lab />;
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
      const guardado = snap.exists() ? snap.data().tabOrder : null;
      const stored = Array.isArray(guardado) ? guardado.map((k) => TAB_RENOMBRADAS[k] || k) : null;
      if (Array.isArray(stored) && stored.length) {
        const known = stored.filter((k, i) => DEFAULT_TAB_ORDER.includes(k) && stored.indexOf(k) === i);
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

  if (user === undefined) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Inter', system-ui, sans-serif", color: "#64748B", fontSize: 14 }}>Cargando…</div>;

  if (user === null) return <LoginScreen />;

  const isAdmin = user.email === ADMIN_EMAIL;

  if (acceso === "cargando") return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Inter', system-ui, sans-serif", color: "#64748B", fontSize: 14 }}>Verificando acceso…</div>;
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
        <button onClick={() => signOut(auth)} style={{ background: "none", border: "none", color: "#64748B", fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: 500 }}>Cerrar sesión</button>
      </div>

      {/* Tabs */}
      {isAdmin && <div className="no-print" style={{ fontSize: 10, color: "#64748B", marginBottom: 4, paddingLeft: 2 }}>Arrastrá una pestaña para reordenarlas</div>}
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
              {/* Etiqueta 'Alpha': avisa que la pestaña está en prueba y que lo
                  que se guarde ahí puede cambiar de forma sin aviso. */}
              {meta.tag && <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", background: tab === key ? "#334155" : "#CBD5E1", color: tab === key ? "#E2E8F0" : "#475569", borderRadius: 4, padding: "1px 5px" }}>{meta.tag}</span>}
            </TabBtn>
          );
        })}
      </div>

      {tab === "scheduler" && <SchedulerView isAdmin={isAdmin} />}
      {tab === "rotaciones" && <RotacionesView isAdmin={isAdmin} />}
      {tab === "pases" && <PasesView isAdmin={isAdmin} />}
      {tab === "paseapp" && <PaseAppView user={user} />}
      {tab === "chipa" && <ChipaView isAdmin={isAdmin} user={user} />}
      {tab === "academico" && <AcademicoView isAdmin={isAdmin} />}
      {tab === "articulo" && <ArticuloSemanaView isAdmin={isAdmin} />}
      {tab === "registro" && <RegistroView isAdmin={isAdmin} user={user} />}
      {tab === "hoy" && <QuienEstaHoyView isAdmin={isAdmin} embedded />}
      {tab === "accesos" && isAdmin && <AccesosView user={user} />}
      {tab === "impresiones" && <ImpresionesView user={user} isAdmin={isAdmin} />}
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
        <div style={{ fontSize: 12, color: "#64748B", marginBottom: 24 }}>Hospital Británico</div>
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
        <button onClick={() => signOut(auth)} style={{ background: "none", border: "none", color: "#64748B", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Cerrar sesión</button>
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
              <button onClick={() => setConfirmId(s.id)} title="Borrar el registro (si vuelve a entrar, pide permiso de nuevo)" style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>🗑️</button>
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
        <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "4px 2px" }}>{vacio}</div>
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
                <div style={{ fontSize: 10, color: "#64748B", marginTop: 1 }}>Pidió acceso: {s.solicitadoEnAR || "—"}</div>
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
  const [rotPorAnio, setRotPorAnio] = useState({});
  const [aplicandoMes, setAplicandoMes] = useState(false);
  const [equiposDoc, setEquiposDoc] = useState({});

  /* En el celular la semana entera no entra: son 104 px de rótulo más siete
     columnas de 150, o sea 1154 px contra los 375 de un teléfono. Antes se
     resolvía con scroll horizontal, que obliga a arrastrar tres pantallas
     para ver el viernes y hace imposible comparar dos días.

     Abajo de 640 px se muestra UN día por vez, con flechas para moverse. La
     grilla es la misma —mismas celdas, mismos chips, mismo código—: lo único
     que cambia es cuántas columnas se dibujan. Arranca en el día de hoy, que
     es el que uno quiere ver cuando abre la app en el pasillo. */
  const chico = useChico();
  const [diaVis, setDiaVis] = useState(() => {
    const hoy = new Date();
    const i = Math.floor((hoy - mondayOf(hoy)) / 86400000);
    return i >= 0 && i < DAYS.length ? i : 0;
  });
  // Al imprimir manda la semana entera aunque estemos en el celular: el papel
  // no tiene el problema de ancho que tiene la pantalla, y un cronograma
  // impreso con un solo día no le sirve a nadie.
  const [imprimiendo, setImprimiendo] = useState(false);
  const DIAS_VIS = chico && !imprimiendo ? [diaVis] : DAYS.map((_, i) => i);

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

  // Rotaciones y vacaciones del año (o de los dos años, si la semana cruza el
  // 31 de diciembre). Se usan para calcular quién queda fuera de la grilla de
  // camas sin marcarlo a mano.
  const aniosEnVista = useMemo(() => {
    const a = new Set();
    for (let i = 0; i < DAYS.length; i++) a.add(shift(monday, i).getFullYear());
    return [...a];
  }, [monday]);
  const clavesAnios = aniosEnVista.join(",");

  useEffect(() => {
    const unsubs = clavesAnios.split(",").map((y) =>
      onSnapshot(doc(db, "scheduler", `rotaciones-${y}`), (snap) => {
        setRotPorAnio((cur) => ({ ...cur, [y]: snap.exists() ? normalizeRot(snap.data()) : emptyRotYear() }));
      }, () => {})
    );
    return () => unsubs.forEach((u) => u());
  }, [clavesAnios]);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "scheduler", "equipos"), (snap) => setEquiposDoc(snap.exists() ? snap.data() : {}), () => {});
    return unsub;
  }, []);

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

  // Motivo por el que alguien no debería estar en sala ese día (rotación,
  // vacaciones o día libre), o null si está disponible. No bloquea: la grilla
  // igual deja asignarlo, pero avisa antes y después marca el chip.
  const motivoDe = useCallback((name, di) => {
    const fecha = shift(monday, di);
    const diaLibre = RESIDENTS.R4.includes(name) && week.diasLibresR4[name] === DAYS[di] ? week.diasLibresR4[name] : null;
    return motivoNoDisponible(name, fecha, rotPorAnio, diaLibre);
  }, [monday, week, rotPorAnio]);

  const pool = useCallback((di) => {
    const d = week.days[di];
    const used = new Set([...SLOT_KEYS.flatMap((k) => d[k]), ...d.unavailable]);
    return ASIGNABLES.filter((n) => !used.has(n) && !motivoDe(n, di));
  }, [week, motivoDe]);

  // Los que quedan fuera automáticamente ese día, para mostrarlos en la fila de
  // "No disponibles" sin que nadie los haya marcado a mano.
  const autoNoDisponibles = useCallback((di) => {
    const d = week.days[di];
    const yaPuestos = new Set([...SLOT_KEYS.flatMap((k) => d[k]), ...d.unavailable]);
    return ASIGNABLES.filter((n) => !yaPuestos.has(n)).map((n) => ({ name: n, motivo: motivoDe(n, di) })).filter((x) => x.motivo);
  }, [week, motivoDe]);

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
    // Avisa pero no frena: la realidad tiene excepciones. Si se asigna igual,
    // el chip queda marcado con ⚠️ y el motivo al pasar el mouse.
    if (target !== "unavailable" && target !== "pool") {
      const motivo = motivoDe(name, di);
      if (motivo) flash(`⚠️ ${motivo} — igual quedó asignado el ${DAYS[di].toLowerCase()}`);
    }
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
  // El día libre de los R4 se elige por mes, pero se guarda por semana para
  // poder hacer excepciones puntuales. Esto propaga lo que está cargado en la
  // semana actual a todas las semanas del mismo mes: se elige una vez y vale
  // para todo el mes, y si después hace falta cambiar una semana suelta, se
  // cambia solo ahí sin romper el resto.
  const aplicarDiasLibresAlMes = async () => {
    if (!isAdmin || aplicandoMes) return;
    const mes = monday.getMonth();
    const anio = monday.getFullYear();
    const lunes = lunesDelMes(anio, mes);
    if (!confirm(`Se van a copiar los días libres de esta semana a las ${lunes.length} semanas de ${MONTHS[mes].toLowerCase()}. ¿Continuar?`)) return;
    setAplicandoMes(true);
    try {
      for (const l of lunes) {
        const id = `week-${isoDate(l)}`;
        if (id === docId) continue; // la actual ya está guardada
        const ref = doc(db, "scheduler", id);
        const snap = await getDoc(ref);
        const base = snap.exists() ? normalize(snap.data()) : emptyWeek();
        base.diasLibresR4 = { ...week.diasLibresR4 };
        await setDoc(ref, base);
      }
      flash(`Días libres aplicados a ${MONTHS[mes].toLowerCase()}`);
    } catch (e) { console.error(e); flash("No se pudieron aplicar"); }
    setAplicandoMes(false);
  };

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
  // En el celular la grilla muestra un día; para imprimir hacen falta los
  // siete. Se enciende el flag, se espera un repintado —la medición de abajo
  // lee el DOM de forma síncrona, así que tiene que encontrar ya la semana
  // entera— y recién ahí se imprime.
  const handlePrint = () => {
    if (chico && !imprimiendo) {
      setImprimiendo(true);
      setTimeout(() => { imprimirAhora(); setTimeout(() => setImprimiendo(false), 600); }, 60);
      return;
    }
    imprimirAhora();
  };

  const imprimirAhora = () => {
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

    const PAGE_W = 1020; // ancho útil en A4 horizontal (96dpi). Va con margen de
    const PAGE_H = 690;  // sobra sobre los 1062px teóricos: si el usuario deja
    // los márgenes "predeterminados" en el diálogo en vez de los 8mm de @page,
    // Chrome ignora la regla y el área imprimible se achica. Con este colchón
    // entra igual y solo se pierde un 3% de tamaño.

    const noPrintEls = el.querySelectorAll(".no-print");
    const printOnlyEls = el.querySelectorAll(".print-only, .print-only-block");
    const prevNoPrint = Array.from(noPrintEls).map((n) => n.style.display);
    const prevPrintOnly = Array.from(printOnlyEls).map((n) => n.style.display);

    // Simulamos por un instante cómo se va a ver impreso (textos completos en
    // vez de los textarea recortados) para medir el alto real.
    noPrintEls.forEach((n) => { n.style.display = "none"; });
    printOnlyEls.forEach((n) => { n.style.display = n.classList.contains("print-only-block") ? "block" : "inline"; });

    // La grilla vive dentro de un contenedor con overflow-x:auto para poder
    // scrollearla en pantalla. Eso rompía la impresión de dos maneras a la vez:
    // el contenedor recortaba la última columna (el domingo), y además su
    // scroll propio hacía que el ancho real de la grilla NO apareciera en el
    // scrollWidth del bloque de impresión — así que la medición daba "entra
    // justo", el zoom quedaba en 1 y nadie achicaba nada. Por eso, antes de
    // medir, abrimos esos contenedores.
    const scrollers = el.querySelectorAll(".print-scroll");
    const prevOverflow = Array.from(scrollers).map((n) => n.style.overflowX);
    scrollers.forEach((n) => { n.style.overflowX = "visible"; });

    const prevWidth = el.style.width;
    const prevZoom = el.style.zoom;
    el.style.zoom = "1";
    el.style.width = PAGE_W + "px";

    // Con los contenedores abiertos, scrollWidth ya incluye lo que se desborda.
    // Igual medimos también los hijos directos por si alguno desborda por su
    // cuenta, para no volver a subestimar el ancho.
    const anchoHijos = Array.from(el.querySelectorAll(".print-scroll > *")).map((n) => n.scrollWidth);
    const naturalW = Math.max(el.scrollWidth, ...anchoHijos, 1);
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
      scrollers.forEach((n, i) => { n.style.overflowX = prevOverflow[i]; });
      noPrintEls.forEach((n, i) => { n.style.display = prevNoPrint[i]; });
      printOnlyEls.forEach((n, i) => { n.style.display = prevPrintOnly[i]; });
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);

    setTimeout(() => window.print(), 150);
  };

  const dates = useMemo(() => DAYS.map((_, i) => shift(monday, i)), [monday]);

  const alertas = useMemo(
    () => analizarSemana(week, monday, rotPorAnio, equiposDoc[mesDeLaSemana(monday)] || null),
    [week, monday, rotPorAnio, equiposDoc]
  );
  const today = new Date();
  const active = sel != null;

  useEffect(() => { const onKey = (e) => e.key === "Escape" && setSel(null); window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);

  return (
    <div onClick={() => { setSel(null); setMenuOpen(false); }}>
      <SchedulerHeader monday={monday} setMonday={setMonday} status={status} menuOpen={menuOpen} setMenuOpen={setMenuOpen} onCopyPrev={copyPrevWeek} onClear={clearWeek} onPrint={handlePrint} onFeriados={() => { setMenuOpen(false); setFeriadosOpen(true); }} isAdmin={isAdmin} />

      <div style={{ minHeight: 34, marginBottom: 6 }} className="no-print">
        {toast ? <Banner tone="warn">{toast}</Banner> : active ? <Banner tone="info"><b>{sel.name}</b> seleccionado — tocá una celda para ubicarlo, o Esc para cancelar</Banner> : <div style={{ fontSize: 12, color: "#64748B", padding: "6px 2px" }}>{isAdmin ? "Tocá un residente para seleccionarlo y después la celda donde va." : "Solo lectura — solo el administrador puede editar."}</div>}
      </div>

      {loading ? <Skeleton /> : (
        <div ref={printRef}>
          {isAdmin && <PanelAlertas duras={alertas.duras} suaves={alertas.suaves} />}
          <EquiposMes monday={monday} isAdmin={isAdmin} />
          <DiasLibresR4 week={week} isAdmin={isAdmin} onChange={setDiaLibre} onAplicarAlMes={aplicarDiasLibresAlMes} aplicando={aplicandoMes} />
          {/* Selector de día: sólo en celular, donde se ve un día por vez. */}
          {chico && (
            <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <button onClick={() => setDiaVis((i) => (i - 1 + DAYS.length) % DAYS.length)}
                aria-label="Día anterior"
                style={{ fontFamily: "inherit", fontSize: 18, lineHeight: 1, fontWeight: 700, width: 44, height: 44, flex: "0 0 auto", borderRadius: 9, border: "1.5px solid #CBD5E1", background: "#fff", color: "#334155", cursor: "pointer" }}>‹</button>
              <div style={{ flex: 1, textAlign: "center", minWidth: 0 }}>
                <div style={{ fontSize: 15.5, fontWeight: 800, color: "#0F172A" }}>{DAYS[diaVis]}</div>
                <div style={{ fontSize: 11.5, color: "#64748B" }}>
                  {dates[diaVis]?.toLocaleDateString("es-AR", { day: "numeric", month: "long" })}
                  {sameDay(dates[diaVis], today) ? " · hoy" : ""}
                </div>
              </div>
              <button onClick={() => setDiaVis((i) => (i + 1) % DAYS.length)}
                aria-label="Día siguiente"
                style={{ fontFamily: "inherit", fontSize: 18, lineHeight: 1, fontWeight: 700, width: 44, height: 44, flex: "0 0 auto", borderRadius: 9, border: "1.5px solid #CBD5E1", background: "#fff", color: "#334155", cursor: "pointer" }}>›</button>
            </div>
          )}
          <div className="print-scroll" style={{ overflowX: "auto", paddingBottom: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: `104px repeat(${DIAS_VIS.length}, minmax(150px, 1fr))`, background: "#fff", borderRadius: "14px 14px 0 0", overflow: "hidden", border: "1px solid #E2E8F0", borderBottom: "none", boxShadow: "0 1px 3px rgba(15,23,42,.06)", minWidth: 104 + DIAS_VIS.length * 150 }}>
            <Corner />{DIAS_VIS.map((i) => <DayHead key={DAYS[i]} name={DAYS[i]} date={dates[i]} isToday={sameDay(dates[i], today)} isWeekend={isWeekendIdx(i)} feriado={week.days[i].feriado} />)}

            {SLOTS.filter((s) => s.key !== "postguardia").map((slot, ri) => (
              <Fragment key={slot.key}>
                <RowLabel label={slot.label} color={slot.accent} fondo={slot.rotulo} />
                {DIAS_VIS.map((di) => (
                  utiBloqueada(di) ? (
                    <Cell key={di} tint={week.days[di].feriado ? "#FEF9E7" : "#F1F5F9"} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                      <div style={{ textAlign: "center", fontSize: 9.5, color: week.days[di].feriado ? "#B45309" : "#94A3B8", fontStyle: "italic", padding: "13px 2px", lineHeight: 1.3 }}>No aplica<br />{week.days[di].feriado ? "feriado" : "fin de semana"}</div>
                    </Cell>
                  ) : (
                    <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place(slot.key, di); }} tint={slot.tint} ring={active ? slot.accent : null} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 40 }}>
                        {[...week.days[di][slot.key]].sort(porJerarquia).map((n) => (
                          <Chip key={n} name={n} selected={sel?.name === n} alerta={motivoDe(n, di)} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: slot.key }); }} onRemove={isAdmin ? (e) => { e.stopPropagation(); removeChip(n, di); } : null} />
                        ))}
                        {active && <GhostHint color={slot.accent} name={sel.name} />}
                        {!active && week.days[di][slot.key].length === 0 && <Dash />}
                      </div>
                    </Cell>
                  )
                ))}
              </Fragment>
            ))}

            <RowLabel label="De guardia" color={FILA_GUARDIA.accent} sub="se superpone" fondo={FILA_GUARDIA.rotulo} />
            {DIAS_VIS.map((di) => {
              const lista = week.days[di].deGuardia;
              return (
                <Cell key={di} onClick={(e) => { e.stopPropagation(); if (isAdmin) setGuardiaEdit(di); }} tint={FILA_GUARDIA.tint} pad={5} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, minHeight: 40, alignContent: "flex-start", cursor: isAdmin ? "pointer" : "default" }}>
                    {lista.length === 0 ? (
                      <div className="no-print" style={{ fontSize: 10, color: "#FDA4AF", fontStyle: "italic", padding: "10px 4px", width: "100%", textAlign: "center" }}>{isAdmin ? "+ elegir guardia" : "—"}</div>
                    ) : lista.map((n) => <ChipGuardia key={n} name={n} />)}
                  </div>
                  <div className="print-only-block" style={{ fontSize: 11.5, lineHeight: 1.4, color: FILA_GUARDIA.accent, fontWeight: 600, padding: "6px 8px" }}>{lista.length ? lista.join(", ") : "—"}</div>
                </Cell>
              );
            })}

            {SLOTS.filter((s) => s.key === "postguardia").map((slot) => (
              <Fragment key={slot.key}>
                <RowLabel label={slot.label} color={slot.accent} fondo={slot.rotulo} />
                {DIAS_VIS.map((di) => (
                  <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place(slot.key, di); }} tint={slot.tint} ring={active ? slot.accent : null} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 40 }}>
                      {[...week.days[di][slot.key]].sort(porJerarquia).map((n) => (
                        <Chip key={n} name={n} selected={sel?.name === n} alerta={motivoDe(n, di)} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: slot.key }); }} onRemove={isAdmin ? (e) => { e.stopPropagation(); removeChip(n, di); } : null} />
                      ))}
                      {active && <GhostHint color={slot.accent} name={sel.name} />}
                      {!active && week.days[di][slot.key].length === 0 && <Dash />}
                    </div>
                  </Cell>
                ))}
              </Fragment>
            ))}

            <RowLabel label="Observaciones" color="#854D0E" sub="importante" />
            {DIAS_VIS.map((di) => (
              <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                <textarea className="no-print" value={week.days[di].observaciones} onChange={(e) => editText(di, "observaciones", e.target.value)} placeholder="Supervisores, pases, avisos…" readOnly={!isAdmin} style={{ ...TEXTAREA, background: "#FEF9C3", borderColor: "#FDE047", color: "#713F12", fontWeight: 600, opacity: isAdmin ? 1 : 0.8, cursor: isAdmin ? "text" : "default" }} />
                <div className="print-only-block" style={{ whiteSpace: "pre-wrap", fontSize: 11.5, lineHeight: 1.4, color: "#713F12", fontWeight: 600, padding: "6px 8px" }}>{week.days[di].observaciones || "—"}</div>
              </Cell>
            ))}

            <RowLabel label="Recordatorios" color="#B45309" sub="+ Académico" />
            {DIAS_VIS.map((di) => {
              const clases = academico.activities.filter((a) => a.date === isoDate(dates[di]));
              return (
                <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
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
          <div style={{ display: "grid", gridTemplateColumns: `104px repeat(${DIAS_VIS.length}, minmax(150px, 1fr))`, background: "#fff", borderRadius: "0 0 14px 14px", overflow: "hidden", border: "1px solid #E2E8F0", borderTop: "none", boxShadow: "0 1px 3px rgba(15,23,42,.06)", minWidth: 104 + DIAS_VIS.length * 150 }}>
            <RowLabel label="Disponibles" color="#16A34A" />
            {DIAS_VIS.map((di) => {
              const free = pool(di);
              return (
                <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place("pool", di); }} tint="#F0FDF4" ring={active ? "#22C55E" : null} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 50 }}>
                    {active && <div style={{ fontSize: 10, color: "#16A34A", fontWeight: 600, textAlign: "center", padding: "1px 0" }}>↩ liberar el {DAYS[di].toLowerCase()}</div>}
                    {free.length === 0 ? (!active && <div style={{ fontSize: 10.5, color: "#64748B", fontStyle: "italic", textAlign: "center", padding: 6 }}>todos asignados</div>) : free.map((n) => <Chip key={n} name={n} selected={sel?.name === n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: "pool" }); }} />)}
                  </div>
                </Cell>
              );
            })}

            <RowLabel label="No disponibles" color="#DC2626" sub="rotación · vacaciones" />
            {DIAS_VIS.map((di) => {
              const autos = autoNoDisponibles(di);
              return (
                <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place("unavailable", di); }} tint="#FEF2F2" ring={active ? "#F87171" : null} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]} lastRow>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 40 }}>
                    {week.days[di].unavailable.map((n) => <OutChip key={n} name={n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: "unavailable" }); }} selected={sel?.name === n} />)}
                    {autos.map(({ name, motivo }) => <AutoOutChip key={name} name={name} motivo={motivo} />)}
                    {active && <div style={{ fontSize: 10, color: "#EF4444", fontWeight: 600, textAlign: "center", padding: "1px 0" }}>marcar solo el {DAYS[di].toLowerCase()}</div>}
                    {!active && week.days[di].unavailable.length === 0 && autos.length === 0 && <Dash />}
                  </div>
                </Cell>
              );
            })}
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
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748B", fontSize: 18, cursor: "pointer", fontFamily: "inherit", lineHeight: 1 }}>×</button>
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
  const esJefe = LEVEL[name] === "JR";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2.5px 6px", borderRadius: 6, background: c.bg, border: `1.5px solid ${c.bd}`, color: c.tx, fontWeight: 600, fontSize: 10.5, lineHeight: 1.25, ...(esJefe ? SKIN_JR : {}) }}>
      {LEVEL[name] === "JR" && "👑"}
      {name}
      <span style={{ fontSize: 7, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: esJefe ? "rgba(69,26,3,.55)" : c.solid, color: "#fff", textShadow: "none" }}>{esResidente(name) ? LEVEL[name] : "—"}</span>
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
    // Si lo que escribió es en realidad un residente (por nombre corto o por
    // nombre público), se guarda como residente en vez de crear un duplicado
    // suelto que después no sumaría en el conteo.
    onChange(normalizarListaGuardia([...seleccion, v]));
    setNuevo("");
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: "18px 20px 20px", width: "100%", maxWidth: 460, maxHeight: "88vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(15,23,42,.28)", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <div style={{ fontWeight: 800, fontSize: 15.5, color: "#0F172A" }}>🌙 De guardia</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748B", fontSize: 18, cursor: "pointer", fontFamily: "inherit", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 14 }}>{dia} {dm(fecha)}</div>

        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 6, letterSpacing: 0.3 }}>RESIDENTES</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {ASIGNABLES.map((n) => {
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
        <div style={{ fontSize: 10.5, color: "#64748B", lineHeight: 1.45, marginBottom: 16 }}>
          Marcar a alguien acá no lo saca de la UTI que tenga asignada ese día ni de "no disponibles" — la guardia se superpone con el resto.
        </div>

        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 6, letterSpacing: 0.3 }}>OTRA PERSONA (PLANTA, OTRO SERVICIO)</div>
        {invitados.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {invitados.map((n) => (
              <div key={n} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 6px 5px 11px", borderRadius: 8, background: "#F1F5F9", border: "1.5px solid #CBD5E1", color: "#475569", fontWeight: 600, fontSize: 12.5 }}>
                {n}
                <button onClick={() => quitar(n)} style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 14, fontFamily: "inherit", lineHeight: 1, padding: 0 }}>×</button>
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

  const addAssignment = (mi) => { if (!isAdmin) return; setEditing({ month: mi, mode: "new", resident: "", place: "", exterior: false }); };

  const saveAssignment = (mi, resident, place, idx, exterior) => {
    if (!resident.trim() || !place.trim()) return;
    const next = clone(data);
    const registro = { resident: resident.trim(), place: place.trim(), exterior: !!exterior };
    if (idx !== undefined && idx !== null) { next.months[mi].assignments[idx] = registro; }
    else { next.months[mi].assignments.push(registro); }
    save(next); setEditing(null);
  };

  const removeAssignment = (mi, idx) => { if (!isAdmin) return; const next = clone(data); next.months[mi].assignments.splice(idx, 1); save(next); };

  const editNotes = (mi, val) => { if (!isAdmin) return; const next = clone(data); next.months[mi].notes = val; save(next); };

  // Marcar a alguien de vacaciones acá lo deja automáticamente fuera de la
  // grilla de camas todo ese mes (ver motivoNoDisponible). Es un dato aparte
  // de las notas justamente para poder usarlo con seguridad.
  const toggleVacaciones = (mi, nombre) => {
    if (!isAdmin) return;
    const next = clone(data);
    const cur = next.months[mi].vacaciones || [];
    next.months[mi].vacaciones = cur.some((v) => v.nombre === nombre)
      ? cur.filter((v) => v.nombre !== nombre)
      : [...cur, { nombre, tramo: tramoPorDefecto(nombre) }];
    save(next);
  };

  const toggleSemanaLibre = (mi, grupo, nombre) => {
    if (!isAdmin) return;
    const next = clone(data);
    const base = next.months[mi].semanasLibres || { navidad: [], anioNuevo: [] };
    const cur = base[grupo] || [];
    next.months[mi].semanasLibres = { ...base, [grupo]: cur.includes(nombre) ? cur.filter((n) => n !== nombre) : [...cur, nombre] };
    save(next);
  };

  const setTramoVacaciones = (mi, nombre, tramo) => {
    if (!isAdmin) return;
    const next = clone(data);
    next.months[mi].vacaciones = (next.months[mi].vacaciones || []).map((v) => (v.nombre === nombre ? { ...v, tramo } : v));
    save(next);
  };

  const toggleMonth = (mi) => setExpanded((cur) => ({ ...cur, [mi]: !isMonthOpen(mi) }));
  const isMonthOpen = (mi) => {
    if (expanded[mi] !== undefined) return expanded[mi];
    const m = data.months[mi];
    return m.assignments.length > 0 || !!m.notes.trim();
  };

  // Vaciar el historial. Borra las dos colecciones enteras: los votos y también
  // quiénes votaron, así las semanas quedan como nuevas y se podría volver a
  // votar cualquiera de ellas. No hay vuelta atrás, por eso pide escribir
  // BORRAR: un solo click de confirmación es demasiado poco para algo que no se
  // puede deshacer.
  const borrarHistorial = async () => {
    if (!isAdmin || textoBorrar.trim().toUpperCase() !== "BORRAR") return;
    setBorrando("yendo");
    try {
      for (const col of ["chipa_votes", "chipa_voters"]) {
        const snap = await getDocs(collection(db, col));
        await Promise.all(snap.docs.map((d) => deleteDoc(doc(db, col, d.id))));
      }
      setHistory(null); setShowHistory(false);
      setWeek({ weekStart: weekId, candidates: [], counts: {}, countsAura: {} });
      setVoted({ chipa: false, aura: false });
      setStatus("saved"); setTimeout(() => setStatus("idle"), 1800);
    } catch (e) { console.error("borrar historial", e); setStatus("error"); }
    setBorrando(false); setTextoBorrar("");
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
          const sl = month.semanasLibres || {};
          const hasData = month.assignments.length > 0 || !!month.notes.trim() || (month.vacaciones || []).length > 0 || (sl.navidad || []).length > 0 || (sl.anioNuevo || []).length > 0;
          const isOpen = isMonthOpen(mi);
          return (
            <div key={mi} style={{ background: "#fff", borderRadius: 12, border: isCurrentMonth ? "2px solid #3B82F6" : "1px solid #E2E8F0", overflow: "hidden", boxShadow: isCurrentMonth ? "0 0 0 3px #3B82F633" : "0 1px 3px rgba(15,23,42,.04)" }}>
              <div onClick={() => toggleMonth(mi)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: isCurrentMonth ? "#EFF6FF" : "#F8FAFC", borderBottom: isOpen ? "1px solid #E2E8F0" : "none", cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontSize: 9, color: "#64748B", display: "inline-block", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
                  <div style={{ fontWeight: 700, fontSize: 13, color: isCurrentMonth ? "#1D4ED8" : hasData ? "#0F172A" : "#94A3B8" }}>{mName}</div>
                  {!hasData && <span style={{ fontSize: 10, color: "#64748B", fontStyle: "italic" }}>vacío</span>}
                </div>
                {isOpen && isAdmin && <button onClick={(e) => { e.stopPropagation(); addAssignment(mi); }} style={{ background: "#E2E8F0", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", color: "#475569", fontFamily: "inherit" }}>+ Agregar</button>}
              </div>
              {isOpen && (
                <div style={{ padding: "8px 14px" }}>
                  {month.assignments.length === 0 && !(editing && editing.month === mi) ? (
                    <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "6px 0" }}>Sin rotaciones este mes</div>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: month.assignments.length > 0 ? 8 : 0 }}>
                      {month.assignments.map((a, idx) => {
                        const lv = LEVEL[a.resident];
                        const c = lv ? COLOR[lv] : { bg: "#F1F5F9", bd: "#CBD5E1", tx: "#475569", solid: "#64748B" };
                        const isEditingThis = editing && editing.month === mi && editing.idx === idx;
                        if (isEditingThis) {
                          return <EditForm key={idx} resident={editing.resident} place={editing.place} exterior={editing.exterior} onResChange={(v) => setEditing({ ...editing, resident: v })} onPlaceChange={(v) => setEditing({ ...editing, place: v })} onExteriorChange={(v) => setEditing({ ...editing, exterior: v })} onSave={() => saveAssignment(mi, editing.resident, editing.place, idx, editing.exterior)} onCancel={() => setEditing(null)} />;
                        }
                        return (
                          <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, background: c.bg, border: `1.5px solid ${c.bd}`, fontSize: 12 }}>
                            <span style={{ fontWeight: 700, color: c.tx }}>{a.resident}</span>
                            <span style={{ color: "#64748B", fontWeight: 500 }}>({a.place})</span>
                            {a.exterior && <span title="Fuera del país — no hace guardias" style={{ fontSize: 10 }}>✈️</span>}
                            {lv && <span style={{ fontSize: 8, fontWeight: 800, background: c.solid, color: "#fff", padding: "1px 4px", borderRadius: 3 }}>{lv}</span>}
                            {isAdmin && <span onClick={() => setEditing({ month: mi, idx, resident: a.resident, place: a.place, exterior: !!a.exterior })} style={{ cursor: "pointer", fontSize: 11, opacity: 0.4 }} title="Editar">✏️</span>}
                            {isAdmin && <span onClick={() => removeAssignment(mi, idx)} style={{ cursor: "pointer", fontSize: 11, opacity: 0.4 }} title="Eliminar">✕</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {editing && editing.month === mi && editing.mode === "new" && (
                    <EditForm resident={editing.resident} place={editing.place} exterior={editing.exterior} onResChange={(v) => setEditing({ ...editing, resident: v })} onPlaceChange={(v) => setEditing({ ...editing, place: v })} onExteriorChange={(v) => setEditing({ ...editing, exterior: v })} onSave={() => saveAssignment(mi, editing.resident, editing.place, undefined, editing.exterior)} onCancel={() => setEditing(null)} />
                  )}
                  <VacacionesPicker mes={mi} seleccion={month.vacaciones || []} isAdmin={isAdmin} onToggle={toggleVacaciones} onTramo={setTramoVacaciones} />
                  {mi === 11 && <SemanasLibresPicker mes={mi} datos={month.semanasLibres || { navidad: [], anioNuevo: [] }} isAdmin={isAdmin} onToggle={toggleSemanaLibre} />}
                  <textarea value={month.notes} onChange={(e) => editNotes(mi, e.target.value)} placeholder="Detalle de vacaciones (ej: 3 primeras semanas)…" readOnly={!isAdmin} style={{ ...TEXTAREA, minHeight: 32, marginTop: 4, fontSize: 11, fontStyle: month.notes ? "normal" : "italic", color: month.notes ? "#92400E" : "#94A3B8", background: month.notes ? "#FFFBEB" : "#FAFAFA", borderColor: month.notes ? "#FDE68A" : "#E2E8F0", opacity: isAdmin ? 1 : 0.8, cursor: isAdmin ? "text" : "default" }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Selector de quién está de vacaciones ese mes. Separado del texto libre de
// notas: las notas son para el detalle humano ("3 primeras semanas"), esto es
// el dato que la app usa para dejarlos fuera de sala automáticamente.
function VacacionesPicker({ mes, seleccion, isAdmin, onToggle, onTramo }) {
  const [abierto, setAbierto] = useState(false);
  if (!isAdmin && seleccion.length === 0) return null;
  const estaMarcado = (n) => seleccion.some((v) => v.nombre === n);

  return (
    <div style={{ marginTop: 6, paddingTop: 8, borderTop: "1px dashed #E2E8F0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: seleccion.length || abierto ? 6 : 0 }}>
        <div style={{ fontSize: 10.5, fontWeight: 800, color: "#0F766E", letterSpacing: 0.3, textTransform: "uppercase" }}>🏖️ De vacaciones este mes</div>
        {isAdmin && <button onClick={() => setAbierto((v) => !v)} style={{ background: "none", border: "none", color: "#0F766E", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{abierto ? "Listo" : "✏️ Editar"}</button>}
      </div>

      {!abierto && seleccion.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {seleccion.map((v) => {
            const c = COLOR[LEVEL[v.nombre]] || COLOR.R2;
            const t = TRAMOS_VACACIONES[v.tramo] || TRAMOS_VACACIONES.mes;
            return (
              <span key={v.nombre} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 999, background: c.bg, border: `1.5px solid ${c.bd}`, color: c.tx, fontWeight: 700, fontSize: 11 }}>
                {v.nombre}
                <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: c.solid, color: "#fff" }}>{LEVEL[v.nombre]}</span>
                <span title={textoTramo(t)} style={{ fontSize: 9.5, fontWeight: 700, color: t.tipo === "invierno" ? "#0369A1" : "#B45309", background: t.tipo === "invierno" ? "#F0F9FF" : "#FFFBEB", border: `1px solid ${t.tipo === "invierno" ? "#BAE6FD" : "#FDE68A"}`, borderRadius: 999, padding: "0 5px" }}>{t.tipo === "invierno" ? "❄️ " : "☀️ "}{t.corto}</span>
              </span>
            );
          })}
        </div>
      )}
      {!abierto && seleccion.length === 0 && isAdmin && (
        <div style={{ fontSize: 11, color: "#64748B", fontStyle: "italic" }}>Nadie marcado. Los que marques quedan fuera de sala durante su tramo.</div>
      )}

      {abierto && (
        <div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: seleccion.length ? 10 : 0 }}>
            {ALL.map((n) => {
              const on = estaMarcado(n);
              const c = COLOR[LEVEL[n]];
              return (
                <div key={n} onClick={() => onToggle(mes, n)} style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 4, padding: "4px 9px", borderRadius: 7, background: on ? c.solid : "#F8FAFC", border: `1.5px solid ${on ? c.solid : "#E2E8F0"}`, color: on ? "#fff" : "#475569", fontWeight: 600, fontSize: 11.5 }}>
                  {on && "✓ "}{n}
                  <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: on ? "rgba(255,255,255,.28)" : c.solid, color: "#fff" }}>{LEVEL[n]}</span>
                </div>
              );
            })}
          </div>

          {/* Los R4 se toman el mes entero, así que no hace falta preguntarles
              el tramo; a los R2 y R3 sí, porque son tres semanas seguidas que
              pueden arrancar la primera o la segunda semana. */}
          {seleccion.map((v) => (
            <div key={v.nombre} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 5 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: "#334155", minWidth: 62 }}>{v.nombre}</span>
              {["verano", "invierno"].map((grupo) => (
                <span key={grupo} style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 9.5, fontWeight: 800, color: grupo === "verano" ? "#B45309" : "#0369A1", textTransform: "uppercase", letterSpacing: 0.3 }}>{grupo === "verano" ? "☀️ verano" : "❄️ invierno"}</span>
                  {Object.entries(TRAMOS_VACACIONES).filter(([, t]) => t.tipo === grupo).map(([clave, t]) => {
                    const on = (v.tramo || "1-3") === clave;
                    return (
                      <button key={clave} onClick={() => onTramo(mes, v.nombre, clave)} style={{ background: on ? "#0F766E" : "#fff", color: on ? "#fff" : "#475569", border: `1.5px solid ${on ? "#0F766E" : "#E2E8F0"}`, borderRadius: 7, padding: "4px 9px", fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                        {t.label}
                      </button>
                    );
                  })}
                </span>
              ))}
            </div>
          ))}
          {seleccion.some((v) => LEVEL[v.nombre] === "R4") && (
            <div style={{ fontSize: 10.5, color: "#64748B", marginTop: 4 }}>
              Los R4 marcados se toman el mes completo. Si es una semana de invierno, cambiale el tramo desde acá.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Solo aparece en diciembre. A fin de año se arma con dos equipos: unos
// trabajan la semana de Navidad y quedan libres la de Año nuevo, y al revés.
// Lo que se marca acá sale directo en la grilla: quien queda libre aparece
// automáticamente como no disponible de lunes a viernes de esa semana, y
// tampoco puede hacer guardia esas noches. Es una desconexión total.
// Las dos semanas se deducen del calendario (la del 25/12 y la del 1/1), así
// que no hay que cargar fechas: alcanza con tildar quién queda libre.
function SemanasLibresPicker({ mes, datos, isAdmin, onToggle }) {
  const [abierto, setAbierto] = useState(false);
  const grupos = [
    { clave: "navidad", label: "🎄 Semana de Navidad", color: "#B91C1C", bg: "#FEF2F2", bd: "#FECACA" },
    { clave: "anioNuevo", label: "🎆 Semana de Año nuevo", color: "#7C3AED", bg: "#F5F3FF", bd: "#DDD6FE" },
  ];
  const hayAlgo = grupos.some((g) => (datos[g.clave] || []).length > 0);
  if (!isAdmin && !hayAlgo) return null;

  return (
    <div style={{ marginTop: 6, paddingTop: 8, borderTop: "1px dashed #E2E8F0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: hayAlgo || abierto ? 6 : 0 }}>
        <div style={{ fontSize: 10.5, fontWeight: 800, color: "#7C3AED", letterSpacing: 0.3, textTransform: "uppercase" }}>🎄 Semanas libres de Navidad y Año nuevo</div>
        {isAdmin && <button onClick={() => setAbierto((v) => !v)} style={{ background: "none", border: "none", color: "#7C3AED", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{abierto ? "Listo" : "✏️ Editar"}</button>}
      </div>

      {!abierto && !hayAlgo && isAdmin && (
        <div style={{ fontSize: 11, color: "#64748B", fontStyle: "italic" }}>Sin definir todavía. A medida que cada uno elija, se lo marca acá: queda fuera de la sala y de las guardias de lunes a viernes de esa semana.</div>
      )}

      {grupos.map((g) => {
        const gente = datos[g.clave] || [];
        if (!abierto && gente.length === 0) return null;
        return (
          <div key={g.clave} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: g.color, marginBottom: 4 }}>{g.label} <span style={{ color: "#64748B", fontWeight: 500 }}>— libres de lunes a viernes, sin sala ni guardia</span></div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {(abierto ? ALL : gente).map((n) => {
                const on = gente.includes(n);
                const c = COLOR[LEVEL[n]];
                if (!abierto) {
                  return (
                    <span key={n} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 999, background: c.bg, border: `1.5px solid ${c.bd}`, color: c.tx, fontWeight: 700, fontSize: 11 }}>
                      {n}<span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: c.solid, color: "#fff" }}>{LEVEL[n]}</span>
                    </span>
                  );
                }
                return (
                  <div key={n} onClick={() => onToggle(mes, g.clave, n)} style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 4, padding: "4px 9px", borderRadius: 7, background: on ? g.color : "#F8FAFC", border: `1.5px solid ${on ? g.color : "#E2E8F0"}`, color: on ? "#fff" : "#475569", fontWeight: 600, fontSize: 11.5 }}>
                    {on && "✓ "}{n}
                    <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: on ? "rgba(255,255,255,.28)" : c.solid, color: "#fff" }}>{LEVEL[n]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const EditForm = ({ resident, place, exterior, onResChange, onPlaceChange, onExteriorChange, onSave, onCancel }) => (
  <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0", flexWrap: "wrap" }}>
    <select value={resident} onChange={(e) => onResChange(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", background: "#fff", color: "#0F172A" }}>
      <option value="">Residente…</option>
      {ALL.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
    </select>
    <input value={place} onChange={(e) => onPlaceChange(e.target.value)} placeholder="Lugar (ej: Fernandez, Ecocardio)" onKeyDown={(e) => e.key === "Enter" && onSave()} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", flex: 1, minWidth: 140, color: "#0F172A" }} />
    <label title="Si rota fuera del país no hace guardias en el Británico" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: exterior ? "#B45309" : "#64748B", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
      <input type="checkbox" checked={!!exterior} onChange={(e) => onExteriorChange(e.target.checked)} style={{ cursor: "pointer" }} />
      ✈️ fuera del país
    </label>
    <button onClick={onSave} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓</button>
    <button onClick={onCancel} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✕</button>
  </div>
);

/* ══════════════════ PASES VIEW ══════════════════ */

// Un color por unidad. Tonos apagados, de informe: la idea es ubicarse de un
// vistazo en qué sala se está mirando, no decorar. Cada uno tiene su versión
// fuerte (para la pestaña activa y la barra lateral) y una muy clarita para
// el fondo, que tiene que dejar leer el texto en negro sin esfuerzo.
const PASE_COLOR = {
  "UTI 1": { fuerte: "#1E3A5F", suave: "#EEF2F7" },
  "UTI 2": { fuerte: "#3F5F3A", suave: "#EFF4EE" },
  "UTI 3": { fuerte: "#6B4423", suave: "#F6F1EC" },
  "RECU":  { fuerte: "#4A3B63", suave: "#F2F0F6" },
  "UCO":   { fuerte: "#5A3A44", suave: "#F5F0F1" },
};
const colorUnidad = (u) => PASE_COLOR[(u || "").toUpperCase().replace(/\s+/g, " ")] || { fuerte: "#334155", suave: "#F1F5F9" };

const PASE_FIELDS = [
  ["ap", "Antecedentes"],
  ["ea", "Enfermedad actual"],
  ["req", "Requerimientos / Intercurrencias"],
  ["tto", "Tratamiento"],
  ["labo", "Laboratorio"],
  ["eab", "EAB"],
  ["cultivos", "Cultivos"],
  ["estudios", "Complementarios"],
  ["accesos", "Accesos"],
  ["imagenes", "Imágenes"],
  // Los pendientes NO se muestran acá: la pestaña Pases es la foto del estado
  // de cada paciente, y los pendientes son tarea de guardia — viven en la Pase
  // App, por paciente, donde se pueden tachar. Mostrarlos en los dos lados
  // hace que uno no sepa cuál de las dos listas es la buena.
];

// Los mismos arreglos que usa la Pase App, aplicados también acá: el recuadro
// de tratamiento que el Drive pega adentro de enfermedad actual, accesos e
// imágenes separados, y la redacción prolijada. El pase del Drive se escribe
// a las apuradas y en mayúsculas; que esté mal escrito ahí no quiere decir
// que tenga que leerse mal acá.
function paseArreglado(fields) {
  const f = { ...(fields || {}) };
  if (!f.tto && f.ea) {
    const ls = f.ea.split("\n");
    const corte = ls.findIndex((l) => /^(PESO|PR)\b|^(NE|NPT|NTE|RL|SF|NXB)\s*\d/i.test(l.trim()));
    if (corte > 0) { f.tto = ls.slice(corte).join("\n"); f.ea = ls.slice(0, corte).join("\n"); }
  }
  if (f.accesos) {
    const part = paPartirAccesos(f.accesos);
    f.accesos = part.accesos;
    if (part.imagenes) f.imagenes = [f.imagenes, part.imagenes].filter(Boolean).join("\n");
    if (part.arm) f.accesos = [f.accesos, part.arm].filter(Boolean).join("\n");
    if (!f.accesos) delete f.accesos;
  }
  const g = paReordenarClinicos(f);
  const out = {};
  // Las tres secciones fechadas van con el formato *fecha estudio resultado.
  // Es la misma regla que en Pase App: lo que se corrige en una pestaña vale
  // para la otra, salvo las funcionalidades que sólo existen allá.
  const CON_ASTERISCO = new Set(["labo", "eab", "cultivos", "estudios"]);
  for (const [k, v] of Object.entries(g)) {
    const limpio = k === "cultivos" ? paCultivos(v) : paLimpiar(v);
    out[k] = CON_ASTERISCO.has(k) ? paFormatoAsterisco(limpio) : limpio;
  }
  return out;
}

function timeAgo(iso) {
  if (!iso) return "nunca";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "recién";
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

// A partir de acá el resumen de pases se considera viejo y se vuelve a pedir al
// abrir la pestaña. Quince minutos es, en la práctica, "se actualiza cada vez
// que alguien entra": los pases de Drive se editan durante todo el día, así que
// un umbral largo dejaba ver un resumen de una hora aunque hubiera alguien
// mirando. No se pone en cero para que, si varios entran seguido, no se
// dispare una sincronización por cada click.
const PASES_FRESCO_MS = 15 * 60 * 1000;

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

  // Refresco automático al abrir la pestaña, si el resumen está viejo.
  //
  // La sincronización de fondo la dispara un cron de GitHub Actions cada 2
  // horas, pero el scheduler de GitHub es "best effort" y en la práctica no
  // cumple: medido sobre este mismo repo, los intervalos reales van de 1h55 a
  // 4h36, y llegó a estar 13 horas sin correr una sola vez. Por eso no se
  // puede depender solo de él. Esto cubre el caso que importa —alguien abre la
  // pestaña y quiere ver los pases de ahora— sin tocar el cron ni sumar otro
  // servicio: si el dato está viejo, se pide una sincronización y listo.
  //
  // Se dispara una sola vez por apertura de la pestaña. Si varios lo abren a
  // la vez pueden salir dos o tres pedidos en simultáneo, pero el endpoint es
  // idempotente y en cuanto el primero termina, el onSnapshot le refresca el
  // updatedAt a todos y los demás ya no entran.
  const yaRefresco = useRef(false);
  useEffect(() => {
    if (loading || yaRefresco.current) return;
    const edad = data && data.updatedAt ? Date.now() - new Date(data.updatedAt).getTime() : Infinity;
    if (edad < PASES_FRESCO_MS) return;
    yaRefresco.current = true;
    setSyncing(true);
    fetch("/api/sync-pases")
      .then((r) => r.json())
      .then((j) => { if (!j.ok) setSyncMsg("⚠ No se pudo actualizar el resumen"); })
      .catch(() => setSyncMsg("⚠ No se pudo actualizar el resumen"))
      .finally(() => { setSyncing(false); setTimeout(() => setSyncMsg(null), 5000); });
  }, [loading, data]);

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
        <div style={{ textAlign: "center", padding: "50px 20px", color: "#64748B", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
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
                <button key={u} onClick={() => { setUnit(u); setOpen({}); }} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 5, border: `1.5px solid ${on ? colorUnidad(u).fuerte : "#E2E8F0"}`, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, background: on ? colorUnidad(u).fuerte : "#fff", color: on ? "#fff" : "#475569", display: "flex", alignItems: "center", gap: 6 }}>
                  {u}
                  <span style={{ fontSize: 10, fontWeight: 700, fontFamily: "ui-monospace,monospace", opacity: on ? 0.85 : 0.6 }}>{n}</span>
                </button>
              );
            })}
          </div>

          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por cama, nombre o diagnóstico…" className="no-print" style={{ width: "100%", padding: "9px 12px", borderRadius: 5, border: "1px solid #E2E8F0", fontSize: 12.5, fontFamily: "inherit", marginBottom: 10, outline: "none", boxSizing: "border-box", color: "#0F172A" }} />

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {patients.length === 0 ? (
              <div style={{ textAlign: "center", padding: 30, color: "#64748B", fontSize: 12.5, background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0" }}>
                {q ? "Ningún paciente coincide con la búsqueda" : "Sin pacientes en esta unidad"}
              </div>
            ) : patients.map((p) => {
              const isOpen = !!open[p.bed];
              return (
                <div key={p.bed} style={{ background: "#fff", borderRadius: 6, border: "1px solid #E2E8F0", borderLeft: `4px solid ${colorUnidad(activeUnit).fuerte}`, overflow: "hidden" }}>
                  <div onClick={() => setOpen((o) => ({ ...o, [p.bed]: !o[p.bed] }))} style={{ padding: "11px 13px", cursor: "pointer", display: "flex", gap: 11, alignItems: "flex-start" }}>
                    <div style={{ flexShrink: 0, minWidth: 42, textAlign: "center", background: colorUnidad(activeUnit).suave, color: colorUnidad(activeUnit).fuerte, border: `1px solid ${colorUnidad(activeUnit).fuerte}22`, borderRadius: 5, padding: "5px 7px", fontWeight: 800, fontSize: 14, fontFamily: "ui-monospace,monospace", lineHeight: 1.2 }}>{p.bed}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 700, fontSize: 13.5, color: "#0F172A" }}>{paNombre(p.name).nombre || "—"}</span>
                        {p.age && <span style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600 }}>{p.age} años</span>}
                      </div>
                      {p.flags?.length > 0 && (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                          {p.flags.map((f, i) => (
                            <span key={i} style={{ fontSize: 9.5, fontWeight: 700, background: "#FEF2F2", color: "#B91C1C", border: "1px solid #FECACA", padding: "2px 6px", borderRadius: 5 }}>{f}</span>
                          ))}
                        </div>
                      )}
                      {p.mi && <div style={{ fontSize: 12, color: colorUnidad(activeUnit).fuerte, fontWeight: 600, marginTop: 4, lineHeight: 1.35 }}>{paLimpiar(p.mi)}</div>}
                      {p.status && <div style={{ fontSize: 11.5, color: "#475569", marginTop: 5, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: isOpen ? "unset" : 2, WebkitBoxOrient: "vertical", overflow: isOpen ? "visible" : "hidden" }}>{paLimpiar(p.status)}</div>}
                    </div>
                    <div style={{ flexShrink: 0, color: "#64748B", fontSize: 12, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▼</div>
                  </div>

                  {isOpen && (
                    <div style={{ borderTop: "1px solid #F1F5F9", padding: "4px 13px 12px" }}>
                      {(() => { const ff = paseArreglado(p.fields); return PASE_FIELDS.filter(([k]) => ff[k]).map(([k, label]) => (
                        <div key={k} style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#64748B", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
                          <div style={{ fontSize: 11.5, color: "#334155", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{conNegritas(ff[k], "p" + k)}</div>
                        </div>
                      )); })()}
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
        <button onClick={onGenerar} style={{ background: "none", border: "none", color: "#64748B", fontSize: 10.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>↻ Regenerar</button>
      </div>

      {state.resumen && <div style={{ fontSize: 11.5, color: "#1E1B4B", lineHeight: 1.6, whiteSpace: "pre-wrap", marginBottom: 12 }}>{state.resumen}</div>}

      {state.perlas?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#64748B", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 5 }}>Perlas clínicas · MBE</div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {state.perlas.map((perla, i) => (
              <li key={i} style={{ fontSize: 11.5, color: "#334155", lineHeight: 1.55, marginBottom: 6 }}>{perla}</li>
            ))}
          </ol>
        </div>
      )}

      {state.fuentes?.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#64748B", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 5 }}>Fuentes citadas</div>
          {state.fuentes.map((f, i) => (
            <div key={i} style={{ fontSize: 10.5, color: "#64748B", lineHeight: 1.5, marginBottom: 2 }}>
              {f.referencia}{f.url ? <> — <a href={f.url} target="_blank" rel="noreferrer" style={{ color: "#4F46E5" }}>{f.url}</a></> : ""}
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 10, color: "#64748B", fontStyle: "italic", lineHeight: 1.4 }}>
        Generado por IA como apoyo — no reemplaza el juicio clínico. Verificá siempre las citas antes de usarlas.
      </div>
    </div>
  );
}

/* ══════════════════ CHIPA Y AURA DE LA SEMANA VIEW ══════════════════ */

// Dos votaciones por semana, con los MISMOS candidatos y opuestas en signo: la
// chipa es el castigo y el aura es el premio. Cada uno vota una vez en cada
// una, y las dos son independientes: se puede ganar las dos la misma semana.
const PREMIOS = {
  chipa: {
    clave: "chipa",
    titulo: "Chipa de la semana",
    emoji: "🥐",
    campoVotos: "counts",
    campoVotantes: "voted",
    degrade: "linear-gradient(135deg,#7C2D12,#9A3412 60%,#C2410C)",
    acento: "#C2410C",
    ganadorBg: "#FFF7ED",
    ganadorBd: "#FB923C",
    ganadorTx: "#9A3412",
    trofeo: "🥐",
    yaVotaste: "✓ Ya votaste la chipa de esta semana",
    invitacion: "Tocá a quien se ganó la chipa. El voto es anónimo y no se puede cambiar.",
    vacio: "Nadie disponible esa semana.",
  },
  aura: {
    clave: "aura",
    titulo: "Aura de la semana",
    emoji: "✨",
    campoVotos: "countsAura",
    campoVotantes: "votedAura",
    degrade: "linear-gradient(135deg,#4C1D95,#6D28D9 60%,#8B5CF6)",
    acento: "#7C3AED",
    ganadorBg: "#F5F3FF",
    ganadorBd: "#A78BFA",
    ganadorTx: "#5B21B6",
    trofeo: "🏆",
    yaVotaste: "✓ Ya votaste el aura de esta semana",
    invitacion: "Tocá a quien tuvo el aura. El voto es anónimo y no se puede cambiar.",
    vacio: "Nadie disponible esa semana.",
  },
};

// Qué semana se muestra al entrar. De lunes a viernes, la semana en curso.
// Sábado y domingo ya apuntan a la semana que viene: para la votación el fin de
// semana cuenta como el arranque de la semana siguiente, no como el final de la
// que se termina. Es una decisión de Gonzalo, no un descuido de calendario.
function semanaDeVotacionPorDefecto() {
  const hoy = new Date();
  const di = hoy.getDay(); // 0 domingo, 6 sábado
  const lunes = mondayOf(hoy);
  return di === 0 || di === 6 ? shift(lunes, 7) : lunes;
}

function ChipaView({ isAdmin, user }) {
  const realMonday = useMemo(() => semanaDeVotacionPorDefecto(), []);
  const realWeekId = isoDate(realMonday);
  const [monday, setMonday] = useState(() => realMonday);
  const weekId = isoDate(monday);
  const isRealWeek = weekId === realWeekId;

  const [week, setWeek] = useState({ weekStart: weekId, candidates: [], counts: {}, countsAura: {} });
  const [loading, setLoading] = useState(true);
  // null = todavía no se sabe, true/false ya resuelto. Una por votación.
  const [voted, setVoted] = useState({ chipa: null, aura: null });
  const [status, setStatus] = useState("idle");
  const [editingCandidates, setEditingCandidates] = useState(false);
  const [pickerSel, setPickerSel] = useState([]);
  const [voting, setVoting] = useState(false);
  const [history, setHistory] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [borrando, setBorrando] = useState(false);   // "confirmar" | "yendo" | false
  const [textoBorrar, setTextoBorrar] = useState("");

  useEffect(() => {
    setLoading(true);
    const ref = doc(db, "chipa_votes", weekId);
    const unsub = onSnapshot(ref, (snap) => {
      setWeek(snap.exists() ? normalizeChipaWeek(snap.data(), weekId) : { weekStart: weekId, candidates: [], counts: {}, countsAura: {} });
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, [weekId]);

  useEffect(() => {
    if (!user?.uid) return;
    const ref = doc(db, "chipa_voters", weekId);
    const unsub = onSnapshot(ref, (snap) => {
      const d = snap.exists() ? snap.data() : {};
      const yaVoto = (campo) => Array.isArray(d[campo]) && d[campo].includes(user.uid);
      setVoted({ chipa: yaVoto("voted"), aura: yaVoto("votedAura") });
    }, () => setVoted({ chipa: false, aura: false }));
    return unsub;
  }, [weekId, user?.uid]);

  // Rotaciones y vacaciones del año (y del siguiente, para la semana que cruza
  // diciembre), que es lo que define quién está disponible esa semana.
  const [rotPorAnio, setRotPorAnio] = useState({});
  const aniosSemana = useMemo(() => [...new Set([monday.getFullYear(), shift(monday, 6).getFullYear()])], [weekId]);
  useEffect(() => {
    const unsubs = aniosSemana.map((y) =>
      onSnapshot(doc(db, "scheduler", `rotaciones-${y}`), (snap) => {
        setRotPorAnio((cur) => ({ ...cur, [y]: snap.exists() ? normalizeRot(snap.data()) : emptyRotYear() }));
      }, () => {})
    );
    return () => unsubs.forEach((u) => u());
  }, [aniosSemana.join(",")]);

  // Los candidatos se arman solos con los que estuvieron esa semana. Si la
  // jefatura guardó una lista a mano para esa semana, esa manda: sirve de
  // escape y además es lo que mantiene intacto el historial viejo, que se
  // cargaba siempre a mano.
  const candidatos = useMemo(() => (
    week.candidates.length ? week.candidates : disponiblesEsaSemana(monday, rotPorAnio)
  ), [week.candidates, weekId, rotPorAnio]);

  useEffect(() => { setEditingCandidates(false); }, [weekId]);

  const openPicker = () => { setPickerSel(candidatos); setEditingCandidates(true); };
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

  // Un voto por persona y por votación. Los recuentos y los votantes viven en
  // campos distintos según el premio, así que votar la chipa no consume el
  // voto del aura ni al revés.
  const castVote = async (name, premio) => {
    if (!user?.uid || voted[premio.clave] || voting || !candidatos.includes(name)) return;
    setVoting(true);
    try {
      await setDoc(doc(db, "chipa_votes", weekId), { weekStart: weekId, [premio.campoVotos]: { [name]: increment(1) } }, { merge: true });
      await setDoc(doc(db, "chipa_voters", weekId), { [premio.campoVotantes]: arrayUnion(user.uid) }, { merge: true });
    } catch (e) { console.error("voto " + premio.clave, e); }
    setVoting(false);
  };

  const loadHistory = async () => {
    if (history) { setShowHistory((v) => !v); return; }
    setHistoryLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "chipa_votes"), orderBy("weekStart", "desc")));
      const conAlgo = (w) => w.candidates.length > 0 || Object.keys(w.counts || {}).length > 0 || Object.keys(w.countsAura || {}).length > 0;
      const weeks = snap.docs.map((d) => normalizeChipaWeek(d.data(), d.id)).filter((w) => w.weekStart < realWeekId && conAlgo(w));
      setHistory(weeks);
      setShowHistory(true);
    } catch (e) { console.error(e); }
    setHistoryLoading(false);
  };

  // Vaciar el historial. Borra las dos colecciones enteras: los votos y también
  // quiénes votaron, así las semanas quedan como nuevas y se podría volver a
  // votar cualquiera de ellas. No hay vuelta atrás, por eso pide escribir
  // BORRAR: un solo click de confirmación es demasiado poco para algo que no se
  // puede deshacer.
  const borrarHistorial = async () => {
    if (!isAdmin || textoBorrar.trim().toUpperCase() !== "BORRAR") return;
    setBorrando("yendo");
    try {
      for (const col of ["chipa_votes", "chipa_voters"]) {
        const snap = await getDocs(collection(db, col));
        await Promise.all(snap.docs.map((d) => deleteDoc(doc(db, col, d.id))));
      }
      setHistory(null); setShowHistory(false);
      setWeek({ weekStart: weekId, candidates: [], counts: {}, countsAura: {} });
      setVoted({ chipa: false, aura: false });
      setStatus("saved"); setTimeout(() => setStatus("idle"), 1800);
    } catch (e) { console.error("borrar historial", e); setStatus("error"); }
    setBorrando(false); setTextoBorrar("");
  };

  const S = { saving: { t: "Guardando…", c: "#CBD5E1" }, saved: { t: "✓ Guardado", c: "#86EFAC" }, error: { t: "⚠ Error", c: "#FCA5A5" } }[status];

  if (loading) return <Skeleton />;

  const votacion = (premio) => {
    const cuenta = (n) => (week[premio.campoVotos] || {})[n] || 0;
    const maxVotos = Math.max(0, ...candidatos.map(cuenta));
    const total = candidatos.reduce((s, n) => s + cuenta(n), 0);
    const yaVoto = !!voted[premio.clave];
    return (
      <div style={{ marginBottom: 20 }}>
        <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "11px 15px", marginBottom: 10, borderRadius: 13, background: premio.degrade, color: "#fff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 21 }}>{premio.emoji}</span>
            <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: -0.3 }}>{premio.titulo}</div>
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85 }}>{total} voto{total === 1 ? "" : "s"}</div>
        </div>

        {candidatos.length === 0 ? (
          <div style={{ textAlign: "center", padding: "26px 20px", color: "#64748B", fontSize: 12.5, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
            {premio.emoji} {premio.vacio}
            <div style={{ fontSize: 11.5, marginTop: 8 }}>Los candidatos salen solos de quiénes están en el servicio.{isAdmin ? ' Podés forzar una lista con "Elegir candidatos".' : ""}</div>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
              {candidatos.map((n) => (
                <CandidateCard key={n} name={n} count={cuenta(n)} isWinner={maxVotos > 0 && cuenta(n) === maxVotos}
                  premio={premio} disabled={yaVoto || voting} onVote={() => castVote(n, premio)} />
              ))}
            </div>
            <div style={{ textAlign: "center", padding: "4px 4px", fontSize: 12, fontWeight: 600, color: yaVoto ? premio.acento : "#94A3B8" }}>
              {yaVoto ? premio.yaVotaste : premio.invitacion}
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🥐</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Chipa y Aura</div>
            <div style={{ fontSize: 10.5, opacity: 0.6 }}>Los candidatos son los que están esa semana</div>
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
          <div style={{ fontSize: 12, color: "#64748B", fontWeight: 600, marginBottom: 4 }}>Tocá para agregar o sacar candidatos de esta semana:</div>
          <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 10 }}>Normalmente no hace falta: la lista sale sola de quiénes están en el servicio esa semana. Guardar acá la fija a mano para esta semana, en las dos votaciones.</div>
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
      ) : (
        <>
          {votacion(PREMIOS.chipa)}
          {votacion(PREMIOS.aura)}
        </>
      )}

      <div style={{ marginTop: 18 }}>
        <button className="no-print" onClick={loadHistory} disabled={historyLoading} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, color: "#64748B", padding: "4px 2px", marginBottom: 8, opacity: historyLoading ? 0.5 : 1 }}>
          <span style={{ display: "inline-block", transform: showHistory ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
          {historyLoading ? "Cargando historial…" : `Historial${history ? ` (${history.length})` : ""}`}
        </button>
        {showHistory && history && (
          history.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "4px 2px" }}>Sin semanas anteriores todavía.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {history.map((w) => <ChipaHistoryRow key={w.weekStart} week={w} />)}
            </div>
          )
        )}

        {isAdmin && showHistory && (
          <div className="no-print" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #E2E8F0" }}>
            {borrando ? (
              <div style={{ background: "#FEF2F2", border: "1.5px solid #FECACA", borderRadius: 12, padding: "12px 14px" }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: "#B91C1C", marginBottom: 3 }}>Vaciar el historial de Chipa y Aura</div>
                <div style={{ fontSize: 11.5, color: "#7F1D1D", lineHeight: 1.5, marginBottom: 10 }}>
                  Se borran todas las semanas, las dos votaciones y también quiénes votaron, así que las semanas quedan como nuevas y se puede volver a votar. <b>No se puede deshacer.</b> Escribí BORRAR para confirmar.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input value={textoBorrar} onChange={(e) => setTextoBorrar(e.target.value)} placeholder="BORRAR" disabled={borrando === "yendo"}
                    style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, padding: "7px 11px", borderRadius: 8, border: "1.5px solid #FECACA", fontFamily: "inherit", color: "#0F172A", width: 130 }} />
                  <button onClick={borrarHistorial} disabled={borrando === "yendo" || textoBorrar.trim().toUpperCase() !== "BORRAR"}
                    style={{ background: textoBorrar.trim().toUpperCase() === "BORRAR" ? "#B91C1C" : "#CBD5E1", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12.5, fontWeight: 700, fontFamily: "inherit", cursor: textoBorrar.trim().toUpperCase() === "BORRAR" ? "pointer" : "default" }}>
                    {borrando === "yendo" ? "Borrando…" : "Vaciar el historial"}
                  </button>
                  <button onClick={() => { setBorrando(false); setTextoBorrar(""); }} disabled={borrando === "yendo"}
                    style={{ background: "none", color: "#7F1D1D", border: "none", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", padding: "8px 4px" }}>Cancelar</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setBorrando("confirmar")}
                style={{ background: "none", border: "none", fontFamily: "inherit", fontSize: 11.5, fontWeight: 600, color: "#B91C1C", cursor: "pointer", padding: "2px 0" }}>
                Vaciar el historial de Chipa y Aura
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CandidateCard({ name, count, isWinner, premio, disabled, onVote }) {
  const c = COLOR[LEVEL[name]];
  const gana = isWinner && count > 0;
  return (
    <div onClick={disabled ? undefined : onVote} style={{ cursor: disabled ? "default" : "pointer", userSelect: "none", flex: "1 1 130px", maxWidth: 180, textAlign: "center", padding: "16px 10px", borderRadius: 14, background: gana ? premio.ganadorBg : "#fff", border: `2px solid ${gana ? premio.ganadorBd : "#E2E8F0"}`, boxShadow: gana ? `0 0 0 3px ${premio.ganadorBd}44` : "0 1px 3px rgba(15,23,42,.04)", transition: "transform .1s", opacity: disabled ? 0.75 : 1 }}>
      <div style={{ fontSize: 26, marginBottom: 4 }}>{gana ? premio.trofeo : premio.emoji}</div>
      <div style={{ fontWeight: 800, fontSize: 14, color: "#0F172A" }}>{name}</div>
      <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 5px", borderRadius: 3, background: c.solid, color: "#fff", letterSpacing: 0.2 }}>{LEVEL[name]}</span>
      <div style={{ marginTop: 8, fontSize: 20, fontWeight: 800, color: gana ? premio.ganadorTx : "#334155" }}>{count}</div>
      <div style={{ fontSize: 9.5, color: "#64748B", fontWeight: 600 }}>voto{count === 1 ? "" : "s"}</div>
    </div>
  );
}

function ChipaHistoryRow({ week }) {
  const monday = new Date(`${week.weekStart}T12:00:00`);
  // Desde que los candidatos se arman solos, las semanas nuevas no guardan la
  // lista. Para el historial no hace falta: alcanza con quién recibió votos.
  const nombres = week.candidates.length
    ? week.candidates
    : ALL.filter((n) => (week.counts || {})[n] || (week.countsAura || {})[n]);
  const linea = (premio) => {
    const cuenta = (n) => (week[premio.campoVotos] || {})[n] || 0;
    const max = Math.max(0, ...nombres.map(cuenta));
    const ganadores = max > 0 ? nombres.filter((n) => cuenta(n) === max) : [];
    const ordenados = [...nombres].sort((a, b) => cuenta(b) - cuenta(a)).filter(cuenta);
    return (
      <div style={{ marginTop: 5 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: premio.acento }}>
          {premio.emoji} {ganadores.length === 0 ? "Sin votos" : `${premio.trofeo} ${ganadores.join(" y ")}`}
        </div>
        {ordenados.length > 0 && (
          <div style={{ fontSize: 11, color: "#64748B", marginTop: 2 }}>
            {ordenados.map((n) => `${n} (${cuenta(n)})`).join(" · ")}
          </div>
        )}
      </div>
    );
  };
  return (
    <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E2E8F0", padding: "9px 13px" }}>
      <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>{dm(monday)} — {dm(shift(monday, 6))}</div>
      {linea(PREMIOS.chipa)}
      {linea(PREMIOS.aura)}
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

  // Vaciar el historial. Borra las dos colecciones enteras: los votos y también
  // quiénes votaron, así las semanas quedan como nuevas y se podría volver a
  // votar cualquiera de ellas. No hay vuelta atrás, por eso pide escribir
  // BORRAR: un solo click de confirmación es demasiado poco para algo que no se
  // puede deshacer.
  const borrarHistorial = async () => {
    if (!isAdmin || textoBorrar.trim().toUpperCase() !== "BORRAR") return;
    setBorrando("yendo");
    try {
      for (const col of ["chipa_votes", "chipa_voters"]) {
        const snap = await getDocs(collection(db, col));
        await Promise.all(snap.docs.map((d) => deleteDoc(doc(db, col, d.id))));
      }
      setHistory(null); setShowHistory(false);
      setWeek({ weekStart: weekId, candidates: [], counts: {}, countsAura: {} });
      setVoted({ chipa: false, aura: false });
      setStatus("saved"); setTimeout(() => setStatus("idle"), 1800);
    } catch (e) { console.error("borrar historial", e); setStatus("error"); }
    setBorrando(false); setTextoBorrar("");
  };

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
          <div style={{ textAlign: "center", padding: 30, color: "#64748B", fontSize: 12.5, background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0" }}>Sin actividades próximas{isAdmin ? " — tocá \"Agregar actividad\" para cargar la primera." : "."}</div>
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
        <div style={{ fontSize: 10.5, color: "#64748B", fontWeight: 600, marginBottom: 2 }}>{dateLabel}</div>
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
        <div style={{ textAlign: "center", padding: 30, color: "#64748B", fontSize: 12.5, background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0" }}>
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
          <span className="no-print" style={{ display: "inline-block", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s", color: "#64748B", fontSize: 12 }}>▶</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 14.5, color: "#0F172A", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>📄 {articulo.filename || "Artículo"}</div>
            <div style={{ fontSize: 10.5, color: "#64748B", marginTop: 2 }}>{formatFechaHora(articulo.generatedAt)}{isLatest && <span style={{ marginLeft: 6, fontWeight: 700, color: "#16A34A" }}>· más reciente</span>}</div>
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
            <button onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Eliminar artículo" style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 14, fontFamily: "inherit", padding: "2px 2px" }}>🗑️</button>
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

      {isAdmin && <div className="no-print" style={{ fontSize: 10, color: "#64748B", marginBottom: 4, paddingLeft: 2 }}>Arrastrá una sub-pestaña para reordenarlas</div>}
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

      {sub === "guardias_mes" ? (
        <GuardiasSection cobertura={cobertura} isAdmin={isAdmin} />
      ) : sub === "procedimientos" ? (
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
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>RESIDENTE</div>
            <select value={residente} onChange={(e) => setResidente(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {ALL.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>FECHA</div>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>NOTA (OPCIONAL)</div>
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
        <div style={{ textAlign: "center", padding: "30px 20px", color: "#64748B", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
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
                  <button onClick={() => setConfirmId(e.id)} title="Eliminar" style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>🗑️</button>
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

  // Igual que las guardias: no se muestra ni se cuenta nada anterior a
  // septiembre de 2026.
  const lista = useMemo(() => cobertura.filter((e) => (e.fecha || "") >= INICIO_ESTADISTICAS).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")), [cobertura]);
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
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>RESIDENTE (R2/R3)</div>
            <select value={residente} onChange={(e) => setResidente(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {COBERTURA_RESIDENTS.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>FECHA</div>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>MODALIDAD</div>
            <select value={modalidad} onChange={(e) => setModalidad(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {Object.entries(COBERTURA_TIPOS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>NOTA (OPCIONAL)</div>
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
        <div style={{ textAlign: "center", padding: "30px 20px", color: "#64748B", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
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
                    <button onClick={() => setConfirmId(e.id)} title="Eliminar" style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>🗑️</button>
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
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>RESIDENTE</div>
            <select value={residente} onChange={(e) => setResidente(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {ALL.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>MÓDULO</div>
            <select value={modulo} onChange={(e) => setModulo(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {MODULOS_CLASE.map((mo) => <option key={mo} value={mo}>{mo}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>FECHA</div>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>TEMA (OPCIONAL)</div>
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
        <div style={{ textAlign: "center", padding: "30px 20px", color: "#64748B", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
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
                  <button onClick={() => setConfirmId(c.id)} title="Eliminar" style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>🗑️</button>
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
                <span style={{ color: "#64748B", minWidth: 34 }}>{fechaCorta(p.fecha)}</span>
                <span style={{ color: p.nota ? "#475569" : "#CBD5E1", fontStyle: p.nota ? "normal" : "italic", flex: 1 }}>{p.nota || "sin región"}</span>
                <span style={{ fontSize: 9.5, fontWeight: 700, color: em.color, background: em.bg, borderRadius: 999, padding: "1px 7px" }}>{em.label}</span>
                {eliminar && (
                  confirmId === p.id ? (
                    <span style={{ display: "flex", gap: 3 }}>
                      <button onClick={() => eliminar(p.id)} style={{ fontSize: 9.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 5, padding: "2px 7px", cursor: "pointer", fontFamily: "inherit" }}>Sí</button>
                      <button onClick={() => setConfirmId(null)} style={{ fontSize: 9.5, fontWeight: 700, color: "#64748B", background: "#F1F5F9", border: "none", borderRadius: 5, padding: "2px 7px", cursor: "pointer", fontFamily: "inherit" }}>×</button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmId(p.id)} title="Eliminar" style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>🗑️</button>
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
        <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 9.5, color: "#64748B" }}>▶</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: "#0F766E", flex: 1 }}>{tipo}</span>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B" }}>({items.length})</span>
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
          <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 11, color: "#64748B" }}>▶</span>
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
            <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "10px 14px" }}>Sin procedimientos cargados.</div>
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
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>PROCEDIMIENTO</div>
              <select value={tipo} onChange={(e) => setTipo(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", maxWidth: 240 }}>
                {procList.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>FECHA</div>
              <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>NOTA (OPCIONAL)</div>
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
            <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "4px 2px" }}>Todavía no cargaste ninguno.</div>
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
        <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "4px 2px", marginBottom: 18 }}>Todavía no hay procedimientos cargados.</div>
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
                    <button onClick={() => sacarDeLaLista(p)} style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 13, fontFamily: "inherit", lineHeight: 1 }}>×</button>
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
// Hora actual en Buenos Aires (00-23), independiente de la zona horaria del
// celular de quien mira la página — puede estar consultando desde otro lado.
function horaAR() {
  return Number(new Intl.DateTimeFormat("es-AR", { hour: "2-digit", hourCycle: "h23", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date()));
}

// A partir de esta hora ya solo queda el equipo de guardia en el hospital.
const HORA_AVISO_TARDE = 17;
// Hasta esta hora de la mañana sigue en el hospital la guardia de la noche
// anterior; después arranca la actividad normal y está todo el mundo.
const HORA_FIN_GUARDIA = 8;
// A qué hora cambia el día para el servicio. NO es la medianoche: a las 3 de la
// mañana del jueves el que está en la UTI sigue siendo el equipo del miércoles,
// así que hasta esta hora la pantalla tiene que seguir mostrando el miércoles.
const HORA_CAMBIO_DIA = 6;

// La fecha "de hoy" según el servicio, no según el reloj. Se calcula en hora de
// Buenos Aires para que dé lo mismo desde dónde se mire la página: alguien
// consultando desde otro huso tiene que ver el día que se está trabajando acá.
function fechaDeServicio() {
  const ymd = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  const d = new Date(`${ymd}T00:00:00`);
  if (horaAR() < HORA_CAMBIO_DIA) d.setDate(d.getDate() - 1);
  return d;
}

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
  // El día se recalcula solo. Esta pantalla suele quedar abierta toda la noche
  // en el office o en un celular apoyado, así que si el día cambiara únicamente
  // al recargar, a las 6 de la mañana seguiría mostrando el día anterior.
  const [hoyIso, setHoyIso] = useState(() => isoDate(fechaDeServicio()));
  useEffect(() => {
    const t = setInterval(() => setHoyIso((cur) => {
      const ahora = isoDate(fechaDeServicio());
      return ahora === cur ? cur : ahora;
    }), 60 * 1000);
    return () => clearInterval(t);
  }, []);
  const hoy = useMemo(() => new Date(`${hoyIso}T00:00:00`), [hoyIso]);
  const manana = useMemo(() => shift(hoy, 1), [hoy]);
  const ayer = useMemo(() => shift(hoy, -1), [hoy]);
  // Ayer, hoy y mañana pueden caer en hasta tres documentos semanales
  // distintos (si hoy es lunes o domingo), así que se cargan por id y se
  // guardan en un mapa en vez de tener una variable por semana.
  const idsSemanas = useMemo(() => [...new Set([ayer, hoy, manana].map((d) => isoDate(mondayOf(d))))], [ayer, hoy, manana]);
  const claveIds = idsSemanas.join(",");

  const [semanas, setSemanas] = useState({});
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
    const unsubs = claveIds.split(",").map((id) =>
      onSnapshot(doc(db, "scheduler", `week-${id}`), (snap) => {
        setSemanas((cur) => ({ ...cur, [id]: snap.exists() ? normalize(snap.data()) : emptyWeek() }));
        setLoading(false);
      }, () => setLoading(false))
    );
    return () => unsubs.forEach((u) => u());
  }, [claveIds]);

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

  const diaDe = (fecha) => {
    const w = semanas[isoDate(mondayOf(fecha))];
    return w ? w.days[diOfDate(fecha)] : null;
  };
  const diaHoy = diaDe(hoy);
  const diaManana = diaDe(manana);

  // Quién está realmente en el hospital en este momento. La guardia arranca a
  // la tarde y termina a la mañana siguiente, así que de madrugada el que está
  // es el de la guardia de AYER, no el de hoy. Durante el día (08 a 17) está
  // todo el mundo, así que no hay a quién advertir.
  const guardiaActiva = useMemo(() => {
    const h = horaAR();
    // De la tarde en adelante, y también de madrugada, el que está es el equipo
    // de guardia del día de servicio en curso — que de madrugada ya es el día
    // anterior del calendario, porque el día recién cambia a las 6.
    if (h >= HORA_AVISO_TARDE || h < HORA_CAMBIO_DIA) return parseDeGuardia((diaHoy || {}).deGuardia);
    // Entre las 6 y las 8 el día ya dio vuelta pero la guardia de anoche sigue
    // en el hospital hasta que entrega.
    if (h < HORA_FIN_GUARDIA) return parseDeGuardia((diaDe(ayer) || {}).deGuardia);
    return null; // horario de actividad normal: nadie está "fuera del hospital"
  }, [semanas, diaHoy, ayer, hoy]);

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
                  <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", marginTop: 4 }}>Sin observaciones cargadas.</div>
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
          guardiaActiva={guardiaActiva}
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
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 16, marginBottom: 12, textAlign: "center", color: "#64748B", fontSize: 12.5 }}>
        {emoji} {label} — todavía no hay calendario cargado para esta semana.
      </div>
    );
  }

  return (
    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(15,23,42,.04)", overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "11px 16px", background: "#F8FAFC", borderBottom: "1px solid #F1F5F9", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: "#0F172A" }}>{emoji} {label}</div>
          <div style={{ fontSize: 10.5, color: "#64748B", marginTop: 1, textTransform: "capitalize" }}>{fechaLabel}</div>
        </div>
        {feriado
          ? <span style={{ fontSize: 9.5, fontWeight: 800, color: "#92400E", background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 999, padding: "2px 9px" }}>🎌 FERIADO</span>
          : weekend && <span style={{ fontSize: 9.5, fontWeight: 800, color: "#64748B", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 999, padding: "2px 9px" }}>FIN DE SEMANA</span>}
      </div>

      <div style={{ padding: "10px 16px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        <FilaDeGuardia lista={dia.deGuardia} onPick={onPick} />

        {sinCamas ? (
          <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic" }}>UTI 1, UTI 2 y UTI 3 no aplican {feriado ? "los feriados" : "los fines de semana"} — cobertura por guardia y postguardia.</div>
        ) : (
          SLOTS.filter((s) => s.key !== "postguardia").map((slot) => (
            <FilaResidentes key={slot.key} label={slot.label} color={slot.accent} nombres={dia[slot.key]} onPick={onPick} />
          ))
        )}

        <FilaResidentes label="Postguardia" color={SLOTS[3].accent} nombres={dia.postguardia} onPick={onPick} />
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
    <div style={{ background: FILA_GUARDIA.tint, border: `1.5px solid ${FILA_GUARDIA.rotulo}`, borderRadius: 12, padding: "9px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 800, color: FILA_GUARDIA.accent, letterSpacing: 0.4, textTransform: "uppercase" }}>
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
        <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic" }}>Sin asignar.</div>
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
    <button onClick={() => onPick(persona)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 9px", borderRadius: 999, background: c.bg, border: `1.5px solid ${c.bd}`, color: c.tx, fontWeight: 700, fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", ...(esResidente && LEVEL[persona.key] === "JR" ? SKIN_JR : {}) }}>
      {esResidente && LEVEL[persona.key] === "JR" && "👑"}
      {persona.nombre}
      <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: esResidente && LEVEL[persona.key] === "JR" ? "rgba(69,26,3,.55)" : c.solid, color: "#fff", textShadow: "none" }}>{esResidente ? LEVEL[persona.key] : "—"}</span>
    </button>
  );
}

function PersonaModal({ persona, telefono, isAdmin, editing, draft, onDraftChange, onEdit, onSave, onCancelEdit, onClose, guardiaActiva }) {
  const esResidente = persona.tipo === "residente";
  // Si hay una guardia activa (tarde/noche/madrugada) y esta persona no está
  // en ella, no está en el hospital ahora. Se avisa, pero el teléfono y el
  // botón de WhatsApp se muestran igual: puede haber motivos para llamarla.
  const fueraDelHospital = !!guardiaActiva && !guardiaActiva.some((p) => p.key === persona.key);
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

        {fueraDelHospital && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}>
            <span style={{ fontSize: 15, lineHeight: 1.2 }}>🌙</span>
            <div style={{ fontSize: 12, color: "#92400E", lineHeight: 1.5, fontWeight: 600 }}>
              No se encuentra en el hospital en este momento, contáctese con los médicos de guardia.
            </div>
          </div>
        )}

        {isAdmin && editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            <input value={draft} onChange={(e) => onDraftChange(e.target.value)} placeholder="Ej: 5491122334455 (con 549 adelante, sin espacios ni guiones)" style={{ ...INPUT, width: "100%", boxSizing: "border-box" }} />
            {!esResidente && <div style={{ fontSize: 10.5, color: "#64748B", lineHeight: 1.4 }}>Este contacto no es ninguno de los 12 residentes, así que se guarda solo 15 días y después se borra solo, para no acumular números viejos.</div>}
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
              <div style={{ fontSize: 12.5, color: "#64748B", fontStyle: "italic" }}>Todavía no hay un teléfono cargado para {persona.nombre}.</div>
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
          <button onClick={onClose} style={{ background: "none", color: "#64748B", border: "none", padding: "8px 16px", fontWeight: 600, fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" }}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════ IMPRESIONES ══════════════════ */

// Arma el mes entero en una sola hoja A4 horizontal, listo para imprimir o
// guardar como PDF y repartir en papel. Lee las semanas reales de Firestore,
// así que siempre refleja lo que está cargado hoy. Se abre en una ventana
// nueva con su propio CSS de impresión, igual que el PDF de procedimientos.
// Fecha de emisión, para el sello de las hojas definitivas.
function hoyTexto() {
  const h = new Date();
  return `${h.getDate()} de ${MONTHS[h.getMonth()].toLowerCase()} de ${h.getFullYear()}`;
}

// Vista previa de una hoja. Es el mismo HTML que sale por la impresora, metido
// en un iframe y escalado para que entre en el ancho que haya. Se usa un
// iframe y no un div para que el CSS de la hoja no se mezcle con el de la app.
function HojaPreview({ html }) {
  const cont = useRef(null);
  const [k, setK] = useState(1);
  // Exactamente el área imprimible de una A4 apaisada a 96 dpi, la misma que
  // usa el ajuste dentro de la hoja. Así la vista previa es la hoja entera, ni
  // recortada ni con espacio de más.
  const ANCHO = 1030, alto = 716;
  useEffect(() => {
    const medir = () => {
      const w = cont.current ? cont.current.clientWidth : ANCHO;
      setK(Math.min(1, w / ANCHO));
    };
    medir();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(medir) : null;
    if (ro && cont.current) ro.observe(cont.current);
    window.addEventListener("resize", medir);
    return () => { if (ro) ro.disconnect(); window.removeEventListener("resize", medir); };
  }, []);
  return (
    <div ref={cont} style={{ width: "100%", height: alto * k, overflow: "hidden", borderRadius: 10, border: "1px solid #E2E8F0", background: "#fff" }}>
      {html
        ? <iframe title="vista previa" srcDoc={hojaAjustada(html, false)} sandbox="allow-scripts" scrolling="no"
            style={{ width: ANCHO, height: alto, border: "none", transform: `scale(${k})`, transformOrigin: "top left", display: "block" }} />
        : <div style={{ padding: 26, fontSize: 12.5, color: "#64748B" }}>Cargando el cronograma…</div>}
    </div>
  );
}

function ImpresionesView({ user, isAdmin }) {
  const mesDeHoy = () => {
    const h = new Date();
    const a = Math.max(0, (h.getFullYear() - MES_INICIO_ESTADISTICAS.anio) * 12 + h.getMonth() - MES_INICIO_ESTADISTICAS.mes);
    const d = new Date(MES_INICIO_ESTADISTICAS.anio, MES_INICIO_ESTADISTICAS.mes + a, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const [mesSel, setMesSel] = useState(mesDeHoy);
  const [mesOtro, setMesOtro] = useState(mesDeHoy);
  const [semanaSel, setSemanaSel] = useState(() => isoDate(mondayOf(new Date())));
  const [queOtro, setQueOtro] = useState("salas");
  const [bnOtro, setBnOtro] = useState(true);
  const [borradorPedido, setBorradorPedido] = useState(false);
  const [vista, setVista] = useState(false); // false = color en pantalla
  // Solo la jefatura puede emitir una hoja con sello DEFINITIVO. Para todos los
  // demás la hoja sale marcada como borrador, con marca de agua y con su mail
  // impreso al pie, así una copia que circule siempre se puede rastrear.
  const borrador = isAdmin ? borradorPedido : true;
  const emisor = user ? [user.displayName, user.email].filter(Boolean).join(" · ") : "";
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState(null);
  const [datosMes, setDatosMes] = useState(null);

  const [y, m] = mesSel.split("-").map(Number);
  const anio = y, mes = m - 1;

  // Trae todo lo que necesita una hoja del mes: las semanas que lo tocan, las
  // rotaciones del año y los equipos por UTI.
  const cargarMes = async (a, ms) => {
    const lunes = lunesQueTocanElMes(a, ms);
    const semanas = {};
    for (const l of lunes) {
      const snap = await getDoc(doc(db, "scheduler", `week-${isoDate(l)}`));
      semanas[isoDate(l)] = snap.exists() ? normalize(snap.data()) : emptyWeek();
    }
    const rotSnap = await getDoc(doc(db, "scheduler", `rotaciones-${a}`));
    const rot = rotSnap.exists() ? normalizeRot(rotSnap.data()) : emptyRotYear();
    const eqSnap = await getDoc(doc(db, "scheduler", "equipos"));
    const clave = `${a}-${String(ms + 1).padStart(2, "0")}`;
    const equipos = (eqSnap.exists() ? eqSnap.data() : {})[clave] || {};
    return { anio: a, mes: ms, lunes, semanas, rot, equipos };
  };

  // Los dos cronogramas de arriba se muestran solos al entrar y se rearman
  // cada vez que se cambia el mes.
  useEffect(() => {
    let vivo = true;
    setDatosMes(null); setAviso(null);
    cargarMes(anio, mes)
      .then((d) => { if (vivo) setDatosMes(d); })
      .catch((e) => { console.error(e); if (vivo) setAviso("No se pudieron leer los cronogramas de este mes."); });
    return () => { vivo = false; };
  }, [anio, mes]);

  const htmlSalas = useMemo(() => datosMes && htmlMes({ ...datosMes, tipo: "salas", borrador, emisor, bn: vista }), [datosMes, borrador, emisor, vista]);
  const htmlGuardias = useMemo(() => datosMes && htmlMes({ ...datosMes, tipo: "guardias", borrador, emisor, bn: vista }), [datosMes, borrador, emisor, vista]);

  // Imprimir lo que se está viendo: se rearma la hoja con el color pedido y se
  // abre en una pestaña nueva con el diálogo de impresión.
  const imprimirEsto = (tipo, bn) => {
    if (!datosMes) return;
    abrirBorrador({ ...datosMes, tipo, borrador, emisor, bn });
  };

  const generarOtro = async () => {
    setGenerando(true); setAviso(null);
    try {
      if (queOtro === "semana") {
        const lunes = new Date(`${semanaSel}T00:00:00`);
        const snap = await getDoc(doc(db, "scheduler", `week-${isoDate(lunes)}`));
        const week = snap.exists() ? normalize(snap.data()) : emptyWeek();
        const eqSnap = await getDoc(doc(db, "scheduler", "equipos"));
        const equipos = (eqSnap.exists() ? eqSnap.data() : {})[mesDeLaSemana(lunes)] || {};
        abrirSemana({ lunes, week, equipos, borrador, emisor, bn: bnOtro });
      } else {
        const [a, ms] = mesOtro.split("-").map(Number);
        const d = await cargarMes(a, ms - 1);
        abrirBorrador({ ...d, tipo: queOtro, borrador, emisor, bn: bnOtro });
      }
    } catch (e) {
      console.error(e); setAviso("No se pudo generar la hoja.");
    }
    setGenerando(false);
  };

  // Nada anterior a septiembre de 2026: antes de eso el scheduler no estaba
  // cargado y una hoja de esos meses saldría vacía.
  const opcionesMes = useMemo(() => {
    const hoy = new Date();
    const desde = new Date(MES_INICIO_ESTADISTICAS.anio, MES_INICIO_ESTADISTICAS.mes, 1);
    const hasta = new Date(hoy.getFullYear(), hoy.getMonth() + 5, 1);
    const out = [];
    for (const d = new Date(desde); d <= hasta; d.setMonth(d.getMonth() + 1)) {
      out.push({ clave: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
    }
    return out;
  }, []);

  // Las semanas de la lista arrancan también en septiembre de 2026.
  const opcionesSemana = useMemo(() => {
    const base = mondayOf(new Date());
    const piso = mondayOf(new Date(MES_INICIO_ESTADISTICAS.anio, MES_INICIO_ESTADISTICAS.mes, 1));
    const estaSemana = isoDate(base);
    const out = [];
    for (let i = -12; i <= 20; i++) {
      const l = shift(base, i * 7);
      if (isoDate(l) < isoDate(piso)) continue;
      const f = shift(l, 6);
      const mismo = l.getMonth() === f.getMonth();
      const label = mismo
        ? `${l.getDate()} al ${f.getDate()} de ${MONTHS[l.getMonth()].toLowerCase()} ${f.getFullYear()}`
        : `${l.getDate()} de ${MONTHS[l.getMonth()].toLowerCase()} al ${f.getDate()} de ${MONTHS[f.getMonth()].toLowerCase()} ${f.getFullYear()}`;
      out.push({ clave: isoDate(l), label: label + (isoDate(l) === estaSemana ? "  ·  esta semana" : "") });
    }
    return out;
  }, []);

  const btn = (bg) => ({ background: bg, color: "#fff", border: "none", borderRadius: 9, padding: "9px 16px", fontSize: 12.5, fontWeight: 700, cursor: generando ? "default" : "pointer", fontFamily: "inherit", opacity: generando ? 0.6 : 1 });
  const caja = { background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 16, marginBottom: 12 };
  const sel = { fontSize: 13, padding: "8px 10px", borderRadius: 8, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" };
  const rotulo = { fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 };

  const bloquePrevia = (titulo, bajada, color, tipo, html) => (
    <div style={caja}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 11 }}>
        <div style={{ flex: "1 1 300px" }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color, marginBottom: 2 }}>{titulo}</div>
          <div style={{ fontSize: 11.5, color: "#475569", lineHeight: 1.5 }}>{bajada}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => imprimirEsto(tipo, true)} disabled={!datosMes} style={{ ...btn("#0F172A"), opacity: datosMes ? 1 : 0.5 }}>◻︎ Imprimir en blanco y negro</button>
          <button onClick={() => imprimirEsto(tipo, false)} disabled={!datosMes} style={{ ...btn(color), opacity: datosMes ? 1 : 0.5 }}>🎨 Imprimir en color</button>
        </div>
      </div>
      <HojaPreview html={html} />
    </div>
  );

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <span style={{ fontSize: 22 }}>🖨️</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Ver cronogramas, guardias e imprimir</div>
          <div style={{ fontSize: 10.5, opacity: 0.7 }}>El mes en pantalla, tal cual sale por la impresora</div>
        </div>
      </div>

      {/* Mes que se está mirando, sello y color de la pantalla. */}
      <div style={{ ...caja, background: borrador ? "#FEF2F2" : "#fff", borderColor: borrador ? "#FECACA" : "#E2E8F0" }}>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>

          <div style={{ flex: "0 0 auto" }}>
            <div style={rotulo}>MES QUE SE VE</div>
            <select value={mesSel} onChange={(e) => setMesSel(e.target.value)} style={{ ...sel, fontWeight: 700 }}>
              {opcionesMes.map((o) => <option key={o.clave} value={o.clave}>{o.label}</option>)}
            </select>
          </div>

          <div style={{ flex: "0 0 auto" }}>
            <div style={rotulo}>CÓMO SE VE EN PANTALLA</div>
            <div style={{ display: "inline-flex", borderRadius: 9, border: "1px solid #E2E8F0", overflow: "hidden" }}>
              {[{ v: false, t: "🎨 Color" }, { v: true, t: "◻︎ Blanco y negro" }].map((o) => (
                <button key={String(o.v)} onClick={() => setVista(o.v)} style={{ border: "none", padding: "8px 13px", fontSize: 12.5, fontWeight: 700, fontFamily: "inherit", cursor: "pointer", background: vista === o.v ? "#0F172A" : "#fff", color: vista === o.v ? "#fff" : "#475569" }}>{o.t}</button>
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: "#64748B", marginTop: 5, maxWidth: 250, lineHeight: 1.45 }}>
              Es solo para mirar. Al imprimir elegís el color en cada cronograma.
            </div>
          </div>

          <div style={{ flex: "1 1 280px", borderLeft: "1px solid #E2E8F0", paddingLeft: 18 }}>
            <div style={{ ...rotulo, marginBottom: 6 }}>SELLO</div>
            {isAdmin ? (
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={borradorPedido} onChange={(e) => setBorradorPedido(e.target.checked)} style={{ width: 17, height: 17, marginTop: 1, accentColor: "#B91C1C", cursor: "pointer" }} />
                <span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: borrador ? "#B91C1C" : "#0F172A" }}>Marcar como borrador</span>
                  <span style={{ display: "block", fontSize: 11.5, color: "#475569", lineHeight: 1.5, marginTop: 2 }}>
                    {borrador
                      ? "Sale con sello rojo y marca de agua, para que nadie la tome como firme."
                      : "Sale como DEFINITIVO con la fecha de emisión. Tildá esto si todavía puede cambiar algo."}
                  </span>
                </span>
              </label>
            ) : (
              <div style={{ fontSize: 11.5, color: "#475569", lineHeight: 1.55 }}>
                <span style={{ display: "inline-block", fontSize: 10, fontWeight: 800, background: "#B91C1C", color: "#fff", padding: "2px 7px", borderRadius: 4, marginBottom: 5 }}>BORRADOR</span>
                <br />Todo lo que descargues sale marcado como borrador, con tu nombre y tu mail al pie de la hoja. La versión definitiva la emite únicamente la jefatura de residentes.
              </div>
            )}
          </div>

        </div>
      </div>

      {aviso && <Banner tone="warn">{aviso}</Banner>}

      {/* ── Los dos cronogramas del mes, a la vista ── */}
      {bloquePrevia(
        `🏥 Cobertura de salas · ${MONTHS[mes]} ${anio}`,
        "Las tres salas día por día, postguardia, guardia, equipos por UTI, días libres de los R4 y quién está afuera por rotación o vacaciones.",
        "#0F172A", "salas", htmlSalas)}

      {bloquePrevia(
        `🌙 Guardias · ${MONTHS[mes]} ${anio}`,
        "Solo quién está de guardia cada día, en grande, con el conteo por persona y por nivel. Es el que conviene pegar en la pared.",
        "#9F1239", "guardias", htmlGuardias)}

      {/* ── Cualquier otro cronograma ── */}
      <div style={caja}>
        <div style={{ fontSize: 13.5, fontWeight: 800, color: "#0F172A", marginBottom: 3 }}>⬇️ Descargar otro cronograma</div>
        <div style={{ fontSize: 11.5, color: "#475569", lineHeight: 1.55, marginBottom: 13 }}>
          Cualquier mes desde septiembre de 2026, o una semana suelta con la misma grilla de la pestaña Semana. Se abre el diálogo de impresión: elegí "Guardar como PDF" en Destino si querés el archivo.
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={rotulo}>QUÉ</div>
            <select value={queOtro} onChange={(e) => setQueOtro(e.target.value)} style={sel}>
              <option value="salas">🏥 Cobertura de salas del mes</option>
              <option value="guardias">🌙 Guardias del mes</option>
              <option value="semana">📅 Una semana</option>
            </select>
          </div>
          {queOtro === "semana" ? (
            <div>
              <div style={rotulo}>SEMANA</div>
              <select value={semanaSel} onChange={(e) => setSemanaSel(e.target.value)} style={sel}>
                {opcionesSemana.map((o) => <option key={o.clave} value={o.clave}>{o.label}</option>)}
              </select>
            </div>
          ) : (
            <div>
              <div style={rotulo}>MES</div>
              <select value={mesOtro} onChange={(e) => setMesOtro(e.target.value)} style={sel}>
                {opcionesMes.map((o) => <option key={o.clave} value={o.clave}>{o.label}</option>)}
              </select>
            </div>
          )}
          <div>
            <div style={rotulo}>COLOR</div>
            <select value={bnOtro ? "bn" : "color"} onChange={(e) => setBnOtro(e.target.value === "bn")} style={sel}>
              <option value="bn">◻︎ Blanco y negro</option>
              <option value="color">🎨 Color</option>
            </select>
          </div>
          <button onClick={generarOtro} disabled={generando} style={btn("#0E7490")}>
            {generando ? "Armando…" : "⬇️ Generar"}
          </button>
        </div>
        <div style={{ fontSize: 11, color: "#64748B", lineHeight: 1.5, marginTop: 11 }}>
          En blanco y negro el nivel se distingue por el borde del chip —R4 grueso, R3 fino, R2 punteado—, así que no hace falta color para leerlo.
        </div>
      </div>

      <div style={{ fontSize: 11, color: "#64748B", lineHeight: 1.55, padding: "4px 2px" }}>
        Todo lo que se emita queda firmado con {emisor ? <b>{emisor}</b> : "la cuenta con la que entraste"}.
      </div>
    </div>
  );
}

// Hoja de una semana suelta: es la grilla de la pestaña Semana pasada a una
// tabla propia, en vez de imprimir el DOM de la app. Se genera igual que las
// hojas del mes (ventana nueva con su CSS), así se puede imprimir cualquier
// semana sin tener que navegar hasta ella primero.
// ── Cocina común de las hojas impresas ────────────────────────────────────
// Las tres hojas (semana, cobertura del mes, guardias del mes) comparten la
// paleta, el sello, la marca de agua y el ajuste a una sola página. Todo lo que
// cambie acá cambia en las tres a la vez, que es justamente lo que se quiere.

// Modo color y modo blanco y negro. El modo B/N no es "el color pasado a
// gris": los grises quedan todos parecidos al imprimir en láser. Lo que hace
// es cambiar el canal por el que se distingue el nivel — en vez del color del
// chip, el borde: R4 grueso, R3 fino, R2 punteado, JR doble — y dejar el resto
// en blanco y negro puro, que es lo que mejor sale en cualquier impresora.
function paletaImpresion(bn) {
  if (!bn) {
    return {
      bn: false,
      chips: { R2: ["#DBEAFE", "#93C5FD", "#1E3A8A", "#3B82F6"], R3: ["#D1FAE5", "#6EE7B7", "#065F46", "#10B981"], R4: ["#FFEDD5", "#FDBA74", "#9A3412", "#F97316"], JR: ["#FEF3C7", "#FCD34D", "#78350F", "#D97706"] },
      borde: { R2: "1.2px solid", R3: "1.2px solid", R4: "1.2px solid", JR: "1.2px solid" },
      fila: { uti1: "#0E7490", uti2: "#BE185D", uti3: "#A16207", postguardia: "#A855F7", guardia: "#9F1239", fuera: "#475569" },
      finde: "#F8FAFC", off: "#F1F5F9", obs: ["#FEF9C3", "#713F12"], rec: ["#EFF6FF", "#1E3A8A"],
      leyenda: "",
      tagBorrador: "#B91C1C",
    };
  }
  return {
    bn: true,
    chips: { R2: ["#fff", "#111827", "#111827", "#111827"], R3: ["#fff", "#111827", "#111827", "#111827"], R4: ["#fff", "#111827", "#111827", "#111827"], JR: ["#fff", "#111827", "#111827", "#111827"] },
    borde: { R2: "1.2px dashed", R3: "1.2px solid", R4: "2.2px solid", JR: "3px double" },
    fila: { uti1: "#111827", uti2: "#374151", uti3: "#4B5563", postguardia: "#6B7280", guardia: "#111827", fuera: "#6B7280" },
    finde: "#EEEEEE", off: "#DDDDDD", obs: ["#fff", "#111827"], rec: ["#fff", "#111827"],
    leyenda: " · <b>Niveles:</b> R4 borde grueso · R3 borde fino · R2 borde punteado · JR borde doble.",
    tagBorrador: "#111827",
  };
}

// Un chip de residente, en el modo que corresponda. Se usa igual en las tres
// hojas para que un papel se lea igual que otro.
function chipImpreso(n, P, esc) {
  const lv = LEVEL[n];
  const c = P.chips[lv] || (P.bn ? ["#fff", "#6B7280", "#374151", "#6B7280"] : ["#F1F5F9", "#CBD5E1", "#475569", "#94A3B8"]);
  const b = P.borde[lv] || (P.bn ? "1px dotted" : "1.2px solid");
  return `<span class="chip" style="background:${c[0]};border:${b} ${c[1]};color:${c[2]}">${esc(n)}${lv ? `<b style="background:${c[3]}">${lv}</b>` : ""}</span>`;
}

// Sello, marca de agua y pie de autoría. Solo el admin puede emitir una hoja
// con sello DEFINITIVO: para cualquier otra persona la hoja sale marcada como
// borrador, con marca de agua y con su mail impreso, así una copia que circule
// siempre se puede rastrear hasta quién la sacó.
function selloImpresion({ borrador, emisor, esc }) {
  const fecha = hoyTexto();
  if (borrador) {
    return {
      sello: '<div class="tag borrador">BORRADOR — SUJETO A CAMBIOS</div>',
      agua: '<div class="agua">BORRADOR</div>',
      pie: `<b>Borrador.</b> No es la versión definitiva del cronograma. Descargado por ${esc(emisor || "usuario sin identificar")} el ${fecha}.`,
    };
  }
  return {
    sello: `<div class="tag firme">DEFINITIVO<span>emitido el ${fecha}</span></div>`,
    agua: "",
    pie: `<b>Versión definitiva.</b> Emitida por la jefatura de residentes el ${fecha}.`,
  };
}

// CSS que comparten las tres hojas.
const CSS_IMPRESION = `
@page{size:A4 landscape;margin:8mm}
/* En el diálogo de Chrome la casilla "Gráficos de fondo" viene DESTILDADA por
   defecto, y sin esto los chips salen en blanco: se pierde el color y, peor, en
   blanco y negro se pierde el relleno que separa un chip del otro. Puesto en *
   y no solo en body para que no dependa de la herencia. */
*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Inter',system-ui,sans-serif;color:#0F172A;font-size:10px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1{font-size:17px;letter-spacing:-.3px}
.sub{font-size:10px;color:#475569}
.head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2.5px solid #0F172A;padding-bottom:4px;margin-bottom:5px}
.tag{font-size:9.5px;font-weight:800;color:#fff;padding:3px 9px;border-radius:5px;white-space:nowrap}
.tag.firme{background:#0F172A}
.tag.firme span{display:block;font-size:7.5px;font-weight:600;opacity:.75;letter-spacing:.2px}
.tag.borrador{background:#B91C1C}
.agua{position:fixed;top:30%;left:0;right:0;text-align:center;font-size:130px;font-weight:800;color:rgba(120,120,120,.13);letter-spacing:16px;transform:rotate(-18deg);pointer-events:none;z-index:0}
.head,.bloques,table,.pie{position:relative;z-index:1}
.bloques{display:flex;gap:7px;margin-bottom:5px}
.bloque{flex:1;border:1.5px solid #94A3B8;border-radius:7px;padding:4px 7px}
.bloque h3{font-size:8.5px;text-transform:uppercase;letter-spacing:.5px;color:#334155;margin-bottom:2px}
.eq,.par{display:inline-flex;align-items:center;gap:4px;margin:0 8px 1px 0;flex-wrap:wrap}
.eqn{font-size:11px;font-weight:800;padding:2.5px 7px;border-radius:4px}
.txt{font-size:11px;color:#334155}
/* Los chips son lo que la gente lee de lejos y a contraluz en el office, así que
   van grandes a propósito y todo lo demás de la hoja se apretó para pagarlos.
   Suena contraintuitivo agrandarlos cuando la hoja tiene que entrar en una
   página, pero funciona: el ajuste maqueta el body a 1030/zoom px de
   ancho, así que un tipo más grande baja el zoom y a la vez ensancha las
   columnas en la misma proporción. Lo único que se paga es el tamaño relativo
   del título y los rótulos, que es exactamente lo que sobra en esta hoja.
   El badge de nivel va en em para que crezca con el chip. */
.chip{display:inline-flex;align-items:center;gap:3px;border-radius:10px;padding:1.5px 7px;font-size:17px;font-weight:700;margin:.5px;white-space:nowrap}
.chip b{font-size:.6em;color:#fff;padding:.5px 3.5px;border-radius:3px;font-weight:800}
table{width:100%;border-collapse:collapse;table-layout:fixed}
.nota{font-size:11px;color:#64748B;font-style:italic}
.pie{margin-top:4px;font-size:8px;color:#334155;line-height:1.4;border-top:1px solid #94A3B8;padding-top:4px;break-inside:avoid;page-break-inside:avoid}
table{break-inside:auto}
tr{break-inside:avoid;page-break-inside:avoid}
`;

// El ajuste a una sola página corre DENTRO de la hoja, no desde la app. Así la
// misma hoja se comporta igual en la ventana de impresión y en el iframe de la
// vista previa: lo que se ve en pantalla es literalmente lo que sale impreso.
//
// Cómo funciona: la hoja se maqueta a PW/z píxeles de ancho y después se escala
// por z, así que el alto impreso es alto(PW/z) * z. Se busca el z más grande
// que todavía entra, por bisección.
//
// OJO, dos cosas que ya se aprendieron a los golpes y no hay que deshacer:
//
// 1) Acá antes había un punto fijo (z = PH/alto, repetido) y ESTABA MAL.
//    Oscilaba en vez de converger: al bajar el zoom la hoja se maqueta más
//    ancha, entonces se vuelve más baja, entonces permite subir el zoom, que la
//    angosta de nuevo. Con letra chica el rebote no se notaba; al agrandar los
//    chips se hizo grande y la hoja salía en dos páginas.
// 2) La altura se mide aplicando el zoom de verdad, no escalando una medición
//    hecha a zoom 1. Chrome redondea cada caja al aplicar zoom y con treinta y
//    pico de filas ese redondeo suma varios puntos porcentuales de alto.
//
// El zoom puede pasar de 1: si sobra papel la hoja se agranda hasta llenar la
// página, que es lo que hace que un mes flaco no salga con letra diminuta.
const AJUSTE_HOJA_JS = `
(function(){
  var body=document.body, PW=1030, MAXZ=1.75;
  // Cuánto alto queda para la hoja. En una compu son 716 px: A4 apaisada a
  // 96 dpi menos los márgenes de @page.
  //
  // En iPhone y iPad hay que reservar más. El diálogo de impresión de iOS
  // estampa SIEMPRE un encabezado y un pie propios —la URL, la fecha y el
  // "Página 1 de 2"— y, a diferencia de Chrome en la compu, no hay ninguna
  // casilla para desactivarlos. Eso se come alto de la hoja, y como el sistema
  // no expone cuánto se quedó, no queda otra que reservárselo de antemano. Sin
  // esta reserva la hoja pasa apenas del alto útil y septiembre salía en dos
  // páginas: la primera completa y la segunda con el pie de la hoja solo.
  var esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var PH = esIOS ? 652 : 716;
  // OJO: acá NO se puede usar documentElement.scrollHeight. Nunca devuelve menos
  // que el alto del viewport, así que en una ventana alta —la de cualquiera con
  // la pantalla maximizada— el alto medido se quedaba clavado en el alto de la
  // ventana por más que la hoja se achicara, la bisección se iba hasta el piso
  // y la hoja salía maquetada a tres mil y pico de píxeles: en el papel, una
  // guarda chiquita arriba de una hoja vacía. En headless no se veía porque la
  // ventana es más baja que la hoja. body.scrollHeight es el alto real del
  // contenido y no depende del viewport; por el zoom va en unidades locales,
  // así que se multiplica por z para tenerlo en píxeles impresos.
  function alturaCon(z){ _z=z; body.style.width=(PW/z)+"px"; body.style.zoom=String(z); return body.scrollHeight*z; }
  function anchoDesborda(){ return body.scrollWidth*z0() > PW+2; }
  var _z=1; function z0(){ return _z; }
  function ajustar(){
    var z=1;
    try{
      if(alturaCon(1)>PH){
        var lo=0.3,hi=1;
        for(var i=0;i<12;i++){ var m=(lo+hi)/2; if(alturaCon(m)<=PH) lo=m; else hi=m; }
        z=lo;
      } else if(!anchoDesborda()){
        var lo2=1,hi2=MAXZ;
        for(var j=0;j<10;j++){ var m2=(lo2+hi2)/2;
          if(alturaCon(m2)<=PH && !anchoDesborda()) lo2=m2; else hi2=m2; }
        z=lo2;
      }
      alturaCon(z);
    }catch(e){ /* si algo falla se muestra igual, sin ajustar */ }
  }
  function arrancar(){ ajustar(); if(window.__imprimirAlAjustar){ setTimeout(function(){ window.focus(); window.print(); }, 150); } }
  var f=document.fonts && document.fonts.ready;
  if(f && typeof f.then==="function") f.then(function(){ setTimeout(arrancar,80); }).catch(function(){ setTimeout(arrancar,400); });
  else setTimeout(arrancar,400);
})();`;

// Le pega el ajuste a la hoja. Con imprimir=true además dispara la impresión.
function hojaAjustada(html, imprimir) {
  const script = `<script>${imprimir ? "window.__imprimirAlAjustar=true;" : ""}${AJUSTE_HOJA_JS}<\/script></body>`;
  return html.replace("</body>", script);
}

// Las hojas se arman como un documento HTML completo y recién después se decide
// a dónde va: a una ventana nueva para imprimir, o al iframe de la vista previa.
function abrirHoja(html) {
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(hojaAjustada(html, true));
  win.document.close();
}

function htmlSemana({ lunes, week, equipos, borrador, emisor, bn }) {
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const P = paletaImpresion(bn);
  const chip = (n) => chipImpreso(n, P, esc);
  const { sello, agua, pie } = selloImpresion({ borrador, emisor, esc });

  const fechas = DAYS.map((_, i) => shift(lunes, i));
  const fin = fechas[6];
  const rango = lunes.getMonth() === fin.getMonth()
    ? `${lunes.getDate()} al ${fin.getDate()} de ${MONTHS[lunes.getMonth()].toLowerCase()} de ${fin.getFullYear()}`
    : `${lunes.getDate()} de ${MONTHS[lunes.getMonth()].toLowerCase()} al ${fin.getDate()} de ${MONTHS[fin.getMonth()].toLowerCase()} de ${fin.getFullYear()}`;

  const celdaSlot = (key, di) => {
    const d = week.days[di];
    const bloqueada = (isWeekendIdx(di) || d.feriado) && key !== "postguardia";
    if (bloqueada) return `<td class="finde"><span class="nota">sin sala</span></td>`;
    const gente = [...(d[key] || [])].sort(porJerarquia);
    return `<td class="${isWeekendIdx(di) || d.feriado ? "finde" : ""}">${gente.length ? gente.map(chip).join("") : '<span class="nota">—</span>'}</td>`;
  };
  const filaSlot = (sl) => `<tr><th class="lbl" style="background:${P.fila[sl.key]}">${sl.label}</th>${DAYS.map((_, di) => celdaSlot(sl.key, di)).join("")}</tr>`;

  const filaGuardia = `<tr><th class="lbl" style="background:${P.fila.guardia}">De guardia<span>desde las 16 h</span></th>${DAYS.map((_, di) => {
    const g = [...(week.days[di].deGuardia || [])].sort(porJerarquia);
    return `<td class="g">${g.length ? g.map(chip).join("") : '<span class="nota">sin cargar</span>'}</td>`;
  }).join("")}</tr>`;

  const filaTexto = (label, campo, clase) => {
    if (!DAYS.some((_, di) => (week.days[di][campo] || "").trim())) return "";
    return `<tr><th class="lbl" style="background:#94A3B8">${label}</th>${DAYS.map((_, di) =>
      `<td class="${clase}">${esc((week.days[di][campo] || "").trim())}</td>`).join("")}</tr>`;
  };

  const libresHtml = RESIDENTS.R4.filter((n) => week.diasLibresR4[n]).map((n) =>
    `<span class="par">${chip(n)}<span class="txt">${week.diasLibresR4[n]}</span></span>`).join("") || '<span class="nota">sin cargar</span>';
  const eqHtml = EQUIPO_SLOTS.filter((sl) => (equipos[sl.key] || []).length).map((sl) =>
    `<span class="par"><span class="eqn" style="background:${P.bn ? "#E5E7EB" : sl.tint};color:${P.bn ? "#111827" : sl.accent}">${sl.label}</span>${[...(equipos[sl.key] || [])].sort(porJerarquia).map(chip).join("")}</span>`).join("") || '<span class="nota">sin equipos armados</span>';

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${borrador ? "Borrador — " : ""}Scheduler UTI — Semana del ${rango}</title><style>
${CSS_IMPRESION}
.tag.borrador{background:${P.tagBorrador}}
col.lblcol{width:74px}
thead th{font-size:12.5px;background:#0F172A;color:#fff;padding:4px 3px;border:1px solid #0F172A}
thead th small{display:block;font-size:10px;font-weight:600;opacity:.8}
thead th.fs{background:#475569}
th.lbl{font-size:11.5px;font-weight:800;color:#fff;border:1px solid #94A3B8;padding:3px;vertical-align:middle;line-height:1.2}
th.lbl span{display:block;font-size:8.5px;font-weight:600;opacity:.85}
td{border:1px solid #94A3B8;vertical-align:top;padding:3px;height:52px}
td.finde{background:${P.finde}}
td.g{background:${P.bn ? "#F3F4F6" : "#FFF1F2"};height:46px}
td.obs{background:${P.obs[0]};color:${P.obs[1]};font-size:10.5px;line-height:1.3;height:auto;padding:4px;${P.bn ? "border-left:3px solid #111827;" : ""}}
td.rec{background:${P.rec[0]};color:${P.rec[1]};font-size:10.5px;line-height:1.3;height:auto;padding:4px;${P.bn ? "border-left:3px dashed #111827;" : ""}}
</style></head><body>
${agua}
<div class="head"><div><h1>Semana del ${rango}</h1><div class="sub">Residencia de Terapia Intensiva — Hospital Británico</div></div>${sello}</div>
<div class="bloques">
  <div class="bloque"><h3>Equipos por UTI del mes</h3>${eqHtml}</div>
  <div class="bloque" style="flex:0 0 300px"><h3>Días libres de los R4</h3>${libresHtml}</div>
</div>
<table>
<colgroup><col class="lblcol">${DAYS.map(() => "<col>").join("")}</colgroup>
<thead><tr><th></th>${DAYS.map((d, i) => `<th class="${isWeekendIdx(i) ? "fs" : ""}">${d}<small>${fechas[i].getDate()}/${fechas[i].getMonth() + 1}${week.days[i].feriado ? " · FERIADO" : ""}</small></th>`).join("")}</tr></thead>
<tbody>
${SLOTS.map(filaSlot).join("")}
${filaGuardia}
${filaTexto("Observaciones", "observaciones", "obs")}
${filaTexto("Recordatorios", "recordatorios", "rec")}
</tbody></table>
<div class="pie">${pie}<br><b>Referencias:</b> la guardia empieza a las 16 h. Sábados, domingos y feriados no llevan grilla de salas.${P.leyenda}</div>
</body></html>`;
}

function abrirSemana(opts) { abrirHoja(htmlSemana(opts)); }

function htmlMes({ anio, mes, lunes, semanas, rot, equipos, tipo, borrador, emisor, bn }) {
  const soloGuardias = tipo === "guardias";
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const P = paletaImpresion(bn);
  const chip = (n) => chipImpreso(n, P, esc);
  const { sello, agua, pie } = selloImpresion({ borrador, emisor, esc });

  const datosMes = rot.months[mes] || { assignments: [], vacaciones: [] };
  const diaLibrePrimeraSemana = (semanas[isoDate(lunes[0])] || emptyWeek()).diasLibresR4;

  const celda = (fecha) => {
    const dentro = fecha.getMonth() === mes;
    const w = semanas[isoDate(mondayOf(fecha))];
    if (!dentro || !w) return `<td class="off"><div class="num">${fecha.getDate()}/${fecha.getMonth() + 1}</div><div class="nota">${dentro ? "" : "otro mes"}</div></td>`;
    const d = w.days[diOfDate(fecha)];
    const finde = isWeekendIdx(diOfDate(fecha)) || d.feriado;
    const fila = (lbl, key, gente) => gente && gente.length ? `<div class="fila"><span class="lbl" style="background:${P.fila[key]}">${lbl}</span>${[...gente].sort(porJerarquia).map(chip).join("")}</div>` : "";
    if (soloGuardias) {
      const g = [...(d.deGuardia || [])].sort(porJerarquia);
      return `<td class="${finde ? "finde" : ""} g-solo"><div class="num">${fecha.getDate()}${d.feriado ? ' <span class="fer">FERIADO</span>' : ""}</div>` +
        (g.length ? `<div class="gbig">${g.map(chip).join("")}</div>` : '<div class="nota">sin cargar</div>') + "</td>";
    }
    return `<td class="${finde ? "finde" : ""}"><div class="num">${fecha.getDate()}${d.feriado ? ' <span class="fer">FERIADO</span>' : ""}</div>` +
      (finde ? '<div class="nota">sin sala</div>' : fila("U1", "uti1", d.uti1) + fila("U2", "uti2", d.uti2) + fila("U3", "uti3", d.uti3) + fila("PG", "postguardia", d.postguardia)) +
      fila("G", "guardia", d.deGuardia) +
      (d.observaciones ? `<div class="obs">${esc(d.observaciones)}</div>` : "") +
      "</td>";
  };

  const filas = lunes.map((l) => `<tr>${DAYS.map((_, i) => celda(shift(l, i))).join("")}</tr>`).join("");

  const cuenta = {};
  lunes.forEach((l) => DAYS.forEach((_, i) => {
    const f = shift(l, i);
    if (f.getMonth() !== mes) return;
    const w = semanas[isoDate(mondayOf(f))];
    if (!w) return;
    (w.days[diOfDate(f)].deGuardia || []).forEach((n) => { cuenta[n] = (cuenta[n] || 0) + 1; });
  }));
  const porNivel = { R4: 0, R3: 0, R2: 0 };
  Object.entries(cuenta).forEach(([n, c]) => { if (porNivel[LEVEL[n]] !== undefined) porNivel[LEVEL[n]] += c; });
  const bloqueConteo = ["R4", "R3", "R2"].map((lv) => {
    const gente = ALL.filter((n) => LEVEL[n] === lv && cuenta[n]);
    if (!gente.length) return "";
    return `<div class="eq"><span class="eqn" style="background:${P.bn ? "#E5E7EB" : P.chips[lv][0]};color:#111827">${lv} · ${porNivel[lv]}</span>${gente.map((n) => `${chip(n)}<span class="cnt">${cuenta[n]}</span>`).join("")}</div>`;
  }).join("");
  const eqHtml = EQUIPO_SLOTS.filter((sl) => (equipos[sl.key] || []).length).map((sl) =>
    `<div class="eq"><span class="eqn" style="background:${P.bn ? "#E5E7EB" : sl.tint};color:${P.bn ? "#111827" : sl.accent}">${sl.label}</span>${[...(equipos[sl.key] || [])].sort(porJerarquia).map(chip).join("")}</div>`).join("") || '<div class="nota">Sin equipos armados</div>';
  const libresHtml = RESIDENTS.R4.filter((n) => diaLibrePrimeraSemana[n]).map((n) =>
    `<div class="eq">${chip(n)}<span class="txt">${diaLibrePrimeraSemana[n]}</span></div>`).join("") || '<div class="nota">Sin días libres cargados</div>';
  const rotan = (datosMes.assignments || []).map((x) => `${x.resident} (${x.place}${x.exterior ? " ✈️" : ""})`).join(" · ") || "nadie";
  const exterior = (datosMes.assignments || []).filter((x) => x.exterior).map((x) => `${x.resident} (${x.place})`).join(" · ") || "nadie";
  const vac = (datosMes.vacaciones || []).map((v) => `${v.nombre} (${(TRAMOS_VACACIONES[v.tramo] || TRAMOS_VACACIONES.mes).corto})`).join(" · ") || "nadie";

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${borrador ? "Borrador — " : ""}${soloGuardias ? "Guardias" : "Cobertura de salas"} — ${MONTHS[mes]} ${anio}</title><style>
${CSS_IMPRESION}
.tag.borrador{background:${P.tagBorrador}}
thead th{font-size:13px;background:#0F172A;color:#fff;padding:3px;border:1px solid #0F172A}
td{border:1px solid #94A3B8;vertical-align:top;padding:2px 3px}
td.g-solo{height:82px;text-align:center;vertical-align:middle}
td.g-solo .num{font-size:15px;text-align:left}
.gbig{display:flex;flex-direction:column;align-items:center;gap:4px;margin-top:5px}
.gbig .chip{font-size:15px;padding:3.5px 12px;border-radius:16px}
.gbig .chip b{font-size:9.5px;padding:1px 4px}
.cnt{font-size:12px;font-weight:800;color:#1F2937;margin:0 7px 0 1px}
td.off{background:${P.off}}td.finde{background:${P.finde}}
.num{font-size:14px;font-weight:800;margin-bottom:1px}
.fer{font-size:9px;background:${P.bn ? "#111827" : "#FDE68A"};color:${P.bn ? "#fff" : "#92400E"};padding:1px 4px;border-radius:6px;vertical-align:middle}
.fila{display:flex;align-items:flex-start;gap:3px;margin-bottom:0;flex-wrap:wrap;line-height:1.05}
.fila .lbl{font-size:11.5px;font-weight:800;color:#fff;border-radius:4px;padding:2px 5px;min-width:26px;text-align:center;flex-shrink:0;margin-top:2px}
.obs{font-size:10px;color:${P.obs[1]};background:${P.obs[0]};border-radius:3px;padding:1px 3px;margin-top:1px;line-height:1.25;${P.bn ? "border-left:2.5px solid #111827;" : ""}}
</style></head><body>
${agua}
<div class="head"><div><h1>${soloGuardias ? "Guardias" : "Cobertura de salas"} · ${MONTHS[mes]} ${anio}</h1><div class="sub">Residencia de Terapia Intensiva — Hospital Británico</div></div>${sello}</div>
<div class="bloques">
${soloGuardias
  ? `<div class="bloque"><h3>Guardias del mes por residente</h3>${bloqueConteo || '<div class="nota">Sin guardias cargadas</div>'}</div>
     <div class="bloque" style="flex:0 0 250px"><h3>No hacen guardia este mes</h3><div class="txt" style="line-height:1.6"><b>Fuera del país:</b> ${esc(exterior)}<br><b>Vacaciones:</b> ${esc(vac)}</div></div>`
  : `<div class="bloque"><h3>Equipos por UTI</h3>${eqHtml}</div>
     <div class="bloque"><h3>Días libres R4</h3>${libresHtml}</div>
     <div class="bloque"><h3>Fuera de sala este mes</h3><div class="txt" style="line-height:1.6"><b>Rotan:</b> ${esc(rotan)}<br><b>Vacaciones:</b> ${esc(vac)}<br><span style="color:#64748B">Los que rotan dentro del país siguen haciendo guardias.</span></div></div>`}
</div>
<table>
<colgroup>${DAYS.map((_, i) => `<col style="width:${soloGuardias ? 100 / 7 : isWeekendIdx(i) ? 9 : 16.4}%">`).join("")}</colgroup>
<thead><tr>${DAYS.map((d) => `<th>${d}</th>`).join("")}</tr></thead><tbody>${filas}</tbody></table>
<div class="pie">${pie}<br>${soloGuardias ? "<b>La guardia empieza a las 16 h.</b> Siempre dos residentes, uno de ellos R3 o R4. Los fines de semana, un R3 con un R2." : "<b>Referencias:</b> U1/U2/U3 = sala · PG = postguardia · G = de guardia (desde las 16 h)."}${P.leyenda}</div>
</body></html>`;
}

function abrirBorrador(opts) { abrirHoja(htmlMes(opts)); }


/* ══════════════════ GUARDIAS POR RESIDENTE ══════════════════ */

// Cupo de guardias por nivel y por mes. Cada noche lleva dos residentes, asi
// que el total del mes son dias x 2. R4 y R3 tienen cupo fijo y los R2 se
// llevan el resto: por eso en un mes de 30 dias los R2 hacen 26 y no 28.
const CUPO_MES = { R4: 14, R3: 20 };
const cupoR2 = (anio, mes) => new Date(anio, mes + 1, 0).getDate() * 2 - CUPO_MES.R4 - CUPO_MES.R3;

// Cuenta las guardias que ya estan cargadas en el scheduler y las separa entre
// las que ya pasaron y las que quedan por hacer. De paso detecta las coberturas
// de sala de R2/R3 que hay que registrar (ver detectarCoberturas) y las
// sincroniza sola con la sub-pestaña de cobertura.
function GuardiasSection({ cobertura, isAdmin }) {
  const [mesSel, setMesSel] = useState(() => {
    const h = new Date();
    const a = Math.max(0, (h.getFullYear() - MES_INICIO_ESTADISTICAS.anio) * 12 + h.getMonth() - MES_INICIO_ESTADISTICAS.mes);
    const d = new Date(MES_INICIO_ESTADISTICAS.anio, MES_INICIO_ESTADISTICAS.mes + a, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [abierto, setAbierto] = useState(null);
  const [sync, setSync] = useState(null);
  const [y, m] = mesSel.split("-").map(Number);
  const anio = y, mes = m - 1;
  const hoyIso = isoDate(new Date());

  useEffect(() => {
    let vivo = true;
    setCargando(true); setAbierto(null); setSync(null);
    (async () => {
      const dias = [];
      for (const l of lunesQueTocanElMes(anio, mes)) {
        const snap = await getDoc(doc(db, "scheduler", `week-${isoDate(l)}`));
        const w = snap.exists() ? normalize(snap.data()) : emptyWeek();
        DAYS.forEach((_, i) => {
          const f = shift(l, i);
          if (f.getMonth() !== mes || f.getFullYear() !== anio) return;
          dias.push({ fecha: f, iso: isoDate(f), di: i, d: w.days[i] });
        });
      }
      dias.sort((a, b) => a.fecha - b.fecha);
      const rotSnap = await getDoc(doc(db, "scheduler", `rotaciones-${anio}`));
      const rot = rotSnap.exists() ? normalizeRot(rotSnap.data()) : emptyRotYear();
      if (vivo) { setDatos({ dias, rot }); setCargando(false); }
    })().catch(() => { if (vivo) { setDatos(null); setCargando(false); } });
    return () => { vivo = false; };
  }, [anio, mes]);

  const resumen = useMemo(() => {
    if (!datos) return null;
    const base = () => ({ total: 0, hechas: 0, pendientes: 0, semana: 0, finde: 0, feriado: 0, fechas: [] });
    const conteo = {}, externos = {};
    const huecos = [], sobrantes = [];
    datos.dias.forEach((x) => {
      const g = x.d.deGuardia || [];
      if (g.length < 2) huecos.push(x);
      if (g.length > 2) sobrantes.push(x);
      g.forEach((n) => {
        if (!LEVEL[n]) { externos[n] = (externos[n] || 0) + 1; return; }
        const c = (conteo[n] = conteo[n] || base());
        c.total++;
        if (x.iso < hoyIso) c.hechas++; else c.pendientes++;
        if (x.d.feriado) c.feriado++; else if (isWeekendIdx(x.di)) c.finde++; else c.semana++;
        c.fechas.push({ dia: x.fecha.getDate(), di: x.di, feriado: x.d.feriado, pasada: x.iso < hoyIso });
      });
    });
    const porNivel = { R4: 0, R3: 0, R2: 0, JR: 0 };
    Object.entries(conteo).forEach(([n, c]) => { porNivel[LEVEL[n]] += c.total; });
    const mesRot = datos.rot.months[mes] || { assignments: [], vacaciones: [] };
    const fuera = {};
    (mesRot.assignments || []).forEach((a) => { fuera[a.resident] = a.exterior ? `fuera del país (${a.place})` : `rota en ${a.place}`; });
    (mesRot.vacaciones || []).forEach((v) => { fuera[v.nombre] = `de vacaciones (${(TRAMOS_VACACIONES[v.tramo] || TRAMOS_VACACIONES.mes).corto})`; });
    return { conteo, externos, porNivel, huecos, sobrantes, fuera, dias: datos.dias.length, rotantes: (mesRot.assignments || []).map((a) => a.resident) };
  }, [datos, mes, hoyIso]);

  // ── Sincronización automática con "R2 y R3 que cubrieron sala" ──────────
  // Dos situaciones obligan a registrar una cobertura: un R2 o R3 que aparece
  // en una sala el mismo día que está de postguardia, y uno que aparece en una
  // sala estando de rotación ese mes. Se detectan solas y se escriben con un id
  // fijo (auto-nombre-fecha) para que volver a entrar no duplique nada.
  const detectadas = useMemo(() => {
    if (!datos || !resumen) return [];
    const out = [];
    datos.dias.forEach((x) => {
      if (isWeekendIdx(x.di) || x.d.feriado) return;
      const enSala = [...(x.d.uti1 || []), ...(x.d.uti2 || []), ...(x.d.uti3 || [])];
      enSala.forEach((n) => {
        if (LEVEL[n] !== "R2" && LEVEL[n] !== "R3") return;
        const pg = (x.d.postguardia || []).includes(n);
        const rota = resumen.rotantes.includes(n);
        if (!pg && !rota) return;
        out.push({ id: `auto-${n}-${x.iso}`, residente: n, fecha: x.iso, modalidad: pg ? "post_guardia" : "rotacion" });
      });
    });
    return out;
  }, [datos, resumen]);

  useEffect(() => {
    if (!isAdmin || cargando || !datos) return;
    const yaEstan = new Set((cobertura || []).map((c) => c.id));
    const desdeIso = isoDate(new Date(anio, mes, 1));
    const hastaIso = isoDate(new Date(anio, mes + 1, 0));
    const faltan = detectadas.filter((x) => !yaEstan.has(x.id));
    // las automáticas de este mes que ya no corresponden se borran
    const sobran = (cobertura || []).filter((c) => String(c.id || "").startsWith("auto-") && c.fecha >= desdeIso && c.fecha <= hastaIso && !detectadas.some((d) => d.id === c.id));
    // Si no hay nada que hacer se sale sin tocar el aviso: si acabamos de
    // escribir, el snapshot vuelve a disparar este efecto y borrarlo haría
    // parpadear el mensaje.
    if (!faltan.length && !sobran.length) return;
    let cancelado = false;
    (async () => {
      for (const x of faltan) {
        await setDoc(doc(db, "cobertura_sala", x.id), { ...x, nota: "Detectada automáticamente desde el scheduler", creadoPor: "automático", creadoEn: new Date().toISOString() });
      }
      for (const c of sobran) await deleteDoc(doc(db, "cobertura_sala", c.id));
      if (!cancelado) setSync({ agregadas: faltan.length, borradas: sobran.length });
    })().catch(() => {});
    return () => { cancelado = true; };
  }, [detectadas, cobertura, isAdmin, cargando, datos, anio, mes]);

  // Nunca antes de septiembre de 2026: de ahí para atrás no hay estadística
  // que valga la pena mirar.
  const opciones = useMemo(() => {
    const hoy = new Date();
    const desde = new Date(MES_INICIO_ESTADISTICAS.anio, MES_INICIO_ESTADISTICAS.mes, 1);
    const hasta = new Date(hoy.getFullYear(), hoy.getMonth() + 7, 1);
    const out = [];
    for (let d = new Date(desde); d < hasta; d.setMonth(d.getMonth() + 1)) {
      out.push({ clave: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
    }
    return out;
  }, []);

  const cupos = { R4: CUPO_MES.R4, R3: CUPO_MES.R3, R2: cupoR2(anio, mes) };
  const caja = { background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0", padding: 16, marginBottom: 12 };
  const gente = ASIGNABLES.filter((n) => LEVEL[n] !== "JR");

  // Un grafico de barras. campo dice que columna se dibuja.
  const grafico = (titulo, subtitulo, campo, tinte) => {
    const max = Math.max(1, ...gente.map((n) => (resumen.conteo[n] || {})[campo] || 0));
    const suma = gente.reduce((a, n) => a + ((resumen.conteo[n] || {})[campo] || 0), 0);
    return (
      <div style={caja}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 2 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: "#0F172A" }}>{titulo}</div>
          <div style={{ fontSize: 12, color: "#64748B", fontVariantNumeric: "tabular-nums" }}>{suma} en total</div>
        </div>
        <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.5, marginBottom: 11 }}>{subtitulo}</div>
        {["R4", "R3", "R2"].map((lv) => {
          const del = gente.filter((n) => LEVEL[n] === lv);
          return (
            <div key={lv} style={{ marginBottom: 9 }}>
              <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.4, color: COLOR[lv].tx, marginBottom: 3 }}>{lv}</div>
              {del.map((n) => {
                const c = resumen.conteo[n];
                const v = (c || {})[campo] || 0;
                const abierta = abierto === n;
                return (
                  <div key={n}>
                    <div
                      onClick={() => setAbierto(abierta ? null : n)}
                      title="Tocá para ver los días"
                      style={{ display: "grid", gridTemplateColumns: "76px 1fr 28px", alignItems: "center", gap: 9, padding: "3px 0", cursor: "pointer" }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 700, color: v ? "#334155" : "#94A3B8" }}>{n}</span>
                      <span style={{ height: 15, background: "#F1F5F9", borderRadius: 4, overflow: "hidden" }}>
                        <span style={{ display: "block", height: "100%", width: `${(v / max) * 100}%`, background: v ? tinte : "transparent", borderRadius: 4, transition: "width .2s" }} />
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 800, textAlign: "right", color: v ? "#0F172A" : "#CBD5E1", fontVariantNumeric: "tabular-nums" }}>{v}</span>
                    </div>
                    {abierta && (
                      <div style={{ margin: "2px 0 8px 85px", padding: "8px 11px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8 }}>
                        {c ? (
                          <>
                            <div style={{ fontSize: 11, color: "#64748B", marginBottom: 5 }}>
                              {c.total} en el mes · {c.hechas} ya {c.hechas === 1 ? "hecha" : "hechas"} · {c.pendientes} por hacer · {c.semana} de semana, {c.finde} de fin de semana{c.feriado ? `, ${c.feriado} en feriado` : ""}
                            </div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                              {c.fechas.map((f) => (
                                <span key={f.dia} style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 6, fontVariantNumeric: "tabular-nums", background: f.feriado ? "#FEE2E2" : isWeekendIdx(f.di) ? "#FEF3C7" : "#E2E8F0", color: f.feriado ? "#991B1B" : isWeekendIdx(f.di) ? "#92400E" : "#334155", opacity: f.pasada ? 0.5 : 1 }}>
                                  {DAYS[f.di].slice(0, 3)} {f.dia}
                                </span>
                              ))}
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic" }}>{resumen.fuera[n] || "sin guardias este mes"}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <select value={mesSel} onChange={(e) => setMesSel(e.target.value)} style={{ fontSize: 13, padding: "8px 10px", borderRadius: 8, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", fontWeight: 700 }}>
          {opciones.map((o) => <option key={o.clave} value={o.clave}>{o.label}</option>)}
        </select>
      </div>

      {/* El cupo del mes, en una línea. Antes eran tres pastillas con recuadro;
          es un dato de control que se mira de reojo y no necesita ese peso. */}
      {!cargando && resumen && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 20px", fontSize: 12.5, color: "#64748B", marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #E2E8F0" }}>
          <span>Cupo de {MONTHS[mes].toLowerCase()} · <b style={{ color: "#0F172A", fontVariantNumeric: "tabular-nums" }}>{cupos.R4 + cupos.R3 + cupos.R2}</b> lugares</span>
          {["R4", "R3", "R2"].map((lv) => {
            const dif = resumen.porNivel[lv] - cupos[lv];
            return (
              <span key={lv} style={{ fontVariantNumeric: "tabular-nums" }}>
                {lv} <b style={{ color: "#0F172A" }}>{resumen.porNivel[lv]}</b>/{cupos[lv]}{" "}
                <span style={{ color: dif === 0 ? "#15803D" : "#B91C1C", fontWeight: 600 }}>{dif === 0 ? "exacto" : dif > 0 ? `sobran ${dif}` : `faltan ${-dif}`}</span>
              </span>
            );
          })}
        </div>
      )}

      {cargando && <div style={caja}><span style={{ fontSize: 12.5, color: "#64748B" }}>Leyendo las semanas del mes…</span></div>}

      {!cargando && resumen && (
        <>
          {(resumen.huecos.length > 0 || resumen.sobrantes.length > 0) && (

      <div style={{ ...caja, background: "#FEF2F2", borderColor: "#FECACA" }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: "#B91C1C", marginBottom: 5 }}>Días que no cierran en dos</div>
              {[...resumen.sobrantes, ...resumen.huecos].map((x) => (
                <div key={x.iso} style={{ fontSize: 12, color: "#7F1D1D" }}>
                  <b>{DAYS[x.di]} {x.fecha.getDate()}</b> — {(x.d.deGuardia || []).length} {((x.d.deGuardia || []).length === 1 ? "persona" : "personas")}{(x.d.deGuardia || []).length ? `: ${(x.d.deGuardia || []).join(", ")}` : ""}
                </div>
              ))}
            </div>
          )}

          {grafico("Guardias asignadas", "Todo lo que está cargado en el scheduler para este mes. Tocá una barra para ver los días.", "total", "#9F1239")}
          {grafico("Guardias por realizar", `Las que quedan de hoy en adelante, al ${new Date().getDate()} de ${MONTHS[new Date().getMonth()].toLowerCase()}. Las que ya pasaron no cuentan.`, "pendientes", "#0E7490")}

          {Object.keys(resumen.externos).length > 0 && (
            <div style={caja}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: "#0F172A", marginBottom: 5 }}>De fuera del plantel</div>
              {Object.entries(resumen.externos).map(([n, c]) => (
                <div key={n} style={{ fontSize: 12, color: "#475569" }}>{n} — {c} {c === 1 ? "guardia" : "guardias"}</div>
              ))}
            </div>
          )}

          <div style={{ fontSize: 11, color: "#64748B", lineHeight: 1.55, padding: "0 2px" }}>
            {detectadas.length === 0
              ? "No hay ningún R2 ni R3 cubriendo sala en postguardia o en rotación este mes, así que no hay nada que registrar."
              : `Se detectaron ${detectadas.length} coberturas de sala de R2 o R3 (postguardia o rotación) y quedaron registradas solas en la sub-pestaña de cobertura.`}
            {sync && (sync.agregadas || sync.borradas) ? ` Recién se ${sync.agregadas ? `agregaron ${sync.agregadas}` : ""}${sync.agregadas && sync.borradas ? " y se " : ""}${sync.borradas ? `borraron ${sync.borradas} que ya no correspondían` : ""}.` : ""}
          </div>
        </>
      )}
    </div>
  );
}

/* ══════════════════ ALERTAS DE LA SEMANA ══════════════════ */

// Un "superior" es quien puede quedar a cargo de una sala o una guardia.
const esSuperior = (n) => LEVEL[n] === "R3" || LEVEL[n] === "R4" || LEVEL[n] === "JR";

// Topes de día libre de los R4, por día de la semana.
const TOPE_DIA_LIBRE = { Lunes: 1, Miércoles: 2, Viernes: 2 };

// Por qué alguien no puede estar de guardia. Ojo con la diferencia respecto de
// la sala: rotar en Fernandez o en otro servicio de CABA NO saca a nadie de las
// guardias (las siguen haciendo en el Británico, aunque menos). Solo quedan
// afuera los que están fuera del país o de vacaciones.
function motivoNoPuedeGuardia(name, date, rotPorAnio) {
  const vac = vacacionesEseDia(name, date, rotPorAnio);
  if (vac) return `${name} está ${textoTramo(vac)}`;
  // La semana libre de fin de año es una desconexión total: ni sala ni guardia.
  const libre = semanaLibreEseDia(name, date, rotPorAnio);
  if (libre) return `${name} tiene su semana libre de ${libre}`;
  const rotAnio = rotPorAnio[date.getFullYear()];
  if (!rotAnio) return null;
  const mes = rotAnio.months[date.getMonth()];
  if (!mes) return null;
  const rot = (mes.assignments || []).find((a) => a.resident === name);
  if (rot && rot.exterior) return `${name} está rotando fuera del país (${rot.place})`;
  return null;
}

// Revisa la semana contra las reglas de la residencia y devuelve dos listas:
// las que no se pueden romper nunca (duras) y las que son "lo ideal pero a
// veces la realidad manda" (suaves). Es solo informativo: nunca impide guardar.
function analizarSemana(week, monday, rotPorAnio, equiposMes) {
  const duras = [];
  const suaves = [];
  const agregar = (lista, di, texto) => lista.push({ dia: `${DAYS[di]} ${dm(shift(monday, di))}`, texto });

  // Día libre de los R4: solo lunes, miércoles o viernes, con tope por día.
  const porDia = {};
  RESIDENTS.R4.forEach((n) => {
    const d = week.diasLibresR4[n];
    if (!d) return;
    (porDia[d] = porDia[d] || []).push(n);
  });
  Object.entries(porDia).forEach(([dia, gente]) => {
    const tope = TOPE_DIA_LIBRE[dia];
    if (tope === undefined) {
      duras.push({ dia, texto: `Día libre en ${dia.toLowerCase()} (${gente.join(", ")}) — solo se puede lunes, miércoles o viernes` });
    } else if (gente.length > tope) {
      duras.push({ dia, texto: `${gente.length} R4 con día libre el ${dia.toLowerCase()} (${gente.join(", ")}) — el tope es ${tope}` });
    }
  });

  for (let di = 0; di < DAYS.length; di++) {
    const d = week.days[di];
    const fecha = shift(monday, di);
    const finde = isWeekendIdx(di);
    const feriado = d.feriado;
    const sinCamas = finde || feriado;

    // ── Salas (solo días hábiles que no sean feriado) ──
    if (!sinCamas) {
      SLOTS.filter((sl) => sl.key !== "postguardia").forEach((sl) => {
        const gente = d[sl.key] || [];
        if (gente.length < 2) {
          agregar(duras, di, `${sl.label} con ${gente.length === 0 ? "nadie" : "1 residente"} — el mínimo son 2`);
        } else if (!gente.some(esSuperior)) {
          agregar(duras, di, `${sl.label} sin ningún R3 ni R4 (${gente.join(", ")})`);
        }
        if (sl.key === "uti1" && gente.length === 2) {
          agregar(suaves, di, `UTI 1 con 2 residentes — lo ideal son 3`);
        }
        if (gente.includes(JEFE)) {
          agregar(suaves, di, `${JEFE} está cubriendo ${sl.label} — debería ser excepcional`);
        }
        // El equipo del mes: se busca que cada uno vea la misma sala todo el mes.
        (equiposMes ? gente : []).forEach((n) => {
          const suSala = Object.keys(equiposMes).find((k) => (equiposMes[k] || []).includes(n));
          if (suSala && suSala !== sl.key) {
            const nombreSala = (SLOTS.find((x) => x.key === suSala) || {}).label || suSala;
            agregar(suaves, di, `${n} está en ${sl.label} pero su equipo del mes es ${nombreSala}`);
          }
        });
      });

      // Postguardia. Quién queda postguardia no se elige: es quien estuvo de
      // guardia la noche anterior, así que avisar "lo ideal sería otro" no
      // sirve de nada y ensucia el panel. Lo que sí es un error real es que
      // aparezca acá un R4 que no está rotando: ese trabaja igual en sala al
      // día siguiente y no debería estar ocupando la fila de postguardia.
      (d.postguardia || []).filter((n) => LEVEL[n] === "R4").forEach((n) => {
        const rotAnio = rotPorAnio[fecha.getFullYear()];
        const mesRot = rotAnio && rotAnio.months[fecha.getMonth()];
        const rota = mesRot && (mesRot.assignments || []).some((a) => a.resident === n);
        if (!rota) {
          agregar(suaves, di, `${n} es R4 y no está rotando — su postguardia la trabaja en sala, no debería figurar acá`);
        }
      });

      // Un R4 que no rota no queda postguardia: al día siguiente de su guardia
      // trabaja igual en sala. Pero viene de la noche, así que la regla es que
      // no quede solo con un R2: tiene que haber otro superior con él. Si no lo
      // hay, lo que se prefiere es mover gente de sala, no sacarle la guardia.
      // El lunes no se chequea porque la guardia del domingo nunca es de un R4.
      if (di >= 1) {
        const anoche = (week.days[di - 1] || {}).deGuardia || [];
        anoche.filter((n) => LEVEL[n] === "R4").forEach((n) => {
          const rotAnio = rotPorAnio[fecha.getFullYear()];
          const mesRot = rotAnio && rotAnio.months[fecha.getMonth()];
          const rota = mesRot && (mesRot.assignments || []).some((a) => a.resident === n);
          if (rota) return;
          const sl = SLOTS.filter((x) => x.key !== "postguardia").find((x) => (d[x.key] || []).includes(n));
          if (!sl) return;
          const conEl = (d[sl.key] || []).filter((x) => x !== n);
          if (!conEl.some(esSuperior)) {
            agregar(duras, di, `${n} (R4) está postguardia en ${sl.label} sin otro superior (${conEl.join(", ") || "solo"}) — movés a un R4 o R3 a esa sala`);
          }
        });
      }
    }

    // ── Guardia ──
    const guardia = (d.deGuardia || []);
    const residentesGuardia = guardia.filter((n) => LEVEL[n]);
    if (guardia.length === 0) {
      agregar(duras, di, "Sin nadie de guardia");
    } else {
      if (guardia.length !== 2) {
        // Nunca tres. Si sobran cupos porque las noches ya estaban completas,
        // esos cupos no se usan: esa persona se salva de la guardia y listo.
        agregar(duras, di, guardia.length > 2
          ? `${guardia.length} personas de guardia (${guardia.join(", ")}) — nunca pueden ser 3, sacá a uno`
          : `${guardia.length} persona de guardia (${guardia.join(", ")}) — tienen que ser 2`);
      }
      if (residentesGuardia.length > 0 && !residentesGuardia.some(esSuperior)) {
        agregar(duras, di, `Guardia sin ningún R3 ni R4 (${guardia.join(", ")})`);
      }
      if (finde) {
        const niveles = residentesGuardia.map((n) => LEVEL[n]).sort();
        const esR3R2 = niveles.length === 2 && niveles.includes("R3") && niveles.includes("R2");
        if (!esR3R2) {
          agregar(duras, di, `Guardia de fin de semana (${guardia.join(", ")}) — tiene que ser un R3 y un R2`);
        }
      }
      if ((finde || feriado) && residentesGuardia.some((n) => LEVEL[n] === "R4")) {
        const r4 = residentesGuardia.filter((n) => LEVEL[n] === "R4");
        agregar(duras, di, `${r4.join(", ")} (R4) de guardia en ${feriado ? "un feriado" : "fin de semana"} — los R4 no hacen`);
      }
      residentesGuardia.forEach((n) => {
        const m = motivoNoPuedeGuardia(n, fecha, rotPorAnio);
        if (m) agregar(duras, di, `${m} y está puesto de guardia`);
      });
    }
  }

  return { duras, suaves };
}

// Panel compacto: una barra que dice cuántas alertas hay y se despliega. Si
// está todo bien, una línea verde discreta. Nunca bloquea nada.
function PanelAlertas({ duras, suaves }) {
  const [abierto, setAbierto] = useState(false);
  const total = duras.length + suaves.length;

  if (total === 0) {
    return (
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", marginBottom: 10, borderRadius: 10, background: "#F0FDF4", border: "1px solid #BBF7D0", fontSize: 11, color: "#15803D", fontWeight: 600 }}>
        ✓ La semana cumple todas las reglas
      </div>
    );
  }

  return (
    <div className="no-print" style={{ marginBottom: 10 }}>
      <button onClick={() => setAbierto((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px", borderRadius: 10, background: duras.length ? "#FEF2F2" : "#FFFBEB", border: `1px solid ${duras.length ? "#FECACA" : "#FDE68A"}`, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
        <span style={{ display: "inline-block", transform: abierto ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 10, color: "#64748B" }}>▶</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: duras.length ? "#991B1B" : "#92400E", flex: 1 }}>
          {duras.length > 0 && `${duras.length} ${duras.length === 1 ? "regla incumplida" : "reglas incumplidas"}`}
          {duras.length > 0 && suaves.length > 0 && " · "}
          {suaves.length > 0 && `${suaves.length} ${suaves.length === 1 ? "sugerencia" : "sugerencias"}`}
        </span>
        <span style={{ fontSize: 10, color: "#64748B" }}>{abierto ? "ocultar" : "ver detalle"}</span>
      </button>

      {abierto && (
        <div style={{ marginTop: 6, background: "#fff", borderRadius: 10, border: "1px solid #E2E8F0", overflow: "hidden" }}>
          {[["No se puede romper", duras, "#DC2626", "#FEF2F2"], ["Lo ideal sería", suaves, "#B45309", "#FFFBEB"]]
            .filter(([, lista]) => lista.length > 0)
            .map(([titulo, lista, color, bg]) => (
              <div key={titulo}>
                <div style={{ fontSize: 9.5, fontWeight: 800, color, background: bg, padding: "5px 12px", letterSpacing: 0.3, textTransform: "uppercase" }}>{titulo}</div>
                {lista.map((a, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, padding: "6px 12px", borderTop: i === 0 ? "none" : "1px solid #F8FAFC", fontSize: 11.5 }}>
                    <span style={{ color: "#64748B", minWidth: 92, fontWeight: 600 }}>{a.dia}</span>
                    <span style={{ color: "#334155", flex: 1 }}>{a.texto}</span>
                  </div>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════ EQUIPOS POR UTI (por mes) ══════════════════ */

// A qué mes "pertenece" una semana: la que tiene 4 o más de sus 7 días en él.
// Las semanas cruzan meses, así que mirar solo el lunes daría mal (septiembre
// 2026 arranca un martes).
function mesDeLaSemana(monday) {
  const cuenta = {};
  for (let i = 0; i < DAYS.length; i++) {
    const d = shift(monday, i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    cuenta[k] = (cuenta[k] || 0) + 1;
  }
  return Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a])[0];
}

function etiquetaMes(clave) {
  const [y, m] = clave.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

const EQUIPO_MAX = 4;
const EQUIPO_SLOTS = SLOTS.filter((s) => s.key !== "postguardia");

// Se trata de que cada residente vea la misma sala con los mismos compañeros
// durante todo el mes. Esto guarda ese armado (hasta 4 por UTI) en
// scheduler/equipos, con una clave por mes. Es informativo: no condiciona la
// grilla, solo la tenés a la vista mientras armás la semana.
function EquiposMes({ monday, isAdmin }) {
  const clave = useMemo(() => mesDeLaSemana(monday), [monday]);
  const [todos, setTodos] = useState({});
  const [editando, setEditando] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "scheduler", "equipos"), (snap) => {
      setTodos(snap.exists() ? snap.data() : {});
    }, () => {});
    return unsub;
  }, []);

  const equipos = todos[clave] || {};
  const conGente = EQUIPO_SLOTS.filter((s) => (equipos[s.key] || []).length > 0);

  const guardar = async (next) => {
    try { await setDoc(doc(db, "scheduler", "equipos"), { [clave]: next }, { merge: true }); }
    catch (e) { console.error("equipos", e); }
  };

  // Alguien pertenece a una sola UTI por mes: ponerlo en otra lo saca de la
  // anterior, que es como funciona en la realidad.
  const toggle = (slotKey, nombre) => {
    if (!isAdmin) return;
    const next = {};
    EQUIPO_SLOTS.forEach((s) => { next[s.key] = (equipos[s.key] || []).filter((n) => n !== nombre); });
    const yaEstaba = (equipos[slotKey] || []).includes(nombre);
    if (!yaEstaba) {
      if (next[slotKey].length >= EQUIPO_MAX) return; // tope de 4
      next[slotKey] = [...next[slotKey], nombre];
    }
    guardar(next);
  };

  // Si no hay nada cargado y no sos admin, ni se muestra: no deja hueco.
  if (conGente.length === 0 && !isAdmin) return null;

  return (
    <div className="no-print" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, padding: "7px 12px", borderRadius: 10, background: "#F8FAFC", border: "1px solid #E2E8F0" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#475569", whiteSpace: "nowrap" }}>👥 Equipos por UTI · {etiquetaMes(clave)}</span>

        {conGente.length === 0 ? (
          <span style={{ fontSize: 10.5, color: "#64748B", fontStyle: "italic" }}>Sin equipos armados este mes.</span>
        ) : (
          conGente.map((s) => (
            <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
              <span style={{ fontSize: 9.5, fontWeight: 800, color: s.accent, background: s.tint, borderRadius: 5, padding: "2px 6px", whiteSpace: "nowrap" }}>{s.label}</span>
              {[...(equipos[s.key] || [])].sort(porJerarquia).map((n) => {
                const c = COLOR[LEVEL[n]] || COLOR.R2;
                return (
                  <span key={n} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 7px", borderRadius: 999, background: c.bg, border: `1px solid ${c.bd}`, color: c.tx, fontWeight: 600, fontSize: 10.5 }}>
                    {n}
                    <span style={{ fontSize: 7, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: c.solid, color: "#fff" }}>{LEVEL[n]}</span>
                  </span>
                );
              })}
            </span>
          ))
        )}

        {isAdmin && (
          <button onClick={() => setEditando(true)} style={{ marginLeft: "auto", background: "none", border: "none", color: "#64748B", fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
            {conGente.length === 0 ? "+ Armar equipos" : "✏️ Editar"}
          </button>
        )}
      </div>

      {editando && isAdmin && (
        <EquiposEditor clave={clave} equipos={equipos} onToggle={toggle} onClose={() => setEditando(false)} />
      )}
    </div>
  );
}

function EquiposEditor({ clave, equipos, onToggle, onClose }) {
  const asignados = {};
  EQUIPO_SLOTS.forEach((s) => (equipos[s.key] || []).forEach((n) => { asignados[n] = s.key; }));

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: "18px 20px 20px", width: "100%", maxWidth: 520, maxHeight: "88vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(15,23,42,.28)", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <div style={{ fontWeight: 800, fontSize: 15.5, color: "#0F172A" }}>👥 Equipos por UTI</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748B", fontSize: 18, cursor: "pointer", fontFamily: "inherit", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          {etiquetaMes(clave)} · hasta {EQUIPO_MAX} por sala. Cada residente va en una sola UTI: si lo ponés en otra, sale de la anterior.
        </div>

        {EQUIPO_SLOTS.map((s) => {
          const miembros = [...(equipos[s.key] || [])].sort(porJerarquia);
          const lleno = miembros.length >= EQUIPO_MAX;
          return (
            <div key={s.key} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: s.accent, background: s.tint, borderRadius: 5, padding: "2px 7px" }}>{s.label}</span>
                <span style={{ fontSize: 10.5, color: lleno ? "#B45309" : "#94A3B8", fontWeight: 600 }}>{miembros.length}/{EQUIPO_MAX}{lleno ? " · completo" : ""}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {ALL.map((n) => {
                  const aca = miembros.includes(n);
                  const enOtra = asignados[n] && asignados[n] !== s.key;
                  const bloqueado = !aca && lleno;
                  const c = COLOR[LEVEL[n]];
                  return (
                    <div
                      key={n}
                      onClick={() => !bloqueado && onToggle(s.key, n)}
                      title={enOtra ? `Ahora está en ${EQUIPO_SLOTS.find((x) => x.key === asignados[n]).label}` : bloqueado ? `${s.label} ya tiene ${EQUIPO_MAX}` : undefined}
                      style={{ cursor: bloqueado ? "not-allowed" : "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 4, padding: "4px 9px", borderRadius: 7, background: aca ? c.solid : "#F8FAFC", border: `1.5px solid ${aca ? c.solid : "#E2E8F0"}`, color: aca ? "#fff" : enOtra ? "#CBD5E1" : "#64748B", fontWeight: 600, fontSize: 11.5, opacity: bloqueado ? 0.4 : 1 }}
                    >
                      {aca && "✓ "}{n}
                      <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: aca ? "rgba(255,255,255,.28)" : c.solid, color: "#fff" }}>{LEVEL[n]}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <button onClick={onClose} style={{ width: "100%", marginTop: 4, background: "#16A34A", color: "#fff", border: "none", borderRadius: 10, padding: "11px 16px", fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Listo</button>
      </div>
    </div>
  );
}

/* ══════════════════ DÍAS LIBRES R4 ══════════════════ */

const DIAS_LIBRES_OPCIONES = ["Lunes", "Miércoles", "Viernes"];

function DiasLibresR4({ week, isAdmin, onChange, onAplicarAlMes, aplicando }) {
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
      {isAdmin && any && (
        <button onClick={onAplicarAlMes} disabled={aplicando} className="no-print" title="Copia estos días libres a todas las semanas de este mes" style={{ marginLeft: "auto", background: "#EA580C", color: "#fff", border: "none", borderRadius: 7, padding: "5px 11px", fontSize: 10.5, fontWeight: 700, cursor: aplicando ? "default" : "pointer", fontFamily: "inherit", opacity: aplicando ? 0.6 : 1 }}>
          {aplicando ? "Aplicando…" : "📅 Aplicar a todo el mes"}
        </button>
      )}
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

const RowLabel = ({ label, color, sub, fondo, className }) => (<div className={className} style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end", textAlign: "right", padding: "8px 10px", background: "#F8FAFC", borderRight: "2px solid #E2E8F0", borderBottom: "2px solid #D1D5DB", borderTop: "2px solid #D1D5DB" }}><div style={{ fontWeight: 700, fontSize: 11, color, letterSpacing: 0.1 }}>{label}</div>{sub && <div style={{ fontSize: 8.5, color: "#64748B", marginTop: 1 }}>{sub}</div>}</div>);

const Cell = ({ children, onClick, tint, ring, pad = 4, lastCol, lastRow, className }) => (<div className={className} onClick={onClick} style={{ padding: pad, minHeight: 46, display: "flex", flexDirection: "column", gap: 3, background: tint, borderRight: lastCol ? "none" : "1px solid #F1F5F9", borderBottom: lastRow ? "none" : "1px solid #F1F5F9", boxShadow: ring ? `inset 0 0 0 1.5px ${ring}66` : "none", cursor: ring ? "pointer" : "default", transition: "background .12s, box-shadow .12s" }}>{children}</div>);

function Chip({ name, selected, onPick, onRemove, alerta }) {
  const lv = LEVEL[name]; const c = COLOR[lv];
  const esJefe = lv === "JR";
  return (<div onClick={onPick} title={alerta || undefined} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3.5px 6px 3.5px 8px", borderRadius: 7, background: selected ? c.solid : c.bg, border: alerta && !selected ? "1.5px solid #F59E0B" : `1.5px solid ${selected ? c.solid : c.bd}`, color: selected ? "#fff" : c.tx, fontWeight: 600, fontSize: 11.5, cursor: "pointer", userSelect: "none", boxShadow: selected ? `0 0 0 3px ${c.solid}33` : alerta ? "0 0 0 2px #FDE68A" : "none", transition: "all .12s", ...(esJefe && !selected ? SKIN_JR : {}) }}>
    {alerta && <span title={alerta} style={{ fontSize: 10, lineHeight: 1, cursor: "help" }}>⚠️</span>}
    {lv === "JR" && <span style={{ fontSize: 10, lineHeight: 1 }}>👑</span>}
    <span style={{ flex: 1, lineHeight: 1.3 }}>{name}</span>
    <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 3.5px", borderRadius: 3, background: esJefe && !selected ? "rgba(69,26,3,.55)" : selected ? "rgba(255,255,255,.28)" : c.solid, color: "#fff", letterSpacing: 0.2, textShadow: "none" }}>{lv}</span>
    {onRemove && <span onClick={onRemove} title="Quitar" style={{ fontSize: 11, lineHeight: 1, opacity: 0.45, cursor: "pointer", padding: "0 1px" }}>×</span>}
  </div>);
}

const OutChip = ({ name, onPick, selected }) => (<div onClick={onPick} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 7px", borderRadius: 6, background: selected ? "#94A3B8" : "#E2E8F0", border: `1.5px solid ${selected ? "#94A3B8" : "#CBD5E1"}`, color: selected ? "#fff" : "#64748B", fontSize: 10.5, fontWeight: 600, textDecoration: "line-through", cursor: "pointer", userSelect: "none" }}><span style={{ flex: 1 }}>{name}</span><span style={{ fontSize: 7.5, fontWeight: 800, background: "#94A3B8", color: "#fff", padding: "1px 3px", borderRadius: 2.5 }}>{LEVEL[name]}</span></div>);

// Igual que OutChip pero para los que quedaron fuera automáticamente (rotación,
// vacaciones o día libre). No se puede tocar: no lo puso nadie a mano, sale de
// Rotaciones o del día libre, así que se corrige allá. El candado y el tooltip
// explican por qué está ahí.
const AutoOutChip = ({ name, motivo }) => (
  <div title={motivo} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 7px", borderRadius: 6, background: "#F8FAFC", border: "1.5px dashed #CBD5E1", color: "#64748B", fontSize: 10.5, fontWeight: 600, cursor: "help", userSelect: "none" }}>
    <span style={{ fontSize: 9 }}>🔒</span>
    <span style={{ flex: 1 }}>{name}</span>
    <span style={{ fontSize: 7.5, fontWeight: 800, background: "#CBD5E1", color: "#fff", padding: "1px 3px", borderRadius: 2.5 }}>{LEVEL[name]}</span>
  </div>
);

const GhostHint = ({ color, name }) => (<div style={{ fontSize: 10, color, opacity: 0.75, fontStyle: "italic", textAlign: "center", padding: "1px 0" }}>+ {name}</div>);
const Dash = () => (<div style={{ color: "#64748B", fontSize: 11, textAlign: "center", padding: "10px 0" }}>—</div>);
const Skeleton = () => (<div style={{ height: 460, borderRadius: 14, background: "linear-gradient(90deg,#F1F5F9 25%,#E2E8F0 50%,#F1F5F9 75%)", backgroundSize: "200% 100%", animation: "sk 1.2s infinite", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748B", fontSize: 13 }}>Cargando…<style>{`@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style></div>);

const Legend = () => (<div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
  {Object.entries(COLOR).map(([lv, c]) => (<div key={lv} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748B", fontWeight: 500 }}><span style={{ width: 11, height: 11, borderRadius: 3.5, background: c.bg, border: `1.5px solid ${c.bd}` }} />{lv === "JR" ? "👑 Jefe de residentes" : lv}</div>))}
  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748B", fontWeight: 500 }}><span style={{ width: 11, height: 11, borderRadius: 3.5, background: SLOTS[3].tint, border: `1.5px solid ${SLOTS[3].rotulo}` }} />Postguardia</div>
</div>);

/* ══════════════════ ESTILOS ══════════════════ */

const NAV = { background: "rgba(255,255,255,.14)", border: "none", borderRadius: 7, color: "#fff", padding: "6px 10px", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", lineHeight: 1.2 };

const INPUT = { padding: "6px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", background: "#fff", color: "#0F172A" };

const TEXTAREA = { width: "100%", minHeight: 52, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", background: "#fff", fontSize: 11.5, lineHeight: 1.45, color: "#1F2937", fontWeight: 500, fontFamily: "'Inter', system-ui, sans-serif", resize: "vertical", outline: "none", boxSizing: "border-box" };

/* ══════════════════ PASE APP (alpha) ══════════════════

   El pase de guardia editable. Arranca de la foto que el sync trae del Drive y
   cada residente edita SU copia, que se guarda en Firestore bajo su uid. Nadie
   ve la copia de nadie: es una libreta personal, no el registro del servicio.

   Tres decisiones que conviene entender antes de tocar esto:

   1) La foto del Drive NO se toca nunca. Se guarda entera junto con la copia
      editada, y de la comparación entre las dos sale el resaltado de lo que se
      agregó. Por eso no hacen falta versiones: hay dos textos y un interruptor.

   2) Lo editado se marca con un diff POR PALABRAS, no por carácter. Agregar
      "PL s/p" tiene que verse como dos palabras nuevas y no como siete letras
      sueltas intercaladas.

   3) Las anotaciones son temporales por definición, pero no se borran solas:
      hay un botón explícito. Un borrado automático a las 24 h le puede comer a
      alguien una nota a mitad de guardia, y eso es peor que arrastrar datos
      viejos un día de más.
*/

// Colección propia. Un documento por residente y por pase: id = uid + fecha de
// la foto, así cambiar de pase no pisa lo de la guardia anterior.
const PASEAPP_COL = "pase_guardia";

const PA_ROT = {
  ap: "Antecedentes", ea: "Enfermedad actual", req: "Requerimientos e intercurrencias",
  tto: "Tratamiento", labo: "Laboratorio", eab: "Estado ácido-base", cultivos: "Cultivos",
  estudios: "Estudios", accesos: "Accesos", imagenes: "Imágenes",
};
// El orden en que se muestran los campos. Si el Drive trae un campo que no está
// acá, no se ve: por eso EAB está en la lista aunque solo lo use parte del
// plantel. Cualquier campo nuevo del Drive hay que agregarlo en los dos lados.
//
// Accesos e Imágenes son dos cosas distintas: una vía central no es una TAC.
// En el Drive vienen juntas en el mismo renglón, así que se separan al leer
// (ver paPartirAccesos).
const PA_ORDEN = ["ap", "ea", "req", "tto", "labo", "eab", "cultivos", "estudios", "accesos", "imagenes"];
const PA_TIPOS = ["Medicación", "Intercurrencia", "Estudio", "Procedimiento", "Otro"];
const PA_PESO_SUPUESTO = 70;

// La unidad de cada infusión no está escrita en el pase: depende de la droga.
// Los vasoactivos se titulan en mcg/kg/min, no en mcg/kg/h: para esos se
// muestran las dos. Para sedoanalgesia la de por hora alcanza.
const PA_POR_MINUTO = new Set(["Noradrenalina", "Adrenalina", "Dobutamina", "Dopamina"]);
const PA_UNIDAD = {
  Fentanilo: "mcg", Remifentanilo: "mcg", Dexmedetomidina: "mcg",
  Ketamina: "mg", Morfina: "mg", Noradrenalina: "mg", Midazolam: "mg", Propofol: "mg",
};
// Rango habitual, solo como control de sanidad del DATO: si cae afuera casi
// siempre es un ritmo viejo o una dilución mal escrita, no una mala dosis. No
// es una recomendación de dosificación y no pretende serlo.
//
// Contrastados con fuentes abiertas (StatPearls / NCBI Bookshelf, agosto 2026):
// dexmedetomidina, mantenimiento 0.2–0.7 mcg/kg/h y hasta 1.5 para alcanzar
// sedación, por eso el techo en 1.5. Noradrenalina: las fuentes para adultos
// la dan en mcg/min absolutos y no por kilo, así que el rango de acá es una
// conversión de uso, amplia a propósito (equivale a 0.01–3 mcg/kg/min) para
// que marque sólo lo groseramente improbable.
const PA_RANGO = {
  Fentanilo: [0.5, 10], Remifentanilo: [1, 12], Dexmedetomidina: [0.2, 1.5],
  Morfina: [0.005, 0.2], Ketamina: [0.05, 1.5], Noradrenalina: [0.0006, 0.18],
  Midazolam: [0.02, 0.2], Propofol: [0.5, 4],
};
const PA_INFUS = {
  FENTANILO: "Fentanilo", FNT: "Fentanilo", KETAMINA: "Ketamina", KETA: "Ketamina",
  MORFINA: "Morfina", NORADRENALINA: "Noradrenalina", NORA: "Noradrenalina",
  MIDAZOLAM: "Midazolam", MIDA: "Midazolam", PROPOFOL: "Propofol", PROPO: "Propofol",
  // "DEXMEDETO 400/100/3" aparece así en la 1.4: el nombre entero casi nunca
  // se escribe completo, conviene tener las formas cortas.
  DEXMEDETOMIDINA: "Dexmedetomidina", DEXMEDETO: "Dexmedetomidina", DEXME: "Dexmedetomidina",
  PRECEDEX: "Dexmedetomidina", REMIFENTANILO: "Remifentanilo", REMI: "Remifentanilo",
};
const PA_FARMACOS = new Set(["BISO", "LACOSAMIDA", "ZOLPIDEM", "HIDRO", "MESTINON",
  "PREGABALINA", "MEPREDNISONA", "ARIPIPRAZOL", "VALPROICO", "OLANZAPINA", "QUETIAPINA",
  "METADONA", "SANDOSTATIN", "PARACETAMOL", "TRAMADOL", "NIMODIPINA", "METOCLOPRAMIDA",
  "ONDANSETRON", "MORFINA", "BUPRENORFINA", "DEXAMETASONA", "HALOPERIDOL", "LORAZEPAM",
  "ENOXAPARINA", "LEVETIRACETAM", "FENITOINA"]);

// ── Nombres ────────────────────────────────────────────────────────────────
// El pase mezcla dos convenciones de sexo: F/H (femenino/hombre) y M
// (masculino). "Laluf, Carla Yamela, M" y "Fuentes Armando, M" no pueden ser la
// misma M, así que la M sola se descarta en vez de adivinar.
const PA_SEXO = { F: "Femenino", H: "Masculino" };
const PA_CHICAS = new Set(["de", "del", "la", "las", "los", "y", "da", "di", "van", "von"]);
const paTitulo = (s) => s.split(/\s+/).map((w, i) => {
  const lw = w.toLowerCase();
  return i > 0 && PA_CHICAS.has(lw) ? lw : lw.charAt(0).toUpperCase() + lw.slice(1);
}).join(" ");

/* ── Nombres de pila ───────────────────────────────────────────────────────
   Sirven para una sola cosa: decidir el orden cuando el pase no lo aclara.
   "FUENTES ARMANDO, M, 77" tiene coma, pero la coma separa el sexo, no el
   apellido; sin esta lista la app mostraba "Fuentes Armando" al revés.

   Es una lista, no una regla: no hay ninguna forma de saber por la forma de
   la palabra si "Armando" es nombre o apellido —de hecho Armando Espasandín
   y Armando Fuentes están los dos en el pase, uno con Armando de nombre y el
   otro también—. Por eso sólo se da vuelta el nombre cuando UNA de las dos
   palabras está acá y la otra no. Si están las dos, o ninguna, se respeta el
   orden en que lo escribieron: "Juan Máximo" queda "Juan Máximo".

   Están los de uso corriente en el plantel de pacientes del servicio. Si
   aparece uno que falta y sale al revés, se agrega acá y listo. */
const PA_PILA = new Set([
  // Masculinos
  "JUAN", "JOSE", "JOSÉ", "LUIS", "CARLOS", "JORGE", "MIGUEL", "ANGEL", "ÁNGEL",
  "MANUEL", "PEDRO", "PABLO", "RICARDO", "ROBERTO", "RAUL", "RAÚL", "OSCAR",
  "OSVALDO", "HECTOR", "HÉCTOR", "HUGO", "ALBERTO", "ADOLFO", "ANDRES", "ANDRÉS",
  "ANTONIO", "ARMANDO", "ARTURO", "DANIEL", "DAVID", "DIEGO", "DOMINGO", "EDUARDO",
  "ENRIQUE", "ERNESTO", "FEDERICO", "FELIX", "FÉLIX", "FERNANDO", "FRANCISCO",
  "GABRIEL", "GERARDO", "GUILLERMO", "GUSTAVO", "HORACIO", "IGNACIO", "JAVIER",
  "JULIO", "LEANDRO", "LEONARDO", "LORENZO", "LUCAS", "MARCELINO", "MARCELO",
  "MARCOS", "MARIANO", "MARIO", "MARTIN", "MARTÍN", "MATIAS", "MATÍAS", "MAURICIO",
  "MAXIMO", "MÁXIMO", "NESTOR", "NÉSTOR", "NICOLAS", "NICOLÁS", "NORBERTO",
  "OMAR", "PATRICIO", "RAMON", "RAMÓN", "RODOLFO", "RODRIGO", "RUBEN", "RUBÉN",
  "SANTIAGO", "SEBASTIAN", "SEBASTIÁN", "SERGIO", "TOMAS", "TOMÁS", "VICENTE",
  "VICTOR", "VÍCTOR", "WALTER", "ADRIAN", "ADRIÁN", "ALEJANDRO", "ALFREDO",
  "CRISTIAN", "DARIO", "DARÍO", "EMILIO", "ESTEBAN", "EZEQUIEL", "FABIAN", "FABIÁN",
  "GONZALO", "JOAQUIN", "JOAQUÍN", "LUCIANO", "MAXIMILIANO", "AGUSTIN", "AGUSTÍN",
  // Femeninos
  "MARIA", "MARÍA", "ANA", "CARMEN", "CRISTINA", "GRACIELA", "SUSANA", "SILVIA",
  "PATRICIA", "MONICA", "MÓNICA", "BEATRIZ", "LAURA", "MARTA", "NORMA", "ELENA",
  "ROSA", "TERESA", "ALICIA", "ANDREA", "CLAUDIA", "GABRIELA", "MARCELA",
  "VERONICA", "VERÓNICA", "ADRIANA", "SANDRA", "VIVIANA", "LILIANA", "MIRTA",
  "NELIDA", "NÉLIDA", "OLGA", "IRMA", "ELSA", "HILDA", "JULIA", "LUCIA", "LUCÍA",
  "FLORENCIA", "SOFIA", "SOFÍA", "VALERIA", "NATALIA", "NATALY", "CAROLINA",
  "CARLA", "KARINA", "PAULA", "LUISANA", "ROMINA", "YAMELA", "CECILIA", "DANIELA",
  "ESTELA", "INES", "INÉS", "IRENE", "ISABEL", "JOSEFA", "JUANA", "LIDIA", "LUISA",
  "MERCEDES", "NORA", "RAQUEL", "SARA", "STELLA", "VICTORIA", "AGUSTINA",
  "CAMILA", "MICAELA", "ROCIO", "ROCÍO", "SOLEDAD", "VANESA", "XIMENA",
]);

const esPila = (w) => PA_PILA.has((w || "").toUpperCase());

/* Decide el orden de "PALABRA PALABRA" cuando el pase no lo aclara con una
   coma. Devuelve el texto reordenado como "nombre apellido", o el mismo
   texto si no hay una razón clara para darlo vuelta. */
function paOrdenNombre(t) {
  const ws = t.split(/\s+/).filter(Boolean);
  if (ws.length < 2) return t;
  const pilas = ws.map(esPila);
  const cuantas = pilas.filter(Boolean).length;
  // Ninguna reconocida, o todas: no hay información para decidir. Se respeta
  // lo escrito, que es lo que pidió Gonzalo para los casos dudosos.
  if (cuantas === 0 || cuantas === ws.length) return t;

  // Los nombres de pila van juntos: o están todos al principio (ya está bien)
  // o todos al final (hay que darlo vuelta). Si están intercalados, es un
  // nombre raro y no se toca.
  const primera = pilas.indexOf(true), ultima = pilas.lastIndexOf(true);
  if (ultima - primera + 1 !== cuantas) return t;

  if (primera === 0) return t;                       // "Armando Fuentes": ya está

  // Sólo se da vuelta el caso de dos palabras: "FUENTES ARMANDO" → "Armando
  // Fuentes". Con tres o más no alcanza para decidir. "HASAN NICOLÁS DANIEL"
  // puede ser apellido Hasan con dos nombres, o dos apellidos con Daniel de
  // nombre; las dos lecturas son razonables y dar vuelta una a la fuerza
  // acierta la mitad de las veces. En la duda se respeta lo escrito, y si
  // está mal se corrige a mano desde "editar ficha".
  if (ws.length === 2 && ultima === ws.length - 1)
    return [ws[1], ws[0]].join(" ");
  return t;
}

function paNombre(raw) {
  let t = (raw || "").replace(/\s+/g, " ").trim();
  let edad = null, sexo = null;
  let m = t.match(/(\d{1,3})\s*(?:AÑOS?|Años?|años?)?\s*$/);
  if (m) { const e = +m[1]; if (e > 0 && e < 120) { edad = e; t = t.slice(0, m.index); } }
  t = t.replace(/[\s,.]+$/, "");
  m = t.match(/,\s*([FHM])\s*$/);
  if (m) { sexo = PA_SEXO[m[1]] || null; t = t.slice(0, m.index).replace(/[\s,.]+$/, ""); }
  let nombre;
  if (t.includes(",")) {
    const [ap, no] = t.split(/,(.+)/);
    // La coma dice "apellido, nombre" y casi siempre acierta. Pero hay pases
    // escritos "FUENTES ARMANDO, M, 77", donde la coma separaba el sexo y ya
    // se la comió el paso de arriba: lo que queda antes de la coma es el
    // nombre completo, no sólo el apellido. Si de ese lado hay un nombre de
    // pila reconocible, mandan las palabras y no la coma.
    nombre = no === undefined
      ? paTitulo(paOrdenNombre(ap.trim()))
      : `${paTitulo(no.trim())} ${paTitulo(ap.trim())}`;
  } else {
    // Sin coma no se sabe dónde termina el apellido. Se da vuelta sólo si una
    // de las palabras es un nombre de pila conocido y la otra no; si no, se
    // respeta el orden, porque invertir a ciegas convierte "Hasan Nicolás
    // Daniel" en "Daniel Hasan Nicolás".
    nombre = paTitulo(paOrdenNombre(t));
  }
  return { nombre: nombre.trim(), edad, sexo };
}

// Acentos que el pase escribe en mayúscula sin tilde y se pierden al bajar.
const PA_ACENTOS = {
  lucido: "lúcido", lucida: "lúcida", distension: "distensión", serohematico: "serohemático",
  cateter: "catéter", via: "vía", vias: "vías", dias: "días", ultima: "última", ultimo: "último",
  septico: "séptico", septica: "séptica", hipotension: "hipotensión", infeccion: "infección",
  internacion: "internación", evolucion: "evolución", reaccion: "reacción", cirugia: "cirugía",
  oxigeno: "oxígeno", clinico: "clínico", clinica: "clínica", cronico: "crónico", cronica: "crónica",
  toracico: "torácico", toracica: "torácica", gastrico: "gástrico", hepatico: "hepático",
  pulmon: "pulmón", cardiaco: "cardíaco", neurologico: "neurológico", antibiotico: "antibiótico",
  antibioticos: "antibióticos", sedacion: "sedación", intubacion: "intubación",
  extubacion: "extubación", traqueostomia: "traqueostomía", laparotomia: "laparotomía",
  coleccion: "colección", colecciones: "colecciones", perforacion: "perforación",
  fistula: "fístula", neumonia: "neumonía", transfusion: "transfusión", funcion: "función",
  presion: "presión", hemodinamico: "hemodinámico", organico: "orgánico",
  sintomas: "síntomas", subito: "súbito", subita: "súbita", hipoventilacion: "hipoventilación",
  liquido: "líquido", tonico: "tónico", clonicas: "clónicas", clonico: "clónico",
  analgesia: "analgesia", diuresis: "diuresis", peritonitis: "peritonitis",
  quirurgico: "quirúrgico", quirurgica: "quirúrgica", anemia: "anemia",
  hematico: "hemático", hematoma: "hematoma", craneo: "cráneo", torax: "tórax",
  abdomen: "abdomen", cefalea: "cefalea", vomitos: "vómitos", disnea: "disnea",
  astenia: "astenia", somnolencia: "somnolencia", fiebre: "fiebre",
  colonizacion: "colonización", aislamiento: "aislamiento", desaturacion: "desaturación",
  mecanica: "mecánica", ventilatoria: "ventilatoria", ultrasonido: "ultrasonido",
  gastroenterologia: "gastroenterología", nefrologia: "nefrología", oncologico: "oncológico",
  metastasis: "metástasis", diagnostico: "diagnóstico", pronostico: "pronóstico",
  terapeutico: "terapéutico", farmacologico: "farmacológico", isquemico: "isquémico",
  hemorragico: "hemorrágico", trombotico: "trombótico", embolico: "embólico",
  respiratorio: "respiratorio", renal: "renal", hepatica: "hepática",
  arteria: "arteria", venosa: "venosa", radiologia: "radiología", tomografia: "tomografía",
  // Las que ya vienen acentuadas EN MAYÚSCULA necesitan su entrada igual: al
  // bajarlas quedan con la tilde puesta ("Órdenes") y parecen nombre propio.
  "órdenes": "órdenes", ordenes: "órdenes", "última": "última", "último": "último",
  "lúcida": "lúcida", "lúcido": "lúcido", "hepático": "hepático", "ángulo": "ángulo",
  "cráneo": "cráneo", "tórax": "tórax", "vómitos": "vómitos", "síntomas": "síntomas",
  "mecánica": "mecánica", "línea": "línea", "días": "días", "día": "día",
};
// Palabras que SÍ se bajan a minúscula aunque sean cortas. Sin esto, "TC DE
// ABDOMEN Y PELVIS" queda como "TC DE abdomen Y pelvis": las siglas de 2-4
// letras se respetan por defecto (QX, TAP, HDE son vocabulario real), y eso
// mismo dejaba en mayúscula a los conectores. La regla no puede ser sólo el
// largo, hay que nombrarlos.
const PA_COMUNES = new Set(["SIN", "POR", "CON", "PARA", "DEL", "LOS", "LAS", "UNA", "UNO", "UNOS", "UNAS",
  "NO", "SI", "SE", "SU", "SUS", "AL", "EN", "MAS", "ANTE", "TRAS", "SOBRE", "HOY", "DIA", "DIAS",
  "FOCO", "DOLOR", "LEVE", "ALTA", "BAJA", "ESTA", "ESTE", "CADA", "TODO", "TODA",
  "DE", "Y", "O", "A", "EL", "LA", "LO", "UN", "ES", "HA", "HAY", "QUE", "COMO", "DESDE",
  "HASTA", "ENTRE", "DURANTE", "SEGUN", "SOLO", "YA", "MUY", "BIEN", "MAL", "CUATRO",
  "TRES", "DOS", "CINCO", "SEIS", "NUEVA", "NUEVO", "MENOR", "MAYOR", "AMBOS", "AMBAS",
  "ANTERIOR", "POSTERIOR", "DERECHA", "DERECHO", "IZQUIERDA", "IZQUIERDO", "BILATERAL",
  // Palabras corrientes y unidades que quedaban gritando en el tratamiento:
  // "PESO 60 KG", "FURO 20 DIA". No son siglas, son palabras cortas.
  // "MG" no está acá a propósito: en laboratorio es el magnesio y debe quedar
  // como sigla. Cuando es la unidad viene pegada a un número y la regla de
  // unidades de PA_EXPANDIR ya la baja a "mg".
  "PESO", "KG", "ML", "DIA", "DIAS", "NOCHE", "HS", "GR", "MCG", "AMP", "GOTAS",
  "DIETA", "BLANDA", "AGUA", "LIBRE", "VIA", "ORAL", "TOTAL", "PARCIAL", "PLAN",
  "ALTA", "PASE", "CAMA", "SALA", "TURNO", "CONTROL", "SEGUIR", "IGUAL", "MISMO",
  "AYER", "MAÑANA", "TARDE", "SEMANA", "MES", "AÑO", "AÑOS", "VECES", "CADA",
  "AUTO", "MALA", "MALO", "BUENA", "BUENO", "ORDENES", "ÓRDENES", "ULTIMA", "ÚLTIMA",
  "NOCHE", "NOCTURNO", "NIEGA", "REFIERE", "PERSISTE", "CONTINUA", "SIGUE",
  "BILIOSO", "SEROSO", "SEROSOS", "SEROHEMATICO", "SEROHEMÁTICO", "PURULENTO",
  "CERV", "CERVICAL", "DISTENDIDO", "BLANDO", "DEPRESIBLE", "DOLOROSO",
  // Palabras castellanas que el pase escribe en mayúscula y no son siglas.
  // Sin esto el detector las marca como jerga desconocida y hace ruido.
  "LADO", "TOMA", "MASA", "MIDE", "HACE", "FOSA", "BASE", "NIVEL", "CURSO",
  "CAMBIOS", "AUMENTO", "MENOR", "MAYOR", "LIBRE", "MEDIA", "GUARDIA", "SALA",
  "NEGATIVO", "POSITIVO", "PERSISTE", "INICIA", "SUSP", "STOP", "VIAS", "VÍAS",
  "DERRAME", "PLEURAL", "HEMATOMA", "SUBDURAL", "PARIETAL", "FRONTO", "PARIETO",
  "INSULAR", "INFERIOR", "SUPERIOR", "ANTERIOR", "ESPESOR", "MULTIPLES",
  "MÚLTIPLES", "CONTEXTO", "PREVIO", "HACIA", "TURBIO", "SEDACIÓN", "SEDACION",
  "STATUS", "FIEBRE", "DOLOR", "EDEMA", "ASTA", "DIFUSA", "SIGNOS", "AUSENTE",
  "AUSENTES", "PRESENTE", "VITAL", "FUNCIONANTE", "CUBIERTAS", "GASAS"]);

// Abreviaturas de fármacos que se escriben cortas pero son nombres, no siglas:
// conviene verlas con inicial mayúscula y no en bloque. Se resuelven en
// PA_ACENTOS con su forma prolija.
const PA_DROGAS_CORTAS = {
  furo: "Furosemida", mero: "Meropenem", vanco: "Vancomicina", ptz: "Piperacilina-tazobactam",
  col: "Colistina", ams: "Ampicilina-sulbactam", dexa: "Dexametasona", lora: "Lorazepam",
  // "leve" NO va acá: en los informes de imágenes "LEVE AUMENTO", "LEVE
  // EDEMA" son el adjetivo castellano, y el diccionario, que mira palabra por
  // palabra sin contexto, los convertía en "Levetiracetam". En un renglón de
  // tratamiento eso es peligroso. Se resuelve en PA_EXPANDIR exigiendo que
  // atrás venga una dosis, que es como se escribe la droga de verdad.
  dipi: "Dipirona", para: "Paracetamol", keta: "Ketamina",
  nora: "Noradrenalina", biso: "Bisoprolol", diclo: "Diclofenac", hidro: "Hidrocortisona",
  fluco: "Fluconazol", aciclo: "Aciclovir", claritro: "Claritromicina", anfo: "Anfotericina",
};

const PA_EXPANDIR = [
  [/\bHDE\b/gi, "hemodinámicamente estable"], [/\bHDI\b/gi, "hemodinámicamente inestable"],
  // "VE" tiene una variante por residente. Todas dicen lo mismo: si respira
  // solo y con cuánto oxígeno. Se unifican como "VE sin O₂" / "VE con O₂ a
  // N L/min", que es la forma corta que ya se lee de un vistazo.
  [/\bVE\s*S\/?\s*O\s*2\b/gi, "VE sin O₂"],
  [/\bVE\s+SIN\s+O\s*2\b/gi, "VE sin O₂"],
  [/\bVE\s+SIN\s+REQ\.?\s*(?:DE)?\s*O\s*2\b/gi, "VE sin O₂"],
  [/\bVE\s+O2A?\s*([\d.,]+)\s*L(?:TS?|\/M(?:IN)?)?\b/gi, "VE con O₂ a $1 L/min"],
  [/\bVE\s+([\d.,]+)\s*L(?:TS?|\/M(?:IN)?)?\b/gi, "VE con O₂ a $1 L/min"],
  [/\bEOT\b/gi, "extubación"],
  [/\bVVC\b/gi, "vía venosa central"], [/\bDVE\b/gi, "drenaje ventricular externo"],
  [/\bTAP\b/gi, "tubo pleural"], [/\bNET\b/gi, "nutrición enteral total"],
  [/\bNPT\b/gi, "nutrición parenteral total"], [/\bNE\b/gi, "nutrición enteral"],
  [/\bDICLO\b/gi, "diclofenac"], [/\bBISO\b/gi, "bisoprolol"], [/\bPRECEDEX\b/gi, "dexmedetomidina"],
  // LEVE es levetiracetam sólo si atrás viene una dosis ("LEVE 500 MG C/12",
  // "LEVE 1 GR"). "LEVE AUMENTO", "LEVE EDEMA" y demás quedan como el
  // adjetivo, que es lo que son en los informes de imágenes.
  [/\bLEVE\s+(?=\d)/gi, "Levetiracetam "],
  [/\bRHA\s*\+/gi, "ruidos hidroaéreos presentes"],
  [/\bRHA\b/gi, "ruidos hidroaéreos"], [/\bISQX\b/gi, "infección de sitio quirúrgico"],
  [/\bEPM\b/gi, "episodio psicomotriz"], [/\bVEDA\b/gi, "videoendoscopia digestiva alta"],
  [/\bVATS\b/gi, "cirugía toracoscópica videoasistida"], [/\bCBO\b/gi, "cerebro"],
  // Unidades pegadas al número: "120MG" → "120 mg", "20ML" → "20 ml".
  // "MG" pegado al número es miligramos ("1000MG"); separado y seguido de otro
  // número es el magnesio del laboratorio ("PLQ 85 MG 1.8"), que se deja como
  // sigla. Sin esta distinción el analito se convertía en unidad.
  [/(\d)MG\b/gi, "$1 mg"],
  [/(\d)\s+MG\b(?!\s*[\d.,])/gi, "$1 mg"],
  [/(\d)\s*ML\b/gi, "$1 ml"], [/(\d)\s*KG\b/gi, "$1 kg"],
  [/(\d)\s*MCG\b/gi, "$1 mcg"], [/(\d)\s*GRS?\b/gi, "$1 g"],
  // "FURO 20 DIA" quiere decir 20 por día, no "20 día".
  [/(\d)\s+D[IÍ]A\b/gi, "$1 por día"],
  [/\bDIA\b/g, "día"], [/\bdia\b/g, "día"], [/\bDIAS\b/g, "días"], [/\bdias\b/g, "días"],
  // ── Examen físico y estado, según los patrones del pase ──────────────────
  // Estas salen de mirar los 25 pases: son las formas que realmente se usan.
  // La idea no es traducir palabra por palabra sino que la frase se lea como
  // una oración ("abdomen doloroso a la palpación profunda").
  [/\bABD\b/gi, "abdomen"], [/\bABDI\b/gi, "abdomen"],
  [/\bA\s+PALP\.?\s+PROFUNDA\b/gi, "a la palpación profunda"],
  [/\bPALP\b\.?/gi, "palpación"],
  [/\bMMII\b/gi, "miembros inferiores"], [/\bMMSS\b/gi, "miembros superiores"],
  [/\bFII\b/gi, "fosa ilíaca izquierda"], [/\bFID\b/gi, "fosa ilíaca derecha"],
  [/\bHD\b(?!E)/gi, "hipocondrio derecho"], [/\bHI\b/gi, "hipocondrio izquierdo"],
  [/\bDER\b\.?/gi, "derecha"], [/\bIZQ\b\.?/gi, "izquierda"],
  [/\bSNG\b/gi, "sonda nasogástrica"], [/\bSV\b/gi, "sonda vesical"],
  [/\bTAP\b/gi, "tubo pleural"], [/\bVAC\b/gi, "sistema VAC"],
  [/\bAT\b/gi, "aspirado traqueal"],
  // "2 DJES" son dos drenajes, no "2 drenaje": el plural se respeta.
  [/\b(\d+)\s+DJE?S\b/gi, "$1 drenajes"], [/\bDJES\b/gi, "drenajes"],
  [/\bDJE\b/gi, "drenaje"], [/\bDJP\b/gi, "drenaje"], [/\bDREN\b/gi, "drenaje"],
  // "ABDI RHA AUSENTES" es abdomen CON ruidos ausentes.
  [/\bABDI?\s+(?=RHA|RUIDOS)/gi, "abdomen con "],
  [/\bS\/\s*P\b/gi, "sin particularidades"],
  [/\bAFEBRIL\b/gi, "afebril"], [/\bSUBFEBRIL\b/gi, "subfebril"],
  [/\bESCARA\b/gi, "escara"],
  // Antihipertensivos y demás que el pase abrevia. Confirmadas con Gonzalo.
  [/\bDOXA\b/gi, "doxazosina"], [/\bAMLO\b/gi, "amlodipina"],
  [/\bNXB\b/gi, "nada por boca"], [/\bNPO\b/gi, "nada por boca"],
  // "HASAT RODILLAS" es "hasta las rodillas": un tipeo, no una sigla.
  [/\bHASAT\b/gi, "hasta"],
  // "Carvedilol 12.5/12" = 12,5 mg cada 12 h. El patrón dosis/intervalo es
  // constante en el pase, así que se escribe como se lee en voz alta.
  [/\b([A-Za-zÁÉÍÓÚÑáéíóúñ]{4,})\s+([\d.,]+)\s*\/\s*(4|6|8|12|24)\b(?!\s*\/)/g, "$1 $2 mg cada $3 h"],
  [/\bC\/\s*(4|6|8|12|24)\s*(?:HS?)?\b/gi, "cada $1 h"],
  // El balance del día al final del renglón, en palabras.
  [/,\s*(\d{2,4})\s*-\s*(\d{2,4})\s*$/gm, ". Ingresos $1 ml, diuresis $2 ml"],
  // ── Sacadas del contexto de los propios pases (barrido de las 25 camas) ──
  // Antibióticos y microbiología: aparecen siempre dentro de listas de ATB o
  // de cultivos, así que el contexto no deja lugar a dudas.
  [/\bTIGE\b/gi, "tigeciclina"], [/\bCRO\b/gi, "ceftriaxona"],
  [/\bCAZ\s*\/\s*AVI\b/gi, "ceftazidima-avibactam"], [/\bCEFTA\s+AVI\b/gi, "ceftazidima-avibactam"],
  [/\bFEP\b/gi, "cefepime"], [/\bDAPTO\b/gi, "daptomicina"], [/\bMETRO\b/gi, "metronidazol"],
  [/\bANIDULA\b/gi, "anidulafungina"], [/\bLEVO\b/gi, "levofloxacina"],
  [/\bCGP\b/gi, "cocos gram positivos"], [/\bBGN\b/gi, "bacilos gram negativos"],
  [/\bEVR\b/gi, "enterococo vancomicina resistente"],
  [/\bTCD\b/gi, "toxina de Clostridioides difficile"],
  // Estudios y antecedentes.
  [/\bEFR\b/gi, "espirometría"], [/\bCRM\b/gi, "cirugía de revascularización miocárdica"],
  [/\bDLP\b/gi, "dislipemia"], [/\bACO\b/gi, "anticoagulación"],
  [/\bFQ\b/gi, "fisicoquímico"], [/\bDIFU\b/gi, "difusión"],
  // "ASCITIS GII" es grado II; el recuento del líquido usa RTO y MONO.
  [/\bG(I{1,3}|IV)\b/g, (m, r) => "grado " + r],
  [/\bRTO\b/gi, "recuento"], [/\bMONO\b/gi, "mononucleares"],
  [/\bRMN\b/gi, "resonancia"], [/\bRXTX\b/gi, "radiografía de tórax"],
  [/\bITU\b/gi, "infección urinaria"], [/\bKPN\b/gi, "Klebsiella pneumoniae"],
  [/\bFBC\b/gi, "fibrobroncoscopía"], [/\bHPB\b/gi, "hiperplasia prostática benigna"],
  [/\bACM\b/gi, "arteria cerebral media"], [/\bDTC\b/gi, "doppler transcraneal"],
  [/\bDM\b/gi, "diabetes mellitus"], [/\bVO\b/gi, "vía oral"],
  // ── Ambiguas: se resuelven por contexto, nunca a ciegas ──────────────────
  // NIR va siempre pegado a diabetes; DOB es daño de órgano blanco.
  [/\bNIR\b/gi, "no insulinorrequiriente"], [/\bDOB\b/g, "daño de órgano blanco"],
  [/\bRZO\b/gi, "realizó"],
  // ISQX es siempre infección de sitio quirúrgico. ISQ a secas depende: con
  // ACV o con un miembro es isquémico/isquemia; sólo se expande cuando el
  // contexto lo dice, y si no queda como está.
  [/\bISQX\b/gi, "infección de sitio quirúrgico"],
  [/\bACV\s+ISQ\b/gi, "ACV isquémico"],
  [/\bISQ\s+(MMII|MII|MSI|MSD|MID)\b/gi, "isquemia de $1"],
  // AA con cirugía o laparotomía es abdomen agudo; con infrarrenal o aorta es
  // aneurisma. Sin ninguna de las dos pistas, se deja sin tocar.
  [/\bAA\s+(QX|LAP|PERFORATIVO|OBSTRUCTIVO)\b/gi, "abdomen agudo $1"],
  [/\bAA\s+(INFRARENAL|INFRARRENAL|AORT[AI]CO|DE\s+AORTA)\b/gi, "aneurisma $1"],
  [/\bPEND\b/gi, "pendiente"], [/\bCIR\b/gi, "catéter peridural"], [/\bTFG\b/gi, "filtrado glomerular"],
  // ── Sumadas el 2/9/2026 ──────────────────────────────────────────────────
  // Normalizaciones de laboratorio: el pase escribe la misma cosa de tres
  // maneras según quién la anota. Se unifican a la forma que usa el servicio.
  // Ojo: acá NO se expanden a la palabra completa, se corrige la sigla, que
  // es como se lee mejor en una lista de valores.
  [/\bHGB\b/g, "Hb"], [/\bHB\b/g, "Hb"], [/\bHEMOGLOBINA\b/gi, "Hb"],
  [/\bPLT\b/g, "PLQ"], [/\bPLAQ\b/g, "PLQ"], [/\bPLAQUETAS\b/gi, "PLQ"],
  // MG en laboratorio es magnesio y se deja MG. Pero "20MG" ya se convirtió
  // en "20 mg" más arriba, así que lo que queda suelto es el analito.
  // Términos de cirugía y abdomen confirmados con Gonzalo.
  [/\bSOI\b/gi, "suboclusión intestinal"],
  [/\bBHN\b/gi, "balance hídrico negativo"],
  [/\bBHP\b/gi, "balance hídrico positivo"],
  [/\bASAS\b/gi, "asas"],
  // LAP es laparoscopía sola, o laparoscópico cuando adjetiva a la cirugía.
  [/\b(COLECISTECTOM[IÍ]A|APENDICECTOM[IÍ]A|GASTRECTOM[IÍ]A|CIRUG[IÍ]A)\s+LAP\b/gi, "$1 laparoscópica"],
  [/\bLAP\s+(EXPLORADORA|DIAGN[OÓ]STICA)\b/gi, "laparoscopía $1"],
  [/\bLAP\b/gi, "laparoscopía"],
  // ILEO depende del contexto: solo se toca cuando el propio renglón lo
  // aclara. "ILEOCOLICO", "ILEOSTOMIA" y demás no se rompen porque el \b
  // exige que la palabra termine ahí.
  [/\b[IÍ]LEO\s+PARAL[IÍ]TICO\b/gi, "íleo paralítico"],
  [/\bILEOSTOM[IÍ]A\b/gi, "ileostomía"],
  // CTE es contraste cuando habla una tomografía; si no, se deja.
  [/\b(TC|TAC|RMN|RESONANCIA|TOMOGRAF[IÍ]A)\s*(C\/|CON\s+|S\/|SIN\s+)?CTE\b/gi,
    (m, est, prep) => `${est} ${prep ? prep.replace(/^C\/$/i, "con ").replace(/^S\/$/i, "sin ") : ""}contraste`.replace(/\s+/g, " ")],
  [/\bC\/\s*CTE\b/gi, "con contraste"], [/\bS\/\s*CTE\b/gi, "sin contraste"],
  // MM pegado a un número es milímetros; suelto puede ser otra cosa y no se toca.
  [/(\d)\s*MM\b/g, "$1 mm"],
];

// ── Detector de abreviaturas que la app todavía no entiende ────────────────
//
// El pase suma jerga nueva todo el tiempo y hasta ahora la cazábamos de a una,
// leyendo pases a mano. Esto la junta sola: una sigla que sobrevive a
// paLimpiar() —queda en mayúscula, no está en ningún diccionario y no es un
// laboratorio ni una unidad— es candidata a que alguien la explique.
//
// A propósito NO adivina el significado: sólo señala. Inventar una expansión
// plausible en un pase de terapia es peor que dejar la sigla cruda.
const PA_IGNORAR = new Set([
  // Laboratorios y gases: se leen bien abreviados y son los que más aparecen.
  "HB", "HTO", "HT", "GB", "PLAQ", "GLU", "UREA", "CREA", "CR", "NA", "K", "CL",
  "CA", "MG", "P", "ALB", "PROT", "BILI", "BT", "FAL", "TGO", "TGP", "LDH", "TP",
  "APTT", "RIN", "PMN", "LEUCOS", "TAG", "TG", "AMILASA", "PH", "PO2", "PCO2",
  "HCO3", "EB", "SAT", "FIO2", "PAFI", "LAC",
  // Cultivos y microbiología.
  "HC", "HCX", "UC", "RC", "HMC", "MATQX", "ATB", "BAL", "MPX",
  // Unidades y medidas.
  "ML", "MG", "GR", "GRS", "MCG", "KG", "CM", "MM", "LTS", "L", "HS", "H", "UI", "UGR",
  // Siglas de uso corriente que ya todos leen.
  "UTI", "UCO", "RECU", "CM", "QX", "DX", "TC", "TAC", "RM", "RX", "ECO", "EEG",
  "LCR", "GCS", "RASS", "SOFA", "APACHE", "PIC", "PAM", "TAM", "FC", "FR", "TA",
  "OK", "SOS", "NEG", "POS", "OFF", "ON", "II", "III", "IV", "VI",
  // Vía aérea, accesos y soportes: vocabulario diario del servicio.
  "IOT", "ARM", "VNI", "CPAP", "VE", "EOT", "TQT", "TET", "SNG", "SV", "TAP",
  "CVC", "VVC", "VVP", "PICC", "DVE", "DJE", "DJP", "COOK", "VAC", "HD", "HDF",
  "PC", "PS", "VC", "VCV", "PCV", "VT", "PEEP", "PAFI", "FD", "YD", "FI", "YI",
  // Patologías y antecedentes que se escriben siempre abreviados.
  "HTA", "DBT", "EPOC", "ERC", "IC", "IAM", "ACV", "HSA", "TEP", "TVP", "FA",
  "IRA", "IRC", "HIP", "TBQ", "OH", "SAHOS", "MOD", "SME", "CF", "FEY", "BGN",
  "BGP", "SAMS", "SAMR", "KPC", "BLEE", "PBE", "HDA", "HDB",
  // Soluciones, sueros y nutrición.
  "SF", "RL", "DX", "NE", "NET", "NPT", "PHP", "AM", "PM",
  // Servicios, procedimientos y varios de uso corriente.
  "TTO", "REQ", "EAB", "PL", "TX", "EX", "PQ", "LIQ", "AMC", "MI", "AP", "EA",
  "GOT", "BASE", "PR", "DOB", "HMD", "CTI", "CM", "GC", "TR",
]);

function paDesconocidas(txt) {
  if (!txt) return [];
  const out = new Set();
  // Sólo sobre el texto YA limpiado: lo que queda en mayúscula ahí es lo que
  // ningún diccionario supo tocar.
  const limpio = paLimpiar(txt);
  const re = /(?<![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])[A-ZÁÉÍÓÚÜÑ]{2,10}(?![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/g;
  let m;
  while ((m = re.exec(limpio))) {
    const w = m[0];
    if (PA_IGNORAR.has(w) || PA_COMUNES.has(w)) continue;
    if (/\d/.test(w)) continue;
    out.add(w);
  }
  return [...out];
}

// ── Cultivos: un renglón por muestra ───────────────────────────────────────
//
// El campo viene como un párrafo corrido donde conviven fechas, muestras y
// gérmenes, separados con lo que el residente tuvo a mano: "//", "/", ",", o
// nada. Cuesta leerlo en el celular justo cuando importa, que es cuando hay
// fiebre y hay que saber qué creció y de dónde.
//
// Se parte en un renglón por muestra, con la fecha adelante. Si dos muestras
// vienen sin fecha entre medio, la segunda hereda la de la anterior: es la
// convención del servicio (se sacaron el mismo día).
//
// Importante: la barra NO sirve como separador de muestras, porque también se
// usa DENTRO de una ("MAT/QX", "HMC/RC/UC", "COPRO/TCD"). Se corta por fecha y
// por "//", que son los cortes que no tienen ese doble uso.
const PA_MUESTRAS = [
  [/^HMC\s*X\s*(\d)/i, (m) => `HMCx${m[1]}`], [/^HMC\b/i, () => "HMC"],
  [/^HC\s*X\s*(\d)/i, (m) => `HCx${m[1]}`],
  [/^H\s*X\s*(\d)/i, (m) => `HCx${m[1]}`], [/^HC\b/i, () => "HC"],
  [/^UC\b/i, () => "UC"], [/^RC\b/i, () => "RC"], [/^AT\b/i, () => "AT"],
  [/^MAT\s*\/?\s*QX\b/i, () => "Mat Qx"], [/^MATQX\b/i, () => "Mat Qx"],
  [/^LCR\b/i, () => "LCR"], [/^COPRO\b/i, () => "Copro"],
  [/^MPX\b/i, () => "MPX"], [/^TCD\b/i, () => "TCD"],
  [/^PC\b/i, () => "PC"], [/^MINIBAL\b/i, () => "Minibal"], [/^BAL\b/i, () => "BAL"],
];

// ── Reordenar lo clínico según QUÉ es, no dónde lo escribieron ────────────
//
// En el Drive los cuatro campos de resultados —laboratorio, EAB, cultivos y
// estudios— se usan como cajones sueltos: lo que se escribe primero cae donde
// haya lugar. En la cama 1.3 del 31/8, el campo "cultivos" tenía adentro tres
// EEG, una resonancia y el laboratorio completo; y el campo "estudios" tenía
// los cultivos. Leído así, para saber si creció algo hay que barrer los cuatro
// campos, que es justo lo que uno no quiere hacer a las tres de la mañana.
//
// Esto reparte cada renglón según lo que dice, no según dónde estaba. Un EEG
// va a estudios aunque lo hayan escrito en cultivos; un hemocultivo va a
// cultivos aunque esté en estudios; una tira de GB/HB/PLAQ va a laboratorio.
//
// Criterio conservador a propósito: lo que NO se puede clasificar con certeza
// se queda donde estaba. Mover mal un dato es peor que dejarlo en un cajón
// raro — al menos ahí el residente sabe buscarlo.
const PA_ES_ESTUDIO = /\b(EEG|RNM|RMN|RESONANCIA|TAC|TC|TCTX|RX|RXTX|RADIOGRAF|ECO|ECOCARDIO|DOPPLER|ANGIO|DIFU|DIFUSI[ÓO]N|VEDA|ENDOSCOPIA|CENTELLO|PET|TOMOGRAF|ESPIROMETR|FIBROBRONCO|FBC|ANGIOTC|ANGIOTAC|DTC|ETE|ETT|ECODOPPLER|FIBRO\s*BRONCO|RM\b|MINIMENTAL|POLISOMNO)\b/i;
const PA_ES_CULTIVO = /\b(HMC|HC|HX\d|HCX\d|HMCX\d|UC|RC|AT|MAT\s*\/?\s*QX|MATQX|MPX|TCD|COPRO|MINIBAL|BAL|HISOPADO|PUNTA|RETRO|MICOL[ÓO]GICO|BACTERIOL[ÓO]GICO|CRIPTOCOCO|GDH)\b/i;
const PA_ES_GERMEN = /\b(SAMS|SAMR|SAMR?S|KPC|KPN|BGN|CGP|EVR|BLEE|E\.?\s*COLI|KLEBSIELLA|STREPTO|STAPH|S\.\s*EPIDERMIDIS|ENTEROCOCO|E\.?\s*FAECIUM|CANDIDA|SERRATIA|PSEUDOMONA|ACINETOBACTER|BACTEROIDES|ENTEROBACTER|CLOACAE|MET[AI]P?NEUMO|MTP|ANGINOSUS|CONSTELLATUS|PARAPSILOSIS|KRUSEI|GLABRATA|CAPITIS|LENTUS|MARCENSES|MICROCOCUSS?|OXYTOCA|PNEUMONIA[E]?)\b/i;
// El fisicoquímico del líquido cefalorraquídeo: es el resultado de una punción,
// no un cultivo ni una tira de sangre. Sin esta regla el mismo LCR cae en
// laboratorio o en estudios según cuántos valores le hayan escrito ese día.
const PA_ES_LCR_FQ = /\bLCR\b[\s\S]{0,40}?(TURBIO|L[ÍI]MPIDO|INCOLORO|LEUCOS?|GLUCORRAQUIA|PROTEINORRAQUIA|MONONUCLEAR|PMN)/i;
// Una tira de laboratorio: tres o más analitos con su número.
const PA_ANALITOS = /\b(GB|HB|HTO?|PLAQ|TP|APTT|RIN|NA|K|CL|UREA|CREA|CA|P|MG|GOT|TGO|TGP|FAL|BT|BILI|ALB|PROT|LDH|AMILASA|TAG|TG|GLU|LEUCOS|PMN|LAC)\s*[<>]?\s*\d/gi;
// El EAB se escribe como una tira de barras que arranca con un pH: 7.40/34.5/…
const PA_ES_EAB = /(^|\s)7[.,]\d{2}\s*\/\s*\d/;

function paQueEs(txt) {
  const t = (txt || "").trim();
  if (!t) return null;
  if (/^LABORATORIO\b/i.test(t)) return "labo";
  if (PA_ES_EAB.test(t) || /^EAB\b/i.test(t)) return "eab";
  // El orden importa: "25/08 HMC X2, UC, cultivos LCR: pendiente" tiene
  // siglas de cultivo Y la palabra LCR; manda el cultivo.
  if (PA_ES_CULTIVO.test(t) || PA_ES_GERMEN.test(t)) return "cultivos";
  if (PA_ES_LCR_FQ.test(t)) return "estudios";
  if (PA_ES_ESTUDIO.test(t)) return "estudios";
  const analitos = (t.match(PA_ANALITOS) || []).length;
  if (analitos >= 3) return "labo";
  return null;   // no se sabe: se queda donde estaba
}

// Parte un campo en trozos con fecha, igual que los cultivos: una fecha nueva
// arranca un dato nuevo, y el que viene sin fecha hereda la anterior.
function paTrozos(txt) {
  const FECHA = /((?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])(?:\/\d{2,4})?)/;
  const out = [];
  let ultima = "";
  for (const bloque of (txt || "").split(/\s*\/\/\s*|\n/)) {
    const re = new RegExp(FECHA.source + "(?=\\s)", "g");
    const cortes = [];
    let m;
    while ((m = re.exec(bloque))) if (m.index > 0) cortes.push(m.index);
    let ant = 0;
    for (const c of [...cortes, bloque.length]) {
      const t = bloque.slice(ant, c).trim();
      ant = c;
      if (!t) continue;
      const mf = t.match(new RegExp("^" + FECHA.source));
      if (mf) ultima = mf[1];
      out.push({ fecha: mf ? mf[1] : ultima, texto: mf ? t.slice(mf[0].length).replace(/^\s*[:\-]?\s*/, "") : t });
    }
  }
  return out;
}

function paReordenarClinicos(campos) {
  const CAJONES = ["labo", "eab", "cultivos", "estudios"];
  if (!CAJONES.some((k) => campos[k])) return campos;

  const nuevos = { labo: [], eab: [], cultivos: [], estudios: [] };
  let movidos = 0;

  for (const origen of CAJONES) {
    if (!campos[origen]) continue;
    for (const tr of paTrozos(campos[origen])) {
      const destino = paQueEs(tr.texto) || origen;
      if (destino !== origen) movidos++;
      // La etiqueta "LABORATORIO" sobra una vez que está en su propio campo.
      const limpio = tr.texto.replace(/^LABORATORIO\s*[:\-]?\s*/i, "").replace(/^[\s,;:]+/, "").trim();
      if (limpio) nuevos[destino].push((tr.fecha ? tr.fecha + " " : "") + limpio);
    }
  }

  if (!movidos) return campos;   // ya estaba todo en su lugar
  const salida = { ...campos };
  for (const k of CAJONES) {
    // El mismo dato suele estar escrito en dos campos ("25/08 HMC X2" aparece
    // en cultivos y en estudios). Al juntarlos quedaría dos veces, así que se
    // deja uno: se compara sin mayúsculas ni puntuación para que "HMC X2" y
    // "HMCX2:" cuenten como el mismo renglón.
    const vistos = new Set();
    const unicos = nuevos[k].filter((linea) => {
      const clave = linea.toUpperCase().replace(/[^A-Z0-9ÁÉÍÓÚÑ]/g, "");
      if (vistos.has(clave)) return false;
      vistos.add(clave);
      return true;
    });
    const v = unicos.join("\n");
    if (v) salida[k] = v; else delete salida[k];
  }
  return salida;
}

/* ── Formato de laboratorios, estudios y cultivos ─────────────────────────
   Regla que fijó Gonzalo el 2/9/2026: cada renglón de estas tres secciones se
   escribe *fecha estudio resultado. El asterisco adelante y la fecha después,
   siempre en ese orden.

   Lo que llega del Drive tiene todas las variantes: la fecha adelante sin
   asterisco, el asterisco pegado a la fecha, la fecha con dos puntos, o el
   asterisco puesto a mitad del renglón. Esto las lleva a todas a la misma
   forma, sin inventar una fecha donde no la hay: un renglón sin fecha se deja
   como está, porque poner la de hoy sería afirmar algo que nadie escribió. */
function paFormatoAsterisco(txt) {
  if (!txt) return txt;
  const FECHA = /(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])(?:\/\d{2,4})?/;
  const salida = [];
  for (const linea of txt.split("\n")) {
    let l = linea.trim();
    if (!l) { salida.push(l); continue; }
    // Los cultivos ya salen de paCultivos con su propio encabezado «fecha:».
    // Ese formato es el que se acordó para esa sección y no se pisa acá.
    if (l.startsWith("«")) { salida.push(l); continue; }
    // Se sacan los asteriscos que haya en cualquier lado y se vuelve a poner
    // uno solo adelante, para no acumular "**" al pasar dos veces.
    l = l.replace(/\*+/g, " ").replace(/\s*\/\/\s*/g, " ").replace(/\s{2,}/g, " ").trim();

    // Un estudio por renglón. En el Drive tres tomografías de tres días
    // distintas suelen venir pegadas en un párrafo: la fecha de la segunda
    // queda enterrada a mitad de la oración y no se ve al pasar la vista.
    // Se corta en cada fecha que arranca un estudio nuevo.
    //
    // Sólo cortan las fechas que están al principio de una oración — después
    // de un punto, o al empezar el renglón. Una fecha en el medio de una
    // frase ("previo del 24/8") es parte del texto, no un estudio nuevo, y
    // cortar ahí partiría la oración al medio.
    const re = new RegExp("(?:(?<=[.;])\\s+|^)(" + FECHA.source + ")(?=[\\s:,\\-])", "g");
    const cortes = [];
    let m;
    while ((m = re.exec(l))) cortes.push(m.index + m[0].length - m[1].length);
    const trozos = [];
    for (let i = 0; i < cortes.length; i++) {
      if (i === 0 && cortes[0] > 0) trozos.push(l.slice(0, cortes[0]));
      trozos.push(l.slice(cortes[i], cortes[i + 1] ?? l.length));
    }
    if (!trozos.length) trozos.push(l);

    for (const tr of trozos) {
      const t = tr.trim().replace(/[.;,\s]+$/, (x) => (x.includes(".") ? "." : ""));
      if (!t) continue;
      const mf = t.match(new RegExp("^(" + FECHA.source + ")\\s*[:\\-]?\\s*([\\s\\S]*)$"));
      if (!mf) { salida.push(t); continue; }  // sin fecha adelante: no se toca
      const resto = mf[2].trim();
      salida.push(resto ? `*${mf[1]} ${resto}` : `*${mf[1]}`);
    }
  }
  return salida.join("\n");
}

function paCultivos(txt) {
  if (!txt) return txt;
  // Una fecha de verdad: día 1-31 y mes 1-12. Sin esto, "RC 2/2" (dos frascos
  // de dos) se lee como fecha y parte la muestra al medio.
  const FECHA = /((?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])(?:\/\d{2,4})?)/;
  // Distinguir una fecha de un recuento de frascos ("RC 2/2", "HMC 6/7") es el
  // punto delicado, porque "2/2" también es 2 de febrero. Cortar por fecha y
  // después mirar qué había antes no sirve: para cuando se corta, la sigla ya
  // quedó del otro lado. Así que primero se BLINDAN los recuentos —toda
  // "SIGLA n/m" se reemplaza por un marcador— y recién después se corta por
  // fecha. Al final se restauran.
  const blindados = [];
  // Sólo cuenta como recuento de frascos si el denominador es chico (≤9) y el
  // numerador no lo supera: "RC 2/2" y "HMC 1/2" sí, "HMC 28/07" no —eso es
  // una fecha, y convertirla en "28 de 07" arruina el renglón.
  let t0 = txt.replace(/\b(HMC|HC|H|RC|UC|AT|HX\d|HCX\d|HMCX\d)\s+(\d{1,2})\s*\/\s*(\d)\b(?!\/|\d)/gi,
    (m, sig, a, b) => {
      if (+a > +b) return m;
      blindados.push(`${sig} ${a} de ${b}`);
      return `\u0001${blindados.length - 1}\u0001`;
    });
  const restaurar = (x) => x.replace(/\u0001(\d+)\u0001/g, (m, i) => blindados[+i]);

  const trozos = [];
  for (const bloque of t0.split(/\s*\/\/\s*/)) {
    const re = new RegExp(FECHA.source + "(?=\\s)", "g");
    let ult = 0, m;
    while ((m = re.exec(bloque))) {
      if (m.index === 0) continue;
      const t = bloque.slice(ult, m.index).trim();
      if (t) trozos.push(t);
      ult = m.index;
    }
    const fin2 = bloque.slice(ult).trim();
    if (fin2) trozos.push(fin2);
  }

  const out = [];
  let ultimaFecha = "";
  for (const trozo of trozos) {
    const mf = trozo.match(new RegExp("^" + FECHA.source + "\\s*[:\\-]?\\s*"));
    let resto = trozo, fecha = ultimaFecha;
    if (mf) { fecha = mf[1]; ultimaFecha = fecha; resto = trozo.slice(mf[0].length); }

    // Dentro del trozo puede haber más de una muestra separada por coma o
    // barra, pero sólo si lo que sigue arranca con una sigla de muestra: así
    // "MAT/QX" no se parte al medio.
    // Sólo se parte si lo que sigue es una sigla de muestra conocida: un
    // "Bacteroides+ S. Epidermidis" es UN resultado con dos gérmenes, no dos
    // muestras, y partirlo por la coma lo rompería.
    const SIG = "(?:HMC|HC|H|UC|RC|AT|MAT\\s*\\/?\\s*QX|MATQX|LCR|COPRO|MPX|TCD|PC|MINIBAL|BAL)";
    const sub = restaurar(resto).split(new RegExp(`\\s*[,;]\\s*(?=${SIG}\\b)|\\s+\\/\\s*(?=${SIG}\\b)`, "i"));
    for (const x of sub) {
      const t = x.trim().replace(/^[\/,;\s]+|[\/,;\s]+$/g, "");
      if (!t) continue;
      out.push({ fecha, texto: t });
    }
  }

  // Red de seguridad. Este campo lo escribe cada uno como puede, y hay pases
  // —2.1 al 31/8— donde la cadena es tan enredada que cualquier regla la
  // desarma mal. Si el resultado tiene renglones sin muestra ni germen, o
  // encabezados que claramente no son fechas, se devuelve el texto original
  // prolijado y nada más: peor que un párrafo denso es un párrafo denso mal
  // partido, que hace perder un cultivo de vista.
  // Se descarta el reordenado si aparece cualquiera de estas señales de que la
  // cadena no se dejó partir bien: renglones sin contenido, o encabezados que
  // no son fechas plausibles (un "6/7" suelto encabezando es un recuento que
  // se coló, no un 6 de julio).
  // "25/08 HMCx2, UC: pendiente" son dos muestras que comparten el resultado:
  // la primera queda sin cuerpo. En vez de descartar todo el reordenado, se
  // pega con la siguiente, que es lo que el pase quiere decir.
  for (let i = out.length - 2; i >= 0; i--) {
    const cuerpoVacio = !out[i].texto || !/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(out[i].texto.replace(/^\s*[A-ZÁÉÍÓÚÑ]{1,6}X?\d?\s*[:,]?\s*/i, ""));
    if (cuerpoVacio && out[i].fecha === out[i + 1].fecha) {
      // Las dos muestras van juntas en el encabezado ("HMCx2 y UC: pendiente"),
      // no una pegada al cuerpo de la otra con una coma suelta.
      // Minúscula en la unión: "HMCx2 y UC: pendiente", no "…Y UC".
      const izq = out[i].texto.replace(/[\s,;:]+$/, "");
      const der = out[i + 1].texto.replace(/^[\s,;:yY]+\s*/, "");
      out[i + 1].texto = izq + " y " + der;
      out.splice(i, 1);
    }
  }

  // Segunda pasada: si después de unir quedó alguno sin nada, se une con el
  // siguiente aunque cambie la fecha (es la misma tanda de cultivos).
  for (let i = out.length - 2; i >= 0; i--) {
    if (!out[i].texto || !out[i].texto.trim()) {
      out[i + 1].texto = out[i + 1].texto;
      out.splice(i, 1);
    }
  }

  const vacios = out.filter((x) => !x.texto || x.texto.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "").length < 3).length;
  const raros = out.filter((x) => /^\d\/\d$/.test(x.fecha || "")).length;
  if (vacios >= 1 || raros >= 1) return paLimpiar(restaurar(txt));

  return out.map(({ fecha, texto }) => {
    let t = texto;
    // "½" y "1/2" y "2/2" son cuántos frascos crecieron.
    t = t.replace(/½/g, "1 de 2").replace(/^\s*(\d)\s*\/\s*(\d)\b(?!\d)/, "$1 de $2");
    // La sigla de muestra, escrita prolija, y dos puntos antes del germen.
    let muestra = "";
    for (const [re, fn] of PA_MUESTRAS) {
      const m = t.match(re);
      if (m) { muestra = fn(m); t = t.slice(m[0].length).replace(/^\s*[:\-]?\s*/, ""); break; }
    }
    // Si tras la sigla viene otra fecha ("Mat Qx 23/06: …"), ésa es la fecha de
    // ESA muestra y pisa a la heredada.
    let f2 = fecha;
    const mi = t.match(new RegExp("^\\s*" + FECHA.source + "\\s*[:\\-]?\\s*"));
    if (mi) { f2 = mi[1]; t = t.slice(mi[0].length); }
    let cuerpo = paLimpiar(t).replace(/^[:\-\s]+/, "");
    // La "y" que une dos muestras no arranca oración: minúscula.
    cuerpo = cuerpo.replace(/^Y\s+/, "").replace(/\sY\s(?=[a-záéíóúñ])/g, " y ");
    const cab = [f2, muestra].filter(Boolean).join(" ");
    // El marcador «» lo convierte a negrita el renderizador; en texto plano
    // queda como un par de comillas angulares y no molesta.
    // Puntuación colgando al principio del cuerpo: queda cuando la muestra se
    // separó de una lista ("HMC X2, UC, cultivos LCR: pendiente").
    cuerpo = cuerpo.replace(/^[\s,;:]+/, "");
    cuerpo = cuerpo.replace(/^[\s,;:]+/, "");
    return cab ? `«${cab}:» ${cuerpo}` : cuerpo;
  }).reduce((acc, linea) => {
    // Un renglón que quedó con encabezado y sin resultado ("«25/08 HMCx2:»")
    // es una muestra que comparte el resultado con la siguiente: se juntan los
    // dos encabezados en vez de dejar una línea huérfana.
    const vacio = /^«[^»]*»\s*$/.test(linea);
    if (vacio) { acc.pendiente = (acc.pendiente || "") + linea.replace(/^«|:»\s*$/g, "") + " y "; return acc; }
    if (acc.pendiente) {
      linea = linea.replace(/^«/, "«" + acc.pendiente.replace(/\s+y\s*$/, " y "));
      acc.pendiente = "";
    }
    acc.lineas.push(linea);
    return acc;
  }, { lineas: [], pendiente: "" }).lineas
    // "25/08 HMCx2 y 25/08 UC" → "25/08 HMCx2 y UC": la fecha repetida sobra.
    .map((linea) => linea.replace(/^«([^»]*)»/, (m, cab) => {
      const f = (cab.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/) || [])[1];
      if (!f) return m;
      const partes = cab.split(" y ").map((x, i) => (i > 0 && x.startsWith(f + " ") ? x.slice(f.length + 1) : x));
      return "«" + partes.join(" y ") + "»";
    }))
    .join("\n");
}

/* Clave para ordenar camas como las cuenta una persona y no como las ordena
   una computadora. Cada tanda de dígitos se rellena con ceros a la izquierda,
   así "1.2" queda antes que "1.10" y "R3" antes que "R12". Comparar los
   textos crudos daría el orden alfabético, donde "1.10" viene antes que
   "1.2" porque el "1" pesa menos que el "2". */
function paCamaOrden(cama) {
  return String(cama || "").replace(/\d+/g, (n) => n.padStart(6, "0"));
}

function paLimpiar(txt) {
  if (!txt) return txt;
  let t = txt.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const letras = t.replace(/[^a-zA-ZáéíóúñÁÉÍÓÚÑ]/g, "");
  const mays = (t.match(/[A-ZÁÉÍÓÚÑ]/g) || []).length;
  if (letras.length && mays / letras.length >= 0.55) {
    // Solo palabras de 5+ letras o conectores comunes: las siglas cortas (QX,
    // TAP, HDE) son el vocabulario real del servicio y se respetan.
    // Ojo con \b: JavaScript no considera letra a la "Á", así que /\b[A-ZÁ...]+\b/
    // partía "ÓRDENES" en "Ó" + "RDENES" y sólo bajaba la segunda mitad, dejando
    // "Órdenes" como si fuera nombre propio. Se delimita a mano con lookarounds
    // sobre el conjunto completo de letras.
    const L = "A-Za-zÁÉÍÓÚÜÑáéíóúüñ";
    t = t.replace(new RegExp(`(?<![${L}])[A-ZÁÉÍÓÚÜÑ]+(?![${L}])`, "g"), (w) => {
      if (/\d/.test(w)) return w;
      const low = w.toLowerCase();
      if (PA_DROGAS_CORTAS[low]) return PA_DROGAS_CORTAS[low];
      if (!PA_COMUNES.has(w) && w.length < 5) return w;
      return PA_ACENTOS[low] || low;
    });
    t = t.replace(/(^|\n|(?<=[.;:] )|(?<=→ ))([a-záéíóúñ])/g, (m, a, b) => a + b.toUpperCase());
    // "Si síntomas → toraco" y no "Si sintomas → Toraco": después de flecha
    // sigue la misma idea, así que se capitaliza sólo si arranca oración.
    t = t.replace(/(→ )([A-ZÁÉÍÓÚÑ])(?=[a-záéíóúñ])/g, (m, a, b) => a + b.toLowerCase());
  }
  for (const [re, rep] of PA_EXPANDIR) t = t.replace(re, rep);
  // Puntuación: el pase se escribe rápido y quedan ", ,", espacios antes de
  // la coma y comas colgando al final del renglón.
  t = t.replace(/([,;:])(?=[A-Za-zÁÉÍÓÚÑáéíóúñ])/g, "$1 ")  // "PIR,hemodinámicamente"
       .replace(/\s+([,.;:])/g, "$1")
       .replace(/([,;])\s*(?=[,;])/g, "")
       .replace(/,\s*$/gm, "")
       .replace(/\s{2,}/g, " ");
  // La capitalización va DESPUÉS de expandir las siglas: si no, "HDE. VE S/O2"
  // se expande a "hemodinámicamente estable. ventilando..." con la minúscula
  // ya cristalizada después del punto.
  t = t.replace(/(^|\n|(?<=[.;:] ))([a-záéíóúñ])/g, (m, a, b) => a + b.toUpperCase());
  return t;
}

// Marca de cuándo se relevó un ingreso o egreso. Día y hora, porque una
// guardia cruza la medianoche y "14:20" solo sería ambiguo.
function paAhora() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0"), mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── Mecánica ventilatoria ──────────────────────────────────────────────────
//
// Cada modo se programa con parámetros distintos, así que mostrar una lista
// única de casillas obliga a adivinar cuáles corresponden. Se elige el modo y
// se piden sólo los settings de ese modo. La presión meseta y la PEEP total
// son medidas, no programadas: van aparte porque son las que hacen falta para
// driving pressure y auto-PEEP, y sólo se obtienen haciendo una pausa.
const PA_MODOS = {
  pc: { rot: "Presión control", campos: [["pc", "PC sobre PEEP"], ["fr", "FR"], ["peep", "PEEP"], ["fio2", "FiO₂ %"], ["ti", "Ti (seg)"]] },
  vc: { rot: "Volumen control", campos: [["vt", "Vt programado"], ["fr", "FR"], ["peep", "PEEP"], ["fio2", "FiO₂ %"], ["flujo", "Flujo"]] },
  ps: { rot: "Presión soporte", campos: [["ps", "PS sobre PEEP"], ["peep", "PEEP"], ["fio2", "FiO₂ %"]] },
};

// Lee lo que el pase ya trae escrito: "PC 12/18/8/21 VT 350", "VENTILADOR:
// PC 13/12/8/30 VT 335". El orden es presión sobre PEEP / FR / PEEP / FiO2,
// y el VT que sigue es el volumen que sale, no uno programado. Es una
// precarga para no tipear de nuevo, no una fuente de verdad: queda editable.
function paLeerArm(txt) {
  if (!txt) return null;
  const t = txt.toUpperCase();
  const m = t.match(/\b(PC|PCV|VC|VCV|PS|PSV)\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)(?:\s*\/\s*(\d+))?/);
  if (!m) return null;
  const modo = /^P?S/.test(m[1]) ? "ps" : /^V/.test(m[1]) ? "vc" : "pc";
  const vt = t.match(/\bVT\s*(\d{3,4})/);
  const v = { modo };
  if (modo === "vc") { v.vt = m[2]; v.fr = m[3]; v.peep = m[4]; if (m[5]) v.fio2 = m[5]; }
  else if (modo === "ps") { v.ps = m[2]; v.peep = m[3]; v.fio2 = m[4]; }
  else { v.pc = m[2]; v.fr = m[3]; v.peep = m[4]; if (m[5]) v.fio2 = m[5]; }
  if (vt) v.vtMedido = vt[1];
  return v;
}

// ── Separar accesos de imágenes y de ARM ───────────────────────────────────
//
// En el Drive las tres cosas caen en el mismo renglón de "ACCESOS", separadas
// con "//" o con una etiqueta suelta. Pero un catéter, una tomografía y los
// parámetros del respirador son datos distintos y se consultan en momentos
// distintos, así que se parten acá. Lo que no se puede clasificar queda en
// accesos, que es lo que más aparece: es mejor dejarlo donde estaba que
// inventarle una categoría.
function paPartirAccesos(txt) {
  const out = { accesos: [], imagenes: [], arm: [] };
  if (!txt) return { accesos: "", imagenes: "", arm: "" };
  const esImagen = /^(IM[ÁA]GENES|TAC|TC|RX|RXTX|TCTX|ECO|ECOGRAF|RM|RMN|ANGIO|DOPPLER|RADIOGRAF)/i;
  const esArm = /^(ARM|VNI|VENTILACI[ÓO]N|MODO)\b/i;
  for (const trozo of txt.split(/\s*\/\/\s*|\n/)) {
    const t = trozo.trim();
    if (!t) continue;
    if (esArm.test(t)) out.arm.push(t);
    else if (esImagen.test(t.replace(/^\d{1,2}\/\d{1,2}\s*/, ""))) out.imagenes.push(t);
    else out.accesos.push(t);
  }
  return { accesos: out.accesos.join("\n"), imagenes: out.imagenes.join("\n"), arm: out.arm.join("\n") };
}

// ── Parseo de infusiones y pendientes ──────────────────────────────────────
function paProcesar(raw, unidad) {
  const campos = { ...(raw.fields || {}) };

  // Red de seguridad del lado del cliente para el recuadro de TRATAMIENTO que
  // el Drive pega adentro de ENFERMEDAD ACTUAL. El arreglo de fondo está en
  // api/parse-pase.js, pero Firestore puede tener todavía un pase sincronizado
  // con el parser viejo, y no quiero que la medicación quede escondida hasta
  // el próximo sync. Si el pase ya viene bien partido, esto no hace nada.
  if (!campos.tto && campos.ea) {
    const lsEa = campos.ea.split("\n");
    const corte = lsEa.findIndex((l) => /^(PESO|PR)\b|^(NE|NPT|NTE|RL|SF|NXB)\s*\d/i.test(l.trim()));
    if (corte > 0) {
      campos.tto = lsEa.slice(corte).join("\n");
      campos.ea = lsEa.slice(0, corte).join("\n");
    }
  }

  // Accesos, imágenes y ARM vienen amontonados en el mismo campo.
  const part = paPartirAccesos(campos.accesos);
  if (campos.accesos) {
    campos.accesos = part.accesos;
    if (part.imagenes) campos.imagenes = [campos.imagenes, part.imagenes].filter(Boolean).join("\n");
    if (!campos.accesos) delete campos.accesos;
  }

  // Repartir laboratorio, EAB, cultivos y estudios según lo que dice cada
  // renglón, no según en qué campo lo escribieron.
  Object.assign(campos, paReordenarClinicos(campos));

  const todo = Object.values(campos).join(" ");
  const inf = [], vistos = new Set();
  // Las infusiones no siempre están en TTO: la 1.1 las tiene en enfermedad
  // actual. Se busca en todos los campos. NA solo cuenta en tratamiento, porque
  // en laboratorio es el sodio.
  for (const [campo, txt] of Object.entries(campos)) {
    const re = /\b([A-ZÁÉÍÓÚÑ]{2,15})\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*(?:→\s*([0-9.,]+))?/g;
    let m;
    while ((m = re.exec(txt || ""))) {
      const droga = PA_INFUS[m[1]] || (m[1] === "NA" && campo === "tto" ? "Noradrenalina" : null);
      if (!droga) continue;
      const k = `${droga}|${m[2]}|${m[3]}|${m[4]}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      inf.push({ droga, mg: +m[2], ml: +m[3], ritmo: +m[4],
        declarada: m[5] ? parseFloat(m[5].replace(",", ".")) : null,
        // "campo" es sólo para el cartel de "escrita en tal lado"; para poder
        // reescribir el renglón cuando se cambia el goteo hace falta saber en
        // qué campo está de verdad y con qué números venía escrito.
        campo: campo === "tto" ? null : campo,
        campoReal: campo, original: `${m[2]}/${m[3]}/${m[4]}` });
    }
  }
  // Propofol al 2%: se escribe distinto que el resto de las infusiones. No es
  // "droga mg/ml/ritmo" sino "PROPO 2% 8" = propofol al 2% pasando a 8 ml/h.
  // El 2% quiere decir 2 g en 100 ml, o sea 20 mg/ml, y con eso la dosis por
  // kilo sale igual que en las demás. También se acepta al 1% (10 mg/ml).
  for (const [campo, txt] of Object.entries(campos)) {
    const reP = /\bPROPO(?:FOL)?\s*(1|2)\s*%\s*(?:A\s*)?([\d.,]+)\s*(?:ML\/?H)?/gi;
    let mp2;
    while ((mp2 = reP.exec(txt || ""))) {
      const mgMl = +mp2[1] * 10;              // 1% = 10 mg/ml, 2% = 20 mg/ml
      const ritmo = parseFloat(mp2[2].replace(",", "."));
      if (!isFinite(ritmo)) continue;
      const k = `Propofol|${mgMl}|1|${ritmo}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      // Se guarda como "mgMl mg en 1 ml" para que la fórmula de siempre
      // (concentración ÷ dilución × ritmo ÷ peso) dé el resultado correcto.
      inf.push({ droga: "Propofol", mg: mgMl, ml: 1, ritmo, declarada: null,
        campo: campo === "tto" ? null : campo, campoReal: campo,
        original: `${mp2[1]}% ${mp2[2]}`, porcentaje: +mp2[1] });
    }
  }

  const interm = [];
  const reI = /\b([A-ZÁÉÍÓÚÑ]{3,15})\s+(\d+)\s*\/\s*(\d+)\b(?!\s*\/)/g;
  let mi;
  while ((mi = reI.exec(campos.tto || ""))) {
    if (PA_FARMACOS.has(mi[1]) && [4, 6, 8, 12, 24].includes(+mi[3]))
      interm.push({ droga: paTitulo(mi[1]), mg: +mi[2], cada: +mi[3] });
  }
  // Peso real estimado: es el que se usa para calcular las dosis. Cualquier
  // peso escrito sin aclaración ("PESO 70 KG", o incluso "70 KG" suelto) se
  // interpreta como real estimado — así lo definió Gonzalo el 2/9/2026.
  const mp = todo.match(/PESO\s*(?:REAL\s*)?(?:ESTIMADO\s*)?(?:DE\s*)?(\d{2,3})\s*KG/i)
          || todo.match(/(?<![A-ZÁÉÍÓÚÑ])PR\s*(\d{2,3})\s*KG/i);
  // Peso teórico (PT), también llamado predicho. NO se usa para las dosis:
  // sirve sólo para la mecánica ventilatoria, donde el volumen corriente se
  // calcula por kilo de peso predicho y no por el peso real del paciente.
  const mpt = todo.match(/(?<![A-ZÁÉÍÓÚÑ])PT\s*:?\s*(\d{2,3})\s*KG/i);
  // Balance del día escrito al final del renglón de estado: "…, 890-590" son
  // 890 ml de ingresos y 590 ml de diuresis. Se acota fuerte a propósito —par
  // al final del renglón, precedido por coma y sin "%"— porque el mismo patrón
  // aparece como rango en "FEY 45-50%" o "TROPO 72 - 85", y leer una fracción
  // de eyección como si fuera un balance sería un error feo.
  let balDia = null;
  for (const linea of (campos.req || "").split("\n")) {
    const mb = linea.match(/,\s*(\d{2,4})\s*-\s*(\d{2,4})\s*$/);
    if (mb) balDia = { ingresos: +mb[1], egresos: +mb[2] };
  }

  const pend = (campos.pendiente || "")
    .split(/\n|\/\/|(?<=[a-zA-ZáéíóúÁÉÍÓÚ0-9])\s+\/\s+(?=[A-ZÁÉÍÓÚ])/)
    .map((x) => x.replace(/^[\s/]+|[\s/]+$/g, "")).filter(Boolean)
    .map((x) => ({ texto: paLimpiar(x), listo: false }));
  const req = (campos.req || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const ult = req.length ? req[req.length - 1] : "";
  const limpios = {};
  // Cultivos tienen su propio tratamiento: se reordenan en un renglón por
  // muestra, con la fecha adelante.
  const CON_ASTERISCO = new Set(["labo", "eab", "cultivos", "estudios"]);
  for (const [k, v] of Object.entries(campos)) if (k !== "pendiente") {
    const limpio = k === "cultivos" ? paCultivos(v) : paLimpiar(v);
    // *fecha estudio resultado, en las tres secciones fechadas.
    limpios[k] = CON_ASTERISCO.has(k) ? paFormatoAsterisco(limpio) : limpio;
  }
  return {
    unidad, cama: raw.bed, ...paNombre(raw.name),
    mi: paLimpiar(raw.mi || ""), campos: limpios,
    peso: mp ? +mp[1] : null, pesoTeorico: mpt ? +mpt[1] : null,
    infusiones: inf, intermitentes: interm,
    pendientes: pend, anotaciones: [],
    // Si el pase ya traía el balance del día, entra precargado en vez de
    // obligar a copiarlo a mano.
    balance: balDia
      ? { ingresos: [{ que: "Aportes del día (del pase)", ml: balDia.ingresos, cuando: "" }],
          egresos: [{ que: "Diuresis del día (del pase)", ml: balDia.egresos, cuando: "" }] }
      : { ingresos: [], egresos: [] },
    sinCompletar: !req.length || /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(ult),
    // Texto crudo del respirador tal como venía en el pase, para precargar el
    // pop-up de mecánica ventilatoria.
    armTexto: part.arm || "",
  };
}

// ── Diff por palabras ──────────────────────────────────────────────────────
// Palabra y no carácter: agregar "PL s/p" tiene que leerse como dos palabras
// nuevas, no como siete letras sueltas intercaladas en el texto.
function paDiff(a, b) {
  if (a === b) return [{ t: "=", v: a }];
  const A = (a || "").split(/(\s+)/), B = (b || "").split(/(\s+)/);
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: "=", v: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ t: "-", v: A[i] }); i++; }
    else { out.push({ t: "+", v: B[j] }); j++; }
  }
  while (i < n) out.push({ t: "-", v: A[i++] });
  while (j < m) out.push({ t: "+", v: B[j++] });
  return out;
}

// Pone en negrita lo que va entre «» —el encabezado de cada cultivo, "fecha
// muestra:"— y el "+" que separa dos gérmenes. El texto guardado sigue siendo
// plano: los marcadores viven en el string y sólo se interpretan al mostrarlo,
// así la edición libre y el diff de cambios siguen funcionando igual. Cuando
// el campo está en foco se ve el texto crudo, como con el resaltado.
function conNegritas(txt, key) {
  // El asterisco de "*25/8 TAC ..." también entra: la fecha va en negrita, que
  // es para lo que se puso el formato. El asterisco queda porque es la marca
  // que usa el servicio y se escribe igual acá y en el Drive.
  if (!txt || (!txt.includes("«") && !txt.includes("+") && !txt.includes("*"))) return txt;
  const out = [];
  const re = /«([^»]*)»|(\s\+\s)|(?:^|(?<=\n))(\*\s?(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])(?:\/\d{2,4})?)/g;
  let ult = 0, m, i = 0;
  while ((m = re.exec(txt))) {
    if (m.index > ult) out.push(<span key={`${key}t${i++}`}>{txt.slice(ult, m.index)}</span>);
    out.push(m[1] !== undefined
      ? <b key={`${key}b${i++}`}>{m[1]}</b>
      : m[3] !== undefined
      ? <b key={`${key}f${i++}`}>{m[3]}</b>
      : <b key={`${key}p${i++}`}> + </b>);
    ult = m.index + m[0].length;
  }
  if (ult < txt.length) out.push(<span key={`${key}t${i++}`}>{txt.slice(ult)}</span>);
  return <>{out}</>;
}

/* ── Resaltado de renglones ────────────────────────────────────────────────
   Marcar con amarillo o verde lo que uno quiere volver a mirar. La marca vive
   dentro del propio texto, como un caracter invisible al principio del
   renglón, para que viaje con el campo: se guarda, se sincroniza y sobrevive
   a mover renglones sin ninguna estructura aparte que mantener en orden.

   Se eligieron caracteres de control, que no aparecen nunca en un pase y no
   se ven si por algún motivo se escapan a la pantalla. */
const PA_MARCA = { "\u0011": "#FEF08A", "\u0012": "#BBF7D0" };   // amarillo, verde
const PA_MARCA_ROT = { "\u0011": "Amarillo", "\u0012": "Verde" };
const PA_MARCAS = Object.keys(PA_MARCA);

// Separa el color de una linea de su texto.
function paMarcaDe(linea) {
  const c = (linea || "")[0];
  return PA_MARCA[c] ? { color: c, texto: linea.slice(1) } : { color: null, texto: linea || "" };
}
// Pone, cambia o saca el color de una linea.
function paMarcar(linea, color) {
  const { texto } = paMarcaDe(linea);
  return color ? color + texto : texto;
}
// Saca todas las marcas de un texto. Se usa al editar y al copiar.
const paSinMarcas = (t) => (t || "").replace(/[\u0011\u0012]/g, "");

/* Lo que escribiste va en naranja; lo que borraste, no se muestra.
   Antes se mostraba tachado al lado, y en un renglón muy editado quedaban dos
   versiones mezcladas del mismo texto: justo lo que uno no quiere leer a las
   tres de la mañana. Para ver lo que decía el Drive está el botón de arriba,
   que muestra el pase entero sin ninguna edición. */
function TextoMarcado({ actual, original }) {
  // El resaltado se pinta por renglón, así que se procesa línea por línea y
  // el diff se hace sobre el texto sin marcas: si no, el caracter invisible
  // contaría como una edición y todo el renglón saldría en naranja.
  const lineas = (actual || "").split("\n");
  const orig = (original || "").split("\n");
  return (
    <>
      {lineas.map((linea, li) => {
        const { color, texto } = paMarcaDe(linea);
        const previa = paSinMarcas(orig[li] ?? "");
        const cuerpo = texto === previa
          ? conNegritas(texto, `n${li}`)
          : paDiff(previa, texto)
              .filter((d) => d.t !== "-")
              .map((d, i) =>
                d.t === "=" ? <span key={i}>{conNegritas(d.v, `d${li}_${i}`)}</span>
                : <ins key={i} style={{ background: "#FFF6E5", color: "#8A4B00", fontWeight: 600, textDecoration: "none", borderRadius: 2, boxShadow: "inset 0 -2px 0 #E9C48A" }}>{d.v}</ins>);
        return (
          <div key={li} style={color ? {
            background: PA_MARCA[color], borderRadius: 3,
            padding: "1px 4px", margin: "1px -4px",
          } : undefined}>
            {cuerpo}
          </div>
        );
      })}
    </>
  );
}

function paDosis(inf, pesoReal) {
  const peso = pesoReal || PA_PESO_SUPUESTO;
  const u = PA_UNIDAD[inf.droga];
  if (!u) return { sinUnidad: true, peso };
  const kgh = (inf.mg / inf.ml) * inf.ritmo / peso;
  return { u, kgh, kgmin: kgh / 60, peso, supuesto: !pesoReal };
}

/* ── La vista ───────────────────────────────────────────────────────────── */
function PaseAppView({ user }) {
  const [foto, setFoto] = useState(null);        // pase del Drive, nunca se toca
  const [mio, setMio] = useState(null);          // mi copia editable
  const [cargando, setCargando] = useState(true);
  const [uSel, setUSel] = useState(null);
  const [iSel, setISel] = useState(0);
  const [verOriginal, setVerOriginal] = useState(false);
  const [enFoco, setEnFoco] = useState(null);
  // Todas las secciones arrancan colapsadas: en el celular, durante el pase,
  // lo primero que uno quiere ver es el paciente, no cuatro cajas abiertas.
  const [plegado, setPlegado] = useState({ anot: true, pend: true, bal: true, raras: true });
  const [tipoSel, setTipoSel] = useState("Intercurrencia");
  const [estado, setEstado] = useState("");
  // ARM por paciente (no uno solo para toda la unidad, que era el bug latente
  // del prototipo): clave = índice del paciente.
  const [arm, setArm] = useState({});
  const [armAbierto, setArmAbierto] = useState(false);
  const [ordenando, setOrdenando] = useState(null);
  const [resaltando, setResaltando] = useState(null);  // campo en modo resaltar
  const chico = useChico();
  const [editando, setEditando] = useState(false);
  const [confirmandoEgreso, setConfirmandoEgreso] = useState(false);
  const undo = useRef([]);
  const guardarTimer = useRef(null);

  const docId = user && foto ? `${user.uid}__${(foto.tomado || "").slice(0, 10)}` : null;

  // 1) La foto del Drive
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "scheduler", "pases-latest"), (snap) => {
      if (!snap.exists()) { setCargando(false); return; }
      const d = snap.data();
      // Igual que la pestaña Pases: si el sync no dejó unitOrder, se usan las
      // claves de units para no quedarse sin unidades por un campo faltante.
      const unidades = d.unitOrder?.length ? d.unitOrder : Object.keys(d.units || {});
      const pacientes = unidades.flatMap((u) =>
        (d.units?.[u] || []).map((p) => paProcesar(p, u)));
      setFoto({ tomado: d.updatedAt, unidades, pacientes });
      setUSel((cur) => cur || unidades[0] || null);
      setCargando(false);
    }, () => setCargando(false));
    return unsub;
  }, []);

  // 2) Mi copia. Si no existe todavía, arranca siendo la foto.
  useEffect(() => {
    if (!docId || !foto) return;
    let vivo = true;
    getDoc(doc(db, PASEAPP_COL, docId)).then((snap) => {
      if (!vivo) return;
      if (snap.exists() && Array.isArray(snap.data().pacientes)) {
        setMio(snap.data().pacientes);
        setEstado("Recuperado de tu última sesión");
      } else {
        setMio(JSON.parse(JSON.stringify(foto.pacientes)));
      }
    }).catch(() => setMio(JSON.parse(JSON.stringify(foto.pacientes))));
    return () => { vivo = false; };
  }, [docId, foto]);

  const guardar = (datos) => {
    if (!docId) return;
    clearTimeout(guardarTimer.current);
    guardarTimer.current = setTimeout(async () => {
      try {
        await setDoc(doc(db, PASEAPP_COL, docId), {
          uid: user.uid, email: user.email || "", nombre: user.displayName || "",
          tomado: foto.tomado, guardadoEn: new Date().toISOString(), pacientes: datos,
        });
        setEstado("Guardado " + new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }));
      } catch (e) { console.error("guardar pase", e); setEstado("No se pudo guardar"); }
    }, 700);
  };

  // Toda mutación pasa por acá: apila para deshacer y guarda.
  const mutar = (fn) => {
    setMio((cur) => {
      undo.current.push(JSON.stringify(cur));
      if (undo.current.length > 40) undo.current.shift();
      const next = JSON.parse(JSON.stringify(cur));
      fn(next);
      guardar(next);
      return next;
    });
  };
  // ── Agregar una cama ────────────────────────────────────────────────────
  //
  // El pase del Drive es una foto de un momento: si entra alguien después,
  // no hay dónde escribirlo. Esto agrega una cama a la copia privada, en la
  // unidad que se está mirando.
  //
  // Se permite a propósito repetir el número de cama. Pasa de verdad: un
  // paciente que se va y otro que entra a la misma cama en la misma guardia,
  // o una cama que se desdobla. Bloquearlo sería resolver un problema que el
  // servicio no tiene, y crear uno que sí.
  //
  // Dos formas de crearla, según lo que se necesite: vacía, para un ingreso
  // nuevo; o copia del paciente que se está viendo, para cuando lo que se
  // quiere es una segunda versión de la misma ficha (por ejemplo, dejar el
  // pase de la mañana y arrancar el de la tarde sin volver a tipear todo).
  const agregarCama = () => {
    const base = {
      nombre: "", edad: null, sexo: null, mi: "", peso: null, pesoTeorico: null,
      campos: {}, anotaciones: [], infusiones: [], arm: {}, ordenCampos: [],
    };
    base.cama = String((mio[idx] || {}).cama || "");
    base.unidad = uSel;
    base.egresado = false;
    base.sinCompletar = false;
    base.agregada = true;               // marca: no vino del Drive
    mutar((d) => { d.splice(idx + 1, 0, base); });
    setISel(idx + 1);
    setEditando(true);                  // se abre la ficha para completarla
    setEstado("Cama agregada");
  };

  /* ── Enviar un paciente a otra cama ─────────────────────────────────────
     Los movimientos de cama son de las cosas que más pasan en una guardia y
     hasta ahora había que editar la ficha a mano de los dos lados, con el
     riesgo de dejar dos pacientes declarando la misma cama sin darse cuenta.

     La cama viaja con el paciente: lo que se mueve es la ficha entera, y el
     número de cama y la unidad pasan a ser los del destino. Se puede cruzar
     de unidad —de UTI 1 a RECU, por ejemplo—, que es lo que pasa de verdad.

     Si el destino está libre, se muda y listo, sin preguntar. Si está
     ocupado hay que decidir qué pasa con el que estaba, y ahí sí pregunta:
     intercambiarlos, mandarlo a una tercera cama, o marcarlo como egresado.
     Nunca se resuelve solo, porque las tres respuestas son plausibles y
     elegir mal significa perder una ficha entera. */
  const [enviando, setEnviando] = useState(null);   // { destino, choque } | null
  const [trayendo, setTrayendo] = useState(false);  // eligiendo a quién traer a una cama libre

  // La ficha vacía que queda cuando alguien egresa. Es la misma forma que usa
  // marcarEgreso, sacada acá para no repetirla en los dos lugares.
  const fichaVacia = (cama, unidad) => ({
    cama, unidad, egresado: true, agregada: false, sinCompletar: false,
    nombre: "", edad: null, sexo: null, mi: "", peso: null, pesoTeorico: null,
    campos: {}, anotaciones: [], infusiones: [], intermitentes: [],
    pendientes: [], arm: {}, ordenCampos: [], armTexto: "",
    balance: { ingresos: [], egresos: [] },
  });

  // Una cama está ocupada si tiene a alguien que no egresó. Una cama vacía
  // por egreso se puede reusar sin preguntar nada.
  const ocupada = (x) => x && !x.egresado && (x.nombre || "").trim();

  // Paso 1: elegiste el destino. Si está libre se muda directo; si no, se
  // guarda el choque para que la pantalla pregunte qué hacer con el que está.
  const elegirDestino = (j) => {
    if (ocupada(mio[j])) { setEnviando({ destino: j, choque: true }); return; }
    moverA(j, "libre", null);
  };

  // Paso 2: el movimiento en sí. `que` dice qué pasa con el desplazado:
  //   libre        → no había nadie
  //   intercambiar → se va a la cama que dejo yo
  //   tercera      → se va a la cama `otro` que elegiste
  //   egreso       → su ficha se vacía y queda como cama libre
  const moverA = (j, que, otro) => {
    const miCama = mio[idx].cama, miUnidad = mio[idx].unidad;
    const suCama = mio[j].cama, suUnidad = mio[j].unidad;
    mutar((d) => {
      // Los índices se corren en cuanto se borra un elemento, así que primero
      // se agarran las fichas por referencia y recién después se toca el
      // array. Trabajar con índices y splice a la vez es la forma clásica de
      // mover mal a un paciente.
      const yo = d[idx], el = d[j], tercero = otro != null ? d[otro] : null;

      if (que === "intercambiar") {
        el.cama = miCama; el.unidad = miUnidad;
      } else if (que === "tercera" && tercero) {
        el.cama = tercero.cama; el.unidad = tercero.unidad;
        // La tercera cama estaba libre (el selector sólo ofrece libres), así
        // que lo que había ahí era una ficha vacía y sobra.
        d.splice(d.indexOf(tercero), 1);
      } else if (que === "egreso") {
        // El que estaba se fue: su ficha desaparece y la cama la ocupa el que
        // llega. Dejar la ficha vacía además haría que dos renglones declaren
        // la misma cama.
        d.splice(d.indexOf(el), 1);
      } else if (que === "libre") {
        // El destino era una cama vacía. Esa ficha vacía se consume: si no,
        // quedan dos renglones diciendo ser la misma cama, uno con el
        // paciente y otro vacío, y en la barra aparece dos veces.
        d.splice(d.indexOf(el), 1);
      }
      yo.cama = suCama;
      yo.unidad = suUnidad;
    });
    // La vista sigue al paciente movido: si no, desaparece de la pestaña en
    // la que estabas y parece que se perdió. No se puede guardar la ficha por
    // referencia porque mutar clona todo; se lo busca por nombre y cama, que
    // después del movimiento ya lo identifican.
    const miNombre = mio[idx].nombre;
    setUSel(suUnidad);
    setMio((cur) => {
      const k = cur.findIndex((x) => x.cama === suCama && x.unidad === suUnidad && x.nombre === miNombre);
      if (k >= 0) setISel(k);
      return cur;
    });
    setEnviando(null);
    setEstado(
      que === "intercambiar" ? `Intercambiados: ${miCama} ↔ ${suCama}`
      : que === "egreso" ? `Movido a ${suCama}. El paciente de ${suCama} egresó.`
      : `Movido a ${suCama}`
    );
  };

  /* ── Qué se puede hacer con una cama libre ──────────────────────────────
     Una cama vacía no es un error ni un hueco: durante la guardia es un
     lugar donde puede entrar alguien. Las tres salidas son las que pasan de
     verdad — entra un paciente nuevo, se muda uno que ya está, o la cama no
     va más en el pase. */

  // Entra alguien nuevo: la ficha se vacía del todo y se abre para escribir.
  const ingresarPaciente = () => {
    mutar((d) => {
      const c = d[idx].cama, u = d[idx].unidad;
      d[idx] = {
        ...fichaVacia(c, u),
        egresado: false,        // deja de ser cama libre
        agregada: true,         // no vino del Drive
        ingreso: paAhora(),     // queda la marca de cuándo entró
      };
    });
    setEditando(true);
    setEstado("Cama ocupada. Completá la ficha.");
  };

  // Se muda alguien que ya está en otra cama. Su cama anterior queda libre,
  // que es lo que pasa de verdad: el lugar del que se fue no desaparece.
  const traerDe = (j) => {
    const suCama = mio[j].cama, suUnidad = mio[j].unidad;
    const acaCama = mio[idx].cama, acaUnidad = mio[idx].unidad;
    const quien = mio[j].nombre;
    mutar((d) => {
      const el = d[j];
      // La ficha entera se muda: se conserva todo y sólo cambian cama y unidad.
      d[idx] = { ...JSON.parse(JSON.stringify(el)), cama: acaCama, unidad: acaUnidad };
      // Donde estaba, queda una cama libre.
      d[j] = fichaVacia(suCama, suUnidad);
    });
    setTrayendo(false);
    setEstado(`${(quien || "").split(" ").pop()} pasó de ${suCama} a ${acaCama}. La ${suCama} quedó libre.`);
  };

  // La cama no va más. Se saca del pase: si la agregaste vos desaparece y
  // listo; si venía del Drive, vuelve cuando sincronices, y el cartel lo dice.
  const eliminarCama = () => {
    const c = mio[idx].cama;
    mutar((d) => { d.splice(idx, 1); });
    setISel(0);
    setEstado(`Cama ${c} sacada del pase`);
  };

  const deshacer = () => {
    if (!undo.current.length) { setEstado("Nada para deshacer"); return; }
    const prev = JSON.parse(undo.current.pop());
    setMio(prev); guardar(prev);
    setEstado("Deshecho · quedan " + undo.current.length);
  };
  const reiniciar = async () => {
    if (!confirm("Esto borra tus anotaciones y ediciones, y vuelve a traer el pase del Drive.\n\n¿Seguro?")) return;
    const limpio = JSON.parse(JSON.stringify(foto.pacientes));
    undo.current = [];
    setMio(limpio);
    try { await deleteDoc(doc(db, PASEAPP_COL, docId)); } catch (e) { /* si no existía, da igual */ }
    setEstado("Pase sincronizado y anotaciones borradas");
  };

  if (cargando || !mio || !foto) return <Skeleton />;

  // La tira de camas va ordenada por número de cama, no por la posición que
  // la ficha tiene en el array. Antes seguía el orden del array y al mover a
  // alguien de unidad aparecía último de la fila aunque su cama fuera la 1.1:
  // uno recorre la sala por número, así que la barra tiene que leerse igual.
  //
  // El orden es natural: "1.2" va antes que "1.10", y "R3" antes que "R12".
  // Comparar como texto pondría "1.10" antes que "1.2", que es como ordena
  // una computadora y no como cuenta una persona.
  const idxUnidad = mio
    .map((p, i) => [p, i])
    .filter(([p]) => p.unidad === uSel)
    .sort(([a], [b]) => paCamaOrden(a.cama).localeCompare(paCamaOrden(b.cama)))
    .map(([, i]) => i);
  const idx = idxUnidad.includes(iSel) ? iSel : (idxUnidad[0] ?? 0);
  const o = foto.pacientes[idx] || {};
  const p = verOriginal ? o : (mio[idx] || {});
  const editable = !verOriginal;

  // Todas las camas del pase, para el selector de destino de "Enviar a otra
  // cama". Se ofrecen las de todas las unidades porque los traslados entre
  // sectores son moneda corriente; la propia queda afuera, que mandarse a uno
  // mismo no es nada.
  //
  // Va DESPUÉS del return de arriba a propósito: depende de `mio`, que arranca
  // en null mientras carga, y de `idx`, que se calcula acá. Tenerlo antes hacía
  // que la pestaña entera se cayera al abrirla —React desmonta el árbol y
  // queda la pantalla de un solo color— antes siquiera de tocar nada.
  const destinos = mio
    .map((x, i) => ({ i, cama: x.cama, unidad: x.unidad, quien: ocupada(x) ? x.nombre : null }))
    .filter((c) => c.i !== idx);
  // Orden de las secciones. Por defecto el clínico (antecedentes, enfermedad
  // actual, requerimientos, tratamiento...), pero cada uno puede subir o bajar
  // las que mira primero. Queda guardado en la copia privada, así que el orden
  // de uno no le cambia la pantalla a nadie.
  const presentes = PA_ORDEN.filter((k) => p.campos && p.campos[k] !== undefined);
  const guardado = (p.ordenCampos || []).filter((k) => presentes.includes(k));
  const campos = [...guardado, ...presentes.filter((k) => !guardado.includes(k))];

  const moverCampo = (k, paso) => mutar((d) => {
    const act = [...campos];
    const i = act.indexOf(k), j = i + paso;
    if (i < 0 || j < 0 || j >= act.length) return;
    [act[i], act[j]] = [act[j], act[i]];
    d[idx].ordenCampos = act;
  });

  // Cambiar dilución o ritmo de una infusión. Se guarda en la copia propia y
  // la dosis se recalcula sola: si en la guardia se sube el goteo, el número
  // que se ve tiene que ser el de ahora, no el que quedó escrito en el Drive.
  const cambiarInfusion = (k, campo, valor) => mutar((d) => {
    const inf = d[idx].infusiones?.[k];
    if (!inf) return;
    inf[campo] = valor === "" ? "" : Number(valor);
    // La dosis que venía anotada en el pase deja de aplicar apenas se toca el
    // goteo: si no, el cartel de "no coincide" compara contra un valor viejo.
    inf.declarada = null;
    inf.tocada = true;

    // Y se reescribe el renglón del pase, para que el texto y la dosis no digan
    // cosas distintas.
    //
    // Se hace por líneas y reconstruyendo la línea entera, no con un replace
    // sobre todo el texto: React puede correr este updater dos veces y un
    // replace que se aplique dos veces deja el número viejo pegado al nuevo
    // ("200/250/16200/250/32"). Reconstruir la línea es idempotente.
    const c = inf.campoReal;
    const texto = d[idx].campos?.[c];
    if (c && texto && inf.mg !== "" && inf.ml !== "" && inf.ritmo !== "") {
      const nuevo = `${inf.mg}/${inf.ml}/${inf.ritmo}`;
      const tri = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/;
      d[idx].campos[c] = texto.split("\n").map((linea) => {
        if (!tri.test(linea)) return linea;
        // ¿esta línea es la de esta droga? El nombre puede estar prolijado
        // ("Ketamina") o crudo ("KETA"), así que se aceptan las dos formas.
        const prim = (linea.trim().split(/\s+/)[0] || "").toUpperCase();
        const esta = PA_INFUS[prim] === inf.droga ||
          prim === inf.droga.toUpperCase() ||
          (prim === "NA" && inf.droga === "Noradrenalina");
        return esta ? linea.replace(tri, nuevo) : linea;
      }).join("\n");
    }
  });

  // Mover un renglón dentro de una sección. El texto de cada campo es un bloque
  // de líneas; reordenar es mover la línea y volver a pegar.
  // Egreso: el paciente se fue y el pase del Drive todavía lo muestra. No se
  // borra el renglón —la cama sigue existiendo y saber que quedó libre es
  // justamente el dato útil a las tres de la mañana— sino que se le vacía
  // todo: campos, dosis, pendientes, balance y anotaciones. Queda la cama con
  // el cartel de vacía.
  //
  // Esto vive solo en tu copia. Cuando entre un pase nuevo del Drive con el
  // paciente ya dado de alta, "borrar mis anotaciones y sincronizar" limpia
  // todo y vuelve a arrancar de la foto.
  const marcarEgreso = () => {
    mutar((d) => {
      const x = d[idx];
      x.egresado = true;
      x.nombre = "";
      x.edad = null;
      x.sexo = null;
      x.mi = "";
      x.peso = null;
      x.pesoTeorico = null;
      x.campos = {};
      x.infusiones = [];
      x.intermitentes = [];
      x.pendientes = [];
      x.anotaciones = [];
      x.balance = { ingresos: [], egresos: [] };
      x.armTexto = "";
      x.sinCompletar = false;
    });
    setConfirmandoEgreso(false);
    setEditando(false);
  };

  // Pintar o despintar un renglón. El color se guarda dentro del texto, así
  // que viaja con el campo y no hay una estructura aparte que mantener.
  const marcarLinea = (k, i, color) => mutar((d) => {
    const ls = (d[idx].campos[k] || "").split("\n");
    if (i < 0 || i >= ls.length) return;
    ls[i] = paMarcar(ls[i], color);
    d[idx].campos[k] = ls.join("\n");
  });

  const moverLinea = (k, i, paso) => mutar((d) => {
    const ls = (d[idx].campos[k] || "").split("\n");
    const j = i + paso;
    if (j < 0 || j >= ls.length) return;
    [ls[i], ls[j]] = [ls[j], ls[i]];
    d[idx].campos[k] = ls.join("\n");
  });

  // Dónde van las dosis calculadas. Lo natural es debajo de Tratamiento, pero
  // hay pacientes que no tienen campo TTO en el Drive y llevan las infusiones
  // escritas en enfermedad actual (1.1, 1.4, 2.5, 3.2, 3.7 al momento de
  // escribir esto). Si se anclaran a "tto" a secas, esos cinco se quedarían sin
  // ninguna dosis a la vista, que es justo el dato que hay que mirar. Cuando no
  // hay tto se muestran en un bloque aparte al final, no colgadas del último
  // campo que haya quedado, porque leer las dosis abajo de "Accesos" confunde.
  const hayTto = campos.includes("tto");

  const editarCampo = (k, txt) => mutar((d) => {
    // Reponer los marcadores de negrita en cultivos: se le sacan al usuario
    // mientras edita y se vuelven a poner al guardar, mirando renglón por
    // renglón si empieza con "fecha muestra:".
    if (k === "cultivos" && !txt.includes("«")) {
      txt = txt.split("\n").map((l) => {
        const m = l.match(/^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+[A-Za-zÁÉÍÓÚÑ][\w.]*)?)\s*:\s*/);
        return m ? `«${m[1]}:» ` + l.slice(m[0].length) : l;
      }).join("\n");
    }
    // Lo que se escribe a mano también se acomoda al formato *fecha ... :
    // así el renglón agregado durante la guardia queda igual que los que
    // vinieron del Drive, sin tener que acordarse de poner el asterisco.
    if (k === "labo" || k === "eab" || k === "estudios") txt = paFormatoAsterisco(txt);
    // Reponer los resaltados. Mientras se edita el campo se muestra sin
    // marcas, así que lo que vuelve del contentEditable no las trae; se
    // vuelven a poner por posición de renglón. Si agregaste o borraste
    // renglones el resaltado puede correrse: es el precio de que el color
    // viva dentro del texto, y se arregla volviendo a marcar.
    const previas = (d[idx].campos[k] || "").split("\n").map((l) => paMarcaDe(l).color);
    if (previas.some(Boolean)) {
      txt = txt.split("\n").map((l, i) => (previas[i] ? paMarcar(l, previas[i]) : l)).join("\n");
    }
    d[idx].campos[k] = txt;
  });

  // Settings de ARM del paciente que se está mirando. Si todavía no se tocó
  // nada, se precargan los que el propio pase trae escritos.
  const armDe = (i) => {
    if (arm[i]) return arm[i];
    const leido = paLeerArm((mio[i] || {}).armTexto);
    return leido || {};
  };
  const setArmDe = (i, campo, valor) =>
    setArm((s) => ({ ...s, [i]: { ...armDe(i), [campo]: valor } }));
  // En el celular los botones chicos se erran con el pulgar. 32 px de lado es
  // el mínimo que se acierta parado en un pasillo; en pantalla grande el
  // mouse no lo necesita y quedarían desproporcionados.
  const FLECHA = { fontFamily: "inherit", fontSize: chico ? 14 : 11, lineHeight: 1,
    padding: chico ? "0" : "3px 6px", width: chico ? 32 : undefined, height: chico ? 32 : undefined,
    flex: chico ? "0 0 auto" : undefined,
    borderRadius: 4, border: "1.5px solid #E2E8F0", background: "#fff", color: "#64748B", cursor: "pointer" };
  const B = { fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 5, border: "1.5px solid #E2E8F0", background: "#fff", color: "#0F172A", cursor: "pointer" };
  const BP = { ...B, background: "#0F5F66", borderColor: "#0F5F66", color: "#fff" };
  const ROT = { fontFamily: "ui-monospace,monospace", fontSize: 10.5, fontWeight: 600, letterSpacing: ".09em", textTransform: "uppercase" };
  const caja = { background: "#fff", border: "1px solid #E2E8F0", borderRadius: 8, marginBottom: 12, overflow: "hidden" };

  const Plegable = ({ k, titulo, color, n, children }) => (
    <div style={{ ...caja, borderLeft: color ? `4px solid ${color}` : caja.border }}>
      <div onClick={() => setPlegado((s) => ({ ...s, [k]: !s[k] }))}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", cursor: "pointer", userSelect: "none" }}>
        <span style={{ fontSize: 10, color: "#64748B", transform: plegado[k] ? "rotate(-90deg)" : "none", transition: "transform .15s" }}>▼</span>
        <span style={{ ...ROT, fontWeight: 800, fontSize: 11.5, color: color || "#334155" }}>{titulo}</span>
        {n > 0 && <span style={{ background: color || "#64748B", color: "#fff", borderRadius: 9, padding: "0 6px", fontSize: 10, fontFamily: "ui-monospace,monospace" }}>{n}</span>}
      </div>
      {!plegado[k] && <div style={{ padding: "0 14px 13px" }}>{children}</div>}
    </div>
  );

  const totalBal = (lista) => (lista || []).reduce((s, x) => s + (Number(x.ml) || 0), 0);
  const ing = totalBal(p.balance?.ingresos), egr = totalBal(p.balance?.egresos);

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <span style={{ fontSize: 22 }}>🩺</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3, display: "flex", alignItems: "center", gap: 7 }}>
            Pase App
            <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: ".08em", background: "#B45309", padding: "2px 6px", borderRadius: 3 }}>ALPHA</span>
          </div>
          <div style={{ fontSize: 10.5, opacity: 0.6 }}>
            Foto del Drive {foto.tomado ? new Date(foto.tomado).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"} · {mio.length} camas · tu copia privada
          </div>
        </div>
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7 }}>{estado}</span>
      </div>

      <div className="no-print" style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
        <button onClick={deshacer} style={B}>↶ Deshacer</button>
        <button onClick={reiniciar} style={B}>Borrar mis anotaciones y sincronizar pase</button>
        <label style={{ ...B, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={verOriginal} onChange={(e) => setVerOriginal(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: "#0F5F66", margin: 0 }} />
          Ver original sin modificaciones
        </label>
      </div>

      <div className="no-print" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 9 }}>
        {foto.unidades.map((u) => {
          const g = mio.filter((x) => x.unidad === u);
          return (
            <button key={u} onClick={() => { setUSel(u); setISel(mio.findIndex((x) => x.unidad === u)); }}
              style={{ ...B, fontSize: 13, fontWeight: 700, ...(u === uSel ? { background: "#0F172A", borderColor: "#0F172A", color: "#fff" } : {}) }}>
              {/* Solo la cantidad de camas. El contador de pendientes por unidad
                  no servía para decidir nada: los pendientes son de cada
                  paciente y se ven en su ficha. */}
              {u} <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 10, opacity: 0.7 }}>{g.length}</span>
            </button>
          );
        })}
      </div>

      <div className="no-print" style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8, marginBottom: 10 }}>
        {idxUnidad.map((i) => {
          const x = mio[i];
          const pend = (x.pendientes || []).filter((y) => !y.listo).length;
          return (
            <button key={i} onClick={() => setISel(i)}
              style={{ flex: "0 0 auto", fontFamily: "ui-monospace,monospace", fontSize: 16, fontWeight: 700, padding: "7px 13px", borderRadius: 5, border: "1.5px solid #E2E8F0", cursor: "pointer", background: i === idx ? "#0F5F66" : "#fff", color: i === idx ? "#fff" : "#334155" }}>
              {x.cama}{pend ? " •" : ""}
              {/* El apellido entero: cortarlo a ocho letras hacía que dos
                  pacientes distintos se vieran igual en la barra. */}
              <span style={{ display: "block", fontSize: 11.5, fontWeight: 600, opacity: 0.85, fontFamily: "inherit" }}>{(x.nombre || "").split(" ").pop()}</span>
            </button>
          );
        })}
      </div>

      {verOriginal && (
        <div style={{ padding: "9px 13px", borderRadius: 6, background: "#FFF6E5", border: "1px solid #E9C48A", color: "#8A4B00", fontSize: 12.5, fontWeight: 600, marginBottom: 12 }}>
          Viendo la foto original del Drive, sin tus cambios. Destildá arriba para volver a tu versión.
        </div>
      )}

      <Plegable k="anot" titulo="Anotaciones de este paciente durante la guardia" color="#8A4B00" n={(p.anotaciones || []).length}>
        {editable && (
          <>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
              {PA_TIPOS.map((t) => (
                <button key={t} onClick={() => setTipoSel(t)}
                  style={{ fontFamily: "ui-monospace,monospace", fontSize: 10.5, fontWeight: 600, padding: "5px 9px", borderRadius: 4, border: "1.5px solid #E9C48A", cursor: "pointer", background: t === tipoSel ? "#8A4B00" : "transparent", color: t === tipoSel ? "#fff" : "#8A4B00" }}>{t}</button>
              ))}
            </div>
            <NuevaAnotacion onAdd={(txt) => mutar((d) => {
              d[idx].anotaciones = d[idx].anotaciones || [];
              d[idx].anotaciones.push({ hora: new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }), tipo: tipoSel, texto: txt });
            })} />
          </>
        )}
        {(p.anotaciones || []).length === 0
          ? <div style={{ fontSize: 13, color: "#64748B", fontStyle: "italic" }}>Todavía no anotaste nada de este paciente.</div>
          : (p.anotaciones || []).map((x, k) => (
            <div key={k} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "8px 0", borderTop: k ? "1px solid #F1F5F9" : "none" }}>
              <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 11, color: "#8A4B00", paddingTop: 2 }}>{x.hora}</span>
              <span style={{ flex: 1, fontSize: 14 }}>
                <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 9, border: "1px solid #E9C48A", color: "#8A4B00", borderRadius: 3, padding: "1px 5px", marginRight: 6 }}>{x.tipo}</span>
                {x.texto}
              </span>
              {editable && <span onClick={() => mutar((d) => { d[idx].anotaciones.splice(k, 1); })} style={{ cursor: "pointer", color: "#94A3B8" }}>×</span>}
            </div>
          ))}
      </Plegable>

      {/* Cama libre: el paciente egresó y todavía no llegó el pase nuevo del
          Drive. Se muestra la cama vacía en vez de sacarla de la lista, porque
          saber que hay lugar es información útil durante la guardia. */}
      {p.egresado ? (
        <div style={{ ...caja, borderStyle: "dashed", background: "#F8FAFC", padding: "26px 18px", textAlign: "center" }}>
          {/* El número de cama se edita acá mismo: una cama que agregaste nace
              con el número de la que estabas mirando y casi siempre hay que
              corregirlo, y no tenía sentido obligar a abrir la ficha para eso. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
            {editable ? (
              <input value={p.cama || ""} onChange={(e) => mutar((d) => { d[idx].cama = e.target.value; })}
                title="Número de cama"
                style={{ width: 92, textAlign: "center", fontFamily: "ui-monospace,monospace", fontSize: 20, fontWeight: 800, color: "#475569", padding: "3px 6px", border: "1.5px solid #CBD5E1", borderRadius: 5, background: "#fff" }} />
            ) : (
              <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 20, fontWeight: 800, color: "#94A3B8" }}>{p.cama}</div>
            )}
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: "#475569", marginTop: 7 }}>Cama libre</div>
          <div style={{ fontSize: 12.5, color: "#64748B", marginTop: 5, lineHeight: 1.5, maxWidth: 440, margin: "5px auto 0" }}>
            {p.agregada
              ? <>La agregaste vos durante la guardia. No existe en el pase del Drive.</>
              : <>La sacaste vos durante la guardia. El pase del Drive todavía la muestra ocupada;
                 cuando entre un pase nuevo, con <b>“Borrar mis anotaciones y sincronizar pase”</b> vuelve
                 lo que diga el Drive.</>}
          </div>

          {editable && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 14 }}>
              <button onClick={ingresarPaciente} style={{ ...B, fontWeight: 700 }}>
                Ingresar nuevo paciente
              </button>
              <button onClick={() => setTrayendo(true)} style={B}>
                Traer paciente de otra cama
              </button>
              <button onClick={() => eliminarCama()} style={{ ...B, color: "#B91C1C", border: "1.5px solid #FCA5A5" }}>
                Eliminar cama del pase
              </button>
              {/* Sólo tiene sentido si la cama venía del Drive: una cama que
                  agregaste vos no tiene datos a los que volver. */}
              {!p.agregada && foto.pacientes[idx] && (
                <button onClick={() => mutar((d) => { d[idx] = JSON.parse(JSON.stringify(foto.pacientes[idx])); })}
                  style={B}>Traer de nuevo los datos del pase</button>
              )}
            </div>
          )}

          {/* Traer a alguien de otra cama: la lista de los que hay, y al
              elegir uno se muda acá y su cama anterior queda libre. */}
          {editable && trayendo && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #CBD5E1", textAlign: "left" }}>
              <div style={{ fontSize: 12.5, color: "#475569", marginBottom: 8 }}>
                ¿A quién traés a la cama <b>{p.cama}</b>?
              </div>
              {(() => {
                const gente = mio
                  .map((x, i) => ({ i, x }))
                  .filter(({ i, x }) => i !== idx && ocupada(x))
                  .sort((a, b) => paCamaOrden(a.x.cama).localeCompare(paCamaOrden(b.x.cama)));
                if (!gente.length) return (
                  <div style={{ fontSize: 12.5, color: "#64748B" }}>No hay ningún paciente cargado en otra cama.</div>
                );
                return (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 190, overflowY: "auto" }}>
                    {gente.map(({ i, x }) => (
                      <button key={i} onClick={() => traerDe(i)}
                        style={{ fontFamily: "ui-monospace,monospace", fontSize: 13, fontWeight: 700, padding: "6px 10px", borderRadius: 5, cursor: "pointer", border: "1.5px solid #CBD5E1", background: "#fff", color: "#334155", textAlign: "left" }}>
                        {x.cama}
                        <span style={{ display: "block", fontSize: 10.5, fontWeight: 600, opacity: 0.8, fontFamily: "inherit" }}>
                          {x.unidad} · {(x.nombre || "").split(" ").pop()}
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })()}
              <button onClick={() => setTrayendo(false)} style={{ ...B, marginTop: 10 }}>Cancelar</button>
            </div>
          )}
        </div>
      ) : (
      <>
      <div style={caja}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid #E2E8F0" }}>
          {/* Identificación editable. El pase del Drive escribe mal los nombres
              a menudo ("MEONIZ GRACIELA, F, 73 AÑOS") y los pacientes cambian de
              cama y de unidad durante la guardia, que es justo cuando esta
              pantalla se usa. Editar acá no toca el Drive: queda en la copia
              propia, como todo lo demás. */}
          {editando ? (
            <div style={{ display: "grid", gap: 7, marginBottom: 4 }}>
              <input value={p.nombre || ""} placeholder="Nombre y apellido"
                onChange={(e) => mutar((d) => { d[idx].nombre = e.target.value; })}
                style={{ fontSize: 16, fontWeight: 700, padding: "6px 8px", border: "1.5px solid #CBD5E1", borderRadius: 5, fontFamily: "inherit" }} />
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                <label style={{ fontSize: 11.5, color: "#64748B", display: "flex", alignItems: "center", gap: 5 }}>
                  Edad
                  <input type="number" value={p.edad || ""} onChange={(e) => mutar((d) => { d[idx].edad = e.target.value ? +e.target.value : null; })}
                    style={{ width: 62, fontFamily: "ui-monospace,monospace", fontSize: 13, padding: "4px 6px", border: "1.5px solid #CBD5E1", borderRadius: 4 }} />
                </label>
                <label style={{ fontSize: 11.5, color: "#64748B", display: "flex", alignItems: "center", gap: 5 }}>
                  Sexo
                  <select value={p.sexo || ""} onChange={(e) => mutar((d) => { d[idx].sexo = e.target.value || null; })}
                    style={{ fontFamily: "inherit", fontSize: 13, padding: "4px 6px", border: "1.5px solid #CBD5E1", borderRadius: 4 }}>
                    <option value="">—</option><option value="femenino">femenino</option><option value="masculino">masculino</option>
                  </select>
                </label>
                <label style={{ fontSize: 11.5, color: "#64748B", display: "flex", alignItems: "center", gap: 5 }}>
                  Cama
                  <input value={p.cama || ""} onChange={(e) => mutar((d) => { d[idx].cama = e.target.value; })}
                    style={{ width: 68, fontFamily: "ui-monospace,monospace", fontSize: 13, padding: "4px 6px", border: "1.5px solid #CBD5E1", borderRadius: 4 }} />
                </label>
                <label style={{ fontSize: 11.5, color: "#64748B", display: "flex", alignItems: "center", gap: 5 }}>
                  Unidad
                  {/* Al mover a otro sector, la vista lo sigue: si no, el
                      paciente desaparece de la pestaña en la que estabas y
                      parece que se perdió. */}
                  <select value={p.unidad || ""} onChange={(e) => { const u = e.target.value; mutar((d) => { d[idx].unidad = u; }); setUSel(u); setISel(idx); }}
                    style={{ fontFamily: "inherit", fontSize: 13, padding: "4px 6px", border: "1.5px solid #CBD5E1", borderRadius: 4 }}>
                    {foto.unidades.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </label>
              </div>
              <div>
                <button onClick={() => setEditando(false)} style={{ ...B, background: "#0F172A", color: "#fff", borderColor: "#0F172A" }}>Listo</button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: -0.2 }}>{p.nombre}</div>
                {editable && (
                  <button onClick={() => setEditando(true)} title="Corregir nombre, edad, cama o unidad"
                    style={{ background: "none", border: "none", color: "#64748B", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>editar ficha</button>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: "#64748B", marginTop: 3 }}>
                {p.edad ? `${p.edad} años` : ""}{p.sexo ? ` · ${p.sexo}` : ""}
              </div>
            </>
          )}
          {/* Motivo de ingreso: es lo primero que uno lee para ubicarse en el
              paciente, así que va destacado y con la fecha separada del texto
              en vez de perdida adelante en gris chico. */}
          {p.mi && (() => {
            const m = (p.mi || "").match(/^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*[:\-]?\s*/);
            const fecha = m ? m[1] : "";
            const texto = m ? p.mi.slice(m[0].length) : p.mi;
            return (
              <div style={{ display: "flex", gap: 11, alignItems: "baseline", marginTop: 9, padding: "11px 13px", background: "#F8FAFC", borderLeft: "4px solid #94A3B8", borderRadius: 5 }}>
                {fecha && (
                  <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 16, fontWeight: 800, color: "#334155", whiteSpace: "nowrap" }}>{fecha}</span>
                )}
                <span style={{ fontSize: 17.5, fontWeight: 800, color: "#0F172A", lineHeight: 1.4, letterSpacing: -0.2 }}>{texto}</span>
              </div>
            );
          })()}
          {/* Sacar al paciente: arriba, junto a los datos de la cama, que es
              donde uno mira cuando alguien se va. Con confirmación, porque es
              la única acción de esta pantalla que borra datos de golpe. */}
          {editable && (
            confirmandoEgreso ? (
              <div style={{ marginTop: 10, padding: "11px 13px", borderRadius: 6, border: "1px solid #FCA5A5", background: "#FEF2F2" }}>
                <div style={{ fontSize: 13.5, color: "#7F1D1D", lineHeight: 1.55 }}>
                  ¿Sacar a <b>{p.nombre || "este paciente"}</b> de la cama <b>{p.cama}</b>?
                  Se borran de tu copia los antecedentes, el tratamiento, las dosis, los pendientes,
                  el balance y tus anotaciones. La cama queda como libre.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <button onClick={marcarEgreso} style={{ ...B, background: "#B91C1C", borderColor: "#B91C1C", color: "#fff" }}>Sí, se fue</button>
                  <button onClick={() => setConfirmandoEgreso(false)} style={B}>Cancelar</button>
                </div>
              </div>
            ) : null
          )}

          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 9, alignItems: "center" }}>
            <span style={{ fontSize: 11.5, border: "1px solid #E2E8F0", borderRadius: 4, padding: "3px 8px" }}>
              Cama <b style={{ fontFamily: "ui-monospace,monospace" }}>{p.cama}</b>
              {p.unidad !== (foto.pacientes[idx] || {}).unidad && (
                <b style={{ color: "#8A4B00", marginLeft: 5 }}>· movido a {p.unidad}</b>
              )}
            </span>
            <span style={{ fontSize: 11.5, border: `1px ${p.peso ? "solid" : "dashed"} #E2E8F0`, borderRadius: 4, padding: "3px 8px", display: "flex", alignItems: "center", gap: 5 }}>
              Peso
              <input type="number" value={p.peso || ""} placeholder="—" disabled={!editable}
                onChange={(e) => mutar((d) => { d[idx].peso = e.target.value ? +e.target.value : null; })}
                style={{ width: 56, fontFamily: "ui-monospace,monospace", fontSize: 13, padding: "3px 5px", border: `1px solid ${p.peso ? "#E2E8F0" : "#FCA5A5"}`, borderRadius: 4 }} /> kg
            </span>
            {/* Sin peso, todas las dosis se calculan sobre 70 kg supuestos. El
                aviso va acá arriba, pegado al campo que lo resuelve, y no sólo
                abajo con las dosis. */}
            {!p.peso && (
              <span style={{ fontSize: 11.5, fontWeight: 700, color: "#B91C1C", border: "1px dashed #FCA5A5", borderRadius: 4, padding: "3px 8px", display: "flex", alignItems: "center" }}>
                ↖ Escribí el peso real o estimado
              </span>
            )}
            {p.sinCompletar && <span style={{ fontSize: 11.5, border: "1px dashed #FCA5A5", color: "#B91C1C", borderRadius: 4, padding: "3px 8px" }}>Último día sin completar</span>}
            {editable && !confirmandoEgreso && (
              <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button onClick={agregarCama}
                  title="Sumar una cama a esta unidad, vacía. Se puede repetir el número de cama."
                  style={{ fontFamily: "inherit", fontSize: 11.5, fontWeight: 600, color: "#334155", background: "#fff", border: "1px solid #CBD5E1", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}>
                  + Agregar cama
                </button>
                <button onClick={() => setEnviando({ destino: null, choque: false })}
                  title="Mover este paciente a otra cama, de esta o de otra unidad"
                  style={{ fontFamily: "inherit", fontSize: 11.5, fontWeight: 600, color: "#334155", background: "#fff", border: "1px solid #CBD5E1", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}>
                  → Enviar a otra cama
                </button>
                <button onClick={() => setConfirmandoEgreso(true)}
                  title="El paciente egresó y el pase del Drive todavía lo muestra"
                  style={{ fontFamily: "inherit", fontSize: 11.5, fontWeight: 600, color: "#B91C1C", background: "#fff", border: "1px solid #FCA5A5", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}>
                  El paciente se fue
                </button>
              </span>
            )}
          </div>

          {/* Enviar a otra cama. Dos pasos: elegir destino y, si está ocupado,
              decidir qué pasa con el que estaba. */}
          {editable && enviando && (
            <div style={{ marginTop: 10, padding: "12px 14px", borderRadius: 6, border: "1.5px solid #CBD5E1", background: "#F8FAFC" }}>
              {!enviando.choque ? (
                <>
                  <div style={{ fontSize: 13.5, color: "#0F172A", marginBottom: 9 }}>
                    Enviar a <b>{p.nombre || "este paciente"}</b> (cama {p.cama}) a:
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 200, overflowY: "auto" }}>
                    {destinos.map((c) => (
                      <button key={c.i} onClick={() => elegirDestino(c.i)}
                        title={c.quien ? `Ocupada por ${c.quien}` : "Cama libre"}
                        style={{ fontFamily: "ui-monospace,monospace", fontSize: 13, fontWeight: 700, padding: "6px 10px", borderRadius: 5, cursor: "pointer",
                          border: `1.5px solid ${c.quien ? "#E9C48A" : "#86EFAC"}`,
                          background: c.quien ? "#FFFBF3" : "#F0FDF4", color: "#334155" }}>
                        {c.cama}
                        <span style={{ display: "block", fontSize: 10, fontWeight: 600, opacity: 0.75, fontFamily: "inherit" }}>
                          {c.unidad}{c.quien ? " · ocupada" : " · libre"}
                        </span>
                      </button>
                    ))}
                  </div>
                  <button onClick={() => setEnviando(null)} style={{ ...B, marginTop: 10 }}>Cancelar</button>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 13.5, color: "#0F172A", lineHeight: 1.55, marginBottom: 10 }}>
                    En la cama <b>{mio[enviando.destino].cama}</b> está <b>{mio[enviando.destino].nombre}</b>.
                    ¿Qué hacemos con {mio[enviando.destino].nombre ? "él" : "esa ficha"}?
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button onClick={() => moverA(enviando.destino, "intercambiar", null)} style={{ ...B, fontWeight: 700 }}>
                      Se cambian de lugar (pasa a {p.cama})
                    </button>
                    <button onClick={() => setEnviando({ ...enviando, tercera: true })} style={B}>
                      Mandarlo a otra cama
                    </button>
                    <button onClick={() => moverA(enviando.destino, "egreso", null)}
                      style={{ ...B, color: "#B91C1C", border: "1.5px solid #FCA5A5" }}>
                      Ese paciente se fue
                    </button>
                    <button onClick={() => setEnviando(null)} style={B}>Cancelar</button>
                  </div>

                  {/* Tercera cama: sólo las libres, porque encadenar dos
                      desplazados abre una cadena sin fin. */}
                  {enviando.tercera && (
                    <div style={{ marginTop: 11, paddingTop: 10, borderTop: "1px dashed #CBD5E1" }}>
                      <div style={{ fontSize: 12.5, color: "#475569", marginBottom: 7 }}>
                        ¿A qué cama libre va <b>{mio[enviando.destino].nombre}</b>?
                      </div>
                      {(() => {
                        const libres = destinos.filter((c) => c.i !== enviando.destino && !c.quien);
                        if (!libres.length) return (
                          <div style={{ fontSize: 12.5, color: "#B91C1C" }}>
                            No hay ninguna cama libre. Agregá una con “+ Agregar cama” y volvé a intentar.
                          </div>
                        );
                        return (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {libres.map((c) => (
                              <button key={c.i} onClick={() => moverA(enviando.destino, "tercera", c.i)}
                                style={{ fontFamily: "ui-monospace,monospace", fontSize: 13, fontWeight: 700, padding: "6px 10px", borderRadius: 5, cursor: "pointer", border: "1.5px solid #86EFAC", background: "#F0FDF4", color: "#334155" }}>
                                {c.cama}
                                <span style={{ display: "block", fontSize: 10, fontWeight: 600, opacity: 0.75, fontFamily: "inherit" }}>{c.unidad}</span>
                              </button>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {campos.map((k) => {
          const txt = p.campos[k] || "", orig = o.campos?.[k] || "";
          const cambiado = txt !== orig;
          return (
            <div key={k} style={{ borderBottom: "1px solid #E2E8F0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px" }}>
                <span style={{ ...ROT, fontWeight: 800, fontSize: 11.5, color: "#334155" }}>{PA_ROT[k]}</span>
                {editable && (
                  <span style={{ display: "flex", gap: 2 }}>
                    <button onClick={() => moverCampo(k, -1)} title="Subir esta sección" style={FLECHA}>↑</button>
                    <button onClick={() => moverCampo(k, 1)} title="Bajar esta sección" style={FLECHA}>↓</button>
                    {(txt || "").includes("\n") && (
                      <button onClick={() => { setOrdenando(ordenando === k ? null : k); setResaltando(null); }}
                        title="Reordenar los renglones de esta sección"
                        style={{ ...FLECHA, background: ordenando === k ? "#0F172A" : "#fff", color: ordenando === k ? "#fff" : "#64748B" }}>⇅</button>
                    )}
                    {/* Resaltar: se marca por renglón, con el dedo, sin tener
                        que seleccionar texto —que en un celular es la peor
                        interacción posible—. */}
                    <button onClick={() => { setResaltando(resaltando === k ? null : k); setOrdenando(null); }}
                      title="Resaltar renglones de esta sección"
                      style={{ ...FLECHA, background: resaltando === k ? "#0F172A" : "#fff", color: resaltando === k ? "#fff" : "#64748B" }}>🖍</button>
                  </span>
                )}
                <span style={{ marginLeft: "auto", fontSize: 11, color: cambiado ? "#8A4B00" : "#94A3B8" }}>
                  {ordenando === k ? "moviendo renglones"
                    : resaltando === k ? "tocá un renglón para resaltarlo"
                    : cambiado ? "editado" : "tocá para editar"}
                </span>
              </div>
              <div style={{ padding: "0 14px 12px", fontSize: 14 }}>
                {ordenando === k ? (
                  /* Modo reordenar: cada renglón por separado, con sus flechas.
                     Se separa de la edición porque un contenteditable con
                     botones adentro se pelea con el cursor. */
                  <div style={{ display: "grid", gap: 4 }}>
                    {(txt || "").split("\n").map((l, li, arr) => {
                      const { color, texto } = paMarcaDe(l);
                      return (
                        <div key={li} style={{ display: "flex", alignItems: "flex-start", gap: 6, background: color ? PA_MARCA[color] : "#F8FAFC", borderRadius: 4, padding: "5px 7px" }}>
                          <span style={{ flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{texto}</span>
                          <button onClick={() => moverLinea(k, li, -1)} disabled={li === 0} style={{ ...FLECHA, opacity: li === 0 ? 0.3 : 1 }}>↑</button>
                          <button onClick={() => moverLinea(k, li, 1)} disabled={li === arr.length - 1} style={{ ...FLECHA, opacity: li === arr.length - 1 ? 0.3 : 1 }}>↓</button>
                        </div>
                      );
                    })}
                  </div>
                ) : resaltando === k ? (
                  /* Modo resaltar: un renglón por fila y los colores al lado.
                     Tocar el color que ya tiene se lo saca. */
                  <div style={{ display: "grid", gap: 4 }}>
                    {(txt || "").split("\n").map((l, li) => {
                      const { color, texto } = paMarcaDe(l);
                      return (
                        <div key={li} style={{ display: "flex", alignItems: "flex-start", gap: 6, background: color ? PA_MARCA[color] : "#F8FAFC", borderRadius: 4, padding: "5px 7px" }}>
                          <span style={{ flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{texto}</span>
                          {PA_MARCAS.map((c) => (
                            <button key={c} onClick={() => marcarLinea(k, li, color === c ? null : c)}
                              title={color === c ? "Sacar el resaltado" : PA_MARCA_ROT[c]}
                              style={{ width: 26, height: 26, flex: "0 0 auto", borderRadius: 5, cursor: "pointer",
                                background: PA_MARCA[c],
                                border: color === c ? "2.5px solid #0F172A" : "1.5px solid #CBD5E1" }} />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div contentEditable={editable} suppressContentEditableWarning
                    onFocus={() => setEnFoco(k)}
                    onBlur={(e) => { editarCampo(k, e.currentTarget.innerText); setEnFoco(null); }}
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", outline: "none", background: enFoco === k ? "rgba(15,95,102,.06)" : "transparent", borderRadius: 3, minHeight: 20 }}>
                    {/* Mientras el campo tiene el foco se muestra texto plano: si le
                        metemos marcas mientras se escribe, el cursor salta al inicio. */}
                    {/* Al editar se ven los «» crudos, que confunden; se sacan.
                        Al guardar se reponen si el renglón sigue teniendo la
                        forma "fecha muestra: germen", así el formato sobrevive
                        a una edición sin obligar a nadie a tipear símbolos. */}
                    {verOriginal || enFoco === k
                      ? paSinMarcas(txt).replace(/[«»]/g, "")
                      : <TextoMarcado actual={txt} original={orig} />}
                  </div>
                )}
              </div>
              {k === "tto" && <DosisDe p={p} onCambio={editable ? cambiarInfusion : null} />}
            </div>
          );
        })}

        {/* Sin campo Tratamiento, las dosis van igual: bloque propio al final. */}
        {!hayTto && (
          <div style={{ borderBottom: "1px solid #E2E8F0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px" }}>
              <span style={{ ...ROT, fontWeight: 800, fontSize: 11.5, color: "#334155" }}>Tratamiento</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "#94A3B8" }}>según lo escrito arriba</span>
            </div>
            <DosisDe p={p} onCambio={editable ? cambiarInfusion : null} />
          </div>
        )}
      </div>

      {/* ARM: casi nunca se usa, así que no ocupa lugar en la ficha. Botón que
          abre un pop-up, con los settings del modo que corresponda. */}
      <button onClick={() => setArmAbierto(true)} style={{ ...B, width: "100%", textAlign: "left", marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "#64748B" }}>🫁</span> Ver ARM de este paciente
        {(armDe(idx).modo || p.armTexto) && <span style={{ marginLeft: "auto", fontSize: 11, color: "#64748B" }}>
          {PA_MODOS[armDe(idx).modo]?.rot || "según el pase"}
        </span>}
      </button>

      <Plegable k="bal" titulo="Balance" color="#1D4ED8" n={(p.balance?.ingresos?.length || 0) + (p.balance?.egresos?.length || 0)}>
        <div style={{ display: "grid", gap: 12 }}>
          {[["ingresos", "Ingresos", ing], ["egresos", "Egresos", egr]].map(([campo, rot, tot]) => (
            <div key={campo}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                <span style={{ ...ROT, fontSize: 9.5, color: "#64748B" }}>{rot}</span>
                <span style={{ marginLeft: "auto", fontFamily: "ui-monospace,monospace", fontWeight: 700, fontSize: 14 }}>{tot} ml</span>
              </div>
              {(p.balance?.[campo] || []).map((x, k) => (
                <div key={k} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderTop: k ? "1px solid #F1F5F9" : "none" }}>
                  <span style={{ flex: 1, fontSize: 13.5 }}>
                    {x.que}
                    {/* Cuándo se relevó: un ingreso de las 18 y uno de las 3 de
                        la mañana no se leen igual al hacer el balance. */}
                    {x.cuando && <span style={{ color: "#94A3B8", fontFamily: "ui-monospace,monospace", fontSize: 11.5, marginLeft: 6 }}>{x.cuando}</span>}
                  </span>
                  <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 13.5, fontWeight: 600 }}>{x.ml} ml</span>
                  {editable && <span onClick={() => mutar((d) => { d[idx].balance[campo].splice(k, 1); })} style={{ cursor: "pointer", color: "#94A3B8" }}>×</span>}
                </div>
              ))}
              {editable && <FilaBalance onAdd={(que, ml) => mutar((d) => {
                if (!d[idx].balance) d[idx].balance = { ingresos: [], egresos: [] };
                d[idx].balance[campo].push({ que, ml, cuando: paAhora() });
              })} />}
            </div>
          ))}
          <div style={{ borderTop: "1px solid #E2E8F0", paddingTop: 9, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...ROT, fontSize: 9.5, color: "#64748B" }}>Balance</span>
            <span style={{ marginLeft: "auto", fontFamily: "ui-monospace,monospace", fontWeight: 700, fontSize: 17, color: ing - egr >= 0 ? "#1D4ED8" : "#B91C1C" }}>
              {ing - egr >= 0 ? "+" : ""}{ing - egr} ml
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.45 }}>
            {(p.balance?.ingresos || []).some((x) => /del pase/.test(x.que || ""))
              ? "Los renglones marcados \u0022del pase\u0022 salen del balance escrito al final del estado de hoy. El resto lo cargás vos en la cama."
              : "El balance lo cargás vos en la cama: no viene en el pase del Drive."}
          </div>
        </div>
      </Plegable>





      <Plegable k="pend" titulo="Pendientes" color="#0F5F66" n={(p.pendientes || []).filter((x) => !x.listo).length}>
        {(p.pendientes || []).length === 0
          ? <div style={{ fontSize: 13, color: "#64748B", fontStyle: "italic" }}>Sin pendientes cargados para este paciente.</div>
          : (p.pendientes || []).map((x, k) => (
            <div key={k} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "6px 0", borderTop: k ? "1px solid #F1F5F9" : "none" }}>
              <input type="checkbox" checked={x.listo} disabled={!editable}
                onChange={() => mutar((d) => { d[idx].pendientes[k].listo = !d[idx].pendientes[k].listo; })}
                style={{ width: 19, height: 19, accentColor: "#0F5F66", marginTop: 1 }} />
              <span style={{ flex: 1, fontSize: 14.5, textDecoration: x.listo ? "line-through" : "none", color: x.listo ? "#94A3B8" : "inherit" }}>{x.texto}</span>
              {editable && <span onClick={() => mutar((d) => { d[idx].pendientes.splice(k, 1); })} style={{ cursor: "pointer", color: "#94A3B8" }}>×</span>}
            </div>
          ))}
        {editable && <NuevoPendiente onAdd={(txt) => mutar((d) => {
          d[idx].pendientes = d[idx].pendientes || [];
          d[idx].pendientes.push({ texto: txt, listo: false });
        })} />}
      </Plegable>

      {/* Abreviaturas que la app no supo interpretar en ESTE paciente. No
          adivina el significado: sólo las señala, porque inventar una
          expansión plausible en un pase de terapia es peor que dejar la sigla
          cruda. Sirve para que la jerga nueva aparezca sola en vez de tener
          que ir a cazarla leyendo pases. */}
      {(() => {
        const raras = [...new Set(PA_ORDEN.flatMap((k) => paDesconocidas(p.campos?.[k])))];
        if (!raras.length) return null;
        return (
          <Plegable k="raras" titulo="Abreviaturas sin interpretar" color="#94A3B8" n={raras.length}>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
              {raras.map((w) => (
                <span key={w} style={{ fontFamily: "ui-monospace,monospace", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 4, padding: "3px 7px", color: "#475569" }}>{w}</span>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.45 }}>
              Estas siglas quedaron sin expandir: la app las deja tal cual en vez de suponer qué significan.
              Si alguna es de uso corriente, decímela y la agrego al diccionario.
            </div>
          </Plegable>
        );
      })()}

      </>
      )}

      <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.5, padding: "4px 2px" }}>
        <b>Versión alpha.</b> Tu copia se guarda en tu cuenta y nadie más la ve. Las anotaciones son temporales: cuando entra un pase nuevo, usá "Borrar mis anotaciones y sincronizar pase". Si algo no funciona o te falta algo, decímelo.
      </div>

      {armAbierto && (
        <ArmPopup p={p} v={armDe(idx)} set={(c, val) => setArmDe(idx, c, val)}
          setPT={(val) => mutar((d) => { d[idx].pesoTeorico = val; })}
          cerrar={() => setArmAbierto(false)} />
      )}
    </div>
  );
}

/* ── Pop-up de mecánica ventilatoria ──────────────────────────────────────
   Se elige el modo y se piden sólo los settings de ese modo. Meseta y PEEP
   total van siempre, porque son medidas con pausa y son las que dan driving
   pressure y auto-PEEP, que es para lo que uno abre esto. */
function ArmPopup({ p, v, set, setPT, cerrar }) {
  const modo = v.modo || "";
  // Peso para el Vt: el teórico manda. Regla de Gonzalo del 2/9/2026: el PT
  // se usa acá y en ningún otro lado — las dosis de drogas siguen yendo por
  // peso real.
  const pesoVt = p.pesoTeorico || p.peso || null;
  const conPT = !!p.pesoTeorico;
  const campos = PA_MODOS[modo]?.campos || [];
  const n = (x) => (x === "" || x == null || isNaN(+x) ? null : +x);
  const pl = n(v.pmeseta), pt = n(v.peeptotal), pe = n(v.peep);
  const vt = n(v.vtMedido) ?? n(v.vt);
  const peep = pt ?? pe;
  const dp = pl != null && peep != null ? pl - peep : null;
  const inp = { width: "100%", fontFamily: "ui-monospace,monospace", fontSize: 15, padding: "7px 9px", border: "1.5px solid #E2E8F0", borderRadius: 5, boxSizing: "border-box" };
  return (
    <div onClick={cerrar} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, border: "1.5px solid #CBD5E1", maxWidth: 480, width: "100%", maxHeight: "88vh", overflowY: "auto", padding: 18 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
          <b style={{ fontSize: 16 }}>Mecánica ventilatoria</b>
          <button onClick={cerrar} style={{ marginLeft: "auto", border: "none", background: "none", fontSize: 20, cursor: "pointer", color: "#64748B", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 12.5, color: "#64748B", marginBottom: 12 }}>{p.nombre} · cama {p.cama}</div>

        {/* El peso predicho vive acá y no en la ficha, porque acá es el único
            lugar donde se usa. Si el pase lo trae escrito como "PT 60 KG"
            viene cargado solo; si no, se escribe una vez y queda. */}
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "9px 11px", marginBottom: 14 }}>
          <span style={{ fontSize: 11.5, color: "#64748B" }}>Peso teórico (PT)</span>
          <input type="number" value={p.pesoTeorico || ""} placeholder="—"
            onChange={(e) => setPT && setPT(e.target.value ? +e.target.value : null)}
            style={{ width: 62, fontFamily: "ui-monospace,monospace", fontSize: 14, padding: "4px 6px", border: `1px solid ${conPT ? "#E2E8F0" : "#FCA5A5"}`, borderRadius: 4 }} />
          <span style={{ fontSize: 11.5, color: "#64748B" }}>kg</span>
          <span style={{ fontSize: 11.5, color: conPT ? "#64748B" : "#B91C1C", marginLeft: "auto" }}>
            {conPT ? "El Vt/kg se calcula con este peso." :
             p.peso ? `Sin PT cargado: el Vt/kg usa el peso real (${p.peso} kg) y queda subestimado.` :
             "Sin PT ni peso: no se puede calcular el Vt/kg."}
          </span>
        </div>

        <label style={{ fontSize: 11.5, color: "#64748B", display: "block", marginBottom: 4 }}>Modo ventilatorio</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          {Object.entries(PA_MODOS).map(([k, m]) => (
            <button key={k} onClick={() => set("modo", k)}
              style={{ fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 6, cursor: "pointer",
                border: modo === k ? "1.5px solid #0F172A" : "1.5px solid #E2E8F0",
                background: modo === k ? "#0F172A" : "#fff", color: modo === k ? "#fff" : "#475569" }}>
              {m.rot}
            </button>
          ))}
        </div>

        {!modo && <div style={{ fontSize: 13, color: "#64748B", padding: "10px 0" }}>Elegí el modo para cargar los parámetros.</div>}

        {modo && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(108px,1fr))", gap: 9, marginBottom: 14 }}>
            {campos.map(([k, rot]) => (
              <div key={k}>
                <label style={{ fontSize: 11, color: "#64748B", display: "block", marginBottom: 3 }}>{rot}</label>
                <input type="number" value={v[k] ?? ""} onChange={(e) => set(k, e.target.value)} style={inp} />
              </div>
            ))}
          </div>
        )}

        <div style={{ borderTop: "1px solid #E2E8F0", paddingTop: 12 }}>
          <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 7 }}>Medidas con pausa</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(108px,1fr))", gap: 9 }}>
            {[["pmeseta", "Presión meseta"], ["peeptotal", "PEEP total"], ["vtMedido", "Vt exhalado"]].map(([k, rot]) => (
              <div key={k}>
                <label style={{ fontSize: 11, color: "#64748B", display: "block", marginBottom: 3 }}>{rot}</label>
                <input type="number" value={v[k] ?? ""} onChange={(e) => set(k, e.target.value)} style={inp} />
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", borderTop: "1px solid #E2E8F0", marginTop: 12, paddingTop: 12 }}>
          {[["Driving pressure", dp != null ? dp.toFixed(1) : "—"],
            ["Auto-PEEP", pt != null && pe != null ? (pt - pe).toFixed(1) : "—"],
            ["Compliance", dp && vt ? (vt / dp).toFixed(1) : "—"],
            // El Vt se programa por kilo de peso PREDICHO, no del real: los
            // pulmones no engordan. Si el pase trae PT se usa ese; si no, se
            // cae al peso real y se avisa abajo, porque en un obeso la
            // diferencia entre los dos puede ser de varios ml/kg.
            ["Vt / kg", vt && pesoVt ? (vt / pesoVt).toFixed(1) : "—"]].map(([l, val]) => (
            <div key={l} style={{ fontSize: 12, color: "#64748B" }}>{l}
              <b style={{ display: "block", fontFamily: "ui-monospace,monospace", fontSize: 19, color: "#0F172A" }}>{val}</b>
            </div>
          ))}
        </div>

        {p.armTexto && (
          <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 12, paddingTop: 10, borderTop: "1px dashed #E2E8F0" }}>
            En el pase dice: <span style={{ fontFamily: "ui-monospace,monospace", color: "#0F172A" }}>{p.armTexto}</span>
          </div>
        )}
        <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 10, lineHeight: 1.45 }}>
          Driving = meseta − PEEP total. Auto-PEEP = PEEP total − PEEP programada. Compliance = Vt / driving.
          {" El Vt/kg va por peso teórico (predicho), no por el real."}
        </div>
      </div>
    </div>
  );
}

// Dosis calculadas. SOLO infusiones endovenosas continuas: son las únicas
// donde la dosis por kilo depende de la dilución y del ritmo, y por lo tanto
// las únicas donde este cálculo agrega algo. Un comprimido cada 12 horas ya
// dice todo lo que hay que saber en el renglón de tratamiento; ponerlo acá
// abajo repetido solo hace ruido en la sección que uno mira para chequear una
// bomba.
function DosisDe({ p, onCambio }) {
  const inf = p.infusiones || [];
  if (!inf.length) return null;
  const editable = typeof onCambio === "function";
  const cel = { width: 58, fontFamily: "ui-monospace,monospace", fontSize: 13, padding: "3px 5px", border: "1.5px solid #E2E8F0", borderRadius: 4, textAlign: "right" };
  return (
    <div style={{ margin: "0 14px 12px", paddingTop: 10, borderTop: "1px dashed #E2E8F0" }}>
      {!p.peso && inf.length > 0 && (
        <div style={{ fontSize: 13, fontWeight: 700, color: "#B91C1C", marginBottom: 8 }}>Dosis en paciente de {PA_PESO_SUPUESTO} kg</div>
      )}
      {inf.map((x, k) => {
        const g = paDosis(x, p.peso);
        const dec = x.declarada;
        const dif = !g.sinUnidad && dec != null && Math.abs(g.kgh - dec) / Math.max(dec, 1e-9) > 0.10;
        const r = PA_RANGO[x.droga];
        const fuera = !g.sinUnidad && r && (g.kgh < r[0] || g.kgh > r[1]);
        return (
          <div key={k} style={{ padding: "8px 0", borderTop: k ? "1px solid #F1F5F9" : "none" }}>
            {/* La dosis va pegada al nombre de la droga: es el dato que se
                busca, no tiene sentido mandarlo a una columna aparte. */}
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: 14.5 }}>{x.droga}</span>
              {g.sinUnidad
                ? <span style={{ color: "#B91C1C", fontSize: 12 }}>sin unidad definida</span>
                : <span style={{ fontFamily: "ui-monospace,monospace", fontWeight: 700, fontSize: 15, color: fuera ? "#B91C1C" : "#0F172A" }}>
                    {g.kgh.toFixed(3)} <em style={{ fontStyle: "normal", fontSize: 11, color: "#64748B" }}>{g.u}/kg/h</em>
                    {PA_POR_MINUTO.has(x.droga) && (
                      <span style={{ marginLeft: 9 }}>
                        {(g.kgh * 1000 / 60).toFixed(3)} <em style={{ fontStyle: "normal", fontSize: 11, color: "#64748B" }}>mcg/kg/min</em>
                      </span>
                    )}
                  </span>}
            </div>
            {/* Dilución y ritmo editables: si en la guardia se cambia el goteo,
                la dosis se recalcula sola en vez de quedar mintiendo. */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5, fontSize: 11.5, color: "#64748B", flexWrap: "wrap" }}>
              {editable ? <input type="number" value={x.mg} onChange={(e) => onCambio(k, "mg", e.target.value)} style={cel} />
                        : <b style={{ fontFamily: "ui-monospace,monospace" }}>{x.mg}</b>}
              <span>{g.u || "?"} en</span>
              {editable ? <input type="number" value={x.ml} onChange={(e) => onCambio(k, "ml", e.target.value)} style={cel} />
                        : <b style={{ fontFamily: "ui-monospace,monospace" }}>{x.ml}</b>}
              <span>ml a</span>
              {editable ? <input type="number" value={x.ritmo} onChange={(e) => onCambio(k, "ritmo", e.target.value)} style={cel} />
                        : <b style={{ fontFamily: "ui-monospace,monospace" }}>{x.ritmo}</b>}
              <span>ml/h · peso {g.peso} kg</span>
            </div>
            {dec != null && (
              <div style={{ fontSize: 11.5, marginTop: 4, color: dif ? "#B91C1C" : "#64748B", fontWeight: dif ? 600 : 400 }}>
                {dif ? "⚠ No coincide" : "✓ Coincide"} · el pase anota <b>{dec}</b>
              </div>
            )}
            {fuera && <div style={{ fontSize: 11.5, marginTop: 4, color: "#B91C1C" }}>⚠ Fuera del rango habitual ({r[0]}–{r[1]} {g.u}/kg/h). Revisá el ritmo o la dilución.</div>}
            {x.campo && <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>Escrita en {PA_ROT[x.campo] || x.campo}, no en tratamiento.</div>}
          </div>
        );
      })}
      <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 8, lineHeight: 1.45 }}>
        Dosis = concentración ÷ dilución × ritmo ÷ peso. <b>Verificá contra la bomba antes de usar.</b>
      </div>
    </div>
  );
}
function NuevaAnotacion({ onAdd }) {
  const [v, setV] = useState("");
  const enviar = () => { const t = v.trim(); if (!t) return; onAdd(t); setV(""); };
  return (
    <div style={{ display: "flex", gap: 7, marginBottom: 10 }}>
      <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && enviar()}
        placeholder="Qué pasó…" style={{ flex: 1, fontSize: 14, padding: "7px 9px", border: "1.5px solid #E2E8F0", borderRadius: 5, fontFamily: "inherit" }} />
      <button onClick={enviar} style={{ background: "#0F5F66", color: "#fff", border: "none", borderRadius: 5, padding: "7px 13px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Anotar</button>
    </div>
  );
}

function NuevoPendiente({ onAdd }) {
  const [v, setV] = useState("");
  const enviar = () => { const t = v.trim(); if (!t) return; onAdd(t); setV(""); };
  return (
    <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
      <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && enviar()}
        placeholder="Agregar pendiente…" style={{ flex: 1, fontSize: 14, padding: "7px 9px", border: "1.5px solid #E2E8F0", borderRadius: 5, fontFamily: "inherit" }} />
      <button onClick={enviar} style={{ background: "#0F5F66", color: "#fff", border: "none", borderRadius: 5, padding: "7px 13px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Agregar</button>
    </div>
  );
}

function FilaBalance({ onAdd }) {
  const [que, setQue] = useState("");
  const [ml, setMl] = useState("");
  const enviar = () => {
    const q = que.trim(), n = Number(ml);
    if (!q || !isFinite(n)) return;
    onAdd(q, n); setQue(""); setMl("");
  };
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
      <input value={que} onChange={(e) => setQue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && enviar()}
        placeholder="Qué" style={{ flex: 1, fontSize: 13.5, padding: "6px 8px", border: "1.5px solid #E2E8F0", borderRadius: 5, fontFamily: "inherit" }} />
      <input type="number" value={ml} onChange={(e) => setMl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && enviar()}
        placeholder="ml" style={{ width: 72, fontSize: 13.5, padding: "6px 8px", border: "1.5px solid #E2E8F0", borderRadius: 5, fontFamily: "ui-monospace,monospace" }} />
      <button onClick={enviar} style={{ background: "#fff", border: "1.5px solid #E2E8F0", borderRadius: 5, padding: "6px 11px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+</button>
    </div>
  );
}
