import { initializeApp, getApps } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";
import { inflateRawSync } from "zlib";

var firebaseConfig = {
  apiKey: "AIzaSyAHjLDpf9MZr8I6KA1sg3Ofr0GzN0IYENw",
  authDomain: "residencia-uti-hb.firebaseapp.com",
  projectId: "residencia-uti-hb",
  storageBucket: "residencia-uti-hb.firebasestorage.app",
  messagingSenderId: "404025159387",
  appId: "1:404025159337:web:eab539798b975a00dca6fe",
};

var app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
var db = getFirestore(app);

var DOCS = [
  { fallbackUnit: "Doc 1", docId: "1tI_qLk2KBzsuH9kvLEbXb1CHkEMiOynX" },
  { fallbackUnit: "Doc 2", docId: "1w3DmAlBp_YAaga6l-a4n2EPI-M-qGake" },
  { fallbackUnit: "Doc 3", docId: "1F8k_iEChO2Lfw0JhpnF7F9Gb2wj-7kp7" },
  { fallbackUnit: "Doc 4", docId: "1aqaYd9WC86REwTfKFWE5mJf96aMotUV4" },
];

var UNIT_ORDER = ["UTI 1", "UTI 2", "UTI 3", "UCO", "RECU"];

var FIELDS = [
  { key: "ap", re: /^AP\s*[:\-]/i },
  { key: "req", re: /^(REQUERIMIENTOS?\s*\/?INTERCURRENCIAS?|INTERCURRENCIAS?\s*\/?REQUERIMIENTOS?|REQ\s*\/\s*INTERCURRENCIAS?)/i },
  { key: "ea", re: /^EA\s*[:\-\s]/i },
  { key: "tto", re: /^TTO\b|^TRATAMIENTO\b/i },
  { key: "accesos", re: /^ACCESOS?\b/i },
  { key: "cultivos", re: /^CULTIVOS?\b/i },
  { key: "estudios", re: /^(COMPLEMENTARIOS?|ESTUDIOS?|EC\s*::?)/i },
  { key: "labo", re: /^(LABO|LAB)\b/i },
  { key: "eab", re: /^EAB\b/i },
  { key: "pendiente", re: /^PENDIENTES?\s*[:\-]?/i },
];

var BED_RE = /^(\d\.\d{1,2}|R\d{1,2}|UCO\s*\d{1,2})$/i;
/* El encabezado de la unidad adentro del documento. Se acepta con dos puntos,
   guion o una fecha al lado ("UTI 2:", "UTI 2 - 02/09"), porque el pase se
   escribe a mano y el encabezado se retoca seguido. Antes se exigía que el
   renglón dijera exactamente "UTI 2" y cualquier agregado lo volvía
   irreconocible. */
var UNIT_RE = /^(UTI\s*\d|UCO|RECU|TERAPIA\s*\d|RECUPERACI[OÓ]N)\s*[:\-–]?\s*(\d{1,2}\/\d{1,2}(\/\d{2,4})?)?$/i;

/* La unidad que le corresponde a una cama, leída del propio número: "2.5" es
   UTI 2, "R3" es RECU, "UCO 4" es UCO.

   Esto es lo que salva el pase cuando el encabezado del documento falta o
   está mal escrito. El 2/9/2026 alguien tocó el encabezado del documento de
   UTI 2 y la app mostró una pestaña llamada "Doc 3" con las camas 2.1 a 2.5
   adentro: el nombre de respaldo era una etiqueta interna, no una respuesta.
   El número de cama, en cambio, siempre está y no miente. */
