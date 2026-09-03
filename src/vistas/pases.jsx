/* ══════════════════════════════════════════════════════════════════════════
   La pestaña de pases
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useRef } from "react";
import { Skeleton } from "../comunes";
import { conNegritas, paLimpiar, paNombre, paseCrudo, usePaseDelDrive, PASE_FIELDS } from "../pase/motor";
import { PASES_FRESCO_MS } from "../config";
import { timeAgo } from "../fechas";
import { colorUnidad, paseArreglado } from "../modelo";
import { NAV } from "../ui";

function PasesView({ isAdmin }) {
  // Esta pestaña quiere el pase tal cual viene del Drive, sin procesar: lo
  // muestra crudo, campo por campo. (Pase App y RedCap leen el mismo
  // documento pero lo procesan distinto — de ahí que el lector sea uno solo y
  // lo que cambie sea qué se hace con cada paciente.)
  const { foto, cargando: loading } = usePaseDelDrive(paseCrudo);
  const data = foto ? foto.crudo : null;
  const [unit, setUnit] = useState(null);
  const [open, setOpen] = useState({});
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [q, setQ] = useState("");
  // Resumen por IA de cada paciente: se genera solo a demanda (al tocar el
  // botón), no automático, y queda en memoria mientras la pestaña está
  // abierta — no se guarda en Firestore.
  const [aiState, setAiState] = useState({}); // { [bed]: { loading, error, resumen, perlas, fuentes } }

  const generarResumenIA = async (p) => {
    setAiState((s) => ({ ...s, [p.bed]: { loading: true } }));
    try {
      const r = await fetch("/api/resumen-paciente", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paciente: p }),
      });
      const j = await r.json();
      if (j.ok) {
        setAiState((s) => ({ ...s, [p.bed]: { ...j.resumen, loading: false } }));
      } else {
        setAiState((s) => ({ ...s, [p.bed]: { loading: false, error: j.error || "Error al generar el resumen." } }));
      }
    } catch (e) {
      setAiState((s) => ({ ...s, [p.bed]: { loading: false, error: "No se pudo conectar con el servidor." } }));
    }
  };

  // Refresco automático al abrir la pestaña, si el resumen está viejo.
  //
  // La sincronización de fondo la dispara un cron de GitHub Actions cada 2
  // horas, pero el scheduler de GitHub es "best effort" y en la práctica no
  // cumple: medido sobre este mismo repo, los intervalos reales van de 1h55 a
  // 4h36, y llegó a estar 13 horas sin correr una sola vez. Por eso no se
  // puede depender solo de él. Esto cubre el caso que importa —alguien abre la
  // pestaña y quiere ver los pases de ahora— sin tocar el cron ni sumar otro
  // servicio: si el dato está viejo, se pide una sincronización y listo.
  //
  // Se dispara una sola vez por apertura de la pestaña. Si varios lo abren a
  // la vez pueden salir dos o tres pedidos en simultáneo, pero el endpoint es
  // idempotente y en cuanto el primero termina, el onSnapshot le refresca el
  // updatedAt a todos y los demás ya no entran.
  const yaRefresco = useRef(false);
  useEffect(() => {
    if (loading || yaRefresco.current) return;
    const edad = data && data.updatedAt ? Date.now() - new Date(data.updatedAt).getTime() : Infinity;
    if (edad < PASES_FRESCO_MS) return;
    yaRefresco.current = true;
    setSyncing(true);
    fetch("/api/sync-pases")
      .then((r) => r.json())
      .then((j) => { if (!j.ok) setSyncMsg("⚠ No se pudo actualizar el resumen"); })
      .catch(() => setSyncMsg("⚠ No se pudo actualizar el resumen"))
      .finally(() => { setSyncing(false); setTimeout(() => setSyncMsg(null), 5000); });
  }, [loading, data]);

  const order = data?.unitOrder?.length ? data.unitOrder : Object.keys(data?.units || {});
  const activeUnit = unit && order.includes(unit) ? unit : order[0];
  const patients = (data?.units?.[activeUnit] || []).filter((p) => {
    if (!q.trim()) return true;
    const hay = `${p.bed} ${p.name} ${p.mi} ${p.status}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  const sync = async () => {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await fetch("/api/sync-pases");
      const j = await r.json();
      if (j.ok) {
        setSyncMsg(`✓ ${j.totalPatients} pacientes actualizados`);
        if (j.errors?.length) setSyncMsg(`✓ ${j.totalPatients} pacientes · ${j.errors.length} doc con problema`);
      } else setSyncMsg("⚠ " + (j.error || "Error al sincronizar"));
    } catch (e) {
      setSyncMsg("⚠ No se pudo conectar con el servidor");
    }
    setSyncing(false);
    setTimeout(() => setSyncMsg(null), 5000);
  };

  if (loading) return <Skeleton />;

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🛏️</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Resumen de pases</div>
            <div style={{ fontSize: 10.5, opacity: 0.55 }}>
              Actualizado {timeAgo(data?.updatedAt)}
              {data?.totalPatients ? ` · ${data.totalPatients} pacientes` : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {syncMsg && <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.9 }}>{syncMsg}</span>}
          {isAdmin && (
            <button onClick={sync} disabled={syncing} style={{ ...NAV, width: "auto", padding: "6px 12px", fontSize: 11, opacity: syncing ? 0.5 : 1 }}>
              {syncing ? "Sincronizando…" : "↻ Sincronizar"}
            </button>
          )}
        </div>
      </div>

      {data?.errors?.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {data.errors.map((e, i) => (
            <div key={i} style={{ background: "#FEF2F2", border: "1px solid #FECACA", color: "#991B1B", padding: "7px 12px", borderRadius: 9, fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>
              ⚠ <b>{e.unit}</b>: {e.error}
            </div>
          ))}
        </div>
      )}

      {!data || !order.length ? (
        <div style={{ textAlign: "center", padding: "50px 20px", color: "#64748B", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
          Todavía no se sincronizó ningún pase.
          {isAdmin && <div style={{ fontSize: 11.5, marginTop: 8 }}>Tocá "Sincronizar" para traerlos de los documentos.</div>}
        </div>
      ) : (
        <>
          {/* Selector de unidad */}
          <div className="no-print" style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8, marginBottom: 8 }}>
            {order.map((u) => {
              const n = data.units[u]?.length || 0;
              const on = u === activeUnit;
              return (
                <button key={u} onClick={() => { setUnit(u); setOpen({}); }} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 5, border: `1.5px solid ${on ? colorUnidad(u).fuerte : "#E2E8F0"}`, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, background: on ? colorUnidad(u).fuerte : "#fff", color: on ? "#fff" : "#475569", display: "flex", alignItems: "center", gap: 6 }}>
                  {u}
                  <span style={{ fontSize: 10, fontWeight: 700, fontFamily: "ui-monospace,monospace", opacity: on ? 0.85 : 0.6 }}>{n}</span>
                </button>
              );
            })}
          </div>

          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por cama, nombre o diagnóstico…" className="no-print" style={{ width: "100%", padding: "9px 12px", borderRadius: 5, border: "1px solid #E2E8F0", fontSize: 12.5, fontFamily: "inherit", marginBottom: 10, outline: "none", boxSizing: "border-box", color: "#0F172A" }} />

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {patients.length === 0 ? (
              <div style={{ textAlign: "center", padding: 30, color: "#64748B", fontSize: 12.5, background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0" }}>
                {q ? "Ningún paciente coincide con la búsqueda" : "Sin pacientes en esta unidad"}
              </div>
            ) : patients.map((p) => {
              const isOpen = !!open[p.bed];
              return (
                <div key={p.bed} style={{ background: "#fff", borderRadius: 6, border: "1px solid #E2E8F0", borderLeft: `4px solid ${colorUnidad(activeUnit).fuerte}`, overflow: "hidden" }}>
                  <div onClick={() => setOpen((o) => ({ ...o, [p.bed]: !o[p.bed] }))} style={{ padding: "11px 13px", cursor: "pointer", display: "flex", gap: 11, alignItems: "flex-start" }}>
                    <div style={{ flexShrink: 0, minWidth: 42, textAlign: "center", background: colorUnidad(activeUnit).suave, color: colorUnidad(activeUnit).fuerte, border: `1px solid ${colorUnidad(activeUnit).fuerte}22`, borderRadius: 5, padding: "5px 7px", fontWeight: 800, fontSize: 14, fontFamily: "ui-monospace,monospace", lineHeight: 1.2 }}>{p.bed}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 700, fontSize: 13.5, color: "#0F172A" }}>{paNombre(p.name).nombre || "—"}</span>
                        {p.age && <span style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600 }}>{p.age} años</span>}
                      </div>
                      {p.flags?.length > 0 && (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                          {p.flags.map((f, i) => (
                            <span key={i} style={{ fontSize: 9.5, fontWeight: 700, background: "#FEF2F2", color: "#B91C1C", border: "1px solid #FECACA", padding: "2px 6px", borderRadius: 5 }}>{f}</span>
                          ))}
                        </div>
                      )}
                      {p.vacia
                        ? <div style={{ fontSize: 12, color: "#94A3B8", fontStyle: "italic", marginTop: 4 }}>Cama libre</div>
                        : p.mi && <div style={{ fontSize: 12, color: colorUnidad(activeUnit).fuerte, fontWeight: 600, marginTop: 4, lineHeight: 1.35 }}>{paLimpiar(p.mi)}</div>}
                      {p.status && <div style={{ fontSize: 11.5, color: "#475569", marginTop: 5, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: isOpen ? "unset" : 2, WebkitBoxOrient: "vertical", overflow: isOpen ? "visible" : "hidden" }}>{paLimpiar(p.status)}</div>}
                    </div>
                    <div style={{ flexShrink: 0, color: "#64748B", fontSize: 12, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▼</div>
                  </div>

                  {isOpen && (
                    <div style={{ borderTop: "1px solid #F1F5F9", padding: "4px 13px 12px" }}>
                      {(() => { const ff = paseArreglado(p.fields); return PASE_FIELDS.filter(([k]) => ff[k]).map(([k, label]) => (
                        <div key={k} style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#64748B", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
                          <div style={{ fontSize: 11.5, color: "#334155", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{conNegritas(ff[k], "p" + k)}</div>
                        </div>
                      )); })()}
                      <ResumenIAPaciente p={p} state={aiState[p.bed]} onGenerar={() => generarResumenIA(p)} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Resumen de un paciente en particular generado por IA, a demanda (nunca
// automático). Se arma con toda la información cargada en el pase de ese
// paciente y devuelve un resumen clínico formal + 5 perlas basadas en MBE
// revisada por pares, con citas si corresponde.
function ResumenIAPaciente({ p, state, onGenerar }) {
  if (!state) {
    return (
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #E2E8F0" }}>
        <button onClick={(e) => { e.stopPropagation(); onGenerar(); }} style={{ display: "flex", alignItems: "center", gap: 6, background: "#EEF2FF", color: "#3730A3", border: "1px solid #C7D2FE", borderRadius: 8, padding: "7px 13px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          🤖 Generar resumen de este paciente en IA
        </button>
      </div>
    );
  }

  if (state.loading) {
    return (
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #E2E8F0", fontSize: 11.5, color: "#6366F1", fontWeight: 600 }}>
        🤖 Generando resumen clínico y perlas basadas en evidencia… puede tardar unos segundos.
      </div>
    );
  }

  if (state.error) {
    return (
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #E2E8F0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, background: "#FEF2F2", border: "1px solid #FECACA", color: "#991B1B", padding: "6px 12px", borderRadius: 9, fontSize: 11.5, fontWeight: 500, marginBottom: 8 }}>
          ⛔ {state.error}
        </div>
        <button onClick={(e) => { e.stopPropagation(); onGenerar(); }} style={{ background: "#EEF2FF", color: "#3730A3", border: "1px solid #C7D2FE", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #E2E8F0" }} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: "#3730A3", letterSpacing: 0.4, textTransform: "uppercase" }}>🤖 Resumen clínico generado por IA</div>
        <button onClick={onGenerar} style={{ background: "none", border: "none", color: "#64748B", fontSize: 10.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>↻ Regenerar</button>
      </div>

      {state.resumen && <div style={{ fontSize: 11.5, color: "#1E1B4B", lineHeight: 1.6, whiteSpace: "pre-wrap", marginBottom: 12 }}>{state.resumen}</div>}

      {state.perlas?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#64748B", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 5 }}>Perlas clínicas · MBE</div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {state.perlas.map((perla, i) => (
              <li key={i} style={{ fontSize: 11.5, color: "#334155", lineHeight: 1.55, marginBottom: 6 }}>{perla}</li>
            ))}
          </ol>
        </div>
      )}

      {state.fuentes?.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#64748B", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 5 }}>Fuentes citadas</div>
          {state.fuentes.map((f, i) => (
            <div key={i} style={{ fontSize: 10.5, color: "#64748B", lineHeight: 1.5, marginBottom: 2 }}>
              {f.referencia}{f.url ? <> — <a href={f.url} target="_blank" rel="noreferrer" style={{ color: "#4F46E5" }}>{f.url}</a></> : ""}
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 10, color: "#64748B", fontStyle: "italic", lineHeight: 1.4 }}>
        Generado por IA como apoyo — no reemplaza el juicio clínico. Verificá siempre las citas antes de usarlas.
      </div>
    </div>
  );
}

/* ══════════════════ CHIPA Y AURA DE LA SEMANA VIEW ══════════════════ */

export { PasesView, ResumenIAPaciente };
