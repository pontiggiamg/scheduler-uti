/* ══════════════════════════════════════════════════════════════════════════
   LA NUBE — todo lo que habla con Firestore pasa por acá

   POR QUÉ EXISTE ESTE ARCHIVO
   ---------------------------
   Hasta el 3/9/2026 cada pantalla se conectaba a la base por su cuenta, y
   —esto es lo importante— casi todas ignoraban el error. De 28 conexiones,
   21 tenían el manejo de falla vacío: `() => {}`, o como mucho "apagá el
   cartel de cargando". Cuando la base decía que no, la app no decía nada:
   mostraba la pantalla vacía, como si de verdad no hubiera datos.

   Eso no es una cuestión de prolijidad. Es la causa concreta de los dos
   peores problemas que tuvo la app:

     · 3/9/2026 — Nahuel y Ulloa vieron durante días "Actualizado nunca" y
       todos los meses en blanco. La base les estaba rechazando cada lectura
       por un agujero en las reglas, y la app se los mostró como si el
       servicio no tuviera cargado nada.

     · 2/9/2026 — se perdió una guardia entera de anotaciones. Las escrituras
       venían fallando y el único aviso era un cartel gris chiquito.

   En una app que se usa a las 3 de la mañana con pacientes reales, fallar en
   silencio es peor que fallar fuerte. Alguien que ve un error sabe que no
   puede confiar en lo que tiene delante; alguien que ve una pantalla vacía
   cree que está viendo la verdad.

   QUÉ HACE
   --------
   Dos cosas, nada más:

     1. `escuchar()` envuelve a onSnapshot y manda cualquier falla a un
        registro común. Reemplazar `onSnapshot(...)` por `escuchar(...)` en
        una pantalla alcanza para que sus errores dejen de ser invisibles.

     2. `<AvisoDeFallas />` se dibuja UNA vez arriba de todo y muestra lo que
        esté fallando en ese momento, en castellano y diciendo qué significa.
        Se limpia solo cuando la lectura vuelve a andar.

   Además vive acá `useGuardadoConEspera`, que es el patrón de "guardar sin
   mandar una escritura por tecla" que estaba copiado en cuatro pantallas
   distintas, cada una con sus propios bugs.
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from "react";
import { onSnapshot } from "firebase/firestore";

/* ── El registro de fallas ────────────────────────────────────────────────
   Un Map global (etiqueta → falla) más una lista de interesados. No usa
   Context a propósito: `escuchar()` se llama desde adentro de efectos y
   callbacks sueltos, donde no siempre hay un componente a mano. Un módulo
   simple funciona desde cualquier lado. */
const fallas = new Map();
const oyentes = new Set();

function avisarCambio() {
  // Se copia la lista antes de recorrerla: un oyente puede darse de baja
  // mientras se le avisa (React lo hace al desmontar), y modificar el Set
  // durante su propio recorrido se saltea elementos.
  [...oyentes].forEach((f) => f());
}

// Snapshot inmutable para useSyncExternalStore: tiene que devolver LA MISMA
// referencia mientras nada cambie, o React entra en un bucle de renders.
let instantanea = [];
function recalcular() {
  instantanea = [...fallas.entries()].map(([etiqueta, f]) => ({ etiqueta, ...f }));
  avisarCambio();
}

export function registrarFalla(etiqueta, error, tipo = "lectura") {
  const mensaje = (error && error.message) || String(error || "error desconocido");
  const previa = fallas.get(etiqueta);
  // Si ya estaba registrada la misma falla, no se recalcula: evita repintar
  // la pantalla en loop cuando Firestore reintenta y vuelve a fallar.
  if (previa && previa.mensaje === mensaje && previa.tipo === tipo) return;
  fallas.set(etiqueta, { mensaje, tipo, cuando: new Date().toISOString() });
  recalcular();
}

export function limpiarFalla(etiqueta) {
  if (!fallas.has(etiqueta)) return;
  fallas.delete(etiqueta);
  recalcular();
}

function suscribir(fn) {
  oyentes.add(fn);
  return () => oyentes.delete(fn);
}
const leerInstantanea = () => instantanea;

export function useFallas() {
  return useSyncExternalStore(suscribir, leerInstantanea, leerInstantanea);
}

