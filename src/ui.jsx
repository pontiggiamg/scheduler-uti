/* ══════════════════════════════════════════════════════════════════════════
   Las piezas visuales que se repiten

   Los ladrillos con los que estan hechas casi todas las pantallas: la ficha
   de un residente, una celda de la grilla, un cartel. Estan una sola vez
   para que la app se vea igual en todos lados.
   ══════════════════════════════════════════════════════════════════════════ */

import { useState } from "react";
import { COLOR, LEVEL, SKIN_JR, SLOTS } from "./config";
import { dm } from "./fechas";
import { esResidente } from "./modelo";

const TabBtn = ({ active, onClick, children, draggable, dragging, dropTarget, badge, onDragStart, onDragEnter, onDragOver, onDrop, onDragEnd }) => (
  <button
    onClick={onClick}
    draggable={draggable}
    onDragStart={onDragStart}
    onDragEnter={onDragEnter}
    onDragOver={onDragOver}
    onDrop={onDrop}
    onDragEnd={onDragEnd}
    title={draggable ? "Arrastrá para reordenar" : undefined}
    style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 22px", fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: draggable ? "grab" : "pointer", background: active ? "#0F172A" : "#E2E8F0", color: active ? "#fff" : "#64748B", border: "none", borderRadius: "10px 10px 0 0", transition: "all .15s", letterSpacing: 0.1, opacity: dragging ? 0.4 : 1, boxShadow: dropTarget ? "inset 3px 0 0 #3B82F6" : "none" }}
  >
    {children}
    {badge > 0 && <span style={{ fontSize: 10, fontWeight: 800, background: "#DC2626", color: "#fff", borderRadius: 999, padding: "1px 7px", minWidth: 18, textAlign: "center" }}>{badge}</span>}
  </button>
);

/* ══════════════════ SCHEDULER VIEW ══════════════════ */

// Chip compacto para la fila "De guardia" del calendario. Coloreado por nivel
// si es residente, gris si es alguien de afuera (planta, otro servicio).
const ChipGuardia = ({ name }) => {
  const c = esResidente(name) ? COLOR[LEVEL[name]] : { bg: "#F1F5F9", bd: "#CBD5E1", tx: "#475569", solid: "#94A3B8" };
  const esJefe = LEVEL[name] === "JR";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2.5px 6px", borderRadius: 6, background: c.bg, border: `1.5px solid ${c.bd}`, color: c.tx, fontWeight: 600, fontSize: 10.5, lineHeight: 1.25, ...(esJefe ? SKIN_JR : {}) }}>
      {LEVEL[name] === "JR" && "👑"}
      {name}
      <span style={{ fontSize: 7, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: esJefe ? "rgba(69,26,3,.55)" : c.solid, color: "#fff", textShadow: "none" }}>{esResidente(name) ? LEVEL[name] : "—"}</span>
    </span>
  );
};

