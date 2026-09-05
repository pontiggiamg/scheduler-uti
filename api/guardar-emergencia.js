// Guarda "de emergencia" el cronograma de la semana cuando el navegador va a
// cerrar o recargar la página con un cambio sin confirmar todavía (por
// ejemplo, tocar un comodín y apretar F5 al toque).
//
// Por qué existe: el guardado normal usa el SDK de cliente de Firestore
// (setDoc), que abre su propia conexión (websocket / long-polling). Cuando la
// pestaña se cierra o recarga, el navegador puede cortar esa conexión antes
// de que el setDoc llegue a confirmarse en el servidor — el intento de
// guardado arrancó, pero nunca terminó. navigator.sendBeacon() está hecho
// exactamente para este momento: encola un POST simple que el navegador
// garantiza enviar incluso mientras la página se está descargando, sin
// esperar respuesta. Este endpoint es el que recibe ese POST y hace la
// escritura real en Firestore con el SDK de administrador (ver _admin.js),
// porque sendBeacon no puede hablar directo con el SDK de Firestore ni
// mandar el token de autenticación de Google del usuario.
//
// Seguridad: sendBeacon no permite mandar el token de Firebase Auth como
// header, así que este endpoint no puede verificar "quién" escribe de la
// misma forma que las reglas de Firestore normales. Para no abrir un agujero,
// se restringe fuerte lo que puede hacer:
//   · Solo puede escribir en la colección "scheduler" (los cronogramas de
//     semana), nunca en pase_guardia, usuarios_autorizados, etc.
//   · El id del documento tiene que matchear el patrón de una semana
//     (week-AAAA-MM-DD) — nunca "pases-latest" ni cualquier otro doc.
//   · Solo permite MERGE (combinar), nunca reemplazar el documento entero:
//     así, en el peor caso de un beacon corrupto o repetido, lo más que
//     puede pasar es que se sobreescriban un par de campos de esa semana,
//     nunca que se borre el resto.
//
// Config necesaria en Vercel: la misma FIREBASE_SERVICE_ACCOUNT que ya usan
// sync-pases.js y resumen-articulo.js (ver _admin.js).

import { adminDb } from "./_admin.js";

const IDPATTERN = /^week-\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método no permitido, usá POST." });
  }

  try {
    // sendBeacon manda el body como texto plano (Blob), no como JSON parseado
    // por Vercel automáticamente en todos los casos — se parsea a mano por
    // las dudas de que llegue como string.
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const docId = typeof body.docId === "string" ? body.docId : "";
    const datos = body.datos;

    if (!IDPATTERN.test(docId)) {
      return res.status(400).json({ ok: false, error: "docId inválido: solo se acepta el patrón week-AAAA-MM-DD." });
    }
    if (!datos || typeof datos !== "object" || Array.isArray(datos)) {
      return res.status(400).json({ ok: false, error: "Falta 'datos' o no es un objeto." });
    }

    await adminDb().collection("scheduler").doc(docId).set(datos, { merge: true });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
