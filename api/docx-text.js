import { inflateRawSync } from "node:zlib";

/* Lector mínimo de ZIP + extractor de texto de .docx.
   No usa librerías externas: un .docx es un ZIP y Node ya trae inflate. */

function findEOCD(buf) {
  // El "End of Central Directory" está al final; puede haber comentario.
  const start = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readZipEntry(buf, name) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error("No parece un archivo ZIP/DOCX válido");

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
      // Cabecera local: el tamaño de los campos varía, hay que releerlo
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`No se encontró ${name} dentro del documento`);
}

/** Convierte el buffer de un .docx en texto plano con saltos de línea. */
export function docxToText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const xml = readZipEntry(buf, "word/document.xml").toString("utf8");

  let t = xml;
  // Saltos de párrafo y de línea
  t = t.replace(/<w:p\b[^>]*\/>/g, "\n");
  t = t.replace(/<w:p\b[^>]*>/g, "\n");
  t = t.replace(/<w:br\b[^>]*\/?>/g, "\n");
  // Separar celdas de tabla para que no se peguen
  t = t.replace(/<\/w:tc>/g, "\n");
  // Tabuladores
  t = t.replace(/<w:tab\b[^>]*\/?>/g, " ");
  // Quitar el resto de las etiquetas
  t = t.replace(/<[^>]+>/g, "");
  // Entidades
  t = t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, "&");

  return t;
}