/* ── escuchar: onSnapshot que no se traga los errores ─────────────────────

   Se usa igual que onSnapshot, con una etiqueta más:

     const unsub = escuchar(doc(db, "scheduler", "equipos"),
                            (snap) => { ... },
                            "los equipos del mes");

   La etiqueta se le muestra a la persona, así que se escribe como se lo
   diría en voz alta ("el pase del Drive", "las rotaciones de 2026"), no como
   nombre de colección.

   `alFallar` es opcional y corre ADEMÁS del registro, para lo que cada
   pantalla necesite hacer de su lado (típicamente apagar su "Cargando…").

   Con `etiqueta = null` la falla NO se muestra. Se usa a propósito para lo
   puramente cosmético —el orden en que están las pestañas, el numerito de
   solicitudes pendientes—: si eso no carga, la app se ve exactamente igual y
   nadie se queda sin ningún dato. Avisar de eso con el mismo cartel que usa
   "no se guardó lo que anotaste" convierte el cartel en ruido, y un cartel
   que grita por todo termina sin que nadie lo lea. */
export function escuchar(ref, alRecibir, etiqueta, alFallar) {
  if (!etiqueta) {
    return onSnapshot(ref, alRecibir, (e) => {
      console.error("escuchar (sin aviso):", e);
      if (alFallar) alFallar(e);
    });
  }

  const cortar = onSnapshot(
    ref,
    (snap) => {
      limpiarFalla(etiqueta);      // volvió a andar
      alRecibir(snap);
    },
    (e) => {
      console.error("escuchar:", etiqueta, e);
      registrarFalla(etiqueta, e, "lectura");
      if (alFallar) alFallar(e);
    }
  );

  /* Al desconectarse se borra la falla. Sin esto, una pantalla que falló y
     después se cerró (cambiar de pestaña la desmonta) dejaba su aviso colgado
     para siempre, hablando de algo que ya nadie está mirando. Si el problema
     sigue, la próxima vez que alguien abra esa pantalla vuelve a aparecer, y
     mientras tanto Firestore reintenta solo. */
  return () => {
    limpiarFalla(etiqueta);
    cortar();
  };
}

/* Lo mismo para una escritura suelta. Devuelve true/false para que quien
   llama pueda decidir, pero el aviso en pantalla ya sale solo. */
export async function escribir(promesa, etiqueta) {
  try {
    await promesa;
    limpiarFalla(etiqueta);
    return true;
  } catch (e) {
    console.error("escribir:", etiqueta, e);
    registrarFalla(etiqueta, e, "escritura");
    return false;
  }
}

/* ── El cartel ────────────────────────────────────────────────────────────
   Se dibuja una sola vez, arriba de todo. Si no hay nada fallando no ocupa
   ni un pixel. */
