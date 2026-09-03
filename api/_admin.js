/* ══════════════════════════════════════════════════════════════════════════
   LA CREDENCIAL DEL SERVIDOR

   Los endpoints que corren en Vercel —el sync del pase, el resumen de
   artículos— escriben en Firestore sin ningún usuario detrás: no hay nadie
   logueado del otro lado. Hasta el 2/9/2026 lo hacían con el SDK del cliente,
   que es el mismo que usa el navegador, y por eso hubo que dejarles abierto
   un documento en las reglas: cualquiera con el ID del proyecto podía
   sobreescribir el resumen del pase.

   Con el SDK de administrador el servidor se identifica con una credencial
   propia y pasa por encima de las reglas de seguridad. Eso permite cerrarlas
   del todo: ya no hace falta ninguna excepción.

   CÓMO SE CONFIGURA
   -----------------
   Hace falta una variable de entorno en Vercel llamada FIREBASE_SERVICE_ACCOUNT
   con el contenido del archivo JSON que genera Firebase en
   Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada.

   Si esa variable no está, estos endpoints avisan con un error claro en vez
   de fallar de una forma difícil de diagnosticar. Es a propósito: un sync que
   no anda tiene que decir por qué.

   ESA CLAVE ES UN SECRETO
   -----------------------
   Da acceso total a la base, saltándose las reglas. Va en Vercel y en ningún
   otro lado: nunca en el repositorio, nunca en el código, nunca en un mensaje.
   Si alguna vez se filtra, se revoca desde la misma pantalla de Firebase y se
   genera una nueva.
   ══════════════════════════════════════════════════════════════════════════ */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

let dbCache = null;

export function adminDb() {
  if (dbCache) return dbCache;

  const crudo = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!crudo) {
    throw new Error(
      "Falta la variable FIREBASE_SERVICE_ACCOUNT en Vercel. " +
      "Se genera en Firebase → Configuración del proyecto → Cuentas de servicio " +
      "→ Generar nueva clave privada, y se pega entera como variable de entorno."
    );
  }

  let cuenta;
  try {
    cuenta = JSON.parse(crudo);
  } catch (e) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT no es un JSON válido. Tiene que ser el contenido " +
      "completo del archivo que descarga Firebase, incluidas las llaves de apertura y cierre."
    );
  }

  // Vercel guarda los saltos de línea de la clave privada como "\\n" literal.
  // Sin esto la credencial se rechaza con un error de firma que no dice nada
  // sobre la causa real.
  if (typeof cuenta.private_key === "string") {
    cuenta.private_key = cuenta.private_key.replace(/\\n/g, "\n");
  }

  const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(cuenta) });
  dbCache = getFirestore(app);
  return dbCache;
}
