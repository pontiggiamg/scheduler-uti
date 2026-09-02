/* ══════════════════════════════════════════════════════════════════════════
   MOTOR DE REGLAS — el proyecto elegido (2/9/2026)

   Hoy las reglas de la UTI viven adentro del código de App.jsx. Están bien
   escritas y comentadas, pero están cableadas: "el mínimo son 2 por sala",
   "el día libre del R4 solo lunes, miércoles o viernes", "el R4 postguardia
   va acompañado". Para que la UCO use esto, hay que abrir App.jsx y
   reescribirlas. Eso no es un producto: es un favor que se hace una vez.

   Este prototipo invierte la relación. Las reglas pasan a ser DATOS —un
   documento que se lee y se edita— y el código pasa a ser un motor que las
   evalúa sin saber de qué servicio se trata. La prueba de fuego, y por eso
   está acá abajo escrita de verdad: dar de alta la UCO no debería requerir
   un solo commit, solo un archivo de configuración.

   Lo que se puede tocar en esta pantalla es real: al cambiar un número, las
   violaciones se recalculan de verdad contra una semana de ejemplo. No es
   una maqueta con datos pintados.

   Lo que NO está resuelto y hay que decirlo: acá las reglas son de tipos
   fijos (mínimos, topes, prohibiciones). Una regla que no entre en esos
   tipos —"Dani postguardia va con otro superior"— sigue necesitando código.
   Un motor totalmente general es otro proyecto, y probablemente uno malo:
   configurar la UTI terminaría siendo más trabajo que programarla.
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useMemo } from "react";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/* ── Las dos configuraciones ───────────────────────────────────────────────
   Esto es lo que hoy está en el código y acá pasa a ser un documento. En la
   versión de verdad viviría en Firestore, un documento por servicio, y se
   editaría desde una pantalla como ésta. */

const CONFIGS = {
  uti: {
    nombre: "Terapia Intensiva",
    hospital: "Británico",
    color: "#1E3A5F",
    // Los niveles y quién los ocupa. La UTI arranca en R2: no hay R1.
    niveles: [
      { id: "R2", rot: "R2", superior: false },
      { id: "R3", rot: "R3", superior: true },
      { id: "R4", rot: "R4", superior: true },
    ],
    plantel: {
      R2: ["Maca", "Andy", "Nata", "Nahuel"],
      R3: ["Chris", "Ulloa", "Varoli", "Gian"],
      R4: ["Dani", "Caro", "Leo", "Vani"],
    },
    // Las áreas que hay que cubrir cada día hábil.
    areas: [
      { id: "uti1", label: "UTI 1", minimo: 2, ideal: 3, pideSuperior: true },
      { id: "uti2", label: "UTI 2", minimo: 2, ideal: 2, pideSuperior: true },
      { id: "uti3", label: "UTI 3", minimo: 2, ideal: 2, pideSuperior: true },
      { id: "recu", label: "Recuperatoria", minimo: 2, ideal: 2, pideSuperior: true },
    ],
    guardia: { porDia: 2, pideSuperior: true, findeSeguidoProhibido: true },
    diaLibre: {
      nivel: "R4",
      diasPermitidos: ["Lunes", "Miércoles", "Viernes"],
      topePorDia: { Lunes: 1, Miércoles: 2, Viernes: 1 },
    },
  },

  uco: {
    nombre: "Unidad Coronaria",
    hospital: "Británico",
    color: "#6B4423",
    // Inventada a propósito para probar el motor: plantel más chico, tres
    // niveles distintos, dos áreas en vez de cuatro, una sola guardia.
    // Cuando el JR de la UCO diga sus reglas de verdad, se cambian acá y
    // nada más. Ese es justamente el punto.
    niveles: [
      { id: "R1", rot: "R1", superior: false },
      { id: "R2", rot: "R2", superior: false },
      { id: "R3", rot: "R3", superior: true },
    ],
    plantel: {
      R1: ["Ejemplo 1", "Ejemplo 2"],
      R2: ["Ejemplo 3", "Ejemplo 4"],
      R3: ["Ejemplo 5", "Ejemplo 6"],
    },
    areas: [
      { id: "uco", label: "UCO", minimo: 2, ideal: 3, pideSuperior: true },
      { id: "inter", label: "Intermedios", minimo: 1, ideal: 2, pideSuperior: false },
    ],
    guardia: { porDia: 1, pideSuperior: true, findeSeguidoProhibido: false },
    diaLibre: {
      nivel: "R3",
      diasPermitidos: ["Martes", "Jueves"],
      topePorDia: { Martes: 1, Jueves: 1 },
    },
  },
};

