import { inflateRawSync } from "zlib";
import { parsePase } from "./_parser.js";
import { adminDb } from "./_admin.js";

/* Este endpoint usa el SDK de ADMINISTRADOR, no el del navegador.

   Antes usaba el del cliente, sin ningún usuario: escribía como un visitante
   anónimo, y por eso las reglas de Firestore tenían que dejar abierto el
   documento del pase para que alguien pudiera escribirlo sin estar logueado.
   Con la credencial de servicio el servidor se identifica y esa excepción ya
   no hace falta. */

var DOCS = [
  { fallbackUnit: "Doc 1", docId: "1tI_qLk2KBzsuH9kvLEbXb1CHkEMiOynX" },
  { fallbackUnit: "Doc 2", docId: "1w3DmAlBp_YAaga6l-a4n2EPI-M-qGake" },
  { fallbackUnit: "Doc 3", docId: "1F8k_iEChO2Lfw0JhpnF7F9Gb2wj-7kp7" },
  { fallbackUnit: "Doc 4", docId: "1aqaYd9WC86REwTfKFWE5mJf96aMotUV4" },
];

var UNIT_ORDER = ["UTI 1", "UTI 2", "UTI 3", "UCO", "RECU"];

/* El parser vive en _parser.js, una sola copia para los dos endpoints.
   Antes este archivo tenía la suya y cada arreglo había que hacerlo dos
   veces; llegaron a divergir de verdad. Ver _parser.js. */

/* ── Las camas de cada unidad ─────────────────────────────────────────────
   El documento del Drive lista SOLAMENTE las camas ocupadas: una cama vacía
   no aparece por ningún lado. Para poder mostrarla como libre hay que saber
   que existe, y eso el documento no lo dice.

   Por eso el padrón está escrito acá. Confirmado con Gonzalo el 2/9/2026.

   Antes se intentaba deducirlo rellenando los huecos entre la primera y la
   última cama nombrada. Eso encontraba la 2.4 entre la 2.3 y la 2.5, pero no
   las de los extremos: si R5 estaba vacía, RECU parecía terminar en R4, y si
   la 1.1 estaba vacía, UTI 1 parecía empezar en la 1.2. Justamente las dos
   que faltaban.

   Si alguna vez se abre o se cierra una cama, se cambia este número. */
var CAMAS_POR_UNIDAD = {
  "UTI 1": 8,
  "UTI 2": 5,
  "UTI 3": 9,
  "RECU": 5,
};

// Cómo se escribe la cama número n de una unidad: "1.4", "R3", "UCO 2".
function nombreDeCama(unidad, n) {
  var m = String(unidad).toUpperCase().match(/^UTI\s*(\d)/);
  if (m) return m[1] + "." + n;
  if (/^RECU/i.test(unidad)) return "R" + n;
  if (/^UCO/i.test(unidad)) return "UCO " + n;
  return String(n);
}

/* Agrega las camas que la unidad tiene y el Drive no nombró, porque estaban
   vacías. Quedan marcadas con vacia:true para que la app las muestre como
   libres y no como un paciente sin datos. */
function completarCamas(lista, unidad) {
  var total = CAMAS_POR_UNIDAD[unidad];
  if (!total) return lista;                 // unidad que no conocemos: no se toca

  var ocupadas = {};
  for (var i = 0; i < lista.length; i++) {
    var b = String(lista[i].bed || "").toUpperCase().replace(/\s+/g, "");
    var mm = b.match(/^(?:\d\.|R|UCO)(\d+)$/);
    if (mm) ocupadas[+mm[1]] = true;
  }

  var out = lista.slice();
  for (var n = 1; n <= total; n++) {
    if (ocupadas[n]) continue;
    out.push({
      unit: unidad, bed: nombreDeCama(unidad, n), name: "", age: null, mi: "",
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
    Object.keys(units).forEach(function (u) { units[u] = completarCamas(units[u], u); });

    var known = UNIT_ORDER.filter(function(u) { return units[u] && units[u].length; });
    var extra = Object.keys(units).filter(function(u) { return UNIT_ORDER.indexOf(u) < 0; });

    var payload = {
      updatedAt: new Date().toISOString(),
      unitOrder: known.concat(extra),
      units: units,
      errors: errors,
      totalPatients: Object.keys(units).reduce(function(n, k) { return n + units[k].length; }, 0),
    };

    await adminDb().collection("scheduler").doc("pases-latest").set(payload);

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