function downloadCSV(filename, headers, rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Panel compacto: una barra que dice cuántas alertas hay y se despliega. Si
// está todo bien, una línea verde discreta. Nunca bloquea nada.
function PanelAlertas({ duras, suaves }) {
  const [abierto, setAbierto] = useState(false);
  const total = duras.length + suaves.length;

  if (total === 0) {
    return (
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", marginBottom: 10, borderRadius: 10, background: "#F0FDF4", border: "1px solid #BBF7D0", fontSize: 11, color: "#15803D", fontWeight: 600 }}>
        ✓ La semana cumple todas las reglas
      </div>
    );
  }

  return (
    <div className="no-print" style={{ marginBottom: 10 }}>
      <button onClick={() => setAbierto((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px", borderRadius: 10, background: duras.length ? "#FEF2F2" : "#FFFBEB", border: `1px solid ${duras.length ? "#FECACA" : "#FDE68A"}`, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
        <span style={{ display: "inline-block", transform: abierto ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 10, color: "#64748B" }}>▶</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: duras.length ? "#991B1B" : "#92400E", flex: 1 }}>
          {duras.length > 0 && `${duras.length} ${duras.length === 1 ? "regla incumplida" : "reglas incumplidas"}`}
          {duras.length > 0 && suaves.length > 0 && " · "}
          {suaves.length > 0 && `${suaves.length} ${suaves.length === 1 ? "sugerencia" : "sugerencias"}`}
        </span>
        <span style={{ fontSize: 10, color: "#64748B" }}>{abierto ? "ocultar" : "ver detalle"}</span>
      </button>

      {abierto && (
        <div style={{ marginTop: 6, background: "#fff", borderRadius: 10, border: "1px solid #E2E8F0", overflow: "hidden" }}>
          {[["No se puede romper", duras, "#DC2626", "#FEF2F2"], ["Lo ideal sería", suaves, "#B45309", "#FFFBEB"]]
            .filter(([, lista]) => lista.length > 0)
            .map(([titulo, lista, color, bg]) => (
              <div key={titulo}>
                <div style={{ fontSize: 9.5, fontWeight: 800, color, background: bg, padding: "5px 12px", letterSpacing: 0.3, textTransform: "uppercase" }}>{titulo}</div>
                {lista.map((a, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, padding: "6px 12px", borderTop: i === 0 ? "none" : "1px solid #F8FAFC", fontSize: 11.5 }}>
                    <span style={{ color: "#64748B", minWidth: 92, fontWeight: 600 }}>{a.dia}</span>
                    <span style={{ color: "#334155", flex: 1 }}>{a.texto}</span>
                  </div>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════ EQUIPOS POR UTI (por mes) ══════════════════ */

const MenuItem = ({ children, onClick, danger }) => (<button onClick={onClick} style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", border: "none", background: "transparent", fontSize: 12.5, fontFamily: "inherit", cursor: "pointer", color: danger ? "#DC2626" : "#334155", fontWeight: 500 }} onMouseEnter={(e) => (e.currentTarget.style.background = danger ? "#FEF2F2" : "#F8FAFC")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>{children}</button>);

const Banner = ({ tone, children }) => { const c = tone === "warn" ? { bg: "#FEF2F2", bd: "#FECACA", tx: "#991B1B", icon: "⛔" } : { bg: "#EFF6FF", bd: "#BFDBFE", tx: "#1E40AF", icon: "👆" }; return (<div style={{ display: "flex", alignItems: "center", gap: 7, background: c.bg, border: `1px solid ${c.bd}`, color: c.tx, padding: "6px 12px", borderRadius: 9, fontSize: 12, fontWeight: 500 }}><span>{c.icon}</span><span>{children}</span></div>); };

const Corner = () => (<div style={{ background: "#F8FAFC", borderBottom: "2px solid #E2E8F0", borderRight: "2px solid #E2E8F0" }} />);

const DayHead = ({ name, date, isToday, isWeekend, feriado }) => (<div style={{ padding: "9px 4px", textAlign: "center", background: feriado ? "#FEF3C7" : isToday ? "#EFF6FF" : isWeekend ? "#F1F5F9" : "#F8FAFC", borderBottom: "2px solid #E2E8F0", borderRight: "1px solid #F1F5F9" }}><div style={{ fontWeight: 700, fontSize: 12.5, color: feriado ? "#92400E" : isToday ? "#1D4ED8" : isWeekend ? "#94A3B8" : "#0F172A" }}>{name}</div><div style={{ fontSize: 10.5, color: feriado ? "#B45309" : isToday ? "#3B82F6" : "#94A3B8", fontWeight: isToday ? 700 : 500 }}>{dm(date)}</div>{feriado && <div style={{ fontSize: 8, fontWeight: 800, color: "#92400E", background: "#FDE68A", borderRadius: 999, padding: "1px 6px", marginTop: 2, display: "inline-block", letterSpacing: 0.3 }}>🎌 FERIADO</div>}</div>);

const RowLabel = ({ label, color, sub, fondo, className }) => (<div className={className} style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end", textAlign: "right", padding: "8px 10px", background: "#F8FAFC", borderRight: "2px solid #E2E8F0", borderBottom: "2px solid #D1D5DB", borderTop: "2px solid #D1D5DB" }}><div style={{ fontWeight: 700, fontSize: 11, color, letterSpacing: 0.1 }}>{label}</div>{sub && <div style={{ fontSize: 8.5, color: "#64748B", marginTop: 1 }}>{sub}</div>}</div>);

const Cell = ({ children, onClick, tint, ring, pad = 4, lastCol, lastRow, className }) => (<div className={className} onClick={onClick} style={{ padding: pad, minHeight: 46, display: "flex", flexDirection: "column", gap: 3, background: tint, borderRight: lastCol ? "none" : "1px solid #F1F5F9", borderBottom: lastRow ? "none" : "1px solid #F1F5F9", boxShadow: ring ? `inset 0 0 0 1.5px ${ring}66` : "none", cursor: ring ? "pointer" : "default", transition: "background .12s, box-shadow .12s" }}>{children}</div>);

function Chip({ name, selected, onPick, onRemove, alerta }) {
  const lv = LEVEL[name]; const c = COLOR[lv];
  const esJefe = lv === "JR";
  return (<div onClick={onPick} title={alerta || undefined} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3.5px 6px 3.5px 8px", borderRadius: 7, background: selected ? c.solid : c.bg, border: alerta && !selected ? "1.5px solid #F59E0B" : `1.5px solid ${selected ? c.solid : c.bd}`, color: selected ? "#fff" : c.tx, fontWeight: 600, fontSize: 11.5, cursor: "pointer", userSelect: "none", boxShadow: selected ? `0 0 0 3px ${c.solid}33` : alerta ? "0 0 0 2px #FDE68A" : "none", transition: "all .12s", ...(esJefe && !selected ? SKIN_JR : {}) }}>
    {alerta && <span title={alerta} style={{ fontSize: 10, lineHeight: 1, cursor: "help" }}>⚠️</span>}
    {lv === "JR" && <span style={{ fontSize: 10, lineHeight: 1 }}>👑</span>}
    <span style={{ flex: 1, lineHeight: 1.3 }}>{name}</span>
    <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 3.5px", borderRadius: 3, background: esJefe && !selected ? "rgba(69,26,3,.55)" : selected ? "rgba(255,255,255,.28)" : c.solid, color: "#fff", letterSpacing: 0.2, textShadow: "none" }}>{lv}</span>
    {onRemove && <span onClick={onRemove} title="Quitar" style={{ fontSize: 11, lineHeight: 1, opacity: 0.45, cursor: "pointer", padding: "0 1px" }}>×</span>}
  </div>);
}

const OutChip = ({ name, onPick, selected }) => (<div onClick={onPick} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 7px", borderRadius: 6, background: selected ? "#94A3B8" : "#E2E8F0", border: `1.5px solid ${selected ? "#94A3B8" : "#CBD5E1"}`, color: selected ? "#fff" : "#64748B", fontSize: 10.5, fontWeight: 600, textDecoration: "line-through", cursor: "pointer", userSelect: "none" }}><span style={{ flex: 1 }}>{name}</span><span style={{ fontSize: 7.5, fontWeight: 800, background: "#94A3B8", color: "#fff", padding: "1px 3px", borderRadius: 2.5 }}>{LEVEL[name]}</span></div>);

// Igual que OutChip pero para los que quedaron fuera automáticamente (rotación,
// vacaciones o día libre). No se puede tocar: no lo puso nadie a mano, sale de
// Rotaciones o del día libre, así que se corrige allá. El candado y el tooltip
// explican por qué está ahí.
const AutoOutChip = ({ name, motivo }) => (
  <div title={motivo} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 7px", borderRadius: 6, background: "#F8FAFC", border: "1.5px dashed #CBD5E1", color: "#64748B", fontSize: 10.5, fontWeight: 600, cursor: "help", userSelect: "none" }}>
    <span style={{ fontSize: 9 }}>🔒</span>
    <span style={{ flex: 1 }}>{name}</span>
    <span style={{ fontSize: 7.5, fontWeight: 800, background: "#CBD5E1", color: "#fff", padding: "1px 3px", borderRadius: 2.5 }}>{LEVEL[name]}</span>
  </div>
);

const GhostHint = ({ color, name }) => (<div style={{ fontSize: 10, color, opacity: 0.75, fontStyle: "italic", textAlign: "center", padding: "1px 0" }}>+ {name}</div>);

const Dash = () => (<div style={{ color: "#64748B", fontSize: 11, textAlign: "center", padding: "10px 0" }}>—</div>);

const Legend = () => (<div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
  {Object.entries(COLOR).map(([lv, c]) => (<div key={lv} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748B", fontWeight: 500 }}><span style={{ width: 11, height: 11, borderRadius: 3.5, background: c.bg, border: `1.5px solid ${c.bd}` }} />{lv === "JR" ? "👑 Jefe de residentes" : lv}</div>))}
  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748B", fontWeight: 500 }}><span style={{ width: 11, height: 11, borderRadius: 3.5, background: SLOTS[3].tint, border: `1.5px solid ${SLOTS[3].rotulo}` }} />Postguardia</div>
</div>);

/* ══════════════════ ESTILOS ══════════════════ */

const NAV = { background: "rgba(255,255,255,.14)", border: "none", borderRadius: 7, color: "#fff", padding: "6px 10px", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", lineHeight: 1.2 };

const INPUT = { padding: "6px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", background: "#fff", color: "#0F172A" };

const TEXTAREA = { width: "100%", minHeight: 52, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", background: "#fff", fontSize: 11.5, lineHeight: 1.45, color: "#1F2937", fontWeight: 500, fontFamily: "'Inter', system-ui, sans-serif", resize: "vertical", outline: "none", boxSizing: "border-box" };

export { AutoOutChip, Banner, Cell, Chip, ChipGuardia, Corner, Dash, DayHead, GhostHint, INPUT, Legend, MenuItem, NAV, OutChip, PanelAlertas, RowLabel, TEXTAREA, TabBtn, downloadCSV };