/* ── El motor ──────────────────────────────────────────────────────────────
   No sabe qué es una UTI. Recibe una configuración y una semana, y devuelve
   qué se está incumpliendo. Es la misma función para los dos servicios: esa
   es toda la idea. */

function evaluar(cfg, semana) {
  const duras = [], suaves = [];
  const nivelDe = (persona) => {
    for (const [niv, gente] of Object.entries(cfg.plantel))
      if (gente.includes(persona)) return niv;
    return null;
  };
  const esSuperior = (persona) => {
    const n = cfg.niveles.find((x) => x.id === nivelDe(persona));
    return !!(n && n.superior);
  };

  semana.forEach((dia) => {
    if (dia.habil) {
      cfg.areas.forEach((area) => {
        const gente = dia.areas[area.id] || [];
        if (gente.length < area.minimo) {
          duras.push({ dia: dia.nombre, texto: `${area.label} con ${gente.length || "nadie"} — el mínimo son ${area.minimo}` });
        } else if (area.pideSuperior && !gente.some(esSuperior)) {
          const sup = cfg.niveles.filter((n) => n.superior).map((n) => n.id).join(" ni ");
          duras.push({ dia: dia.nombre, texto: `${area.label} sin ningún ${sup} (${gente.join(", ")})` });
        }
        if (gente.length >= area.minimo && gente.length < area.ideal) {
          suaves.push({ dia: dia.nombre, texto: `${area.label} con ${gente.length} — lo ideal son ${area.ideal}` });
        }
      });
    }

    const g = dia.guardia || [];
    if (g.length !== cfg.guardia.porDia) {
      duras.push({ dia: dia.nombre, texto: `Guardia con ${g.length} — tienen que ser ${cfg.guardia.porDia}` });
    } else if (cfg.guardia.pideSuperior && !g.some(esSuperior)) {
      duras.push({ dia: dia.nombre, texto: `Guardia sin ningún superior (${g.join(", ")})` });
    }
  });

  // Día libre: qué días se puede y cuántos por día.
  const porDia = {};
  Object.entries(semana[0]?.diasLibres || {}).forEach(([persona, d]) => {
    (porDia[d] = porDia[d] || []).push(persona);
  });
  Object.entries(porDia).forEach(([d, gente]) => {
    const dl = cfg.diaLibre;
    if (!dl.diasPermitidos.includes(d)) {
      duras.push({ dia: d, texto: `Día libre en ${d.toLowerCase()} (${gente.join(", ")}) — solo se puede ${dl.diasPermitidos.join(", ").toLowerCase()}` });
    } else if (gente.length > (dl.topePorDia[d] ?? 1)) {
      duras.push({ dia: d, texto: `${gente.length} con día libre el ${d.toLowerCase()} — el tope es ${dl.topePorDia[d]}` });
    }
  });

  return { duras, suaves };
}

/* ── Una semana de ejemplo, generada según la configuración ────────────── */
function semanaEjemplo(cfg, romper) {
  const dias = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
  const todos = Object.values(cfg.plantel).flat();
  const superiores = cfg.niveles.filter((n) => n.superior).flatMap((n) => cfg.plantel[n.id] || []);
  let i = 0;
  const sig = () => todos[i++ % todos.length];

  return dias.map((nombre, di) => {
    const habil = di < 5;
    const areas = {};
    if (habil) {
      cfg.areas.forEach((a, ai) => {
        // Se arma cumpliendo el ideal, con un superior adelante.
        const cuantos = romper && ai === 0 && di === 0 ? 1 : a.ideal;
        const gente = [];
        if (a.pideSuperior && !(romper && ai === 1 && di === 1)) gente.push(superiores[(di + ai) % superiores.length]);
        while (gente.length < cuantos) { const p = sig(); if (!gente.includes(p)) gente.push(p); }
        areas[a.id] = gente;
      });
    }
    const guardia = [];
    while (guardia.length < cfg.guardia.porDia) {
      const p = di === 2 && romper ? todos[0] : superiores[(di + guardia.length) % superiores.length];
      if (!guardia.includes(p)) guardia.push(p); else guardia.push(sig());
    }
    const diasLibres = {};
    if (di === 0) {
      const nivel = cfg.plantel[cfg.diaLibre.nivel] || [];
      nivel.slice(0, 2).forEach((p, k) => {
        diasLibres[p] = romper && k === 1 ? "Jueves" : cfg.diaLibre.diasPermitidos[k % cfg.diaLibre.diasPermitidos.length];
      });
    }
    return { nombre, habil, areas, guardia, diasLibres };
  });
}

