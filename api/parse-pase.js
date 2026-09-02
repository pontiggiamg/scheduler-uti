// Parser de pases de UTI — convierte el texto plano de un Google Doc
// en una lista estructurada de pacientes.

const FIELDS = [
  { key: "ap", re: /^AP\s*[:\-]/i, label: "Antecedentes" },
  { key: "req", re: /^(REQUERIMIENTOS?\s*\/?\s*INTERCURRENCIAS?|INTERCURRENCIAS?\s*\/?\s*REQUERIMIENTOS?|REQ\s*\/\s*INTERCURRENCIAS?)/i, label: "Requerimientos / Intercurrencias" },
  { key: "ea", re: /^EA\s*[:\-\s]/i, label: "Enfermedad actual" },
  { key: "tto", re: /^TTO\b|^TRATAMIENTO\b/i, label: "Tratamiento" },
  { key: "accesos", re: /^ACCESOS?\b/i, label: "Accesos" },
  { key: "cultivos", re: /^CULTIVOS?\b/i, label: "Cultivos" },
  { key: "estudios", re: /^(COMPLEMENTARIOS?|ESTUDIOS?|EC\s*::?)/i, label: "Complementarios" },
  { key: "labo", re: /^(LABO|LAB)\b/i, label: "Laboratorio" },
  { key: "eab", re: /^EAB\b/i, label: "EAB" },
  { key: "pendiente", re: /^PENDIENTES?\s*[:\-]?/i, label: "Pendientes" },
];

// Marcadores de cama: "1.1", "2.3", "R1", "UCO 1", "UCO1"
const BED_RE = /^(\d\.\d{1,2}|R\d{1,2}|UCO\s*\d{1,2})$/i;
// Encabezado de unidad dentro del doc: "UTI 2", "UCO", "RECU"
/* El encabezado de la unidad adentro del documento. Se acepta con dos puntos,
   guion o una fecha al lado ("UTI 2:", "UTI 2 - 02/09"), porque el pase se
   escribe a mano y el encabezado se retoca seguido. Antes se exigía que el
   renglón dijera exactamente "UTI 2" y cualquier agregado lo volvía
   irreconocible. */
const UNIT_RE = /^(UTI\s*\d|UCO|RECU|TERAPIA\s*\d|RECUPERACI[OÓ]N)\s*[:\-–]?\s*(\d{1,2}\/\d{1,2}(\/\d{2,4})?)?$/i;

/* La unidad que le corresponde a una cama, leída del propio número: "2.5" es
   UTI 2, "R3" es RECU, "UCO 4" es UCO.

   Esto es lo que salva el pase cuando el encabezado del documento falta o
   está mal escrito. El 2/9/2026 alguien tocó el encabezado del documento de
   UTI 2 y la app mostró una pestaña llamada "Doc 3" con las camas 2.1 a 2.5
   adentro. El número de cama, en cambio, siempre está y no miente. */
function unidadDeCama(bed) {
  const b = String(bed || "").toUpperCase().replace(/\s+/g, "");
  const m = b.match(/^(\d)\./);
  if (m) return "UTI " + m[1];
  if (/^R\d/.test(b)) return "RECU";
  if (/^UCO/.test(b)) return "UCO";
  return null;
}

const AGE_RE = /(\d{1,3})\s*A[ÑN]OS?/i;
const DATE_RE = /(\d{1,2}\/\d{1,2})/;

