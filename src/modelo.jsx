/* ══════════════════════════════════════════════════════════════════════════
   El modelo

   Como se leen y se validan los datos que vienen de la base, y las reglas
   del servicio: quien esta disponible un dia, quien no puede hacer guardia,
   que semana es de que mes. Es la cabeza del sistema; no dibuja nada.
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect } from "react";
import { db } from "./firebase";
import { doc } from "firebase/firestore";
import { escuchar } from "./nube";
import { shift, isoDate } from "./comunes";
import { paCultivos, paFormatoAsterisco, paLimpiar, paPartirAccesos, paPartirTto, paReordenarClinicos } from "./pase/motor";
import { ALL, ASIGNABLES, CUPO_MES, DAYS, JEFE, LEVEL, PASE_COLOR, RESIDENTS, SLOTS, SLOT_KEYS, TOPE_DIA_LIBRE, WEEKEND_START_IDX, isWeekendIdx, nombrePublico } from "./config";
import { diOfDate, dm, lunesDelMes, mesDeLaSemana, mesLargo, mondayOf } from "./fechas";

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

/* ══════════════════ LECTORES COMPARTIDOS ══════════════════

   Dos datos que varias pestañas necesitan al mismo tiempo: el pase del Drive
   y las rotaciones del año. Antes cada pestaña se conectaba por su cuenta, y
   ese fue el origen de bugs de verdad: el pase se leía en TRES lugares con
   tres formas distintas de interpretar los mismos campos, y el 3/9/2026 la
   edad del paciente se perdía en dos de esos tres porque el arreglo se había
   hecho en uno solo. Un dato leído en un solo lugar no puede desincronizarse
   consigo mismo. */

/* Las rotaciones y vacaciones de uno o más años (scheduler/rotaciones-AAAA).
   Se pide más de un año cuando la semana cruza diciembre. */
function useRotaciones(anios) {
  const [rotPorAnio, setRotPorAnio] = useState({});
  const clave = anios.join(",");
  useEffect(() => {
    const unsubs = clave.split(",").filter(Boolean).map((y) =>
      escuchar(doc(db, "scheduler", `rotaciones-${y}`), (snap) => {
        setRotPorAnio((cur) => ({ ...cur, [y]: snap.exists() ? normalizeRot(snap.data()) : emptyRotYear() }));
      }, `las rotaciones de ${y}`)
    );
    return () => unsubs.forEach((u) => u());
  }, [clave]);
  return rotPorAnio;
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

const colorUnidad = (u) => PASE_COLOR[(u || "").toUpperCase().replace(/\s+/g, " ")] || { fuerte: "#334155", suave: "#F1F5F9" };

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
  // El peso y la dieta salen del arranque de TRATAMIENTO: el peso ya se
  // muestra en la ficha y la dieta pertenece a Requerimientos.
  if (f.tto) {
    const pt = paPartirTto(f.tto);
    if (pt.tto !== f.tto) {
      f.tto = pt.tto;
      if (pt.dieta) f.req = [pt.dieta, f.req].filter(Boolean).join("\n");
      if (!f.tto) delete f.tto;
    }
  }
  const g = paReordenarClinicos(f);
  const out = {};
  // Las tres secciones fechadas van con el formato *fecha estudio resultado.
  // Es la misma regla que en Pase App: lo que se corrige en una pestaña vale
  // para la otra, salvo las funcionalidades que sólo existen allá.
  const CON_ASTERISCO = new Set(["labo", "eab", "cultivos", "estudios"]);
  for (const [k, v] of Object.entries(g)) {
    // Cultivos pasa por paLimpiar ANTES de agruparse: si no, las siglas de
    // esa sección se quedaban crudas —"HMC X2" seguía siendo "HMC X2" en vez
    // de "HCx2"— porque paCultivos sólo reordena y nunca normaliza.
    const limpio = k === "cultivos" ? paCultivos(paLimpiar(v)) : paLimpiar(v);
    out[k] = CON_ASTERISCO.has(k) ? paFormatoAsterisco(limpio) : limpio;
  }
  return out;
}

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

// Deja solo los dígitos de un teléfono cargado a mano, para armar el link de
// wa.me (que no acepta espacios, guiones ni el signo +).
function limpiarTelefono(raw) {
  return (raw || "").replace(/[^\d]/g, "");
}

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

const cupoR2 = (anio, mes) => new Date(anio, mes + 1, 0).getDate() * 2 - CUPO_MES.R4 - CUPO_MES.R3;

// Un "superior" es quien puede quedar a cargo de una sala o una guardia.
const esSuperior = (n) => LEVEL[n] === "R3" || LEVEL[n] === "R4" || LEVEL[n] === "JR";

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

export { TRAMOS_VACACIONES, agruparPorMes, agruparPorTipo, analizarSemana, canonizarGuardia, clone, colorUnidad, cupoR2, disponiblesEsaSemana, emptyAcademico, emptyDay, emptyDiasLibresR4, emptyRotYear, emptyWeek, esResidente, esSuperior, isBlank, limpiarTelefono, motivoNoDisponible, motivoNoPuedeGuardia, normalizarListaGuardia, normalize, normalizeAcademico, normalizeChipaWeek, normalizeRot, parseDeGuardia, paseArreglado, resolverResidente, semanaDeVotacionPorDefecto, semanaLibreEseDia, textoTramo, tramoPorDefecto, useRotaciones, vacacionesEseDia };
