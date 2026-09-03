/* ══════════════════════════════════════════════════════════════════════════
   La pestaña de registro
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useMemo } from "react";
import { db } from "../firebase";
import { doc, setDoc, getDoc, deleteDoc, collection } from "firebase/firestore";
import { escuchar, escribir } from "../nube";
import { shift, isoDate, Skeleton } from "../comunes";
import { ALL, ASIGNABLES, COBERTURA_RESIDENTS, COBERTURA_TIPOS, COLOR, CUPO_MES, DAYS, DEFAULT_PROCEDIMIENTOS, DEFAULT_REGISTRO_SUB_ORDER, EVENTO_TIPOS, INICIO_ESTADISTICAS, LEVEL, MES_INICIO_ESTADISTICAS, MODULOS_CLASE, MONTHS, REGISTRO_SUB_META, RESIDENT_BY_EMAIL, isWeekendIdx } from "../config";
import { fechaCorta, lunesQueTocanElMes } from "../fechas";
import { TRAMOS_VACACIONES, agruparPorMes, agruparPorTipo, cupoR2, emptyRotYear, emptyWeek, normalize, normalizeRot } from "../modelo";
import { downloadCSV } from "../ui";

// Abre una ventana nueva con el registro de procedimientos de un residente,
// ya agrupado por tipo, y dispara el diálogo de impresión (el residente elige
// "Guardar como PDF"). Mismo patrón que la impresión del calendario semanal:
// título dinámico seteado antes de imprimir para que el nombre de archivo
// sugerido ya venga armado.
function descargarPDFProcedimientos(residente, grupos) {
  const total = grupos.reduce((n, g) => n + g.items.length, 0);
  const win = window.open("", "_blank");
  if (!win) return;
  const filas = grupos.map((g) => {
    const meses = agruparPorMes(g.items);
    return `
      <h3>${g.tipo} <span class="cnt">(${g.items.length})</span></h3>
      <table>
        <thead><tr><th>Mes</th><th>Cantidad</th><th>Región (detalle opcional)</th></tr></thead>
        <tbody>
          ${meses.map((m) => {
            const notas = m.items.map((p) => p.nota).filter(Boolean);
            const detalle = notas.length ? notas.join(", ").replace(/</g, "&lt;") : "—";
            return `<tr><td class="mes">${m.label}</td><td class="cant">${m.items.length}</td><td class="det">${detalle}</td></tr>`;
          }).join("")}
        </tbody>
      </table>
    `;
  }).join("");
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8" />
    <title>Registro de procedimientos — ${residente}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: 'Inter', system-ui, sans-serif; color: #0F172A; padding: 28px 34px; }
      h1 { font-size: 19px; margin: 0 0 2px; }
      .sub { font-size: 12px; color: #64748B; margin: 0 0 22px; }
      h3 { font-size: 13px; color: #0F766E; border-bottom: 1.5px solid #99F6E4; padding-bottom: 4px; margin: 20px 0 6px; }
      .cnt { color: #94A3B8; font-weight: 500; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
      th { text-align: left; font-size: 10.5px; color: #94A3B8; font-weight: 700; padding: 4px 6px; }
      td { font-size: 12px; padding: 4px 6px; border-top: 1px solid #F1F5F9; }
      td.mes { white-space: nowrap; color: #334155; font-weight: 600; width: 150px; text-transform: capitalize; }
      td.cant { width: 70px; color: #0F766E; font-weight: 700; }
      td.det { color: #64748B; }
      @media print { body { padding: 14mm; } }
    </style>
    </head><body>
    <h1>Registro de procedimientos — ${residente}</h1>
    <p class="sub">Scheduler UTI · Hospital Británico · Total: ${total} procedimiento${total === 1 ? "" : "s"}</p>
    ${filas || "<p>Todavía no hay procedimientos cargados.</p>"}
    </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 200);
}

function RegistroView({ isAdmin, user }) {
  const [subOrder, setSubOrder] = useState(DEFAULT_REGISTRO_SUB_ORDER);
  const [sub, setSub] = useState("tarde");
  const [eventos, setEventos] = useState([]);
  const [procedimientos, setProcedimientos] = useState([]);
  const [procList, setProcList] = useState(DEFAULT_PROCEDIMIENTOS);
  const [cobertura, setCobertura] = useState([]);
  const [clases, setClases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);

  useEffect(() => {
    const unsub = escuchar(collection(db, "registro_eventos"), (snap) => {
      setEventos(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, "el registro de llegadas tarde y faltas", () => setLoading(false));
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = escuchar(collection(db, "procedimientos"), (snap) => {
      setProcedimientos(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, "los procedimientos cargados");
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = escuchar(collection(db, "cobertura_sala"), (snap) => {
      setCobertura(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, "las coberturas de sala");
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = escuchar(collection(db, "registro_clases"), (snap) => {
      setClases(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, "el registro de clases");
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = escuchar(doc(db, "scheduler", "registro-config"), (snap) => {
      const list = snap.exists() && Array.isArray(snap.data().procedimientosList) ? snap.data().procedimientosList : null;
      setProcList(list && list.length ? list : DEFAULT_PROCEDIMIENTOS);
    }, "la lista de procedimientos");
    return unsub;
  }, []);

  useEffect(() => {
    const ref = doc(db, "scheduler", "ui-config");
    const unsub = escuchar(ref, (snap) => {
      const stored = snap.exists() ? snap.data().registroSubOrder : null;
      if (Array.isArray(stored) && stored.length) {
        const known = stored.filter((k) => DEFAULT_REGISTRO_SUB_ORDER.includes(k));
        const missing = DEFAULT_REGISTRO_SUB_ORDER.filter((k) => !known.includes(k));
        setSubOrder([...known, ...missing]);
      } else {
        setSubOrder(DEFAULT_REGISTRO_SUB_ORDER);
      }
    }, null);   // cosmético, igual que el orden de las pestañas
    return unsub;
  }, []);

  const persistSubOrder = (next) => {
    setSubOrder(next);
    escribir(setDoc(doc(db, "scheduler", "ui-config"), { registroSubOrder: next }, { merge: true }), "el orden de las sub-pestañas");
  };

  const handleSubDragStart = (i) => (e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; };
  const handleSubDragEnter = (i) => (e) => { e.preventDefault(); if (dragIdx !== null) setOverIdx(i); };
  const handleSubDragOver = (e) => { e.preventDefault(); };
  const handleSubDragEnd = () => { setDragIdx(null); setOverIdx(null); };
  const handleSubDrop = (i) => (e) => {
    e.preventDefault();
    const from = dragIdx;
    setDragIdx(null); setOverIdx(null);
    if (from === null || from === i) return;
    const next = [...subOrder];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    persistSubOrder(next);
  };

  const misResidente = RESIDENT_BY_EMAIL[(user?.email || "").toLowerCase()] || null;

  if (loading) return <Skeleton />;

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <span style={{ fontSize: 22 }}>📋</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Registro</div>
          <div style={{ fontSize: 10.5, opacity: 0.7 }}>Llegadas tarde, faltas, guardias, procedimientos y cobertura de sala</div>
        </div>
      </div>

      {isAdmin && <div className="no-print" style={{ fontSize: 10, color: "#64748B", marginBottom: 4, paddingLeft: 2 }}>Arrastrá una sub-pestaña para reordenarlas</div>}
      <div className="no-print" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {subOrder.map((key, i) => {
          const s = REGISTRO_SUB_META[key];
          if (!s) return null;
          const dropTarget = isAdmin && overIdx === i && dragIdx !== null && dragIdx !== i;
          return (
            <button
              key={key}
              onClick={() => setSub(key)}
              draggable={isAdmin}
              onDragStart={handleSubDragStart(i)}
              onDragEnter={handleSubDragEnter(i)}
              onDragOver={handleSubDragOver}
              onDrop={handleSubDrop(i)}
              onDragEnd={handleSubDragEnd}
              title={isAdmin ? "Arrastrá para reordenar" : undefined}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 9, border: `1.5px solid ${sub === key ? s.color : "#E2E8F0"}`, background: sub === key ? s.color : "#fff", color: sub === key ? "#fff" : "#64748B", fontWeight: 700, fontSize: 12.5, cursor: isAdmin ? "grab" : "pointer", fontFamily: "inherit", opacity: dragIdx === i ? 0.4 : 1, boxShadow: dropTarget ? "inset 3px 0 0 #3B82F6" : "none" }}
            >
              <span>{s.icon}</span>{s.label}
            </button>
          );
        })}
      </div>

      {sub === "guardias_mes" ? (
        <GuardiasSection cobertura={cobertura} isAdmin={isAdmin} />
      ) : sub === "procedimientos" ? (
        <ProcedimientosSection procedimientos={procedimientos} procList={procList} isAdmin={isAdmin} user={user} misResidente={misResidente} />
      ) : sub === "cobertura" ? (
        <CoberturaSection cobertura={cobertura} isAdmin={isAdmin} user={user} />
      ) : sub === "clases" ? (
        <ClasesSection clases={clases} isAdmin={isAdmin} user={user} />
      ) : (
        <EventosSection key={sub} tipo={sub} eventos={eventos} isAdmin={isAdmin} user={user} />
      )}
    </div>
  );
}

function EventosSection({ tipo, eventos, isAdmin, user }) {
  const meta = EVENTO_TIPOS[tipo];
  const [residente, setResidente] = useState(ALL[0]);
  const [fecha, setFecha] = useState(() => isoDate(new Date()));
  const [nota, setNota] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState(null);

  const lista = useMemo(() => eventos.filter((e) => e.tipo === tipo).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")), [eventos, tipo]);
  const totales = useMemo(() => {
    const t = {};
    lista.forEach((e) => { t[e.residente] = (t[e.residente] || 0) + 1; });
    return t;
  }, [lista]);

  const agregar = async () => {
    if (!residente || !fecha || saving) return;
    setSaving(true);
    const ok = await escribir(setDoc(doc(collection(db, "registro_eventos")), {
      residente, tipo, fecha, nota: nota.trim(),
      creadoPor: user?.email || "", creadoEn: new Date().toISOString(),
    }), "cargar el registro");
    if (ok) setNota("");
    setSaving(false);
  };

  const eliminar = async (id) => {
    await escribir(deleteDoc(doc(db, "registro_eventos", id)), "borrar el registro");
    setConfirmId(null);
  };

  const exportar = () => {
    downloadCSV(`registro-${tipo}.csv`, ["Residente", "Fecha", "Nota"], lista.map((e) => [e.residente, e.fecha, e.nota || ""]));
  };

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {ALL.map((n) => {
          const c = totales[n] || 0;
          const lv = COLOR[LEVEL[n]];
          return (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 9, background: "#fff", border: "1px solid #E2E8F0" }}>
              <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: lv.solid, color: "#fff" }}>{LEVEL[n]}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>{n}</span>
              <span style={{ fontSize: 12, fontWeight: 800, color: c > 0 ? meta.color : "#CBD5E1", background: c > 0 ? meta.bg : "#F8FAFC", borderRadius: 999, padding: "1px 8px", minWidth: 18, textAlign: "center" }}>{c}</span>
            </div>
          );
        })}
      </div>

      {isAdmin && (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 12, marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>RESIDENTE</div>
            <select value={residente} onChange={(e) => setResidente(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {ALL.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>FECHA</div>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>NOTA (OPCIONAL)</div>
            <input value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Detalle…" style={{ width: "100%", fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", boxSizing: "border-box" }} />
          </div>
          <button onClick={agregar} disabled={saving} style={{ background: meta.color, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1 }}>
            + Agregar {meta.singular}
          </button>
        </div>
      )}

      {isAdmin && lista.length > 0 && (
        <button onClick={exportar} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "#64748B", padding: "2px 2px", marginBottom: 8 }}>
          ⬇️ Exportar CSV
        </button>
      )}

      {lista.length === 0 ? (
        <div style={{ textAlign: "center", padding: "30px 20px", color: "#64748B", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
          {meta.icon} Todavía no hay {meta.label.toLowerCase()} registradas.
        </div>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
          {lista.map((e, i) => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i === lista.length - 1 ? "none" : "1px solid #F1F5F9" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, background: meta.bg, border: `1px solid ${meta.bd}`, borderRadius: 6, padding: "2px 7px", minWidth: 42, textAlign: "center" }}>{fechaCorta(e.fecha)}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A", minWidth: 60 }}>{e.residente}</span>
              {e.nota && <span style={{ fontSize: 11.5, color: "#64748B", flex: 1 }}>{e.nota}</span>}
              {isAdmin && (
                confirmId === e.id ? (
                  <span style={{ display: "flex", gap: 4 }}>
                    <button onClick={() => eliminar(e.id)} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Sí, borrar</button>
                    <button onClick={() => setConfirmId(null)} style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", background: "#F1F5F9", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmId(e.id)} title="Eliminar" style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>🗑️</button>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CoberturaSection({ cobertura, isAdmin, user }) {
  const [residente, setResidente] = useState(COBERTURA_RESIDENTS[0]);
  const [fecha, setFecha] = useState(() => isoDate(new Date()));
  const [modalidad, setModalidad] = useState("post_guardia");
  const [nota, setNota] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState(null);

  // Igual que las guardias: no se muestra ni se cuenta nada anterior a
  // septiembre de 2026.
  const lista = useMemo(() => cobertura.filter((e) => (e.fecha || "") >= INICIO_ESTADISTICAS).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")), [cobertura]);
  const totales = useMemo(() => {
    const t = {};
    lista.forEach((e) => { t[e.residente] = (t[e.residente] || 0) + 1; });
    return t;
  }, [lista]);

  const agregar = async () => {
    if (!residente || !fecha || saving) return;
    setSaving(true);
    const ok = await escribir(setDoc(doc(collection(db, "cobertura_sala")), {
      residente, fecha, modalidad, nota: nota.trim(),
      creadoPor: user?.email || "", creadoEn: new Date().toISOString(),
    }), "cargar la cobertura de sala");
    if (ok) setNota("");
    setSaving(false);
  };

  const eliminar = async (id) => {
    await escribir(deleteDoc(doc(db, "cobertura_sala", id)), "borrar la cobertura de sala");
    setConfirmId(null);
  };

  const exportar = () => {
    downloadCSV("cobertura-sala.csv", ["Residente", "Fecha", "Modalidad", "Nota"], lista.map((e) => [e.residente, e.fecha, COBERTURA_TIPOS[e.modalidad]?.label || e.modalidad, e.nota || ""]));
  };

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {COBERTURA_RESIDENTS.map((n) => {
          const c = totales[n] || 0;
          const lv = COLOR[LEVEL[n]];
          return (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 9, background: "#fff", border: "1px solid #E2E8F0" }}>
              <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: lv.solid, color: "#fff" }}>{LEVEL[n]}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>{n}</span>
              <span style={{ fontSize: 12, fontWeight: 800, color: c > 0 ? "#1D4ED8" : "#CBD5E1", background: c > 0 ? "#EFF6FF" : "#F8FAFC", borderRadius: 999, padding: "1px 8px", minWidth: 18, textAlign: "center" }}>{c}</span>
            </div>
          );
        })}
      </div>

      {isAdmin && (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 12, marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>RESIDENTE (R2/R3)</div>
            <select value={residente} onChange={(e) => setResidente(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {COBERTURA_RESIDENTS.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>FECHA</div>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>MODALIDAD</div>
            <select value={modalidad} onChange={(e) => setModalidad(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {Object.entries(COBERTURA_TIPOS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>NOTA (OPCIONAL)</div>
            <input value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Detalle…" style={{ width: "100%", fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", boxSizing: "border-box" }} />
          </div>
          <button onClick={agregar} disabled={saving} style={{ background: "#1D4ED8", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1 }}>
            + Agregar cobertura
          </button>
        </div>
      )}

      {isAdmin && lista.length > 0 && (
        <button onClick={exportar} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "#64748B", padding: "2px 2px", marginBottom: 8 }}>
          ⬇️ Exportar CSV
        </button>
      )}

      {lista.length === 0 ? (
        <div style={{ textAlign: "center", padding: "30px 20px", color: "#64748B", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
          🔁 Todavía no hay coberturas de sala registradas.
        </div>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
          {lista.map((e, i) => {
            const mod = COBERTURA_TIPOS[e.modalidad] || COBERTURA_TIPOS.post_guardia;
            const lv = COLOR[LEVEL[e.residente]] || COLOR.R2;
            return (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i === lista.length - 1 ? "none" : "1px solid #F1F5F9", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#1D4ED8", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 6, padding: "2px 7px", minWidth: 42, textAlign: "center" }}>{fechaCorta(e.fecha)}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999, background: lv?.bg, border: `1px solid ${lv?.bd}`, color: lv?.tx, fontSize: 12, fontWeight: 700 }}>
                  {e.residente}
                  <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: lv?.solid, color: "#fff" }}>{LEVEL[e.residente]}</span>
                </span>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: e.modalidad === "rotacion" ? "#0369A1" : "#9F1239", background: e.modalidad === "rotacion" ? "#F0F9FF" : "#FFF1F2", borderRadius: 999, padding: "2px 9px" }}>{mod.label}</span>
                {e.nota && <span style={{ fontSize: 11.5, color: "#64748B", flex: 1 }}>{e.nota}</span>}
                {isAdmin && (
                  confirmId === e.id ? (
                    <span style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => eliminar(e.id)} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Sí, borrar</button>
                      <button onClick={() => setConfirmId(null)} style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", background: "#F1F5F9", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmId(e.id)} title="Eliminar" style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>🗑️</button>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ClasesSection({ clases, isAdmin, user }) {
  const [residente, setResidente] = useState(ALL[0]);
  const [modulo, setModulo] = useState(MODULOS_CLASE[0]);
  const [fecha, setFecha] = useState(() => isoDate(new Date()));
  const [tema, setTema] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState(null);

  const lista = useMemo(() => [...clases].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")), [clases]);

  const matriz = useMemo(() => {
    const m = {};
    ALL.forEach((n) => { m[n] = { total: 0 }; MODULOS_CLASE.forEach((mo) => { m[n][mo] = 0; }); });
    lista.forEach((c) => {
      if (!m[c.residente]) return;
      m[c.residente][c.modulo] = (m[c.residente][c.modulo] || 0) + 1;
      m[c.residente].total += 1;
    });
    return m;
  }, [lista]);

  const agregar = async () => {
    if (!residente || !modulo || !fecha || saving) return;
    setSaving(true);
    const ok = await escribir(setDoc(doc(collection(db, "registro_clases")), {
      residente, modulo, fecha, tema: tema.trim(),
      creadoPor: user?.email || "", creadoEn: new Date().toISOString(),
    }), "cargar la clase");
    if (ok) setTema("");
    setSaving(false);
  };

  const eliminar = async (id) => {
    await escribir(deleteDoc(doc(db, "registro_clases", id)), "borrar la clase");
    setConfirmId(null);
  };

  const exportar = () => {
    downloadCSV("clases-presentaciones.csv", ["Residente", "Módulo", "Fecha", "Tema"], lista.map((c) => [c.residente, c.modulo, c.fecha, c.tema || ""]));
  };

  return (
    <div>
      {/* Matriz de totales: residente × módulo */}
      <div style={{ overflowX: "auto", marginBottom: 14 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", background: "#fff", borderRadius: 14, overflow: "hidden", border: "1px solid #E2E8F0", fontSize: 11.5 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "8px 10px", background: "#F8FAFC", borderBottom: "2px solid #E2E8F0", borderRight: "1px solid #F1F5F9", fontWeight: 700, color: "#334155" }}>Residente</th>
              {MODULOS_CLASE.map((mo) => (
                <th key={mo} style={{ padding: "8px 6px", background: "#F8FAFC", borderBottom: "2px solid #E2E8F0", borderRight: "1px solid #F1F5F9", fontWeight: 700, color: "#7C2D12", whiteSpace: "nowrap" }}>{mo}</th>
              ))}
              <th style={{ padding: "8px 10px", background: "#F8FAFC", borderBottom: "2px solid #E2E8F0", fontWeight: 800, color: "#0F172A" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {ALL.map((n, i) => {
              const lv = COLOR[LEVEL[n]];
              const row = matriz[n];
              return (
                <tr key={n}>
                  <td style={{ padding: "7px 10px", borderBottom: i === ALL.length - 1 ? "none" : "1px solid #F1F5F9", borderRight: "1px solid #F1F5F9", fontWeight: 700, color: "#0F172A", whiteSpace: "nowrap" }}>
                    <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: lv.solid, color: "#fff", marginRight: 5 }}>{LEVEL[n]}</span>
                    {n}
                  </td>
                  {MODULOS_CLASE.map((mo) => (
                    <td key={mo} style={{ textAlign: "center", padding: "7px 6px", borderBottom: i === ALL.length - 1 ? "none" : "1px solid #F1F5F9", borderRight: "1px solid #F1F5F9", color: row[mo] > 0 ? "#7C2D12" : "#CBD5E1", fontWeight: row[mo] > 0 ? 700 : 500 }}>{row[mo] || 0}</td>
                  ))}
                  <td style={{ textAlign: "center", padding: "7px 10px", borderBottom: i === ALL.length - 1 ? "none" : "1px solid #F1F5F9", fontWeight: 800, color: row.total > 0 ? "#0F172A" : "#CBD5E1" }}>{row.total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 12, marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>RESIDENTE</div>
            <select value={residente} onChange={(e) => setResidente(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {ALL.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>MÓDULO</div>
            <select value={modulo} onChange={(e) => setModulo(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }}>
              {MODULOS_CLASE.map((mo) => <option key={mo} value={mo}>{mo}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>FECHA</div>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>TEMA (OPCIONAL)</div>
            <input value={tema} onChange={(e) => setTema(e.target.value)} placeholder="Título de la clase…" style={{ width: "100%", fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", boxSizing: "border-box" }} />
          </div>
          <button onClick={agregar} disabled={saving} style={{ background: "#7C2D12", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1 }}>
            + Agregar clase
          </button>
        </div>
      )}

      {isAdmin && lista.length > 0 && (
        <button onClick={exportar} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "#64748B", padding: "2px 2px", marginBottom: 8 }}>
          ⬇️ Exportar CSV
        </button>
      )}

      {lista.length === 0 ? (
        <div style={{ textAlign: "center", padding: "30px 20px", color: "#64748B", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
          🎓 Todavía no hay clases ni presentaciones registradas.
        </div>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
          {lista.map((c, i) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i === lista.length - 1 ? "none" : "1px solid #F1F5F9", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#7C2D12", background: "#FFF7ED", border: "1px solid #FED7AA", borderRadius: 6, padding: "2px 7px", minWidth: 42, textAlign: "center" }}>{fechaCorta(c.fecha)}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A", minWidth: 60 }}>{c.residente}</span>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: "#7C2D12", background: "#FFF7ED", borderRadius: 999, padding: "2px 9px" }}>{c.modulo}</span>
              {c.tema && <span style={{ fontSize: 11.5, color: "#64748B", flex: 1 }}>{c.tema}</span>}
              {isAdmin && (
                confirmId === c.id ? (
                  <span style={{ display: "flex", gap: 4 }}>
                    <button onClick={() => eliminar(c.id)} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Sí, borrar</button>
                    <button onClick={() => setConfirmId(null)} style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", background: "#F1F5F9", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmId(c.id)} title="Eliminar" style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>🗑️</button>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MonthRow({ label, items, ESTADO_META, confirmId, setConfirmId, eliminar, lastRow }) {
  const [open, setOpen] = useState(false);
  const hayRegion = items.some((p) => p.nota);
  return (
    <div style={{ borderBottom: lastRow ? "none" : "1px solid #F1F5F9" }}>
      <button onClick={() => setOpen((v) => !v)} disabled={!hayRegion && !eliminar} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "#fff", border: "none", cursor: hayRegion || eliminar ? "pointer" : "default", fontFamily: "inherit", padding: "8px 14px 8px 32px", textAlign: "left" }}>
        <span style={{ display: "inline-block", width: 10, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 9, color: hayRegion || eliminar ? "#CBD5E1" : "transparent" }}>▶</span>
        <span style={{ fontSize: 12.5, color: "#334155", flex: 1, textTransform: "capitalize" }}>{label}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#0F766E", background: "#F0FDFA", border: "1px solid #99F6E4", borderRadius: 999, padding: "1px 9px", minWidth: 20, textAlign: "center" }}>{items.length}</span>
      </button>
      {open && (
        <div style={{ padding: "0 14px 8px 52px", display: "flex", flexDirection: "column", gap: 4 }}>
          {items.map((p) => {
            const em = ESTADO_META[p.estado] || ESTADO_META.pendiente;
            return (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }}>
                <span style={{ color: "#64748B", minWidth: 34 }}>{fechaCorta(p.fecha)}</span>
                <span style={{ color: p.nota ? "#475569" : "#CBD5E1", fontStyle: p.nota ? "normal" : "italic", flex: 1 }}>{p.nota || "sin región"}</span>
                <span style={{ fontSize: 9.5, fontWeight: 700, color: em.color, background: em.bg, borderRadius: 999, padding: "1px 7px" }}>{em.label}</span>
                {eliminar && (
                  confirmId === p.id ? (
                    <span style={{ display: "flex", gap: 3 }}>
                      <button onClick={() => eliminar(p.id)} style={{ fontSize: 9.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 5, padding: "2px 7px", cursor: "pointer", fontFamily: "inherit" }}>Sí</button>
                      <button onClick={() => setConfirmId(null)} style={{ fontSize: 9.5, fontWeight: 700, color: "#64748B", background: "#F1F5F9", border: "none", borderRadius: 5, padding: "2px 7px", cursor: "pointer", fontFamily: "inherit" }}>×</button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmId(p.id)} title="Eliminar" style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>🗑️</button>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TipoGroup({ tipo, items, ESTADO_META, confirmId, setConfirmId, eliminar, lastGroup }) {
  const [open, setOpen] = useState(false);
  const meses = useMemo(() => agruparPorMes(items), [items]);
  return (
    <div style={{ borderBottom: lastGroup ? "none" : "1px solid #F1F5F9" }}>
      <button onClick={() => setOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "#F8FAFC", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "7px 14px", textAlign: "left" }}>
        <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 9.5, color: "#64748B" }}>▶</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: "#0F766E", flex: 1 }}>{tipo}</span>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B" }}>({items.length})</span>
      </button>
      {open && meses.map((m, i) => (
        <MonthRow
          key={m.clave}
          label={m.label}
          items={m.items}
          ESTADO_META={ESTADO_META}
          confirmId={confirmId}
          setConfirmId={setConfirmId}
          eliminar={eliminar}
          lastRow={i === meses.length - 1}
        />
      ))}
    </div>
  );
}

function ResidentProcAccordion({ residente, procs, procList, ESTADO_META, confirmId, setConfirmId, eliminar, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const grupos = useMemo(() => agruparPorTipo(procs, procList), [procs, procList]);

  return (
    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <button onClick={() => setOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "10px 14px", textAlign: "left" }}>
          <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 11, color: "#64748B" }}>▶</span>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A", flex: 1 }}>{residente}</span>
          <span style={{ fontSize: 11, fontWeight: 800, color: procs.length > 0 ? "#0F766E" : "#CBD5E1", background: procs.length > 0 ? "#F0FDFA" : "#F8FAFC", borderRadius: 999, padding: "1px 9px", minWidth: 22, textAlign: "center" }}>{procs.length}</span>
        </button>
        {procs.length > 0 && (
          <button onClick={() => descargarPDFProcedimientos(residente, grupos)} title="Descargar registro en PDF" style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 700, color: "#64748B", padding: "8px 14px" }}>
            ⬇️ PDF
          </button>
        )}
      </div>
      {open && (
        <div style={{ borderTop: "1px solid #F1F5F9" }}>
          {procs.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "10px 14px" }}>Sin procedimientos cargados.</div>
          ) : (
            grupos.map((g, gi) => (
              <TipoGroup
                key={g.tipo}
                tipo={g.tipo}
                items={g.items}
                ESTADO_META={ESTADO_META}
                confirmId={confirmId}
                setConfirmId={setConfirmId}
                eliminar={eliminar}
                lastGroup={gi === grupos.length - 1}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ProcedimientosSection({ procedimientos, procList, isAdmin, user, misResidente }) {
  const [tipo, setTipo] = useState(procList[0] || "");
  const [fecha, setFecha] = useState(() => isoDate(new Date()));
  const [nota, setNota] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingList, setEditingList] = useState(false);
  const [nuevoProc, setNuevoProc] = useState("");
  const [confirmId, setConfirmId] = useState(null);

  useEffect(() => { if (!procList.includes(tipo)) setTipo(procList[0] || ""); }, [procList]); // eslint-disable-line

  const enviar = async () => {
    if (!misResidente || !tipo || !fecha || saving) return;
    setSaving(true);
    const ok = await escribir(setDoc(doc(collection(db, "procedimientos")), {
      residente: misResidente, tipo, fecha, nota: nota.trim(),
      estado: "pendiente", creadoPor: user?.email || "", creadoEn: new Date().toISOString(),
      revisadoPor: null, revisadoEn: null,
    }), "cargar el procedimiento");
    if (ok) setNota("");
    setSaving(false);
  };

  const revisar = async (id, estado) => {
    await escribir(setDoc(doc(db, "procedimientos", id), { estado, revisadoPor: user?.email || "", revisadoEn: new Date().toISOString() }, { merge: true }), "revisar el procedimiento");
  };

  const eliminar = async (id) => {
    await escribir(deleteDoc(doc(db, "procedimientos", id)), "borrar el procedimiento");
    setConfirmId(null);
  };

  const agregarAlaLista = async () => {
    const v = nuevoProc.trim();
    if (!v || procList.includes(v)) { setNuevoProc(""); return; }
    await escribir(setDoc(doc(db, "scheduler", "registro-config"), { procedimientosList: [...procList, v] }, { merge: true }), "agregar el tipo de procedimiento");
    setNuevoProc("");
  };

  const sacarDeLaLista = async (v) => {
    await escribir(setDoc(doc(db, "scheduler", "registro-config"), { procedimientosList: procList.filter((p) => p !== v) }, { merge: true }), "sacar el tipo de procedimiento");
  };

  const mios = useMemo(() => procedimientos.filter((p) => p.residente === misResidente), [procedimientos, misResidente]);
  const misGrupos = useMemo(() => agruparPorTipo(mios, procList), [mios, procList]);
  const pendientes = useMemo(() => procedimientos.filter((p) => p.estado === "pendiente").sort((a, b) => (a.fecha || "").localeCompare(b.fecha || "")), [procedimientos]);
  const aprobados = useMemo(() => procedimientos.filter((p) => p.estado === "aprobado"), [procedimientos]);

  const porResidente = useMemo(() => {
    const g = {};
    procedimientos.forEach((p) => { (g[p.residente] = g[p.residente] || []).push(p); });
    return g;
  }, [procedimientos]);
  const residentesConDatos = useMemo(() => ALL.filter((n) => porResidente[n]?.length), [porResidente]);

  const totalesAprobados = useMemo(() => {
    const t = {};
    aprobados.forEach((p) => { t[p.residente] = (t[p.residente] || 0) + 1; });
    return t;
  }, [aprobados]);

  const ESTADO_META = {
    pendiente: { label: "Pendiente", color: "#B45309", bg: "#FFFBEB" },
    aprobado: { label: "Aprobado", color: "#15803D", bg: "#F0FDF4" },
    rechazado: { label: "Rechazado", color: "#B91C1C", bg: "#FEF2F2" },
  };

  const exportar = () => {
    downloadCSV("procedimientos.csv", ["Residente", "Procedimiento", "Fecha", "Estado", "Nota"], procedimientos.map((p) => [p.residente, p.tipo, p.fecha, ESTADO_META[p.estado]?.label || p.estado, p.nota || ""]));
  };

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {ALL.map((n) => {
          const c = totalesAprobados[n] || 0;
          const lv = COLOR[LEVEL[n]];
          return (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 9, background: "#fff", border: "1px solid #E2E8F0" }}>
              <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: lv.solid, color: "#fff" }}>{LEVEL[n]}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>{n}</span>
              <span style={{ fontSize: 12, fontWeight: 800, color: c > 0 ? "#0F766E" : "#CBD5E1", background: c > 0 ? "#F0FDFA" : "#F8FAFC", borderRadius: 999, padding: "1px 8px", minWidth: 18, textAlign: "center" }}>{c}</span>
            </div>
          );
        })}
      </div>

      {misResidente ? (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 12, marginBottom: 14 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "#0F766E", marginBottom: 8 }}>Cargar procedimiento propio ({misResidente})</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>PROCEDIMIENTO</div>
              <select value={tipo} onChange={(e) => setTipo(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", maxWidth: 240 }}>
                {procList.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>FECHA</div>
              <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 }}>NOTA (OPCIONAL)</div>
              <input value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Detalle…" style={{ width: "100%", fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", boxSizing: "border-box" }} />
            </div>
            <button onClick={enviar} disabled={saving || !tipo} style={{ background: "#0F766E", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1 }}>
              + Enviar para aprobar
            </button>
          </div>
        </div>
      ) : (
        !isAdmin && (
          <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "6px 10px", marginBottom: 14 }}>
            Tu cuenta de Google todavía no está vinculada a ningún residente — avisale al jefe de residentes para poder cargar tus procedimientos.
          </div>
        )
      )}

      {misResidente && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", flex: 1 }}>Mis procedimientos</div>
            {mios.length > 0 && (
              <button onClick={() => descargarPDFProcedimientos(misResidente, misGrupos)} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 700, color: "#64748B" }}>
                ⬇️ Descargar PDF
              </button>
            )}
          </div>
          {mios.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "4px 2px" }}>Todavía no cargaste ninguno.</div>
          ) : (
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
              {misGrupos.map((g, gi) => (
                <TipoGroup
                  key={g.tipo}
                  tipo={g.tipo}
                  items={g.items}
                  ESTADO_META={ESTADO_META}
                  lastGroup={gi === misGrupos.length - 1}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {pendientes.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>Pendientes de aprobar ({pendientes.length})</div>
          <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
            {pendientes.map((p, i) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i === pendientes.length - 1 ? "none" : "1px solid #F1F5F9", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 6, padding: "2px 7px", minWidth: 42, textAlign: "center" }}>{fechaCorta(p.fecha)}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A", minWidth: 60 }}>{p.residente}</span>
                <span style={{ fontSize: 12.5, color: "#334155", flex: 1 }}>{p.tipo}{p.nota ? ` — ${p.nota}` : ""}</span>
                {isAdmin && (
                  <>
                    <button onClick={() => revisar(p.id, "aprobado")} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#16A34A", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>✓ Aprobar</button>
                    <button onClick={() => revisar(p.id, "rechazado")} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>✗ Rechazar</button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <button onClick={exportar} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "#64748B", padding: "2px 2px", marginBottom: 8 }}>
        ⬇️ Exportar todo a CSV
      </button>

      <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 8, marginTop: 4 }}>Historial por residente</div>
      {residentesConDatos.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "4px 2px", marginBottom: 18 }}>Todavía no hay procedimientos cargados.</div>
      ) : (
        <div style={{ marginBottom: 18 }}>
          {residentesConDatos.map((n) => (
            <ResidentProcAccordion
              key={n}
              residente={n}
              procs={porResidente[n] || []}
              procList={procList}
              ESTADO_META={ESTADO_META}
              confirmId={confirmId}
              setConfirmId={setConfirmId}
              eliminar={isAdmin ? eliminar : null}
            />
          ))}
        </div>
      )}

      {isAdmin && (
        <>
          <button onClick={() => setEditingList((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "#64748B", padding: "2px 2px", marginBottom: 8 }}>
            <span style={{ display: "inline-block", transform: editingList ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span> Editar lista de procedimientos
          </button>
          {editingList && (
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 12 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                {procList.map((p) => (
                  <div key={p} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 5px 4px 10px", borderRadius: 8, background: "#F1F5F9", fontSize: 11.5, color: "#334155", fontWeight: 600 }}>
                    {p}
                    <button onClick={() => sacarDeLaLista(p)} style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 13, fontFamily: "inherit", lineHeight: 1 }}>×</button>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input value={nuevoProc} onChange={(e) => setNuevoProc(e.target.value)} placeholder="Nuevo procedimiento…" onKeyDown={(e) => e.key === "Enter" && agregarAlaLista()} style={{ flex: 1, fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" }} />
                <button onClick={agregarAlaLista} style={{ background: "#0F766E", color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>+ Agregar</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ══════════════════ ¿QUIÉN ESTÁ HOY? (vista pública, sin login) ══════════════════ */

// Cuenta las guardias que ya estan cargadas en el scheduler y las separa entre
// las que ya pasaron y las que quedan por hacer. De paso detecta las coberturas
// de sala de R2/R3 que hay que registrar (ver detectarCoberturas) y las
// sincroniza sola con la sub-pestaña de cobertura.
function GuardiasSection({ cobertura, isAdmin }) {
  const [mesSel, setMesSel] = useState(() => {
    const h = new Date();
    const a = Math.max(0, (h.getFullYear() - MES_INICIO_ESTADISTICAS.anio) * 12 + h.getMonth() - MES_INICIO_ESTADISTICAS.mes);
    const d = new Date(MES_INICIO_ESTADISTICAS.anio, MES_INICIO_ESTADISTICAS.mes + a, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [abierto, setAbierto] = useState(null);
  const [sync, setSync] = useState(null);
  const [y, m] = mesSel.split("-").map(Number);
  const anio = y, mes = m - 1;
  const hoyIso = isoDate(new Date());

  useEffect(() => {
    let vivo = true;
    setCargando(true); setAbierto(null); setSync(null);
    (async () => {
      const dias = [];
      for (const l of lunesQueTocanElMes(anio, mes)) {
        const snap = await getDoc(doc(db, "scheduler", `week-${isoDate(l)}`));
        const w = snap.exists() ? normalize(snap.data()) : emptyWeek();
        DAYS.forEach((_, i) => {
          const f = shift(l, i);
          if (f.getMonth() !== mes || f.getFullYear() !== anio) return;
          dias.push({ fecha: f, iso: isoDate(f), di: i, d: w.days[i] });
        });
      }
      dias.sort((a, b) => a.fecha - b.fecha);
      const rotSnap = await getDoc(doc(db, "scheduler", `rotaciones-${anio}`));
      const rot = rotSnap.exists() ? normalizeRot(rotSnap.data()) : emptyRotYear();
      if (vivo) { setDatos({ dias, rot }); setCargando(false); }
    })().catch(() => { if (vivo) { setDatos(null); setCargando(false); } });
    return () => { vivo = false; };
  }, [anio, mes]);

  const resumen = useMemo(() => {
    if (!datos) return null;
    const base = () => ({ total: 0, hechas: 0, pendientes: 0, semana: 0, finde: 0, feriado: 0, fechas: [] });
    const conteo = {}, externos = {};
    const huecos = [], sobrantes = [];
    datos.dias.forEach((x) => {
      const g = x.d.deGuardia || [];
      if (g.length < 2) huecos.push(x);
      if (g.length > 2) sobrantes.push(x);
      g.forEach((n) => {
        if (!LEVEL[n]) { externos[n] = (externos[n] || 0) + 1; return; }
        const c = (conteo[n] = conteo[n] || base());
        c.total++;
        if (x.iso < hoyIso) c.hechas++; else c.pendientes++;
        if (x.d.feriado) c.feriado++; else if (isWeekendIdx(x.di)) c.finde++; else c.semana++;
        c.fechas.push({ dia: x.fecha.getDate(), di: x.di, feriado: x.d.feriado, pasada: x.iso < hoyIso });
      });
    });
    const porNivel = { R4: 0, R3: 0, R2: 0, JR: 0 };
    Object.entries(conteo).forEach(([n, c]) => { porNivel[LEVEL[n]] += c.total; });
    const mesRot = datos.rot.months[mes] || { assignments: [], vacaciones: [] };
    const fuera = {};
    (mesRot.assignments || []).forEach((a) => { fuera[a.resident] = a.exterior ? `fuera del país (${a.place})` : `rota en ${a.place}`; });
    (mesRot.vacaciones || []).forEach((v) => { fuera[v.nombre] = `de vacaciones (${(TRAMOS_VACACIONES[v.tramo] || TRAMOS_VACACIONES.mes).corto})`; });
    return { conteo, externos, porNivel, huecos, sobrantes, fuera, dias: datos.dias.length, rotantes: (mesRot.assignments || []).map((a) => a.resident) };
  }, [datos, mes, hoyIso]);

  // ── Sincronización automática con "R2 y R3 que cubrieron sala" ──────────
  // Dos situaciones obligan a registrar una cobertura: un R2 o R3 que aparece
  // en una sala el mismo día que está de postguardia, y uno que aparece en una
  // sala estando de rotación ese mes. Se detectan solas y se escriben con un id
  // fijo (auto-nombre-fecha) para que volver a entrar no duplique nada.
  const detectadas = useMemo(() => {
    if (!datos || !resumen) return [];
    const out = [];
    datos.dias.forEach((x) => {
      if (isWeekendIdx(x.di) || x.d.feriado) return;
      const enSala = [...(x.d.uti1 || []), ...(x.d.uti2 || []), ...(x.d.uti3 || [])];
      enSala.forEach((n) => {
        if (LEVEL[n] !== "R2" && LEVEL[n] !== "R3") return;
        const pg = (x.d.postguardia || []).includes(n);
        const rota = resumen.rotantes.includes(n);
        if (!pg && !rota) return;
        out.push({ id: `auto-${n}-${x.iso}`, residente: n, fecha: x.iso, modalidad: pg ? "post_guardia" : "rotacion" });
      });
    });
    return out;
  }, [datos, resumen]);

  useEffect(() => {
    if (!isAdmin || cargando || !datos) return;
    const yaEstan = new Set((cobertura || []).map((c) => c.id));
    const desdeIso = isoDate(new Date(anio, mes, 1));
    const hastaIso = isoDate(new Date(anio, mes + 1, 0));
    const faltan = detectadas.filter((x) => !yaEstan.has(x.id));
    // las automáticas de este mes que ya no corresponden se borran
    const sobran = (cobertura || []).filter((c) => String(c.id || "").startsWith("auto-") && c.fecha >= desdeIso && c.fecha <= hastaIso && !detectadas.some((d) => d.id === c.id));
    // Si no hay nada que hacer se sale sin tocar el aviso: si acabamos de
    // escribir, el snapshot vuelve a disparar este efecto y borrarlo haría
    // parpadear el mensaje.
    if (!faltan.length && !sobran.length) return;
    let cancelado = false;
    (async () => {
      for (const x of faltan) {
        await setDoc(doc(db, "cobertura_sala", x.id), { ...x, nota: "Detectada automáticamente desde el scheduler", creadoPor: "automático", creadoEn: new Date().toISOString() });
      }
      for (const c of sobran) await deleteDoc(doc(db, "cobertura_sala", c.id));
      if (!cancelado) setSync({ agregadas: faltan.length, borradas: sobran.length });
    })().catch(() => {});
    return () => { cancelado = true; };
  }, [detectadas, cobertura, isAdmin, cargando, datos, anio, mes]);

  // Nunca antes de septiembre de 2026: de ahí para atrás no hay estadística
  // que valga la pena mirar.
  const opciones = useMemo(() => {
    const hoy = new Date();
    const desde = new Date(MES_INICIO_ESTADISTICAS.anio, MES_INICIO_ESTADISTICAS.mes, 1);
    const hasta = new Date(hoy.getFullYear(), hoy.getMonth() + 7, 1);
    const out = [];
    for (let d = new Date(desde); d < hasta; d.setMonth(d.getMonth() + 1)) {
      out.push({ clave: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
    }
    return out;
  }, []);

  const cupos = { R4: CUPO_MES.R4, R3: CUPO_MES.R3, R2: cupoR2(anio, mes) };
  const caja = { background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0", padding: 16, marginBottom: 12 };
  const gente = ASIGNABLES.filter((n) => LEVEL[n] !== "JR");

  // Un grafico de barras. campo dice que columna se dibuja.
  const grafico = (titulo, subtitulo, campo, tinte) => {
    const max = Math.max(1, ...gente.map((n) => (resumen.conteo[n] || {})[campo] || 0));
    const suma = gente.reduce((a, n) => a + ((resumen.conteo[n] || {})[campo] || 0), 0);
    return (
      <div style={caja}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 2 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: "#0F172A" }}>{titulo}</div>
          <div style={{ fontSize: 12, color: "#64748B", fontVariantNumeric: "tabular-nums" }}>{suma} en total</div>
        </div>
        <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.5, marginBottom: 11 }}>{subtitulo}</div>
        {["R4", "R3", "R2"].map((lv) => {
          const del = gente.filter((n) => LEVEL[n] === lv);
          return (
            <div key={lv} style={{ marginBottom: 9 }}>
              <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.4, color: COLOR[lv].tx, marginBottom: 3 }}>{lv}</div>
              {del.map((n) => {
                const c = resumen.conteo[n];
                const v = (c || {})[campo] || 0;
                const abierta = abierto === n;
                return (
                  <div key={n}>
                    <div
                      onClick={() => setAbierto(abierta ? null : n)}
                      title="Tocá para ver los días"
                      style={{ display: "grid", gridTemplateColumns: "76px 1fr 28px", alignItems: "center", gap: 9, padding: "3px 0", cursor: "pointer" }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 700, color: v ? "#334155" : "#94A3B8" }}>{n}</span>
                      <span style={{ height: 15, background: "#F1F5F9", borderRadius: 4, overflow: "hidden" }}>
                        <span style={{ display: "block", height: "100%", width: `${(v / max) * 100}%`, background: v ? tinte : "transparent", borderRadius: 4, transition: "width .2s" }} />
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 800, textAlign: "right", color: v ? "#0F172A" : "#CBD5E1", fontVariantNumeric: "tabular-nums" }}>{v}</span>
                    </div>
                    {abierta && (
                      <div style={{ margin: "2px 0 8px 85px", padding: "8px 11px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8 }}>
                        {c ? (
                          <>
                            <div style={{ fontSize: 11, color: "#64748B", marginBottom: 5 }}>
                              {c.total} en el mes · {c.hechas} ya {c.hechas === 1 ? "hecha" : "hechas"} · {c.pendientes} por hacer · {c.semana} de semana, {c.finde} de fin de semana{c.feriado ? `, ${c.feriado} en feriado` : ""}
                            </div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                              {c.fechas.map((f) => (
                                <span key={f.dia} style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 6, fontVariantNumeric: "tabular-nums", background: f.feriado ? "#FEE2E2" : isWeekendIdx(f.di) ? "#FEF3C7" : "#E2E8F0", color: f.feriado ? "#991B1B" : isWeekendIdx(f.di) ? "#92400E" : "#334155", opacity: f.pasada ? 0.5 : 1 }}>
                                  {DAYS[f.di].slice(0, 3)} {f.dia}
                                </span>
                              ))}
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic" }}>{resumen.fuera[n] || "sin guardias este mes"}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <select value={mesSel} onChange={(e) => setMesSel(e.target.value)} style={{ fontSize: 13, padding: "8px 10px", borderRadius: 8, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155", fontWeight: 700 }}>
          {opciones.map((o) => <option key={o.clave} value={o.clave}>{o.label}</option>)}
        </select>
      </div>

      {/* El cupo del mes, en una línea. Antes eran tres pastillas con recuadro;
          es un dato de control que se mira de reojo y no necesita ese peso. */}
      {!cargando && resumen && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 20px", fontSize: 12.5, color: "#64748B", marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #E2E8F0" }}>
          <span>Cupo de {MONTHS[mes].toLowerCase()} · <b style={{ color: "#0F172A", fontVariantNumeric: "tabular-nums" }}>{cupos.R4 + cupos.R3 + cupos.R2}</b> lugares</span>
          {["R4", "R3", "R2"].map((lv) => {
            const dif = resumen.porNivel[lv] - cupos[lv];
            return (
              <span key={lv} style={{ fontVariantNumeric: "tabular-nums" }}>
                {lv} <b style={{ color: "#0F172A" }}>{resumen.porNivel[lv]}</b>/{cupos[lv]}{" "}
                <span style={{ color: dif === 0 ? "#15803D" : "#B91C1C", fontWeight: 600 }}>{dif === 0 ? "exacto" : dif > 0 ? `sobran ${dif}` : `faltan ${-dif}`}</span>
              </span>
            );
          })}
        </div>
      )}

      {cargando && <div style={caja}><span style={{ fontSize: 12.5, color: "#64748B" }}>Leyendo las semanas del mes…</span></div>}

      {!cargando && resumen && (
        <>
          {(resumen.huecos.length > 0 || resumen.sobrantes.length > 0) && (

      <div style={{ ...caja, background: "#FEF2F2", borderColor: "#FECACA" }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: "#B91C1C", marginBottom: 5 }}>Días que no cierran en dos</div>
              {[...resumen.sobrantes, ...resumen.huecos].map((x) => (
                <div key={x.iso} style={{ fontSize: 12, color: "#7F1D1D" }}>
                  <b>{DAYS[x.di]} {x.fecha.getDate()}</b> — {(x.d.deGuardia || []).length} {((x.d.deGuardia || []).length === 1 ? "persona" : "personas")}{(x.d.deGuardia || []).length ? `: ${(x.d.deGuardia || []).join(", ")}` : ""}
                </div>
              ))}
            </div>
          )}

          {grafico("Guardias asignadas", "Todo lo que está cargado en el scheduler para este mes. Tocá una barra para ver los días.", "total", "#9F1239")}
          {grafico("Guardias por realizar", `Las que quedan de hoy en adelante, al ${new Date().getDate()} de ${MONTHS[new Date().getMonth()].toLowerCase()}. Las que ya pasaron no cuentan.`, "pendientes", "#0E7490")}

          {Object.keys(resumen.externos).length > 0 && (
            <div style={caja}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: "#0F172A", marginBottom: 5 }}>De fuera del plantel</div>
              {Object.entries(resumen.externos).map(([n, c]) => (
                <div key={n} style={{ fontSize: 12, color: "#475569" }}>{n} — {c} {c === 1 ? "guardia" : "guardias"}</div>
              ))}
            </div>
          )}

          <div style={{ fontSize: 11, color: "#64748B", lineHeight: 1.55, padding: "0 2px" }}>
            {detectadas.length === 0
              ? "No hay ningún R2 ni R3 cubriendo sala en postguardia o en rotación este mes, así que no hay nada que registrar."
              : `Se detectaron ${detectadas.length} coberturas de sala de R2 o R3 (postguardia o rotación) y quedaron registradas solas en la sub-pestaña de cobertura.`}
            {sync && (sync.agregadas || sync.borradas) ? ` Recién se ${sync.agregadas ? `agregaron ${sync.agregadas}` : ""}${sync.agregadas && sync.borradas ? " y se " : ""}${sync.borradas ? `borraron ${sync.borradas} que ya no correspondían` : ""}.` : ""}
          </div>
        </>
      )}
    </div>
  );
}

/* ══════════════════ ALERTAS DE LA SEMANA ══════════════════ */

export { ClasesSection, CoberturaSection, EventosSection, GuardiasSection, MonthRow, ProcedimientosSection, RegistroView, ResidentProcAccordion, TipoGroup, descargarPDFProcedimientos };
