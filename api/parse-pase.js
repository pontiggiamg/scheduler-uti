/* Parser de pases de UTI.

   El código de verdad vive en _parser.js, que es el único lugar donde se toca
   cómo se lee un pase. Este archivo existía con su propia copia completa y
   había que arreglar todo dos veces; ahora sólo reexporta.

   Ver el encabezado de _parser.js para la historia de por qué. */

import { parsePase, lastStatusLine, FIELDS, unidadDeCama, cleanLine, fieldFor, BED_RE, UNIT_RE } from "./_parser.js";

export { parsePase, lastStatusLine, FIELDS, unidadDeCama, cleanLine, fieldFor, BED_RE, UNIT_RE };

export const FIELD_LABELS = Object.fromEntries(FIELDS.map((f) => [f.key, f.label]));
export const FIELD_ORDER = FIELDS.map((f) => f.key);
