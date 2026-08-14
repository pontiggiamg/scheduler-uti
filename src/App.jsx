import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react";
import { db } from "./firebase";
import { doc, onSnapshot, setDoc, getDoc } from "firebase/firestore";

/* ══════════════════ CONFIGURACIÓN ══════════════════ */

const RESIDENTS = {
  R2: ["Maca", "Andy", "Nata", "Nahuel"],
  R3: ["Chris", "Ulloa", "Varoli", "Gian"],
  R4: ["Dani", "Caro", "Leo", "Vani"],
};

const ALL = [...RESIDENTS.R2, ...RESIDENTS.R3, ...RESIDENTS.R4];

const LEVEL = Object.fromEntries(
  Object.entries(RESIDENTS).flatMap(([lv, names]) => names.map((n) => [n, lv]))
);

const COLOR = {
  R2: { bg: "#DBEAFE", bd: "#93C5FD", tx: "#1E3A8A", solid: "#3B82F6" },
  R3: { bg: "#D1FAE5", bd: "#6EE7B7", tx: "#065F46", solid: "#10B981" },
  R4: { bg: "#FFEDD5", bd: "#FDBA74", tx: "#9A3412", solid: "#F97316" },
};

const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"];
const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

const SLOTS = [
  { key: "uti1", label: "UTI 1", accent: "#3B82F6", tint: "#DBEAFE" },
  { key: "uti2", label: "UTI 2", accent: "#3B82F6", tint: "#D1FAE5" },
  { key: "uti3", label: "UTI 3", accent: "#3B82F6", tint: "#FEF3C7" },
  { key: "postguardia", label: "Postguardia", accent: "#A855F7", tint: "#E9D5FF" },
];

const SLOT_KEYS = SLOTS.map((s) => s.key);

/* ══════════════════ FECHAS ══════════════════ */

function mondayOf(date) {
  const d = new Date(date);
  const wd = d.getDay();
  d.setDate(d.getDate() - wd + (wd === 0 ? -6 : 1));
  d.setHours(0, 0, 0, 0);
  return d;
}
const shift = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dm = (d) => `${d.getDate()}/${d.getMonth() + 1}`;
const sameDay = (a, b) => isoDate(a) === isoDate(b);

/* ══════════════════ MODELO SEMANA ══════════════════ */

const emptyDay = () => ({ uti1: [], uti2: [], uti3: [], postguardia: [], unavailable: [], observaciones: "", recordatorios: "" });
const emptyWeek = () => ({ days: DAYS.map(() => emptyDay()) });