/* Rellena las camas que faltan en el medio de una unidad.

   El documento del Drive lista solamente las camas OCUPADAS: si la 2.4 está
   vacía, simplemente no aparece, y en la app quedaba un salto de 2.3 a 2.5
   que se lee como si esa cama no existiera. Pero existe, está libre, y saber
   dónde hay lugar es información útil en el medio de una guardia.

   Se rellena entre la primera y la última cama que el documento sí nombra.
   Lo que NO se puede saber es si hay camas después de la última nombrada: si
   la unidad tiene seis camas y la 2.6 está vacía, el documento no la menciona
   en ningún lado y no hay de dónde deducirla. Para ese caso está el botón
   "+ Agregar cama" de la Pase App.

   Las camas rellenadas se marcan con vacia:true para que la app las muestre
   como libres y no como un paciente sin datos. */
function completarCamas(lista) {
  if (!lista || lista.length < 2) return lista;
  // Sólo se rellena si TODAS las camas de la unidad tienen la misma forma:
  // "2.n" todas, o "Rn" todas. Con formas mezcladas no hay una serie que
  // completar y meterse a inventar sería peor que dejar el hueco.
  var m0 = String(lista[0].bed || "").toUpperCase().match(/^(\d\.|R|UCO\s*)(\d+)$/);
  if (!m0) return lista;
  var prefijo = m0[1];
  var nums = [];
  for (var i = 0; i < lista.length; i++) {
    var m = String(lista[i].bed || "").toUpperCase().match(/^(\d\.|R|UCO\s*)(\d+)$/);
    if (!m || m[1] !== prefijo) return lista;      // formas mezcladas: no se toca
    nums.push(+m[2]);
  }
  var min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
  // Un rango absurdo (alguien escribió "2.99") no dispara cien camas vacías.
  if (max - min > 30) return lista;
  var unidad = lista[0].unit;
  var out = lista.slice();
  for (var n = min; n <= max; n++) {
    if (nums.indexOf(n) >= 0) continue;
    out.push({
      unit: unidad, bed: prefijo + n, name: "", age: null, mi: "",
      flags: [], fields: {}, status: "", vacia: true,
    });
  }
  out.sort(function (a, b) {
    var na = +String(a.bed).replace(/^(\d\.|R|UCO\s*)/i, "");
    var nb = +String(b.bed).replace(/^(\d\.|R|UCO\s*)/i, "");
    return na - nb;
  });
  return out;
}

function unidadDeCama(bed) {
  var b = String(bed || "").toUpperCase().replace(/\s+/g, "");
  var m = b.match(/^(\d)\./);
  if (m) return "UTI " + m[1];
  if (/^R\d/.test(b)) return "RECU";
  if (/^UCO/.test(b)) return "UCO";
  return null;
}
var AGE_RE = /(\d{1,3})\s*A[NY]OS?/i;
var DATE_RE = /(\d{1,2}\/\d{1,2})/;

