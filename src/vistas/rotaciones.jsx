/* ══════════════════════════════════════════════════════════════════════════
   La pestaña de rotaciones
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useCallback } from "react";
import { db } from "../firebase";
import { doc, setDoc } from "firebase/firestore";
import { escuchar, useGuardadoConEspera, CARTEL_ESTADO } from "../nube";
import { Skeleton } from "../comunes";
import { ALL, COLOR, LEVEL, MONTHS } from "../config";
import { TRAMOS_VACACIONES, clone, emptyRotYear, normalizeRot, textoTramo, tramoPorDefecto } from "../modelo";
import { NAV, TEXTAREA } from "../ui";

function RotacionesView({ isAdmin }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState(emptyRotYear);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [expanded, setExpanded] = useState({});

  const docId = `rotaciones-${year}`;

  useEffect(() => {
    setLoading(true);
    const ref = doc(db, "scheduler", docId);
    const unsub = escuchar(ref, (snap) => {
      setData(snap.exists() ? normalizeRot(snap.data()) : emptyRotYear());
      setLoading(false);
    }, "las rotaciones del año", () => setLoading(false));
    return unsub;
  }, [docId]);

  const { guardar, estado: status } = useGuardadoConEspera(
    (next) => setDoc(doc(db, "scheduler", docId), next),
    { etiqueta: "las rotaciones del año", puede: isAdmin, espera: 400 }
  );

  const save = useCallback((next) => {
    if (!isAdmin) return;
    setData(next);
    guardar(next);
  }, [guardar, isAdmin]);

  const addAssignment = (mi) => { if (!isAdmin) return; setEditing({ month: mi, mode: "new", resident: "", place: "", exterior: false }); };

  const saveAssignment = (mi, resident, place, idx, exterior) => {
    if (!resident.trim() || !place.trim()) return;
    const next = clone(data);
    const registro = { resident: resident.trim(), place: place.trim(), exterior: !!exterior };
    if (idx !== undefined && idx !== null) { next.months[mi].assignments[idx] = registro; }
    else { next.months[mi].assignments.push(registro); }
    save(next); setEditing(null);
  };

  const removeAssignment = (mi, idx) => { if (!isAdmin) return; const next = clone(data); next.months[mi].assignments.splice(idx, 1); save(next); };

  const editNotes = (mi, val) => { if (!isAdmin) return; const next = clone(data); next.months[mi].notes = val; save(next); };

  // Marcar a alguien de vacaciones acá lo deja automáticamente fuera de la
  // grilla de camas todo ese mes (ver motivoNoDisponible). Es un dato aparte
  // de las notas justamente para poder usarlo con seguridad.
  const toggleVacaciones = (mi, nombre) => {
    if (!isAdmin) return;
    const next = clone(data);
    const cur = next.months[mi].vacaciones || [];
    next.months[mi].vacaciones = cur.some((v) => v.nombre === nombre)
      ? cur.filter((v) => v.nombre !== nombre)
      : [...cur, { nombre, tramo: tramoPorDefecto(nombre) }];
    save(next);
  };

  const toggleSemanaLibre = (mi, grupo, nombre) => {
    if (!isAdmin) return;
    const next = clone(data);
    const base = next.months[mi].semanasLibres || { navidad: [], anioNuevo: [] };
    const cur = base[grupo] || [];
    next.months[mi].semanasLibres = { ...base, [grupo]: cur.includes(nombre) ? cur.filter((n) => n !== nombre) : [...cur, nombre] };
    save(next);
  };

  const setTramoVacaciones = (mi, nombre, tramo) => {
    if (!isAdmin) return;
    const next = clone(data);
    next.months[mi].vacaciones = (next.months[mi].vacaciones || []).map((v) => (v.nombre === nombre ? { ...v, tramo } : v));
    save(next);
  };

  const toggleMonth = (mi) => setExpanded((cur) => ({ ...cur, [mi]: !isMonthOpen(mi) }));
  const isMonthOpen = (mi) => {
    if (expanded[mi] !== undefined) return expanded[mi];
    const m = data.months[mi];
    return m.assignments.length > 0 || !!m.notes.trim();
  };

  const S = CARTEL_ESTADO[status];   // ver nube.jsx

  if (loading) return <Skeleton />;

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🔄</span>
          <div><div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Rotaciones y Vacaciones</div><div style={{ fontSize: 10.5, opacity: 0.55 }}>Hospital Británico</div></div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => setYear(y => y - 1)} style={NAV}>◀</button>
          <div style={{ fontWeight: 700, fontSize: 18, minWidth: 60, textAlign: "center" }}>{year}</div>
          <button onClick={() => setYear(y => y + 1)} style={NAV}>▶</button>
        </div>
        <div>{S && <div style={{ fontSize: 10.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: "rgba(255,255,255,.12)", color: S.c }}>{S.t}</div>}</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {MONTHS.map((mName, mi) => {
          const month = data.months[mi];
          const isCurrentMonth = new Date().getFullYear() === year && new Date().getMonth() === mi;
          const sl = month.semanasLibres || {};
          const hasData = month.assignments.length > 0 || !!month.notes.trim() || (month.vacaciones || []).length > 0 || (sl.navidad || []).length > 0 || (sl.anioNuevo || []).length > 0;
          const isOpen = isMonthOpen(mi);
          return (
            <div key={mi} style={{ background: "#fff", borderRadius: 12, border: isCurrentMonth ? "2px solid #3B82F6" : "1px solid #E2E8F0", overflow: "hidden", boxShadow: isCurrentMonth ? "0 0 0 3px #3B82F633" : "0 1px 3px rgba(15,23,42,.04)" }}>
              <div onClick={() => toggleMonth(mi)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: isCurrentMonth ? "#EFF6FF" : "#F8FAFC", borderBottom: isOpen ? "1px solid #E2E8F0" : "none", cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontSize: 9, color: "#64748B", display: "inline-block", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
                  <div style={{ fontWeight: 700, fontSize: 13, color: isCurrentMonth ? "#1D4ED8" : hasData ? "#0F172A" : "#94A3B8" }}>{mName}</div>
                  {!hasData && <span style={{ fontSize: 10, color: "#64748B", fontStyle: "italic" }}>vacío</span>}
                </div>
                {isOpen && isAdmin && <button onClick={(e) => { e.stopPropagation(); addAssignment(mi); }} style={{ background: "#E2E8F0", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", color: "#475569", fontFamily: "inherit" }}>+ Agregar</button>}
              </div>
              {isOpen && (
                <div style={{ padding: "8px 14px" }}>
                  {month.assignments.length === 0 && !(editing && editing.month === mi) ? (
                    <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "6px 0" }}>Sin rotaciones este mes</div>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: month.assignments.length > 0 ? 8 : 0 }}>
                      {month.assignments.map((a, idx) => {
                        const lv = LEVEL[a.resident];
                        const c = lv ? COLOR[lv] : { bg: "#F1F5F9", bd: "#CBD5E1", tx: "#475569", solid: "#64748B" };
                        const isEditingThis = editing && editing.month === mi && editing.idx === idx;
                        if (isEditingThis) {
                          return <EditForm key={idx} resident={editing.resident} place={editing.place} exterior={editing.exterior} onResChange={(v) => setEditing({ ...editing, resident: v })} onPlaceChange={(v) => setEditing({ ...editing, place: v })} onExteriorChange={(v) => setEditing({ ...editing, exterior: v })} onSave={() => saveAssignment(mi, editing.resident, editing.place, idx, editing.exterior)} onCancel={() => setEditing(null)} />;
                        }
                        return (
                          <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, background: c.bg, border: `1.5px solid ${c.bd}`, fontSize: 12 }}>
                            <span style={{ fontWeight: 700, color: c.tx }}>{a.resident}</span>
                            <span style={{ color: "#64748B", fontWeight: 500 }}>({a.place})</span>
                            {a.exterior && <span title="Fuera del país — no hace guardias" style={{ fontSize: 10 }}>✈️</span>}
                            {lv && <span style={{ fontSize: 8, fontWeight: 800, background: c.solid, color: "#fff", padding: "1px 4px", borderRadius: 3 }}>{lv}</span>}
                            {isAdmin && <span onClick={() => setEditing({ month: mi, idx, resident: a.resident, place: a.place, exterior: !!a.exterior })} style={{ cursor: "pointer", fontSize: 11, opacity: 0.4 }} title="Editar">✏️</span>}
                            {isAdmin && <span onClick={() => removeAssignment(mi, idx)} style={{ cursor: "pointer", fontSize: 11, opacity: 0.4 }} title="Eliminar">✕</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {editing && editing.month === mi && editing.mode === "new" && (
                    <EditForm resident={editing.resident} place={editing.place} exterior={editing.exterior} onResChange={(v) => setEditing({ ...editing, resident: v })} onPlaceChange={(v) => setEditing({ ...editing, place: v })} onExteriorChange={(v) => setEditing({ ...editing, exterior: v })} onSave={() => saveAssignment(mi, editing.resident, editing.place, undefined, editing.exterior)} onCancel={() => setEditing(null)} />
                  )}
                  <VacacionesPicker mes={mi} seleccion={month.vacaciones || []} isAdmin={isAdmin} onToggle={toggleVacaciones} onTramo={setTramoVacaciones} />
                  {mi === 11 && <SemanasLibresPicker mes={mi} datos={month.semanasLibres || { navidad: [], anioNuevo: [] }} isAdmin={isAdmin} onToggle={toggleSemanaLibre} />}
                  <textarea value={month.notes} onChange={(e) => editNotes(mi, e.target.value)} placeholder="Detalle de vacaciones (ej: 3 primeras semanas)…" readOnly={!isAdmin} style={{ ...TEXTAREA, minHeight: 32, marginTop: 4, fontSize: 11, fontStyle: month.notes ? "normal" : "italic", color: month.notes ? "#92400E" : "#94A3B8", background: month.notes ? "#FFFBEB" : "#FAFAFA", borderColor: month.notes ? "#FDE68A" : "#E2E8F0", opacity: isAdmin ? 1 : 0.8, cursor: isAdmin ? "text" : "default" }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Selector de quién está de vacaciones ese mes. Separado del texto libre de
// notas: las notas son para el detalle humano ("3 primeras semanas"), esto es
// el dato que la app usa para dejarlos fuera de sala automáticamente.
function VacacionesPicker({ mes, seleccion, isAdmin, onToggle, onTramo }) {
  const [abierto, setAbierto] = useState(false);
  if (!isAdmin && seleccion.length === 0) return null;
  const estaMarcado = (n) => seleccion.some((v) => v.nombre === n);

  return (
    <div style={{ marginTop: 6, paddingTop: 8, borderTop: "1px dashed #E2E8F0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: seleccion.length || abierto ? 6 : 0 }}>
        <div style={{ fontSize: 10.5, fontWeight: 800, color: "#0F766E", letterSpacing: 0.3, textTransform: "uppercase" }}>🏖️ De vacaciones este mes</div>
        {isAdmin && <button onClick={() => setAbierto((v) => !v)} style={{ background: "none", border: "none", color: "#0F766E", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{abierto ? "Listo" : "✏️ Editar"}</button>}
      </div>

      {!abierto && seleccion.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {seleccion.map((v) => {
            const c = COLOR[LEVEL[v.nombre]] || COLOR.R2;
            const t = TRAMOS_VACACIONES[v.tramo] || TRAMOS_VACACIONES.mes;
            return (
              <span key={v.nombre} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 999, background: c.bg, border: `1.5px solid ${c.bd}`, color: c.tx, fontWeight: 700, fontSize: 11 }}>
                {v.nombre}
                <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: c.solid, color: "#fff" }}>{LEVEL[v.nombre]}</span>
                <span title={textoTramo(t)} style={{ fontSize: 9.5, fontWeight: 700, color: t.tipo === "invierno" ? "#0369A1" : "#B45309", background: t.tipo === "invierno" ? "#F0F9FF" : "#FFFBEB", border: `1px solid ${t.tipo === "invierno" ? "#BAE6FD" : "#FDE68A"}`, borderRadius: 999, padding: "0 5px" }}>{t.tipo === "invierno" ? "❄️ " : "☀️ "}{t.corto}</span>
              </span>
            );
          })}
        </div>
      )}
      {!abierto && seleccion.length === 0 && isAdmin && (
        <div style={{ fontSize: 11, color: "#64748B", fontStyle: "italic" }}>Nadie marcado. Los que marques quedan fuera de sala durante su tramo.</div>
      )}

      {abierto && (
        <div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: seleccion.length ? 10 : 0 }}>
            {ALL.map((n) => {
              const on = estaMarcado(n);
              const c = COLOR[LEVEL[n]];
              return (
                <div key={n} onClick={() => onToggle(mes, n)} style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 4, padding: "4px 9px", borderRadius: 7, background: on ? c.solid : "#F8FAFC", border: `1.5px solid ${on ? c.solid : "#E2E8F0"}`, color: on ? "#fff" : "#475569", fontWeight: 600, fontSize: 11.5 }}>
                  {on && "✓ "}{n}
                  <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: on ? "rgba(255,255,255,.28)" : c.solid, color: "#fff" }}>{LEVEL[n]}</span>
                </div>
              );
            })}
          </div>

          {/* Los R4 se toman el mes entero, así que no hace falta preguntarles
              el tramo; a los R2 y R3 sí, porque son tres semanas seguidas que
              pueden arrancar la primera o la segunda semana. */}
          {seleccion.map((v) => (
            <div key={v.nombre} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 5 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: "#334155", minWidth: 62 }}>{v.nombre}</span>
              {["verano", "invierno"].map((grupo) => (
                <span key={grupo} style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 9.5, fontWeight: 800, color: grupo === "verano" ? "#B45309" : "#0369A1", textTransform: "uppercase", letterSpacing: 0.3 }}>{grupo === "verano" ? "☀️ verano" : "❄️ invierno"}</span>
                  {Object.entries(TRAMOS_VACACIONES).filter(([, t]) => t.tipo === grupo).map(([clave, t]) => {
                    const on = (v.tramo || "1-3") === clave;
                    return (
                      <button key={clave} onClick={() => onTramo(mes, v.nombre, clave)} style={{ background: on ? "#0F766E" : "#fff", color: on ? "#fff" : "#475569", border: `1.5px solid ${on ? "#0F766E" : "#E2E8F0"}`, borderRadius: 7, padding: "4px 9px", fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                        {t.label}
                      </button>
                    );
                  })}
                </span>
              ))}
            </div>
          ))}
          {seleccion.some((v) => LEVEL[v.nombre] === "R4") && (
            <div style={{ fontSize: 10.5, color: "#64748B", marginTop: 4 }}>
              Los R4 marcados se toman el mes completo. Si es una semana de invierno, cambiale el tramo desde acá.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Solo aparece en diciembre. A fin de año se arma con dos equipos: unos
// trabajan la semana de Navidad y quedan libres la de Año nuevo, y al revés.
// Lo que se marca acá sale directo en la grilla: quien queda libre aparece
// automáticamente como no disponible de lunes a viernes de esa semana, y
// tampoco puede hacer guardia esas noches. Es una desconexión total.
// Las dos semanas se deducen del calendario (la del 25/12 y la del 1/1), así
// que no hay que cargar fechas: alcanza con tildar quién queda libre.
function SemanasLibresPicker({ mes, datos, isAdmin, onToggle }) {
  const [abierto, setAbierto] = useState(false);
  const grupos = [
    { clave: "navidad", label: "🎄 Semana de Navidad", color: "#B91C1C", bg: "#FEF2F2", bd: "#FECACA" },
    { clave: "anioNuevo", label: "🎆 Semana de Año nuevo", color: "#7C3AED", bg: "#F5F3FF", bd: "#DDD6FE" },
  ];
  const hayAlgo = grupos.some((g) => (datos[g.clave] || []).length > 0);
  if (!isAdmin && !hayAlgo) return null;

  return (
    <div style={{ marginTop: 6, paddingTop: 8, borderTop: "1px dashed #E2E8F0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: hayAlgo || abierto ? 6 : 0 }}>
        <div style={{ fontSize: 10.5, fontWeight: 800, color: "#7C3AED", letterSpacing: 0.3, textTransform: "uppercase" }}>🎄 Semanas libres de Navidad y Año nuevo</div>
        {isAdmin && <button onClick={() => setAbierto((v) => !v)} style={{ background: "none", border: "none", color: "#7C3AED", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{abierto ? "Listo" : "✏️ Editar"}</button>}
      </div>

      {!abierto && !hayAlgo && isAdmin && (
        <div style={{ fontSize: 11, color: "#64748B", fontStyle: "italic" }}>Sin definir todavía. A medida que cada uno elija, se lo marca acá: queda fuera de la sala y de las guardias de lunes a viernes de esa semana.</div>
      )}

      {grupos.map((g) => {
        const gente = datos[g.clave] || [];
        if (!abierto && gente.length === 0) return null;
        return (
          <div key={g.clave} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: g.color, marginBottom: 4 }}>{g.label} <span style={{ color: "#64748B", fontWeight: 500 }}>— libres de lunes a viernes, sin sala ni guardia</span></div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {(abierto ? ALL : gente).map((n) => {
                const on = gente.includes(n);
                const c = COLOR[LEVEL[n]];
                if (!abierto) {
                  return (
                    <span key={n} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 999, background: c.bg, border: `1.5px solid ${c.bd}`, color: c.tx, fontWeight: 700, fontSize: 11 }}>
                      {n}<span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: c.solid, color: "#fff" }}>{LEVEL[n]}</span>
                    </span>
                  );
                }
                return (
                  <div key={n} onClick={() => onToggle(mes, g.clave, n)} style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 4, padding: "4px 9px", borderRadius: 7, background: on ? g.color : "#F8FAFC", border: `1.5px solid ${on ? g.color : "#E2E8F0"}`, color: on ? "#fff" : "#475569", fontWeight: 600, fontSize: 11.5 }}>
                    {on && "✓ "}{n}
                    <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: on ? "rgba(255,255,255,.28)" : c.solid, color: "#fff" }}>{LEVEL[n]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const EditForm = ({ resident, place, exterior, onResChange, onPlaceChange, onExteriorChange, onSave, onCancel }) => (
  <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0", flexWrap: "wrap" }}>
    <select value={resident} onChange={(e) => onResChange(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", background: "#fff", color: "#0F172A" }}>
      <option value="">Residente…</option>
      {ALL.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
    </select>
    <input value={place} onChange={(e) => onPlaceChange(e.target.value)} placeholder="Lugar (ej: Fernandez, Ecocardio)" onKeyDown={(e) => e.key === "Enter" && onSave()} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", flex: 1, minWidth: 140, color: "#0F172A" }} />
    <label title="Si rota fuera del país no hace guardias en el Británico" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: exterior ? "#B45309" : "#64748B", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
      <input type="checkbox" checked={!!exterior} onChange={(e) => onExteriorChange(e.target.checked)} style={{ cursor: "pointer" }} />
      ✈️ fuera del país
    </label>
    <button onClick={onSave} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓</button>
    <button onClick={onCancel} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✕</button>
  </div>
);

/* ══════════════════ PASES VIEW ══════════════════ */

export { EditForm, RotacionesView, SemanasLibresPicker, VacacionesPicker };