function normalize(raw) {
  const week = emptyWeek();
  if (!raw || typeof raw !== "object") return week;
  const legacyGlobal = Array.isArray(raw.unavailable) ? raw.unavailable : [];
  const src = raw.days || {};
  for (let i = 0; i < 5; i++) {
    const d = src[i] || {};
    const day = week.days[i];
    for (const k of SLOT_KEYS) {
      const v = d[k];
      day[k] = Array.isArray(v) ? v.filter((n) => LEVEL[n]) : typeof v === "string" && v ? [v] : [];
    }
    day.unavailable = Array.isArray(d.unavailable) ? d.unavailable.filter((n) => LEVEL[n]) : [...legacyGlobal];
    day.observaciones = typeof d.observaciones === "string" ? d.observaciones : "";
    day.recordatorios = typeof d.recordatorios === "string" ? d.recordatorios : "";
  }
  return week;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const isBlank = (w) => w.days.every((d) => SLOT_KEYS.every((k) => d[k].length === 0) && d.unavailable.length === 0 && !d.observaciones.trim() && !d.recordatorios.trim());

/* ══════════════════ MODELO ROTACIONES ══════════════════ */

const emptyRotYear = () => {
  const m = {};
  for (let i = 0; i < 12; i++) m[i] = { assignments: [], notes: "" };
  return { months: m };
};

function normalizeRot(raw) {
  const year = emptyRotYear();
  if (!raw || typeof raw !== "object" || !raw.months) return year;
  for (let i = 0; i < 12; i++) {
    const m = raw.months[i];
    if (m) {
      year.months[i].assignments = Array.isArray(m.assignments) ? m.assignments : [];
      year.months[i].notes = typeof m.notes === "string" ? m.notes : "";
    }
  }
  return year;
}

/* ══════════════════ APP PRINCIPAL ══════════════════ */

export default function App() {
  const [tab, setTab] = useState("scheduler");

  return (
    <div style={{ maxWidth: 1500, margin: "0 auto", padding: "14px 12px 40px", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div className="no-print" style={{ display: "flex", gap: 0, marginBottom: 14 }}>
        <TabBtn active={tab === "scheduler"} onClick={() => setTab("scheduler")}>📅 Semana</TabBtn>
        <TabBtn active={tab === "rotaciones"} onClick={() => setTab("rotaciones")}>🔄 Rotaciones y Vacaciones</TabBtn>
      </div>
      {tab === "scheduler" ? <SchedulerView /> : <RotacionesView />}
    </div>
  );
}

const TabBtn = ({ active, onClick, children }) => (
  <button onClick={onClick} style={{
    padding: "10px 22px", fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: "pointer",
    background: active ? "#0F172A" : "#E2E8F0", color: active ? "#fff" : "#64748B",
    border: "none", borderRadius: active ? "10px 10px 0 0" : "10px 10px 0 0",
    transition: "all .15s", letterSpacing: 0.1,
  }}>{children}</button>
);

/* ══════════════════ SCHEDULER VIEW ══════════════════ */

function SchedulerView() {
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [week, setWeek] = useState(emptyWeek);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("idle");
  const [sel, setSel] = useState(null);
  const [toast, setToast] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const docId = `week-${isoDate(monday)}`;
  const pending = useRef(null);
  const timer = useRef(null);
  const statusTimer = useRef(null);
  const dirty = useRef(false);
  const toastTimer = useRef(null);

  useEffect(() => {
    setLoading(true); setSel(null); dirty.current = false;
    const ref = doc(db, "scheduler", docId);
    const unsub = onSnapshot(ref, { includeMetadataChanges: false }, (snap) => {
      if (snap.metadata.hasPendingWrites || dirty.current) { setLoading(false); return; }
      setWeek(snap.exists() ? normalize(snap.data()) : emptyWeek());
      setLoading(false);
    }, (err) => { console.error("snapshot", err); setStatus("error"); setLoading(false); });
    return () => { unsub(); if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [docId]);

  const flush = useCallback(async () => {
    const payload = pending.current; if (!payload) return;
    pending.current = null; setStatus("saving");
    try { await setDoc(doc(db, "scheduler", docId), payload); dirty.current = false; setStatus("saved");
      if (statusTimer.current) clearTimeout(statusTimer.current);
      statusTimer.current = setTimeout(() => setStatus("idle"), 1600);
    } catch (e) { console.error("save", e); setStatus("error"); }
  }, [docId]);

  const commit = useCallback((next, delay = 350) => {
    setWeek(next); dirty.current = true; pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delay);
  }, [flush]);

  useEffect(() => { const h = () => { if (pending.current) flush(); }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, [flush]);

  const flash = (msg) => { setToast(msg); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 2400); };

  const locationOf = (w, name, di) => { const d = w.days[di]; for (const k of SLOT_KEYS) if (d[k].includes(name)) return k; if (d.unavailable.includes(name)) return "unavailable"; return null; };
  const detach = (w, name, di) => { const d = w.days[di]; for (const k of SLOT_KEYS) d[k] = d[k].filter((n) => n !== name); d.unavailable = d.unavailable.filter((n) => n !== name); };

  const pool = useCallback((di) => {
    const d = week.days[di];
    const used = new Set([...SLOT_KEYS.flatMap((k) => d[k]), ...d.unavailable]);
    return ALL.filter((n) => !used.has(n));
  }, [week]);

  const pick = (name, from) => { setSel((cur) => cur && cur.name === name && cur.from?.di === from?.di && cur.from?.key === from?.key ? null : { name, from }); };

  const place = (target, di) => {
    if (!sel) return;
    const { name, from } = sel; setSel(null);
    if (from && from.di === di && from.key === target) return;
    const next = clone(week);
    if (target === "pool") { detach(next, name, di); commit(next); return; }
    const already = locationOf(next, name, di);
    if (already && already !== from?.key) { const nice = already === "unavailable" ? "no disponible" : already.toUpperCase(); flash(`${name} ya figura el ${DAYS[di]} en ${nice}`); return; }
    if (from) detach(next, name, from.di);
    detach(next, name, di);
    next.days[di][target].push(name);
    commit(next);
  };

  const removeChip = (name, di) => { const next = clone(week); detach(next, name, di); setSel(null); commit(next); };
  const editText = (di, field, value) => { const next = clone(week); next.days[di][field] = value; commit(next, 700); };

  const copyPrevWeek = async () => {
    setMenuOpen(false);
    if (!isBlank(week) && !confirm("Esto reemplaza la semana actual. ¿Continuar?")) return;
    try { const prevId = `week-${isoDate(shift(monday, -7))}`; const snap = await getDoc(doc(db, "scheduler", prevId));
      if (!snap.exists()) return flash("La semana anterior está vacía");
      commit(normalize(snap.data()), 0); flash("Semana anterior copiada");
    } catch (e) { console.error(e); flash("No se pudo copiar"); }
  };

  const clearWeek = () => { setMenuOpen(false); if (!confirm("¿Vaciar toda la semana?")) return; setSel(null); commit(emptyWeek(), 0); };

  const dates = useMemo(() => DAYS.map((_, i) => shift(monday, i)), [monday]);
  const today = new Date();
  const active = sel != null;

  useEffect(() => { const onKey = (e) => e.key === "Escape" && setSel(null); window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);

  return (
    <div onClick={() => { setSel(null); setMenuOpen(false); }}>
      <SchedulerHeader monday={monday} setMonday={setMonday} status={status} menuOpen={menuOpen} setMenuOpen={setMenuOpen} onCopyPrev={copyPrevWeek} onClear={clearWeek} />

      <div style={{ minHeight: 34, marginBottom: 6 }} className="no-print">
        {toast ? <Banner tone="warn">{toast}</Banner> : active ? <Banner tone="info"><b>{sel.name}</b> seleccionado — tocá una celda para ubicarlo, o Esc para cancelar</Banner> : <div style={{ fontSize: 12, color: "#94A3B8", padding: "6px 2px" }}>Tocá un residente para seleccionarlo y después la celda donde va.</div>}
      </div>

      {loading ? <Skeleton /> : (
        <div style={{ overflowX: "auto", paddingBottom: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: "104px repeat(5, minmax(178px, 1fr))", background: "#fff", borderRadius: 14, overflow: "hidden", border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(15,23,42,.06)", minWidth: 1000 }}>
            <Corner />{DAYS.map((d, i) => <DayHead key={d} name={d} date={dates[i]} isToday={sameDay(dates[i], today)} />)}

            {/* UTI 1, 2, 3, Postguardia */}
            {SLOTS.map((slot, ri) => (
              <Fragment key={slot.key}>
                <RowLabel label={slot.label} color={slot.accent} />
                {DAYS.map((_, di) => (
                  <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place(slot.key, di); }} tint={slot.tint} ring={active ? slot.accent : null} lastCol={di === 4}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 40 }}>
                      {week.days[di][slot.key].sort((a, b) => { const order = { R4: 0, R3: 1, R2: 2 }; return (order[LEVEL[a]] || 3) - (order[LEVEL[b]] || 3); }).map((n) => (
                        <Chip key={n} name={n} selected={sel?.name === n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: slot.key }); }} onRemove={(e) => { e.stopPropagation(); removeChip(n, di); }} />
                      ))}
                      {active && <GhostHint color={slot.accent} name={sel.name} />}
                      {!active && week.days[di][slot.key].length === 0 && <Dash />}
                    </div>
                  </Cell>
                ))}
              </Fragment>
            ))}

            {/* OBSERVACIONES — ahora después de Postguardia */}
            <RowLabel label="Observaciones" color="#475569" />
            {DAYS.map((_, di) => (
              <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === 4}>
                <textarea value={week.days[di].observaciones} onChange={(e) => editText(di, "observaciones", e.target.value)} placeholder="Supervisores, pases, avisos…" style={TEXTAREA} />
              </Cell>
            ))}

            {/* RECORDATORIOS — ahora después de Observaciones */}
            <RowLabel label="Recordatorios" color="#B45309" />
            {DAYS.map((_, di) => (
              <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === 4}>
                <textarea value={week.days[di].recordatorios} onChange={(e) => editText(di, "recordatorios", e.target.value)} placeholder="Clases, ateneos, horarios…" style={{ ...TEXTAREA, background: "#FFFBEB", borderColor: "#FDE68A", color: "#78350F" }} />
              </Cell>
            ))}

            {/* Disponibles */}
            <RowLabel label="Disponibles" color="#16A34A" />
            {DAYS.map((_, di) => {
              const free = pool(di);
              return (
                <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place("pool", di); }} tint="#F0FDF4" ring={active ? "#22C55E" : null} lastCol={di === 4}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 50 }}>
                    {active && <div style={{ fontSize: 10, color: "#16A34A", fontWeight: 600, textAlign: "center", padding: "1px 0" }}>↩ liberar el {DAYS[di].toLowerCase()}</div>}
                    {free.length === 0 ? (!active && <div style={{ fontSize: 10.5, color: "#94A3B8", fontStyle: "italic", textAlign: "center", padding: 6 }}>todos asignados</div>) : free.map((n) => <Chip key={n} name={n} selected={sel?.name === n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: "pool" }); }} />)}
                  </div>
                </Cell>
              );
            })}

            {/* No disponibles */}
            <RowLabel label="No disponibles" color="#DC2626" sub="rotación · vacaciones" />
            {DAYS.map((_, di) => (
              <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place("unavailable", di); }} tint="#FEF2F2" ring={active ? "#F87171" : null} lastCol={di === 4} lastRow>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 40 }}>
                  {week.days[di].unavailable.map((n) => <OutChip key={n} name={n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: "unavailable" }); }} selected={sel?.name === n} />)}
                  {active && <div style={{ fontSize: 10, color: "#EF4444", fontWeight: 600, textAlign: "center", padding: "1px 0" }}>marcar solo el {DAYS[di].toLowerCase()}</div>}
                  {!active && week.days[di].unavailable.length === 0 && <Dash />}
                </div>
              </Cell>
            ))}
          </div>
        </div>
      )}
      <Legend />
    </div>
  );
}