export function AvisoDeFallas() {
  const lista = useFallas();
  if (!lista.length) return null;

  const escrituras = lista.filter((f) => f.tipo === "escritura");
  const lecturas = lista.filter((f) => f.tipo === "lectura");

  // Que la base rechace por permisos tiene una causa y una solución
  // concretas, distintas de "se cortó internet". Vale la pena decirlo: la
  // primera vez que pasó, se perdieron tres días creyendo que la app estaba
  // vacía de datos.
  const hayPermisos = lista.some((f) => /permission|insufficient|PERMISSION_DENIED/i.test(f.mensaje));

  const grave = escrituras.length > 0;
  const c = grave
    ? { bg: "#FEF2F2", bd: "#FCA5A5", tx: "#7F1D1D", tit: "#991B1B" }
    : { bg: "#FFFBEB", bd: "#FDE68A", tx: "#78350F", tit: "#92400E" };

  return (
    <div className="no-print" style={{ background: c.bg, border: `1.5px solid ${c.bd}`, borderRadius: 10, padding: "10px 13px", marginBottom: 10, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ fontSize: 13.5, fontWeight: 800, color: c.tit, display: "flex", alignItems: "center", gap: 7 }}>
        <span>{grave ? "⛔" : "⚠️"}</span>
        {grave
          ? "Algo que escribiste no se está guardando"
          : "Hay datos que no pude traer — lo que ves puede estar incompleto"}
      </div>

      <div style={{ fontSize: 12.5, color: c.tx, lineHeight: 1.55, marginTop: 6 }}>
        {grave && <>No cierres la pestaña todavía. </>}
        {lecturas.length > 0 && (
          <>Esta pantalla <b>no está mostrando todo</b>: lo que falta abajo no se pudo leer, así que
          puede verse vacío sin estar vacío de verdad. </>
        )}
      </div>

      <ul style={{ margin: "7px 0 0 18px", padding: 0, fontSize: 12.5, color: c.tx, lineHeight: 1.6 }}>
        {lista.map((f) => (
          <li key={f.etiqueta}>
            {f.tipo === "escritura" ? "No se pudo guardar: " : "No se pudo leer: "}
            <b>{f.etiqueta}</b>
          </li>
        ))}
      </ul>

      {hayPermisos ? (
        <div style={{ fontSize: 12, color: c.tx, lineHeight: 1.55, marginTop: 8, background: "#fff", border: `1px solid ${c.bd}`, borderRadius: 6, padding: "8px 10px" }}>
          Esto <b>no es la conexión</b>: la base está rechazando el pedido por permisos. Se arregla en
          las reglas de Firestore, en la consola de Firebase. Avisale a Gonzalo y mostrale este cartel.
        </div>
      ) : (
        <div style={{ fontSize: 12, color: c.tx, marginTop: 7 }}>
          Si tenés señal, probá recargar la página. Si sigue igual, avisale a Gonzalo.
        </div>
      )}
    </div>
  );
}

/* ── Guardar con espera ───────────────────────────────────────────────────

   El patrón "no mandes una escritura por cada tecla" estaba escrito cuatro
   veces en App.jsx, una por pantalla, y cada copia tenía sus propios bugs.
   Acá está una sola vez.

   Devuelve { guardar, estado, forzar }:
     · guardar(datos)  → agenda la escritura dentro de `espera` ms
     · estado          → "idle" | "guardando" | "guardado" | "error"
     · forzar()        → escribe ya lo que haya pendiente (al cerrar la pestaña)

   Escribe solo si `puede` es true: así una pantalla de solo lectura no
   intenta guardar y no ensucia el cartel de fallas con permisos denegados.

   Fuerza la escritura pendiente cuando la pestaña se oculta. Va con
   "visibilitychange" y no con "beforeunload" porque en el celular cambiar de
   app no dispara beforeunload, y ese es justo el caso que hay que cubrir. */
