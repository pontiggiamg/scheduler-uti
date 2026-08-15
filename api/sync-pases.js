import { initializeApp, getApps } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";
import { inflateRawSync } from "zlib";

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

const isHtml = (s) => /^\s*<(!doctype|html)/i.test(s.slice(0, 200));
const isZip = (buf) =>
  buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

function findEOCD(buf) {
  const start = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readZipEntry(buf, name) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error("No parece un ZIP válido");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const entryName = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (entryName === name) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`No se encontró ${name}`);
}

function docxToText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const xml = readZipEntry(buf, "word/document.xml").toString("utf8");
  let t = xml;
  t = t.replace(/<w:p\b[^>]*\/>/g, "\n");
  t = t.replace(/<w:p\b[^>]*>/g, "\n");
  t = t.replace(/<w:br\b[^>]*\/?>/g, "\n");
  t = t.replace(/<\/w:tc>/g, "\n");
  t = t.replace(/<w:tab\b[^>]*\/?>/g, " ");
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&");
  return t;
}

const FIELDS = [
  { key: "ap", re: /^AP\s*[:\-]/i },
  { key: "req", re: /^(REQUERIMIENTOS?\s*\/?\s*INTERCURRENCIAS?|INTERCURRENCIAS?\s*\/?\s*REQUERIMIENTOS?|REQ\s*\/\s*INTERCURRENCIAS?)/i },
  { key: "ea", re: /^EA\s*[:\-\s]/i },
  { key: "tto", re: /^TTO\b|^TRATAMIENTO\b/i },
  { key: "accesos", re: /^ACCESOS?\b/i },
  { key: "cultivos", re: /^CULTIVOS?\b/i },
  { key: "estudios", re: /^(COMPLEMENTARIOS?|ESTUDIOS?|EC\s*::?)/i },
  { key: "labo", re: /^(LABO|LAB)\b/i },
  { key: "eab", re: /^EAB\b/i },
  { key: "pendiente", re: /^PENDIENTES?\s*[:\-]?/i },
];

const BED_RE = /^(\d\.\d{1,2}|R\d{1,2}|UCO\s*\d{1,2})$/i;
const UNIT_RE = /^(UTI\s*\d|UCO|RECU)$/i;
const AGE_RE = /(\d{1,3})\s*A[ÑN]OS?/i;
const DATE_RE = /(\d{1,2}\/\d{1,2})/;