/* ══════════════════ ROTACIONES VIEW ══════════════════ */

function RotacionesView() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState(emptyRotYear);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("idle");
  const [editing, setEditing] = useState(null); // { month, idx } or { month, "new" }

  const docId = `rotaciones-${year}`;
  const pending = useRef(null);
  const timer = useRef(null);
  const statusTimer = useRef(null);

  useEffect(() => {
    setLoading(true);
    const ref = doc(db, "scheduler", docId);
    const unsub = onSnapshot(ref, (snap) => {
      setData(snap.exists() ? normalizeRot(snap.data()) : emptyRotYear());
      setLoading(false);
    }, () => { setLoading(false); });
    return () => { unsub(); if (timer.current) clearTimeout(timer.current); };
  }, [docId]);

  const save = useCallback(async (next) => {
    setData(next); pending.current = next; setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { await setDoc(doc(db, "scheduler", docId), pending.current); setStatus("saved");
        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus("idle"), 1600);
      } catch (e) { console.error(e); setStatus("error"); }
    }, 400);
  }, [docId]);

  const addAssignment = (mi) => {
    setEditing({ month: mi, mode: "new", resident: "", place: "" });
  };

  const saveAssignment = (mi, resident, place, idx) => {
    if (!resident.trim() || !place.trim()) return;
    const next = clone(data);
    if (idx !== undefined && idx !== null) {
      next.months[mi].assignments[idx] = { resident: resident.trim(), place: place.trim() };
    } else {
      next.months[mi].assignments.push({ resident: resident.trim(), place: place.trim() });
    }
    save(next);
    setEditing(null);
  };

  const removeAssignment = (mi, idx) => {
    const next = clone(data);
    next.months[mi].assignments.splice(idx, 1);
    save(next);
  };

  const editNotes = (mi, val) => {
    const next = clone(data);
    next.months[mi].notes = val;
    save(next);
  };

  const S = { saving: { t: "Guardando…", c: "#CBD5E1" }, saved: { t: "✓ Guardado", c: "#86EFAC" }, error: { t: "⚠ Error", c: "#FCA5A5" } }[status];

  if (loading) return <Skeleton />;

  return (
    <div>
      {/* Header */}
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🔄</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Rotaciones y Vacaciones</div>
            <div style={{ fontSize: 10.5, opacity: 0.55 }}>Hospital Británico</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => setYear(y => y - 1)} style={NAV}>◀</button>
          <div style={{ fontWeight: 700, fontSize: 18, minWidth: 60, textAlign: "center" }}>{year}</div>
          <button onClick={() => setYear(y => y + 1)} style={NAV}>▶</button>
        </div>
        <div>{S && <div style={{ fontSize: 10.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: "rgba(255,255,255,.12)", color: S.c }}>{S.t}</div>}</div>
      </div>

      {/* Grid */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {MONTHS.map((mName, mi) => {
          const month = data.months[mi];
          const isCurrentMonth = new Date().getFullYear() === year && new Date().getMonth() === mi;
          return (
            <div key={mi} style={{ background: "#fff", borderRadius: 12, border: isCurrentMonth ? "2px solid #3B82F6" : "1px solid #E2E8F0", overflow: "hidden", boxShadow: isCurrentMonth ? "0 0 0 3px #3B82F633" : "0 1px 3px rgba(15,23,42,.04)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: isCurrentMonth ? "#EFF6FF" : "#F8FAFC", borderBottom: "1px solid #E2E8F0" }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: isCurrentMonth ? "#1D4ED8" : "#0F172A" }}>{mName}</div>
                <button onClick={() => addAssignment(mi)} style={{ background: "#E2E8F0", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", color: "#475569", fontFamily: "inherit" }}>+ Agregar</button>
              </div>
              <div style={{ padding: "8px 14px" }}>
                {month.assignments.length === 0 && !editing?.month === mi ? (
                  <div style={{ fontSize: 11.5, color: "#94A3B8", fontStyle: "italic", padding: "6px 0" }}>Sin rotaciones este mes</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: month.assignments.length > 0 ? 8 : 0 }}>
                    {month.assignments.map((a, idx) => {
                      const lv = LEVEL[a.resident];
                      const c = lv ? COLOR[lv] : { bg: "#F1F5F9", bd: "#CBD5E1", tx: "#475569", solid: "#64748B" };
                      const isEditing = editing && editing.month === mi && editing.idx === idx;

                      if (isEditing) {
                        return (
                          <EditForm key={idx} resident={editing.resident} place={editing.place}
                            onResChange={(v) => setEditing({ ...editing, resident: v })}
                            onPlaceChange={(v) => setEditing({ ...editing, place: v })}
                            onSave={() => saveAssignment(mi, editing.resident, editing.place, idx)}
                            onCancel={() => setEditing(null)} />
                        );
                      }

                      return (
                        <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, background: c.bg, border: `1.5px solid ${c.bd}`, fontSize: 12 }}>
                          <span style={{ fontWeight: 700, color: c.tx }}>{a.resident}</span>
                          <span style={{ color: "#64748B", fontWeight: 500 }}>({a.place})</span>
                          {lv && <span style={{ fontSize: 8, fontWeight: 800, background: c.solid, color: "#fff", padding: "1px 4px", borderRadius: 3 }}>{lv}</span>}
                          <span onClick={() => setEditing({ month: mi, idx, resident: a.resident, place: a.place })} style={{ cursor: "pointer", fontSize: 11, opacity: 0.4 }} title="Editar">✏️</span>
                          <span onClick={() => removeAssignment(mi, idx)} style={{ cursor: "pointer", fontSize: 11, opacity: 0.4 }} title="Eliminar">✕</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {editing && editing.month === mi && editing.mode === "new" && (
                  <EditForm resident={editing.resident} place={editing.place}
                    onResChange={(v) => setEditing({ ...editing, resident: v })}
                    onPlaceChange={(v) => setEditing({ ...editing, place: v })}
                    onSave={() => saveAssignment(mi, editing.resident, editing.place)}
                    onCancel={() => setEditing(null)} />
                )}

                <textarea value={month.notes} onChange={(e) => editNotes(mi, e.target.value)} placeholder="Vacaciones del mes…" style={{ ...TEXTAREA, minHeight: 32, marginTop: 4, fontSize: 11, fontStyle: month.notes ? "normal" : "italic", color: month.notes ? "#92400E" : "#94A3B8", background: month.notes ? "#FFFBEB" : "#FAFAFA", borderColor: month.notes ? "#FDE68A" : "#E2E8F0" }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const EditForm = ({ resident, place, onResChange, onPlaceChange, onSave, onCancel }) => (
  <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0" }}>
    <select value={resident} onChange={(e) => onResChange(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", background: "#fff", color: "#0F172A" }}>
      <option value="">Residente…</option>
      {ALL.map((n) => <option key={n} value={n}>{n} ({LEVEL[n]})</option>)}
    </select>
    <input value={place} onChange={(e) => onPlaceChange(e.target.value)} placeholder="Lugar (ej: Fernandez, Ecocardio)" onKeyDown={(e) => e.key === "Enter" && onSave()} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", flex: 1, minWidth: 140, color: "#0F172A" }} />
    <button onClick={onSave} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓</button>
    <button onClick={onCancel} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✕</button>
  </div>
);

/* ══════════════════ SCHEDULER HEADER ══════════════════ */

function SchedulerHeader({ monday, setMonday, status, menuOpen, setMenuOpen, onCopyPrev, onClear }) {
  const S = { saving: { t: "Guardando…", c: "#CBD5E1", b: "rgba(255,255,255,.12)" }, saved: { t: "✓ Guardado", c: "#86EFAC", b: "rgba(34,197,94,.18)" }, error: { t: "⚠ Sin conexión", c: "#FCA5A5", b: "rgba(239,68,68,.18)" } }[status];
  return (
    <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22 }}>🏥</span>
        <div><div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Scheduler UTI</div><div style={{ fontSize: 10.5, opacity: 0.55, letterSpacing: 0.2 }}>Hospital Británico</div></div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={(e) => { e.stopPropagation(); setMonday(shift(monday, -7)); }} style={NAV}>◀</button>
        <div style={{ textAlign: "center", minWidth: 172 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{dm(monday)} — {dm(shift(monday, 4))}</div>
          <input type="date" value={isoDate(monday)} onClick={(e) => e.stopPropagation()} onChange={(e) => e.target.value && setMonday(mondayOf(new Date(e.target.value + "T12:00:00")))} style={{ background: "rgba(255,255,255,.14)", border: "none", borderRadius: 6, color: "#fff", padding: "3px 7px", fontSize: 10.5, marginTop: 3, cursor: "pointer", fontFamily: "inherit" }} />
        </div>
        <button onClick={(e) => { e.stopPropagation(); setMonday(shift(monday, 7)); }} style={NAV}>▶</button>
        <button onClick={(e) => { e.stopPropagation(); setMonday(mondayOf(new Date())); }} style={{ ...NAV, width: "auto", padding: "6px 11px", fontSize: 11, fontWeight: 600 }}>Hoy</button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
        {S && <div style={{ fontSize: 10.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: S.b, color: S.c }}>{S.t}</div>}
        <button onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }} style={{ ...NAV, width: "auto", padding: "6px 10px" }}>⋯</button>
        {menuOpen && (
          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, background: "#fff", borderRadius: 10, boxShadow: "0 10px 30px rgba(15,23,42,.22)", border: "1px solid #E2E8F0", overflow: "hidden", zIndex: 40, minWidth: 210 }}>
            <MenuItem onClick={onCopyPrev}>📋 Copiar semana anterior</MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); window.print(); }}>🖨️ Imprimir / PDF</MenuItem>
            <MenuItem onClick={onClear} danger>🗑️ Vaciar semana</MenuItem>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════ COMPONENTES COMPARTIDOS ══════════════════ */

const MenuItem = ({ children, onClick, danger }) => (<button onClick={onClick} style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", border: "none", background: "transparent", fontSize: 12.5, fontFamily: "inherit", cursor: "pointer", color: danger ? "#DC2626" : "#334155", fontWeight: 500 }} onMouseEnter={(e) => (e.currentTarget.style.background = danger ? "#FEF2F2" : "#F8FAFC")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>{children}</button>);

const Banner = ({ tone, children }) => { const c = tone === "warn" ? { bg: "#FEF2F2", bd: "#FECACA", tx: "#991B1B", icon: "⛔" } : { bg: "#EFF6FF", bd: "#BFDBFE", tx: "#1E40AF", icon: "👆" }; return (<div style={{ display: "flex", alignItems: "center", gap: 7, background: c.bg, border: `1px solid ${c.bd}`, color: c.tx, padding: "6px 12px", borderRadius: 9, fontSize: 12, fontWeight: 500 }}><span>{c.icon}</span><span>{children}</span></div>); };

const Corner = () => (<div style={{ background: "#F8FAFC", borderBottom: "2px solid #E2E8F0", borderRight: "2px solid #E2E8F0" }} />);

const DayHead = ({ name, date, isToday }) => (<div style={{ padding: "9px 4px", textAlign: "center", background: isToday ? "#EFF6FF" : "#F8FAFC", borderBottom: "2px solid #E2E8F0", borderRight: "1px solid #F1F5F9" }}><div style={{ fontWeight: 700, fontSize: 12.5, color: isToday ? "#1D4ED8" : "#0F172A" }}>{name}</div><div style={{ fontSize: 10.5, color: isToday ? "#3B82F6" : "#94A3B8", fontWeight: isToday ? 700 : 500 }}>{dm(date)}</div></div>);

const RowLabel = ({ label, color, sub }) => (<div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end", textAlign: "right", padding: "8px 10px", background: "#F8FAFC", borderRight: "2px solid #E2E8F0", borderBottom: "2px solid #D1D5DB", borderTop: "2px solid #D1D5DB" }}><div style={{ fontWeight: 700, fontSize: 11, color, letterSpacing: 0.1 }}>{label}</div>{sub && <div style={{ fontSize: 8.5, color: "#94A3B8", marginTop: 1 }}>{sub}</div>}</div>);

const Cell = ({ children, onClick, tint, ring, pad = 4, lastCol, lastRow }) => (<div onClick={onClick} style={{ padding: pad, minHeight: 46, display: "flex", flexDirection: "column", gap: 3, background: tint, borderRight: lastCol ? "none" : "1px solid #F1F5F9", borderBottom: lastRow ? "none" : "1px solid #F1F5F9", boxShadow: ring ? `inset 0 0 0 1.5px ${ring}66` : "none", cursor: ring ? "pointer" : "default", transition: "background .12s, box-shadow .12s" }}>{children}</div>);

function Chip({ name, selected, onPick, onRemove }) {
  const lv = LEVEL[name]; const c = COLOR[lv];
  return (<div onClick={onPick} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3.5px 6px 3.5px 8px", borderRadius: 7, background: selected ? c.solid : c.bg, border: `1.5px solid ${selected ? c.solid : c.bd}`, color: selected ? "#fff" : c.tx, fontWeight: 600, fontSize: 11.5, cursor: "pointer", userSelect: "none", boxShadow: selected ? `0 0 0 3px ${c.solid}33` : "none", transition: "all .12s" }}>
    <span style={{ flex: 1, lineHeight: 1.3 }}>{name}</span>
    <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 3.5px", borderRadius: 3, background: selected ? "rgba(255,255,255,.28)" : c.solid, color: "#fff", letterSpacing: 0.2 }}>{lv}</span>
    {onRemove && <span onClick={onRemove} title="Quitar" style={{ fontSize: 11, lineHeight: 1, opacity: 0.45, cursor: "pointer", padding: "0 1px" }}>×</span>}
  </div>);
}

const OutChip = ({ name, onPick, selected }) => (<div onClick={onPick} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 7px", borderRadius: 6, background: selected ? "#94A3B8" : "#E2E8F0", border: `1.5px solid ${selected ? "#94A3B8" : "#CBD5E1"}`, color: selected ? "#fff" : "#64748B", fontSize: 10.5, fontWeight: 600, textDecoration: "line-through", cursor: "pointer", userSelect: "none" }}><span style={{ flex: 1 }}>{name}</span><span style={{ fontSize: 7.5, fontWeight: 800, background: "#94A3B8", color: "#fff", padding: "1px 3px", borderRadius: 2.5 }}>{LEVEL[name]}</span></div>);

const GhostHint = ({ color, name }) => (<div style={{ fontSize: 10, color, opacity: 0.75, fontStyle: "italic", textAlign: "center", padding: "1px 0" }}>+ {name}</div>);
const Dash = () => (<div style={{ color: "#CBD5E1", fontSize: 11, textAlign: "center", padding: "10px 0" }}>—</div>);
const Skeleton = () => (<div style={{ height: 460, borderRadius: 14, background: "linear-gradient(90deg,#F1F5F9 25%,#E2E8F0 50%,#F1F5F9 75%)", backgroundSize: "200% 100%", animation: "sk 1.2s infinite", display: "flex", alignItems: "center", justifyContent: "center", color: "#94A3B8", fontSize: 13 }}>Cargando…<style>{`@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style></div>);

const Legend = () => (<div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
  {Object.entries(COLOR).map(([lv, c]) => (<div key={lv} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748B", fontWeight: 500 }}><span style={{ width: 11, height: 11, borderRadius: 3.5, background: c.bg, border: `1.5px solid ${c.bd}` }} />{lv}</div>))}
  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748B", fontWeight: 500 }}><span style={{ width: 11, height: 11, borderRadius: 3.5, background: "#E9D5FF", border: "1.5px solid #D8B4FE" }} />Postguardia</div>
</div>);

/* ══════════════════ ESTILOS ══════════════════ */

const NAV = { background: "rgba(255,255,255,.14)", border: "none", borderRadius: 7, color: "#fff", padding: "6px 10px", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", lineHeight: 1.2 };

const TEXTAREA = { width: "100%", minHeight: 52, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", background: "#fff", fontSize: 11.5, lineHeight: 1.45, color: "#1F2937", fontWeight: 500, fontFamily: "'Inter', system-ui, sans-serif", resize: "vertical", outline: "none", boxSizing: "border-box" };
