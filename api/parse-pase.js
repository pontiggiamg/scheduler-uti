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
const UNIT_RE = /^(UTI\s*\d|UCO|RECU)$/i;

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
      unit = line.toUpperCase().replace(/\s+/g, " ");
      continue;
    }

    if (BED_RE.test(line)) {
      push();
      const bed = line.toUpperCase().replace(/\s+/g, "");
      cur = { unit, bed, name: "", age: null, mi: "", fields: {} };
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
