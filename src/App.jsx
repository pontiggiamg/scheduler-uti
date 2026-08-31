import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react";
import { db, auth, googleProvider } from "./firebase";
import { doc, onSnapshot, setDoc, getDoc, deleteDoc, increment, arrayUnion, collection, getDocs, query, orderBy } from "firebase/firestore";
import { signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";

/* ══════════════════ CONFIGURACIÓN ══════════════════ */

const ADMIN_EMAIL = "pontiggiamg@gmail.com";

// Pestañas de nivel superior de la app. El orden por defecto se usa si todavía
// no hay nada guardado en Firestore (scheduler/ui-config); el admin puede
// reordenarlas arrastrando y ese orden se guarda ahí, compartido para todos.
const DEFAULT_TAB_ORDER = ["scheduler", "rotaciones", "pases", "chipa", "academico", "articulo", "registro", "hoy", "accesos", "impresiones"];
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
          <div className="print-scroll" style={{ overflowX: "auto", paddingBottom: 4 }}>
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
                    {free.length === 0 ? (!active && <div style={{ fontSize: 10.5, color: "#64748B", fontStyle: "italic", textAlign: "center", padding: 6 }}>todos asignados</div>) : free.map((n) => <Chip key={n} name={n} selected={sel?.name === n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: "pool" }); }} />)}
                  </div>
                </Cell>
              );
            })}

            <RowLabel label="No disponibles" color="#DC2626" sub="rotación · vacaciones" />
            {DAYS.map((_, di) => {
              const autos = autoNoDisponibles(di);
              return (
                <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place("unavailable", di); }} tint="#FEF2F2" ring={active ? "#F87171" : null} lastCol={di === DAYS.length - 1} lastRow>
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
              <div style={{ textAlign: "center", padding: 30, color: "#64748B", fontSize: 12.5, background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0" }}>
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
                    <div style={{ flexShrink: 0, color: "#64748B", fontSize: 12, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▼</div>
                  </div>

                  {isOpen && (
                    <div style={{ borderTop: "1px solid #F1F5F9", padding: "4px 13px 12px" }}>
                      {PASE_FIELDS.filter(([k]) => p.fields?.[k]).map(([k, label]) => (
                        <div key={k} style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#64748B", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
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
        {!cargando && resumen && ["R4", "R3", "R2"].map((lv) => {
          const dif = resumen.porNivel[lv] - cupos[lv];
          return (
            <span key={lv} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, padding: "5px 10px", borderRadius: 8, background: dif === 0 ? "#F0FDF4" : "#FEF2F2", border: `1px solid ${dif === 0 ? "#BBF7D0" : "#FECACA"}` }}>
              <b style={{ fontSize: 9.5, color: "#fff", background: COLOR[lv].solid, padding: "1px 5px", borderRadius: 3 }}>{lv}</b>
              <span style={{ fontWeight: 700, color: "#0F172A", fontVariantNumeric: "tabular-nums" }}>{resumen.porNivel[lv]}/{cupos[lv]}</span>
              <span style={{ color: dif === 0 ? "#15803D" : "#B91C1C", fontWeight: 600 }}>{dif === 0 ? "exacto" : dif > 0 ? `+${dif}` : dif}</span>
            </span>
          );
        })}
      </div>

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

const RowLabel = ({ label, color, sub, className }) => (<div className={className} style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end", textAlign: "right", padding: "8px 10px", background: "#F8FAFC", borderRight: "2px solid #E2E8F0", borderBottom: "2px solid #D1D5DB", borderTop: "2px solid #D1D5DB" }}><div style={{ fontWeight: 700, fontSize: 11, color, letterSpacing: 0.1 }}>{label}</div>{sub && <div style={{ fontSize: 8.5, color: "#64748B", marginTop: 1 }}>{sub}</div>}</div>);

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
  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748B", fontWeight: 500 }}><span style={{ width: 11, height: 11, borderRadius: 3.5, background: "#E9D5FF", border: "1.5px solid #D8B4FE" }} />Postguardia</div>
</div>);

/* ══════════════════ ESTILOS ══════════════════ */

const NAV = { background: "rgba(255,255,255,.14)", border: "none", borderRadius: 7, color: "#fff", padding: "6px 10px", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", lineHeight: 1.2 };

const INPUT = { padding: "6px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", background: "#fff", color: "#0F172A" };

const TEXTAREA = { width: "100%", minHeight: 52, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", background: "#fff", fontSize: 11.5, lineHeight: 1.45, color: "#1F2937", fontWeight: 500, fontFamily: "'Inter', system-ui, sans-serif", resize: "vertical", outline: "none", boxSizing: "border-box" };