function cleanLine(s) {
  return s
    .replace(/\u00a0/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function fieldFor(line) {
  for (const f of FIELDS) if (f.re.test(line)) return f;
  return null;
}

function stripLabel(line, field) {
  return line.replace(field.re, "").replace(/^\s*[:\-]\s*/, "").trim();
}

/**
 * Parsea el texto plano de un doc de pase.
 * @param {string} raw - texto del doc
 * @param {string} defaultUnit - unidad por defecto (ej "UTI 1")
 * @returns {Array} pacientes
 */
export function parsePase(raw, defaultUnit) {
  const lines = raw.split("\n").map(cleanLine);

  const patients = [];
  let unit = defaultUnit;
  // ¿El documento traía un encabezado de unidad de verdad? Si no, cada cama
  // decide su unidad por su propio número.
  let vioEncabezado = false;
  let cur = null;
  let curField = null;

  const push = () => {
    if (!cur) return;
    // descartar camas totalmente vacías
    const hasContent = cur.name || Object.values(cur.fields).some((v) => v && v.trim());
    if (hasContent) patients.push(cur);
    cur = null;
    curField = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (UNIT_RE.test(line) && !BED_RE.test(line)) {
      push();
      // Se guarda sólo la sigla, sin los dos puntos ni la fecha que pueda
      // traer el encabezado.
      unit = (line.toUpperCase().match(/^(UTI\s*\d|UCO|RECU)/) || [line.toUpperCase()])[0].replace(/\s+/g, " ").trim();
      vioEncabezado = true;
      continue;
    }

    if (BED_RE.test(line)) {
      push();
      const bed = line.toUpperCase().replace(/\s+/g, "");
      cur = { unit: vioEncabezado ? unit : (unidadDeCama(bed) || unit), bed, name: "", age: null, mi: "", fields: {} };
      curField = null;
      continue;
    }

    if (!cur) continue;

    // Nombre: primera línea con contenido después del marcador de cama
    if (!cur.name && !fieldFor(line) && !/^MI\b/i.test(line)) {
      const m = line.match(AGE_RE);
      if (m) {
        cur.age = parseInt(m[1], 10);
        cur.name = line.replace(AGE_RE, "").replace(/[,.\-\s]+$/, "").trim();
      } else {
        cur.name = line;
      }
      // limpiar marcadores tipo "**...**"
      cur.name = cur.name.replace(/\*+/g, "").replace(/[,.\s]+$/, "").trim();
      continue;
    }

    // MI (motivo de ingreso) — puede venir como "MI: ..." o "14/08 MI: ..."
    if (!cur.mi && /\bMI\b\s*[:\-]/i.test(line)) {
      cur.mi = line.replace(/\*+/g, "").trim();
      const d = line.match(DATE_RE);
      if (d) cur.admission = d[1];
      curField = null;
      continue;
    }

    const f = fieldFor(line);
    if (f) {
      curField = f.key;
      const rest = stripLabel(line, f);
      cur.fields[f.key] = rest;
      continue;
    }

    // Línea de continuación del campo actual
    if (curField) {
      cur.fields[curField] = (cur.fields[curField] ? cur.fields[curField] + "\n" : "") + line;
    } else if (!cur.mi) {
      // línea suelta antes de cualquier campo: probablemente el MI sin etiqueta
      cur.mi = line.replace(/\*+/g, "").trim();
      const d = line.match(DATE_RE);
      if (d) cur.admission = d[1];
    }
  }
  push();

  return patients.map((p) => {
    // limpiar campos vacíos
    const fields = {};
    for (const [k, v] of Object.entries(p.fields)) {
      const t = (v || "").trim();
      if (t) fields[k] = t;
    }

    // Rescate del recuadro de TRATAMIENTO pegado al de ENFERMEDAD ACTUAL.
    //
    // En el Doc, EA y TTO son dos celdas de una tabla, una al lado de la otra.
    // Al exportarlo a texto plano las celdas quedan una detrás de la otra, y
    // como la celda de tratamiento casi nunca empieza con la etiqueta "TTO:",
    // el parser la venía tomando como continuación de EA. Resultado: pacientes
    // "sin tratamiento" que en realidad lo tenían, con la medicación escondida
    // adentro de la enfermedad actual (1.1, 1.4, 3.2 y 3.7 el 31/8).
    //
    // La celda de tratamiento arranca siempre igual: el peso y/o el aporte
    // nutricional (PESO 60 KG, PR 70 KG, RL 42 NE 100, NPT 84). Eso es lo que
    // se busca, y sólo cuando NO hay campo TTO propio, así que un pase bien
    // etiquetado nunca se toca.
    //
    // Importante para lo clínico: EA cuenta al paciente hasta que entra a la
    // UTI. Lo que pasa después son requerimientos e intercurrencias. Por eso
    // acá sólo se separa lo que es tratamiento; no se reinterpreta el resto.
    if (!fields.tto && fields.ea) {
      const ls = fields.ea.split("\n");
      const inicioTto = /^(PESO|PR)\b|^(NE|NPT|NTE|RL|SF|NXB)\s*\d/i;
      const corte = ls.findIndex((l) => inicioTto.test(l.trim()));
      if (corte > 0) {
        fields.tto = ls.slice(corte).join("\n");
        fields.ea = ls.slice(0, corte).join("\n");
      }
    }

    // Fallback: si no hay encabezado REQUERIMIENTOS, las líneas fechadas
    // al final de AP son en realidad las intercurrencias.
    if (!fields.req && fields.ap) {
      const ls = fields.ap.split("\n");
      const first = ls.findIndex((l) => /^\d{1,2}\/\d{1,2}\b/.test(l));
      if (first > 0) {
        fields.req = ls.slice(first).join("\n");
        fields.ap = ls.slice(0, first).join("\n");
      }
    }

    // Flags (colonizaciones, aislamientos) que vienen pegados al nombre
    const flags = [];
    let name = p.name || "";
    const colo = name.match(/COLONIZAD[OA][^*]*/i);
    if (colo) {
      flags.push(colo[0].replace(/[*\s]+$/, "").trim());
      name = name.replace(colo[0], "").replace(/[,.\s]+$/, "").trim();
    }

    // MI limpio, sin la etiqueta repetida
    const mi = (p.mi || "")
      .replace(/\bMI\b\s*:?\s*/gi, "")
      .replace(/^[:\-\s]+/, "")
      .trim();

    return { ...p, name, flags, mi, fields, status: lastStatusLine(fields.req) };
  });
}

// Devuelve la última línea de REQUERIMIENTOS (el estado más reciente)
function lastStatusLine(req) {
  if (!req) return "";
  const ls = req.split("\n").map((s) => s.trim()).filter(Boolean);
  return ls.length ? ls[ls.length - 1] : "";
}

export const FIELD_LABELS = Object.fromEntries(FIELDS.map((f) => [f.key, f.label]));
export const FIELD_ORDER = FIELDS.map((f) => f.key);
