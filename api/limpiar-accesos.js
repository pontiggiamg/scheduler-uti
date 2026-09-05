// Limpieza automática de access_logs de cuentas sin rol asignado.
//
// Por qué existe: cualquiera que abre la URL de la app queda registrado en
// access_logs, tenga rol o no — es lo que hace posible el panel de auditoría
// de la pestaña Accesos (ver src/vistas/accesos.jsx). Pero eso significa que
// alguien que entra una sola vez, por curiosidad o por error, y al que nunca
// se le va a asignar un rol, se queda ahí para siempre ensuciando la lista de
// "⚠️ Sin rol asignado" con gente que a nadie le interesa revisar.
//
// Esto borra esos registros cuando pasaron más de 48 hs desde el último
// ingreso de esa cuenta y sigue sin tener un documento en `cuentas` (es decir,
// sin rol). Una cuenta CON rol nunca pierde nada acá — su historial de
// accesos queda intacto, esto solo mira a quien nunca llegó a tener acceso.
//
// Se dispara solo, una vez por día, por el cron de vercel.json — nadie tiene
// que acordarse de correr esto a mano. También se puede disparar a mano
// abriendo la URL en el navegador (útil para probarlo), siempre que se le
// pase el secreto si CRON_SECRET está configurado.
//
// Seguridad: es un endpoint que BORRA datos, así que si existe la variable de
// entorno CRON_SECRET en Vercel, se exige un header
// "Authorization: Bearer <CRON_SECRET>" — que es exactamente el que Vercel
// manda solo cuando el pedido viene de su propio cron. Sin esa variable
// configurada, el endpoint queda abierto (igual que sync-pases.js y el resto
// de los endpoints de este proyecto), así que conviene configurarla:
// Vercel → Settings → Environment Variables → CRON_SECRET (cualquier texto
// largo al azar sirve, no hace falta que sea nada especial de Firebase).

import { adminDb } from "./_admin.js";

const CUARENTA_Y_OCHO_HS_MS = 48 * 60 * 60 * 1000;
const TAMANIO_LOTE = 450; // Firestore permite hasta 500 escrituras por batch; se deja margen.

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: "No autorizado." });
    }
  }

  try {
    const db = adminDb();
    const limite = new Date(Date.now() - CUARENTA_Y_OCHO_HS_MS).toISOString();

    // Quiénes tienen rol asignado ahora mismo: a esos no se les toca nada,
    // sin importar hace cuánto entraron.
    const cuentasSnap = await db.collection("cuentas").get();
    const conRol = new Set(cuentasSnap.docs.map((d) => d.id.toLowerCase()));

    // access_logs tiene un documento por CADA ingreso, así que puede haber
    // muchos de la misma cuenta sin rol. Se borran todos los que ya pasaron
    // las 48 hs, sean de la cuenta que sean — no hace falta quedarse con el
    // último para "recordar" que existió: si vuelve a entrar, va a generar un
    // registro nuevo y va a reaparecer en la lista, que es lo esperado.
    const logsSnap = await db.collection("access_logs").where("loginAt", "<", limite).get();

    const aBorrar = logsSnap.docs.filter((doc) => {
      const email = (doc.data().email || "").toLowerCase();
      return email && !conRol.has(email);
    });

    let borrados = 0;
    for (let i = 0; i < aBorrar.length; i += TAMANIO_LOTE) {
      const lote = db.batch();
      aBorrar.slice(i, i + TAMANIO_LOTE).forEach((doc) => lote.delete(doc.ref));
      await lote.commit();
      borrados += Math.min(TAMANIO_LOTE, aBorrar.length - i);
    }

    return res.status(200).json({ ok: true, revisados: logsSnap.size, borrados });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}