function cleanLine(s) {
  return s.replace(/\u00a0/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function fieldFor(line) {
  for (const f of FIELDS) if (f.re.test(line)) return f;
  return null;
}

function stripLabel(line, field) {
  return line.replace(field.re, "").replace(/^\s*[:\-]\s*/, "").trim();
}

function lastStatusLine(req) {
  if (!req) return "";
  const ls = req.split("\n").map((s) => s.trim()).filter(Boolean);
  return ls.length ? ls[ls.length - 1] : "";
}

function parsePase(raw, defaultUnit) {
  const lines = raw.split("\n").map(cleanLine);
  const patients = [];
  let unit = defaultUnit;
  let cur = null;
  let curField = null;

  const push = () => {
    if (!cur) return;
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

    if (!cur.name && !fieldFor(line) && !/^MI\b/i.test(line)) {
      const m = line.match(AGE_RE);
      if (m) {
        cur.age = parseInt(m[1], 10);
        cur.name = line.replace(AGE_RE, "").replace(/[,.\-\s]+$/, "").trim();
      } else {
        cur.name = line;
      }
      cur.name = cur.name.replace(/\*+/g, "").replace(/[,.\s]+$/, "").trim();
      continue;
    }

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

    if (curField) {
      cur.fields[curField] = (cur.fields[curField] ? cur.fields[curField] + "\n" : "") + line;
    } else if (!cur.mi) {
      cur.mi = line.replace(/\*+/g, "").trim();
      const d = line.match(DATE_RE);
      if (d) cur.admission = d[1];
    }
  }
  push();

  return patients.map((p) => {
    const fields = {};
    for (const [k, v] of Object.entries(p.fields)) {
      const t = (v || "").trim();
      if (t) fields[k] = t;
    }

    if (!fields.req && fields.ap) {
      const ls = fields.ap.split("\n");
      const first = ls.findIndex((l) => /^\d{1,2}\/\d{1,2}\b/.test(l));
      if (first > 0) {
        fields.req = ls.slice(first).join("\n");
        fields.ap = ls.slice(0, first).join("\n");
      }
    }

    const flags = [];
    let name = p.name || "";
    const colo = name.match(/COLONIZAD[OA][^*]*/i);
    if (colo) {
      flags.push(colo[0].replace(/[*\s]+$/, "").trim());
      name = name.replace(colo[0], "").replace(/[,.\s]+$/, "").trim();
    }

    const mi = (p.mi || "").replace(/\bMI\b\s*:?\s*/gi, "").replace(/^[:\-\s]+/, "").trim();

    return { ...p, name, flags, mi, fields, status: lastStatusLine(fields.req) };
  });
}

async function fetchDocText(docId) {
  const attempts = [
    `https://docs.google.com/document/d/${docId}/export?format=txt`,
    `https://docs.google.com/document/d/${docId}/export?format=docx`,
    `https://drive.google.com/uc?export=download&id=${docId}`,
  ];

  const problems = [];

  for (const url of attempts) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        problems.push(`HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());

      if (isZip(buf)) {
        const text = docxToText(buf);
        if (text.trim()) return text;
        problems.push("documento vacío");
        continue;
      }

      const text = buf.toString("utf8");
      if (isHtml(text)) {
        problems.push("Google devolvió una página de login");
        continue;
      }
      if (text.trim()) return text;
      problems.push("respuesta vacía");
    } catch (e) {
      problems.push(e.message || String(e));
    }
  }

  throw new Error(
    `No se pudo leer el documento (${problems.join(" · ")}). Revisar que esté compartido como "Cualquier persona con el enlace".`
  );
}

export default async function handler(req, res) {
  try {
    const started = Date.now();
    const units = {};
    const errors = [];

    for (const { fallbackUnit, docId } of DOCS) {
      if (!docId || docId.startsWith("PEGAR_ID")) {
        errors.push({ unit: fallbackUnit, error: "Falta configurar el ID del documento" });
        continue;
      }
      try {
        const raw = await fetchDocText(docId);
        const patients = parsePase(raw, fallbackUnit);
        for (const p of patients) {
          const u = p.unit || fallbackUnit;
          if (!units[u]) units[u] = [];
          units[u].push(p);
        }
        if (!patients.length) {
          errors.push({ unit: fallbackUnit, error: "El documento no tenía pacientes cargados" });
        }
      } catch (e) {
        errors.push({ unit: fallbackUnit, error: e.message || String(e) });
      }
    }

    for (const u of Object.keys(units)) {
      units[u].sort((a, b) =>
        a.bed.localeCompare(b.bed, "es", { numeric: true, sensitivity: "base" })
      );
    }

    const known = UNIT_ORDER.filter((u) => units[u]?.length);
    const extra = Object.keys(units).filter((u) => !UNIT_ORDER.includes(u));

    const payload = {
      updatedAt: new Date().toISOString(),
      unitOrder: [...known, ...extra],
      units,
      errors,
      totalPatients: Object.values(units).reduce((n, arr) => n + arr.length, 0),
    };

    await setDoc(doc(db, "scheduler", "pases-latest"), payload);

    return res.status(200).json({
      ok: true,
      ms: Date.now() - started,
      totalPatients: payload.totalPatients,
      units: Object.fromEntries(Object.entries(units).map(([k, v]) => [k, v.length])),
      errors,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message || String(e),
    });
  }
}