function cleanLine(s) {
  return s.replace(/\u00a0/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function fieldFor(line) {
  for (var i = 0; i < FIELDS.length; i++) {
    if (FIELDS[i].re.test(line)) return FIELDS[i];
  }
  return null;
}

function lastStatusLine(req) {
  if (!req) return "";
  var ls = req.split("\n").map(function(s) { return s.trim(); }).filter(Boolean);
  return ls.length ? ls[ls.length - 1] : "";
}

function parsePase(raw, defaultUnit) {
  var lines = raw.split("\n").map(cleanLine);
  var patients = [];
  var unit = defaultUnit;
  // ¿El documento traía un encabezado de unidad de verdad? Si no, cada cama
  // decide su unidad por su propio número.
  var vioEncabezado = false;
  var cur = null;
  var curField = null;

  function push() {
    if (!cur) return;
    var hasContent = cur.name || Object.keys(cur.fields).some(function(k) { return cur.fields[k] && cur.fields[k].trim(); });
    if (hasContent) patients.push(cur);
    cur = null;
    curField = null;
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
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
      cur = { unit: (vioEncabezado ? unit : (unidadDeCama(line) || unit)), bed: line.toUpperCase().replace(/\s+/g, ""), name: "", age: null, mi: "", flags: [], fields: {} };
      curField = null;
      continue;
    }

    if (!cur) continue;

    if (!cur.name && !fieldFor(line) && !/^MI\b/i.test(line)) {
      var m = line.match(AGE_RE);
      if (m) {
        cur.age = parseInt(m[1], 10);
        cur.name = line.replace(AGE_RE, "").replace(/[,.\-\s]+$/, "").trim();
      } else {
        cur.name = line;
      }
      cur.name = cur.name.replace(/\*+/g, "").replace(/[,.\s]+$/, "").trim();
      var colo = cur.name.match(/COLONIZAD[OA][^*]*/i);
      if (colo) {
        cur.flags.push(colo[0].replace(/[*\s]+$/, "").trim());
        cur.name = cur.name.replace(colo[0], "").replace(/[,.\s]+$/, "").trim();
      }
      continue;
    }

    if (!cur.mi && /\bMI\b\s*[:\-]/i.test(line)) {
      cur.mi = line.replace(/\bMI\b\s*:?\s*/gi, "").replace(/^[:\-\s]+/, "").trim();
      curField = null;
      continue;
    }

    var f = fieldFor(line);
    if (f) {
      curField = f.key;
      cur.fields[f.key] = line.replace(f.re, "").replace(/^\s*[:\-]\s*/, "").trim();
      continue;
    }

    if (curField) {
      cur.fields[curField] = (cur.fields[curField] ? cur.fields[curField] + "\n" : "") + line;
    } else if (!cur.mi) {
      cur.mi = line.replace(/\bMI\b\s*:?\s*/gi, "").replace(/^[:\-\s]+/, "").trim();
    }
  }
  push();

  return patients.map(function(p) {
    var fields = {};
    Object.keys(p.fields).forEach(function(k) {
      var t = (p.fields[k] || "").trim();
      if (t) fields[k] = t;
    });
    // Rescate del recuadro de TRATAMIENTO pegado al de ENFERMEDAD ACTUAL.
    // En el Doc son dos celdas de una tabla; al pasar a texto plano quedan
    // una detrás de la otra y, como la de tratamiento casi nunca trae la
    // etiqueta "TTO:", se venía leyendo como continuación de EA. La celda de
    // tratamiento arranca siempre con el peso o el aporte nutricional.
    // Sólo se aplica si no hay campo TTO propio. (Ver api/parse-pase.js.)
    if (!fields.tto && fields.ea) {
      var lsEa = fields.ea.split("\n");
      var inicioTto = /^(PESO|PR)\b|^(NE|NPT|NTE|RL|SF|NXB)\s*\d/i;
      var corte = -1;
      for (var ci = 0; ci < lsEa.length; ci++) {
        if (inicioTto.test(lsEa[ci].trim())) { corte = ci; break; }
      }
      if (corte > 0) {
        fields.tto = lsEa.slice(corte).join("\n");
        fields.ea = lsEa.slice(0, corte).join("\n");
      }
    }

    if (!fields.req && fields.ap) {
      var ls = fields.ap.split("\n");
      var first = -1;
      for (var i = 0; i < ls.length; i++) {
        if (/^\d{1,2}\/\d{1,2}\b/.test(ls[i])) { first = i; break; }
      }
      if (first > 0) {
        fields.req = ls.slice(first).join("\n");
        fields.ap = ls.slice(0, first).join("\n");
      }
    }
    return { unit: p.unit, bed: p.bed, name: p.name, age: p.age, flags: p.flags, mi: p.mi, fields: fields, status: lastStatusLine(fields.req) };
  });
}

function findEOCD(buf) {
  var start = Math.max(0, buf.length - 65557);
  for (var i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readZipEntry(buf, name) {
  var eocd = findEOCD(buf);
  if (eocd < 0) throw new Error("ZIP invalido");
  var count = buf.readUInt16LE(eocd + 10);
  var off = buf.readUInt32LE(eocd + 16);
  for (var i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    var method = buf.readUInt16LE(off + 10);
    var compSize = buf.readUInt32LE(off + 20);
    var nameLen = buf.readUInt16LE(off + 28);
    var extraLen = buf.readUInt16LE(off + 30);
    var commentLen = buf.readUInt16LE(off + 32);
    var localOff = buf.readUInt32LE(off + 42);
    var entryName = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (entryName === name) {
      var lNameLen = buf.readUInt16LE(localOff + 26);
      var lExtraLen = buf.readUInt16LE(localOff + 28);
      var dataStart = localOff + 30 + lNameLen + lExtraLen;
      var raw = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("No se encontro " + name);
}

function docxToText(buffer) {
  var buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  var xml = readZipEntry(buf, "word/document.xml").toString("utf8");
  var t = xml;
  t = t.replace(/<w:p\b[^>]*\/>/g, "\n");
  t = t.replace(/<w:p\b[^>]*>/g, "\n");
  t = t.replace(/<w:br\b[^>]*\/?>/g, "\n");
  t = t.replace(/<\/w:tc>/g, "\n");
  t = t.replace(/<w:tab\b[^>]*\/?>/g, " ");
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  return t;
}

function isHtml(s) { return /^\s*<(!doctype|html)/i.test(s.slice(0, 200)); }
function isZip(buf) { return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04; }

async function fetchDocText(docId) {
  var urls = [
    "https://docs.google.com/document/d/" + docId + "/export?format=txt",
    "https://docs.google.com/document/d/" + docId + "/export?format=docx",
    "https://drive.google.com/uc?export=download&id=" + docId,
  ];
  var problems = [];
  for (var i = 0; i < urls.length; i++) {
    try {
      var res = await fetch(urls[i], { redirect: "follow" });
      if (!res.ok) { problems.push("HTTP " + res.status); continue; }
      var buf = Buffer.from(await res.arrayBuffer());
      if (isZip(buf)) {
        var text = docxToText(buf);
        if (text.trim()) return text;
        problems.push("vacio");
        continue;
      }
      var txt = buf.toString("utf8");
      if (isHtml(txt)) { problems.push("no publico"); continue; }
      if (txt.trim()) return txt;
      problems.push("respuesta vacia");
    } catch (e) {
      problems.push(e.message);
    }
  }
  throw new Error(problems.join(" | "));
}

export default async function handler(req, res) {
  try {
    var started = Date.now();
    var units = {};
    var errors = [];

    for (var i = 0; i < DOCS.length; i++) {
      var d = DOCS[i];
      try {
        var raw = await fetchDocText(d.docId);
        var patients = parsePase(raw, d.fallbackUnit);
        for (var j = 0; j < patients.length; j++) {
          var p = patients[j];
          var u = p.unit || d.fallbackUnit;
          if (!units[u]) units[u] = [];
          units[u].push(p);
        }
        if (!patients.length) errors.push({ unit: d.fallbackUnit, error: "sin pacientes" });
      } catch (e) {
        errors.push({ unit: d.fallbackUnit, error: e.message });
      }
    }

    // Las camas libres del medio se agregan acá, una vez que ya está armada
    // la lista completa de cada unidad.
    Object.keys(units).forEach(function (u) { units[u] = completarCamas(units[u]); });

    var known = UNIT_ORDER.filter(function(u) { return units[u] && units[u].length; });
    var extra = Object.keys(units).filter(function(u) { return UNIT_ORDER.indexOf(u) < 0; });

    var payload = {
      updatedAt: new Date().toISOString(),
      unitOrder: known.concat(extra),
      units: units,
      errors: errors,
      totalPatients: Object.keys(units).reduce(function(n, k) { return n + units[k].length; }, 0),
    };

    await setDoc(doc(db, "scheduler", "pases-latest"), payload);

    return res.status(200).json({
      ok: true,
      ms: Date.now() - started,
      totalPatients: payload.totalPatients,
      units: Object.keys(units).reduce(function(o, k) { o[k] = units[k].length; return o; }, {}),
      errors: errors,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}