/* ── Pantalla ─────────────────────────────────────────────────────────── */

const caja = { background: "#fff", border: "1px solid #E2E8F0", borderRadius: 8, padding: 16 };
const rot = { fontFamily: MONO, fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", color: "#64748B", fontWeight: 700 };

export default function LabMotor({ volver }) {
  const [cual, setCual] = useState("uti");
  const [cfg, setCfg] = useState(CONFIGS.uti);
  const [romper, setRomper] = useState(false);

  const cambiar = (k) => { setCual(k); setCfg(JSON.parse(JSON.stringify(CONFIGS[k]))); };
  const semana = useMemo(() => semanaEjemplo(cfg, romper), [cfg, romper]);
  const { duras, suaves } = useMemo(() => evaluar(cfg, semana), [cfg, semana]);

  const editarArea = (id, campo, valor) =>
    setCfg((c) => ({ ...c, areas: c.areas.map((a) => (a.id === id ? { ...a, [campo]: Math.max(0, +valor || 0) } : a)) }));

  const num = { width: 52, fontFamily: MONO, fontSize: 13.5, padding: "4px 6px", border: "1.5px solid #E2E8F0", borderRadius: 4, textAlign: "right" };

  return (
    <div style={{ minHeight: "100vh", background: "#F8FAFC", fontFamily: "'Inter', system-ui, sans-serif", color: "#0F172A", padding: "18px 16px 60px" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <button onClick={volver} style={{ background: "none", border: "none", color: "#64748B", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit", padding: 0, marginBottom: 12 }}>← Volver al banco de pruebas</button>

        <div style={{ background: cfg.color, color: "#fff", borderRadius: 10, padding: "18px 20px", marginBottom: 14 }}>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".14em", opacity: 0.65, marginBottom: 6 }}>BANCO DE PRUEBAS · MOTOR DE REGLAS</div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.3 }}>La app no sabe de UTI. Sabe de residencias.</div>
          <div style={{ fontSize: 13, lineHeight: 1.55, opacity: 0.88, marginTop: 8, maxWidth: 660 }}>
            Cambiá de servicio con los botones de abajo. Es el <b>mismo motor</b> evaluando
            dos configuraciones distintas: otro plantel, otras áreas, otras guardias, otro
            día libre. No hay una línea de código que diga "UTI" ni "UCO".
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {Object.entries(CONFIGS).map(([k, c]) => (
            <button key={k} onClick={() => cambiar(k)}
              style={{ padding: "9px 16px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
                border: `1.5px solid ${cual === k ? c.color : "#E2E8F0"}`, background: cual === k ? c.color : "#fff", color: cual === k ? "#fff" : "#475569" }}>
              {c.nombre}
              <span style={{ fontFamily: MONO, fontSize: 10, opacity: 0.75, marginLeft: 7 }}>
                {Object.values(c.plantel).flat().length} residentes
              </span>
            </button>
          ))}
          <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "#475569", cursor: "pointer" }}>
            <input type="checkbox" checked={romper} onChange={(e) => setRomper(e.target.checked)} />
            Meter errores a propósito
          </label>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 12 }}>
          <div style={caja}>
            <div style={{ ...rot, marginBottom: 10 }}>La configuración · se puede tocar</div>
            {cfg.areas.map((a) => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: "1px solid #F1F5F9" }}>
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{a.label}</span>
                <span style={{ fontSize: 11, color: "#64748B" }}>mín</span>
                <input type="number" value={a.minimo} onChange={(e) => editarArea(a.id, "minimo", e.target.value)} style={num} />
                <span style={{ fontSize: 11, color: "#64748B" }}>ideal</span>
                <input type="number" value={a.ideal} onChange={(e) => editarArea(a.id, "ideal", e.target.value)} style={num} />
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: "1px solid #F1F5F9" }}>
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>Guardia por día</span>
              <input type="number" value={cfg.guardia.porDia}
                onChange={(e) => setCfg((c) => ({ ...c, guardia: { ...c.guardia, porDia: Math.max(0, +e.target.value || 0) } }))} style={num} />
            </div>
            <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 10, lineHeight: 1.5 }}>
              Tocá cualquier número: las violaciones de la derecha se recalculan solas.
              En la versión de verdad esto vive en Firestore, un documento por servicio.
            </div>
          </div>

          <div style={caja}>
            <div style={{ ...rot, marginBottom: 10 }}>
              Lo que el motor encuentra
              <span style={{ marginLeft: 8, fontFamily: MONO, color: duras.length ? "#B91C1C" : "#15803D" }}>
                {duras.length} duras · {suaves.length} avisos
              </span>
            </div>
            {duras.length === 0 && suaves.length === 0 && (
              <div style={{ fontSize: 13, color: "#15803D", padding: "8px 0" }}>La semana cumple todas las reglas de este servicio.</div>
            )}
            {duras.map((v, i) => (
              <div key={"d" + i} style={{ fontSize: 12.5, color: "#7F1D1D", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 5, padding: "6px 9px", marginBottom: 5 }}>
                <b style={{ fontFamily: MONO, fontSize: 10.5 }}>{v.dia}</b> · {v.texto}
              </div>
            ))}
            {suaves.map((v, i) => (
              <div key={"s" + i} style={{ fontSize: 12.5, color: "#8A4B00", background: "#FFF6E5", border: "1px solid #E9C48A", borderRadius: 5, padding: "6px 9px", marginBottom: 5 }}>
                <b style={{ fontFamily: MONO, fontSize: 10.5 }}>{v.dia}</b> · {v.texto}
              </div>
            ))}
          </div>
        </div>

        <div style={{ ...caja, marginTop: 12 }}>
          <div style={{ ...rot, marginBottom: 9 }}>La semana que se está evaluando</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%", minWidth: 560 }}>
              <thead>
                <tr>
                  <th style={{ ...rot, textAlign: "left", padding: "5px 8px" }}>Día</th>
                  {cfg.areas.map((a) => <th key={a.id} style={{ ...rot, textAlign: "left", padding: "5px 8px" }}>{a.label}</th>)}
                  <th style={{ ...rot, textAlign: "left", padding: "5px 8px" }}>Guardia</th>
                </tr>
              </thead>
              <tbody>
                {semana.map((d) => (
                  <tr key={d.nombre} style={{ borderTop: "1px solid #F1F5F9", background: d.habil ? "#fff" : "#F8FAFC" }}>
                    <td style={{ padding: "6px 8px", fontWeight: 700, whiteSpace: "nowrap" }}>{d.nombre}</td>
                    {cfg.areas.map((a) => (
                      <td key={a.id} style={{ padding: "6px 8px", color: "#475569" }}>{d.habil ? (d.areas[a.id] || []).join(", ") : "—"}</td>
                    ))}
                    <td style={{ padding: "6px 8px", color: "#475569" }}>{(d.guardia || []).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ ...caja, marginTop: 12, borderLeft: `4px solid ${cfg.color}` }}>
          <div style={{ ...rot, marginBottom: 8, color: cfg.color }}>Lo que todavía NO resuelve</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "#334155" }}>
            Las reglas de acá son de tipos fijos: mínimos, ideales, topes, cuántos por día.
            Con eso alcanza para la mayoría, pero no para todo. <b>"Dani postguardia va
            acompañado de otro superior"</b> no entra en ninguna casilla, y hoy sigue
            necesitando código. Lo mismo la regla que vos mismo escribiste: <i>"es su arreglo,
            en esos casos las reglas no cuentan"</i> — un motor que no sepa aceptar una
            excepción acordada entre dos residentes va a estar peleado con el servicio.
            <br /><br />
            Ese es el límite honesto de esto, y también su prueba de fuego: cuando
            el JR de la UCO te pase sus reglas de verdad, el ejercicio es escribirlas acá.
            Las que entren confirman el modelo. Las que no entren dicen qué le falta al motor
            — y eso se averigua en una tarde, no en tres meses.
          </div>
        </div>
      </div>
    </div>
  );
}
