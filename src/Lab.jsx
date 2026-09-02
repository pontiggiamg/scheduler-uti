/* ══════════════════════════════════════════════════════════════════════════
   LABORATORIO — /lab-jr

   QUÉ ES ESTA RUTA
   ----------------
   El banco de pruebas del proyecto. Acá se prueba cualquier cosa nueva antes
   de que llegue a las pestañas que usa el plantel: funciona con los datos
   reales de Firestore, pero no está enlazada desde ningún menú, así que nadie
   se la cruza por accidente en medio de una guardia.

   La regla, decidida con Gonzalo el 1/9/2026: lo que está a medio hacer vive
   acá; a la app "de verdad" solo pasa lo que ya se probó. Una app que doce
   personas usan a las tres de la mañana no es lugar para experimentar.

   No es seguridad: cualquiera que adivine la URL entra. Es separación de
   ambientes, que es otra cosa y para esto alcanza.

   QUÉ SE ESTÁ CONSTRUYENDO ACÁ
   ----------------------------
   El 2/9/2026 Gonzalo eligió una de las cuatro apuestas que habíamos armado:
   EL MOTOR DE REGLAS. Las otras tres —el pase como acto médico, la jefatura
   sin memoria personal, y el producto multi-servicio— se descartaron y su
   texto salió del código; quedan en la conversación por si alguna vuelve.

   Por qué esa: es la única que ya tiene un cliente esperando con nombre y
   apellido. El JR de la UCO del Británico pidió lo mismo para su residencia,
   con reglas muy distintas pero las mismas funcionalidades. Si dar de alta un
   servicio nuevo requiere tocar código, no hay producto, hay un favor que se
   hace una vez. Todo lo demás se puede construir después encima del motor;
   al revés no, porque cada cosa heredaría las reglas de la UTI cableadas.

   CÓMO SE AGREGA UN EXPERIMENTO
   -----------------------------
   1. Un componente nuevo en su propio archivo (ver LabMotor.jsx de ejemplo).
   2. Se importa acá arriba.
   3. Se agrega una entrada a EXPERIMENTOS con su id, y se lo engancha abajo
      donde se elige qué mostrar.
   Nada de esto toca App.jsx ni las pestañas del plantel.
   ══════════════════════════════════════════════════════════════════════════ */

import { useState } from "react";
import LabMotor from "./LabMotor";

export const LAB_PATH = "/lab-jr";
export function isLabRoute() {
  if (typeof window === "undefined") return false;
  return window.location.pathname.replace(/\/+$/, "") === LAB_PATH;
}

const C = {
  tinta: "#0F172A", gris: "#64748B", borde: "#E2E8F0", fondo: "#F8FAFC",
  papel: "#fff", suave: "#F1F5F9",
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// Lo que hay en el banco. Cada entrada es una pantalla que se puede abrir.
// Para sumar otra: se agrega acá y se engancha en el switch de abajo.
const EXPERIMENTOS = [
  {
    id: "motor",
    nombre: "Motor de reglas",
    lema: "La app no sabe de UTI. Sabe de residencias.",
    color: "#1E3A5F",
    estado: "en construcción",
    resumen:
      "Las reglas del servicio dejan de estar escritas en el código y pasan a ser una configuración que se edita desde la app. El código pasa a ser un motor que las hace cumplir sin saber de qué servicio se trata. Se puede cambiar entre la UTI y la UCO y ver el mismo motor evaluando dos configuraciones distintas.",
    proximo:
      "Cuando el JR de la UCO pase sus reglas de verdad, escribirlas acá. Las que entren confirman el modelo; las que no entren dicen qué le falta al motor.",
  },
];

function Encabezado() {
  return (
    <div style={{ background: C.tinta, color: "#fff", borderRadius: 10, padding: "20px 22px", marginBottom: 16 }}>
      <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: ".14em", opacity: 0.6, marginBottom: 7 }}>
        LABORATORIO · /LAB-JR · NO ENLAZADO DESDE NINGUNA PESTAÑA
      </div>
      <div style={{ fontSize: 23, fontWeight: 800, letterSpacing: -0.4, marginBottom: 8 }}>
        Banco de pruebas
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.6, opacity: 0.85, maxWidth: 720 }}>
        Acá se prueba lo nuevo antes de que llegue a las pestañas que usa el plantel.
        Funciona con los datos reales, pero no aparece en ningún menú: nadie se lo cruza
        en medio de una guardia. Lo que está a medio hacer vive acá; a la app pasa
        solo lo que ya se probó.
      </div>
    </div>
  );
}

function Tarjeta({ e, abrir }) {
  return (
    <div style={{ background: C.papel, border: `1px solid ${C.borde}`, borderLeft: `4px solid ${e.color}`, borderRadius: 8, padding: "17px 19px", marginBottom: 11 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 17.5, fontWeight: 800, color: C.tinta, letterSpacing: -0.2 }}>{e.nombre}</div>
        <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".08em", textTransform: "uppercase", fontWeight: 700, color: e.color, background: `${e.color}14`, border: `1px solid ${e.color}33`, borderRadius: 4, padding: "2px 7px" }}>
          {e.estado}
        </span>
      </div>
      <div style={{ fontSize: 13.5, color: e.color, fontWeight: 600, marginTop: 4 }}>{e.lema}</div>

      <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "#334155", marginTop: 11 }}>{e.resumen}</div>

      {e.proximo && (
        <div style={{ background: C.suave, borderRadius: 6, padding: "10px 13px", marginTop: 12, borderLeft: `3px solid ${e.color}` }}>
          <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", color: e.color, fontWeight: 700, marginBottom: 4 }}>
            Lo que sigue
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.55, color: "#334155" }}>{e.proximo}</div>
        </div>
      )}

      <button onClick={abrir} style={{ marginTop: 14, background: e.color, color: "#fff", border: "none", borderRadius: 6, padding: "10px 17px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
        Abrir vista previa →
      </button>
    </div>
  );
}

export default function Lab() {
  const [viendo, setViendo] = useState(null);

  // Qué pantalla se abre. Un experimento nuevo se engancha acá.
  if (viendo === "motor") return <LabMotor volver={() => setViendo(null)} />;

  return (
    <div style={{ minHeight: "100vh", background: C.fondo, fontFamily: "'Inter', system-ui, sans-serif", color: C.tinta, padding: "20px 16px 60px" }}>
      <div style={{ maxWidth: 860, margin: "0 auto" }}>
        <Encabezado />

        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: C.gris, fontWeight: 700, marginBottom: 9 }}>
          En el banco ({EXPERIMENTOS.length})
        </div>

        {EXPERIMENTOS.map((e) => (
          <Tarjeta key={e.id} e={e} abrir={() => setViendo(e.id)} />
        ))}

        <div style={{ fontSize: 11.5, color: C.gris, marginTop: 18, lineHeight: 1.55, textAlign: "center" }}>
          Esta pantalla no está enlazada desde ninguna pestaña. Se llega sabiendo la dirección.
        </div>
      </div>
    </div>
  );
}