export function useGuardadoConEspera(alGuardar, { etiqueta, puede = true, espera = 500, alSalirDeEmergencia } = {}) {
  const [estado, setEstado] = useState("idle");
  const pendiente = useRef(null);
  // Guarda el ÚLTIMO dato pasado a `guardar`, y no se borra cuando arranca la
  // escritura sino recién cuando esa escritura CONFIRMA. `pendiente` en
  // cambio se pone en null apenas el timer dispara (para permitir otro
  // guardar() mientras el anterior está en vuelo), incluso aunque el setDoc
  // siga sin terminar. Con espera=0 ese timer dispara casi al instante: si el
  // beacon de emergencia mirara `pendiente`, en la práctica siempre lo
  // encontraría vacío justo cuando más hace falta (comodín + F5 inmediato), y
  // nunca se mandaría — este es el bug que hizo que el primer intento de
  // arreglo no sirviera.
  const ultimoDato = useRef(null);
  const enVuelo = useRef(false);
  const timer = useRef(null);
  const limpiarEstado = useRef(null);
  // El callback se guarda en una ref y se refresca en cada render: si el
  // temporizador se quedara con la versión del primer render, escribiría con
  // datos viejos cuando por fin dispara (pasó exactamente eso en Pase App).
  const alGuardarRef = useRef(alGuardar);
  alGuardarRef.current = alGuardar;
  const alSalirDeEmergenciaRef = useRef(alSalirDeEmergencia);
  alSalirDeEmergenciaRef.current = alSalirDeEmergencia;

  const escribirYa = useCallback(async () => {
    const datos = pendiente.current;
    if (datos === null || datos === undefined) return;
    pendiente.current = null;
    enVuelo.current = true;
    setEstado("guardando");
    try {
      await alGuardarRef.current(datos);
      enVuelo.current = false;
      if (etiqueta) limpiarFalla(etiqueta);
      setEstado("guardado");
      clearTimeout(limpiarEstado.current);
      limpiarEstado.current = setTimeout(() => setEstado("idle"), 1600);
    } catch (e) {
      enVuelo.current = false;
      console.error("guardar:", etiqueta, e);
      setEstado("error");
      if (etiqueta) registrarFalla(etiqueta, e, "escritura");
    }
  }, [etiqueta]);

  // `esperaAhora` permite pisar la espera para un cambio puntual: tipear
  // texto libre quiere esperar más (para no escribir por tecla), y mover una
  // ficha de lugar quiere responder ya.
  const guardar = useCallback((datos, esperaAhora) => {
    if (!puede) return;
    pendiente.current = datos;
    ultimoDato.current = datos;
    clearTimeout(timer.current);
    timer.current = setTimeout(escribirYa, esperaAhora === undefined ? espera : esperaAhora);
  }, [puede, espera, escribirYa]);

  const forzar = useCallback(() => {
    clearTimeout(timer.current);
    escribirYa();
  }, [escribirYa]);

  useEffect(() => {
    // Al ocultarse la pestaña (F5, cerrar, cambiar de app) puede haber un
    // guardado pendiente o en vuelo que el setDoc normal de Firestore no
    // llegue a confirmar: el navegador corta esa conexión antes de que
    // termine. Por eso, además de `forzar()` (que sigue intentando el camino
    // normal, y puede alcanzar a completarse si el cierre tarda un poco), se
    // manda en paralelo un "beacon" — un envío que el navegador garantiza
    // entregar aunque la página se esté descargando en ese mismo instante —
    // cuando la pantalla que usa este hook definió cómo mandarlo
    // (`alSalirDeEmergencia`). No es un reemplazo del guardado normal, es una
    // red de contención para el instante exacto de cerrar/recargar.
    //
    // Se manda si hay algo pendiente TODAVÍA SIN empezar a escribir
    // (`pendiente`), o si ya empezó pero no confirmó (`enVuelo`) — este
    // segundo caso es justo el de "tocar comodín y F5 al toque" con espera 0:
    // el timer ya disparó y vació `pendiente`, pero el `await setDoc` de
    // adentro puede seguir sin terminar cuando el navegador corta la
    // conexión. `ultimoDato` siempre tiene el último valor real, esté o no
    // vacío `pendiente`.
    const alOcultar = () => {
      if (document.visibilityState !== "hidden") return;
      const hayAlgoPendiente = pendiente.current !== null && pendiente.current !== undefined;
      const hayAlgoEnVuelo = enVuelo.current && ultimoDato.current !== null && ultimoDato.current !== undefined;
      if (!hayAlgoPendiente && !hayAlgoEnVuelo) return;
      if (alSalirDeEmergenciaRef.current) {
        const datos = hayAlgoPendiente ? pendiente.current : ultimoDato.current;
        try { alSalirDeEmergenciaRef.current(datos); } catch (e) { console.error("beacon de emergencia:", etiqueta, e); }
      }
      forzar();
    };
    document.addEventListener("visibilitychange", alOcultar);
    window.addEventListener("pagehide", alOcultar);
    return () => {
      document.removeEventListener("visibilitychange", alOcultar);
      window.removeEventListener("pagehide", alOcultar);
      clearTimeout(timer.current);
      clearTimeout(limpiarEstado.current);
    };
  }, [forzar, etiqueta]);

  return { guardar, estado, forzar };
}

/* Cómo se muestra el estado del guardado, igual en todas las pantallas.
   Estaba escrito cuatro veces, casi igual pero no del todo: una decía
   "⚠ Error", otra "⚠ Sin conexión" para exactamente la misma situación. `b`
   es el fondo, que solo usa la cabecera oscura del cronograma. */
export const CARTEL_ESTADO = {
  guardando: { t: "Guardando…", c: "#CBD5E1", b: "rgba(255,255,255,.12)" },
  guardado: { t: "✓ Guardado", c: "#86EFAC", b: "rgba(34,197,94,.18)" },
  error: { t: "⚠ No se guardó", c: "#FCA5A5", b: "rgba(239,68,68,.18)" },
};
