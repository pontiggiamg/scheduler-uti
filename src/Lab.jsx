/* ══════════════════════════════════════════════════════════════════════════
   LABORATORIO — cuatro apuestas sobre qué debería ser esta herramienta

   Vive en una ruta que no figura en ninguna pestaña ni en ningún menú: hay
   que saber la URL. No es seguridad —cualquiera que la adivine entra— pero
   alcanza para que no aparezca sola mientras se decide.

   Qué es esto y qué NO es. Son cuatro PROTOTIPOS: la pantalla principal de
   cada apuesta, funcionando con los datos reales de Firestore, cada una con
   una tesis distinta sobre dónde está el valor. No son cuatro productos
   terminados, y esa es la idea: el objetivo es que Gonzalo mate tres y
   construyamos bien el que sobreviva. Hacer cuatro apps completas antes de
   decidir cuál sirve es la forma más cara de equivocarse.

   Las cuatro apuestas salen de investigar la evidencia, no de la intuición.
   Los tres hallazgos que las moldearon:

   1) I-PASS (NEJM 2014, 10.700 admisiones, 9 hospitales) redujo los errores
      médicos 23% y los eventos adversos prevenibles 30%, SIN alargar el pase.
      Lo que más creció en esos estudios fue el handoff ESCRITO, que es
      justamente lo que la Pase App ya hace. Falta la estructura.

   2) La ley 26.529 art. 13 exige que la historia clínica informatizada
      garantice inalterabilidad y control de modificaciones. Un campo que se
      sobrescribe sin dejar rastro no cumple. Eso vuelve la trazabilidad un
      requisito legal, no una prolijidad.

   3) El JR de la UCO ya pidió lo mismo con reglas distintas. Ese es el
      hallazgo más importante y no salió de ningún paper: el producto no es
      la app de la UTI, es el motor que sirve para cualquier residencia. La
      prueba de fuego es que dar de alta la UCO no requiera un solo commit.
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

const APUESTAS = [
  {
    id: "motor",
    n: "01",
    nombre: "El motor de reglas",
    lema: "La app no sabe de UTI. Sabe de residencias.",
    color: "#1E3A5F",
    tesis:
      "Hoy las reglas de la UTI están escritas en el código: cuántas guardias por semana, que el R4 postguardia va acompañado, que nadie hace dos fines de semana seguidos. Para que la UCO use esto, alguien tiene que reescribir el código. Esta apuesta invierte eso: las reglas pasan a ser un documento que se edita desde la app, y el código pasa a ser un motor que las hace cumplir sin saber de qué servicio se trata.",
    porque:
      "Es la única apuesta que responde al hecho de que ya hay un segundo cliente esperando. El JR de la UCO no necesita otra app: necesita ésta con otras reglas. Si dar de alta un servicio nuevo requiere tocar código, no hay producto, hay un favor que se hace una vez.",
    riesgo:
      "Es la más difícil de las cuatro y la que menos se luce: si sale bien, se ve exactamente igual que ahora. El riesgo real es hacer un motor tan general que configurar la UTI sea más trabajo que programarla.",
    contra:
      "Antes de construirlo, tomá las reglas de la UCO y escribilas en el formato de configuración. Si no entran, el modelo está mal y es mejor saberlo en una tarde que en tres meses.",
  },
  {
    id: "pase",
    n: "02",
    nombre: "El pase como acto médico",
    lema: "Lo único que la app hace mejor que el papel: recordar quién dijo qué.",
    color: "#6B4423",
    tesis:
      "El pase deja de ser un texto que se pisa y pasa a ser una secuencia de asientos con autor y hora, imborrables. Estructura I-PASS sobre lo que ya existe: gravedad del paciente, resumen, lista de acciones, qué puede pasar y qué hacer si pasa, y la síntesis de quien recibe. Nada se borra: se agrega.",
    porque:
      "I-PASS bajó los errores 23% y los eventos adversos prevenibles 30% sin alargar el pase, y el componente que más creció fue el handoff escrito, que es lo que ya tenés. Además, la ley 26.529 art. 13 exige inalterabilidad con control de modificaciones para la historia clínica informatizada: esta apuesta es la única que convierte una obligación legal en una función.",
    riesgo:
      "Es la apuesta que toca terreno clínico y regulatorio serio. Si el pase de la app se vuelve documento médico, hereda todas las obligaciones de una historia clínica: diez años de guarda, derecho del paciente a pedir copia en 48 horas, auditoría. Eso es una decisión institucional, no de producto.",
    contra:
      "Preguntale al comité de docencia o a legales del hospital si el pase de la app se considera historia clínica. La respuesta cambia el proyecto entero, y es gratis averiguarla.",
  },
  {
    id: "jefatura",
    n: "03",
    nombre: "La jefatura sin memoria personal",
    lema: "Que el próximo JR no empiece de cero.",
    color: "#3F5F3A",
    tesis:
      "Todo lo que hoy vive en tu cabeza —quién debe guardias, quién viene cansado, qué se acordó con quién, qué pasó el verano pasado— pasa a estar registrado y a la vista. La app deja de ser una planilla y pasa a ser la memoria del cargo: cuando entregás la jefatura, entregás también el criterio.",
    porque:
      "El estudio de AIMS mostró que armar cronogramas automáticamente subió el cumplimiento de preferencias del 30% al 80% en residentes, y que lo que más mejoró fue la equidad PERCIBIDA. Eso sugiere que el valor no está en el algoritmo sino en que el proceso sea legible y defendible. Un JR que puede mostrar por qué le tocó a cada uno discute menos.",
    riesgo:
      "Registrar 'quién viene cansado' o 'qué se acordó' es información sobre personas, y en una residencia eso es delicado. Mal hecho, se convierte en un legajo de conducta y nadie lo usa. Es la apuesta con más riesgo humano y menos riesgo técnico.",
    contra:
      "Andá a la regla que vos mismo estableciste: 'es su arreglo, en esos casos las reglas no cuentan'. Cualquier sistema que no sepa registrar un acuerdo entre dos residentes por fuera de la regla va a estar peleado con la realidad del servicio.",
  },
  {
    id: "producto",
    n: "04",
    nombre: "El producto",
    lema: "Que otro servicio pueda usarla sin que vos estés.",
    color: "#4A3B63",
    tesis:
      "Cada servicio es un inquilino con sus datos aislados, su jefe, su plantel y sus reglas. Alta de un servicio nuevo sin programar. Panel para vos como proveedor: qué servicios hay, cuánto se usan, quién quedó trabado. Es la apuesta que trata a la herramienta como algo que se vende, no que se presta.",
    porque:
      "Es la traducción directa de lo que pediste: seguir siendo dueño de esto cuando termine tu jefatura. Y hay un requisito legal atrás: la ley 25.326 trata los datos de salud como sensibles, así que el aislamiento entre instituciones deja de ser prolijidad y pasa a ser obligación. Una fuga de la UTI hacia la UCO sería un incidente reportable.",
    riesgo:
      "Es la que más rápido choca contra lo que no se resuelve programando. Al vender a otra institución cambiás de rol jurídico: pasás a ser encargado del tratamiento de datos sensibles ajenos, con contrato, y con exigencias sobre dónde se alojan los datos. Eso necesita un abogado, no un mejor commit.",
    contra:
      "Antes de escribir una línea, averiguá qué pide el hospital para que un sistema de terceros toque datos de sus pacientes. Si la respuesta es que tiene que estar alojado adentro, la arquitectura entera cambia.",
  },
];

function Encabezado() {
  return (
    <div style={{ background: C.tinta, color: "#fff", borderRadius: 10, padding: "20px 22px", marginBottom: 18 }}>
      <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: ".14em", opacity: 0.6, marginBottom: 7 }}>
        LABORATORIO · NO ENLAZADO DESDE NINGUNA PESTAÑA
      </div>
      <div style={{ fontSize: 23, fontWeight: 800, letterSpacing: -0.4, marginBottom: 8 }}>
        Cuatro apuestas sobre qué debería ser esto
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.6, opacity: 0.85, maxWidth: 720 }}>
        Cada una parte de una idea distinta sobre dónde está el valor. No son cuatro versiones
        de lo mismo: son cuatro respuestas a la pregunta de qué estás construyendo. La idea es
        que descartes tres. Cada ficha dice la apuesta, por qué la haría, qué puede salir mal
        y qué averiguarías antes de invertir tiempo.
      </div>
    </div>
  );
}

function Ficha({ a, abierta, alClick, verProto }) {
  return (
    <div style={{ background: C.papel, border: `1px solid ${C.borde}`, borderLeft: `4px solid ${a.color}`, borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
      <div onClick={alClick} style={{ padding: "15px 18px", cursor: "pointer", display: "flex", gap: 14, alignItems: "flex-start" }}>
        <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 700, color: a.color, opacity: 0.45, lineHeight: 1 }}>{a.n}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16.5, fontWeight: 800, color: C.tinta, letterSpacing: -0.2 }}>{a.nombre}</div>
          <div style={{ fontSize: 13, color: a.color, fontWeight: 600, marginTop: 3 }}>{a.lema}</div>
        </div>
        <div style={{ color: C.gris, fontSize: 12, transform: abierta ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▼</div>
      </div>

      {abierta && (
        <div style={{ padding: "0 18px 16px 46px" }}>
          {[["La apuesta", a.tesis], ["Por qué la haría", a.porque], ["Qué puede salir mal", a.riesgo]].map(([r, t]) => (
            <div key={r} style={{ marginBottom: 13 }}>
              <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", color: C.gris, fontWeight: 700, marginBottom: 4 }}>{r}</div>
              <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "#334155" }}>{t}</div>
            </div>
          ))}
          <div style={{ background: C.suave, borderRadius: 6, padding: "11px 13px", borderLeft: `3px solid ${a.color}` }}>
            <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", color: a.color, fontWeight: 700, marginBottom: 4 }}>
              Lo que averiguaría antes de construirla
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: "#334155" }}>{a.contra}</div>
          </div>

          {verProto && (
            <button onClick={verProto} style={{ marginTop: 13, background: a.color, color: "#fff", border: "none", borderRadius: 6, padding: "10px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              Ver el prototipo funcionando →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Lab() {
  const [abierta, setAbierta] = useState("motor");
  const [viendo, setViendo] = useState(null);

  // Prototipos navegables. Por ahora está el de la apuesta 01; los otros
  // tres se ven como ficha hasta que Gonzalo diga cuál vale la pena.
  if (viendo === "motor") return <LabMotor volver={() => setViendo(null)} />;

  return (
    <div style={{ minHeight: "100vh", background: C.fondo, fontFamily: "'Inter', system-ui, sans-serif", color: C.tinta, padding: "20px 16px 60px" }}>
      <div style={{ maxWidth: 860, margin: "0 auto" }}>
        <Encabezado />

        {APUESTAS.map((a) => (
          <Ficha key={a.id} a={a} abierta={abierta === a.id}
            alClick={() => setAbierta(abierta === a.id ? null : a.id)}
            verProto={a.id === "motor" ? () => setViendo("motor") : null} />
        ))}

        <div style={{ background: C.papel, border: `1px solid ${C.borde}`, borderRadius: 8, padding: "16px 18px", marginTop: 16 }}>
          <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", color: C.gris, fontWeight: 700, marginBottom: 8 }}>
            Lo que diría si tuviera que elegir una
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.65, color: "#334155" }}>
            La <b>01</b>, el motor de reglas, y no por elegancia técnica: porque es la única
            que ya tiene un cliente esperando con nombre y apellido. El JR de la UCO no
            necesita otra app, necesita ésta con otras reglas. Todo lo demás —el pase
            estructurado, la memoria de la jefatura, el panel de proveedor— se puede
            construir después <i>encima</i> del motor. Al revés no: si crecen las tres
            primero, cada una hereda las reglas de la UTI cableadas adentro y sacarlas
            después cuesta el triple.
            <br /><br />
            Y hay algo que ninguna de las cuatro resuelve y conviene decir de frente: lo que
            hace valiosa a esta herramienta no es el código, que cualquiera replica en unos
            meses. Es que entendés el problema desde adentro, que ya la usan doce personas
            todos los días, y que el segundo cliente te buscó a vos. Eso no se programa.
          </div>
        </div>

        <div style={{ fontSize: 11.5, color: C.gris, marginTop: 16, lineHeight: 1.55, textAlign: "center" }}>
          Esta pantalla no está enlazada desde ninguna pestaña. Se llega sabiendo la dirección.
        </div>
      </div>
    </div>
  );
}
