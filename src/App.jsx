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

const SLOTS = [
  { key: "uti1", label: "UTI 1", accent: "#3B82F6", bg: "#FFFFFF", tint: "#EFF6FF" },
  { key: "uti2", label: "UTI 2", accent: "#3B82F6", bg: "#FFFFFF", tint: "#EFF6FF" },
  { key: "uti3", label: "UTI 3", accent: "#3B82F6", bg: "#FFFFFF", tint: "#EFF6FF" },
  { key: "postguardia", label: "Postguardia", accent: "#A855F7", bg: "#FDFAFF", tint: "#F5F3FF" },
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
const shift = (d, n) => {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
};
const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dm = (d) => `${d.getDate()}/${d.getMonth() + 1}`;
const sameDay = (a, b) => isoDate(a) === isoDate(b);

/* ══════════════════ MODELO ══════════════════ */

const emptyDay = () => ({
  uti1: [],
  uti2: [],
  uti3: [],
  postguardia: [],
  unavailable: [],
  observaciones: "",
  recordatorios: "",
});

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

    day.unavailable = Array.isArray(d.unavailable)
      ? d.unavailable.filter((n) => LEVEL[n])
      : [...legacyGlobal];

    day.observaciones = typeof d.observaciones === "string" ? d.observaciones : "";
    day.recordatorios = typeof d.recordatorios === "string" ? d.recordatorios : "";
  }
  return week;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

const isBlank = (w) =>
  w.days.every(
    (d) =>
      SLOT_KEYS.every((k) => d[k].length === 0) &&
      d.unavailable.length === 0 &&
      !d.observaciones.trim() &&
      !d.recordatorios.trim()
  );

/* ══════════════════ APP ══════════════════ */

export default function App() {
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
    setLoading(true);
    setSel(null);
    dirty.current = false;

    const ref = doc(db, "scheduler", docId);
    const unsub = onSnapshot(
      ref,
      { includeMetadataChanges: false },
      (snap) => {
        if (snap.metadata.hasPendingWrites || dirty.current) {
          setLoading(false);
          return;
        }
        setWeek(snap.exists() ? normalize(snap.data()) : emptyWeek());
        setLoading(false);
      },
      (err) => {
        console.error("snapshot", err);
        setStatus("error");
        setLoading(false);
      }
    );

    return () => {
      unsub();
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [docId]);

  const flush = useCallback(async () => {
    const payload = pending.current;
    if (!payload) return;
    pending.current = null;
    setStatus("saving");
    try {
      await setDoc(doc(db, "scheduler", docId), payload);
      dirty.current = false;
      setStatus("saved");
      if (statusTimer.current) clearTimeout(statusTimer.current);
      statusTimer.current = setTimeout(() => setStatus("idle"), 1600);
    } catch (e) {
      console.error("save", e);
      setStatus("error");
    }
  }, [docId]);

  const commit = useCallback(
    (next, delay = 350) => {
      setWeek(next);
      dirty.current = true;
      pending.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    [flush]
  );

  useEffect(() => {
    const h = () => {
      if (pending.current) flush();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [flush]);

  const flash = (msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };

  const locationOf = (w, name, di) => {
    const d = w.days[di];
    for (const k of SLOT_KEYS) if (d[k].includes(name)) return k;
    if (d.unavailable.includes(name)) return "unavailable";
    return null;
  };

  const detach = (w, name, di) => {
    const d = w.days[di];
    for (const k of SLOT_KEYS) d[k] = d[k].filter((n) => n !== name);
    d.unavailable = d.unavailable.filter((n) => n !== name);
  };

  const pool = useCallback(
    (di) => {
      const d = week.days[di];
      const used = new Set([...SLOT_KEYS.flatMap((k) => d[k]), ...d.unavailable]);
      return ALL.filter((n) => !used.has(n));
    },
    [week]
  );

  const pick = (name, from) => {
    setSel((cur) =>
      cur && cur.name === name && cur.from?.di === from?.di && cur.from?.key === from?.key
        ? null
        : { name, from }
    );
  };

  const place = (target, di) => {
    if (!sel) return;
    const { name, from } = sel;
    setSel(null);

    if (from && from.di === di && from.key === target) return;

    const next = clone(week);

    if (target === "pool") {
      detach(next, name, di);
      commit(next);
      return;
    }

    const already = locationOf(next, name, di);
    if (already && already !== from?.key) {
      const nice = already === "unavailable" ? "no disponible" : already.toUpperCase();
      flash(`${name} ya figura el ${DAYS[di]} en ${nice}`);
      return;
    }

    if (from) detach(next, name, from.di);
    detach(next, name, di);
    next.days[di][target].push(name);
    commit(next);
  };

  const removeChip = (name, di) => {
    const next = clone(week);
    detach(next, name, di);
    setSel(null);
    commit(next);
  };

  const editText = (di, field, value) => {
    const next = clone(week);
    next.days[di][field] = value;
    commit(next, 700);
  };

  const copyPrevWeek = async () => {
    setMenuOpen(false);
    if (!isBlank(week) && !confirm("Esto reemplaza la semana actual. ¿Continuar?")) return;
    try {
      const prevId = `week-${isoDate(shift(monday, -7))}`;
      const snap = await getDoc(doc(db, "scheduler", prevId));
      if (!snap.exists()) return flash("La semana anterior está vacía");
      commit(normalize(snap.data()), 0);
      flash("Semana anterior copiada");
    } catch (e) {
      console.error(e);
      flash("No se pudo copiar");
    }
  };

  const clearWeek = () => {
    setMenuOpen(false);
    if (!confirm("¿Vaciar toda la semana?")) return;
    setSel(null);
    commit(emptyWeek(), 0);
  };

  const dates = useMemo(() => DAYS.map((_, i) => shift(monday, i)), [monday]);
  const today = new Date();
  const active = sel != null;

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && setSel(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ══════════════════ RENDER ══════════════════ */

  return (
    <div
      onClick={() => {
        setSel(null);
        setMenuOpen(false);
      }}
      style={{ maxWidth: 1500, margin: "0 auto", padding: "14px 12px 40px" }}
    >
      <Header
        monday={monday}
        setMonday={setMonday}
        status={status}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        onCopyPrev={copyPrevWeek}
        onClear={clearWeek}
      />

      <div style={{ minHeight: 34, marginBottom: 6 }} className="no-print">
        {toast ? (
          <Banner tone="warn">{toast}</Banner>
        ) : active ? (
          <Banner tone="info">
            <b>{sel.name}</b> seleccionado — tocá una celda para ubicarlo, o Esc para cancelar
          </Banner>
        ) : (
          <div style={{ fontSize: 12, color: "#94A3B8", padding: "6px 2px" }}>
            Tocá un residente para seleccionarlo y después la celda donde va.
          </div>
        )}
      </div>

      {loading ? (
        <Skeleton />
      ) : (
        <div style={{ overflowX: "auto", paddingBottom: 4 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "104px repeat(5, minmax(178px, 1fr))",
              background: "#fff",
              borderRadius: 14,
              overflow: "hidden",
              border: "1px solid #E2E8F0",
              boxShadow: "0 1px 3px rgba(15,23,42,.06)",
              minWidth: 1000,
            }}
          >
            {/* encabezado */}
            <Corner />
            {DAYS.map((d, i) => (
              <DayHead key={d} name={d} date={dates[i]} isToday={sameDay(dates[i], today)} />
            ))}

            {/* filas de asignación */}
            {SLOTS.map((slot, ri) => (
              <Fragment key={slot.key}>
                <RowLabel label={slot.label} color={slot.accent} />
                {DAYS.map((_, di) => (
                  <Cell
                    key={di}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (active) place(slot.key, di);
                    }}
                    tint={active ? slot.tint : slot.bg}
                    ring={active ? slot.accent : null}
                    lastCol={di === 4}
                    lastRow={ri === SLOTS.length - 1}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 40 }}>
                      {week.days[di][slot.key]
                        .sort((a, b) => {
                          const order = { R4: 0, R3: 1, R2: 2 };
                          return (order[LEVEL[a]] || 3) - (order[LEVEL[b]] || 3);
                        })
                        .map((n) => (
                          <Chip
                            key={n}
                            name={n}
                            selected={sel?.name === n}
                            onPick={(e) => {
                              e.stopPropagation();
                              pick(n, { di, key: slot.key });
                            }}
                            onRemove={(e) => {
                              e.stopPropagation();
                              removeChip(n, di);
                            }}
                          />
                        ))}
                      {active && <GhostHint color={slot.accent} name={sel.name} />}
                      {!active && week.days[di][slot.key].length === 0 && <Dash />}
                    </div>
                  </Cell>
                ))}
              </Fragment>
            ))}

            {/* disponibles */}
            <RowLabel label="Disponibles" color="#16A34A" />
            {DAYS.map((_, di) => {
              const free = pool(di);
              return (
                <Cell
                  key={di}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (active) place("pool", di);
                  }}
                  tint={active ? "#F0FDF4" : "#FAFDFB"}
                  ring={active ? "#22C55E" : null}
                  lastCol={di === 4}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 50 }}>
                    {active && (
                      <div style={{ fontSize: 10, color: "#16A34A", fontWeight: 600, textAlign: "center", padding: "1px 0" }}>
                        ↩ liberar el {DAYS[di].toLowerCase()}
                      </div>
                    )}
                    {free.length === 0 ? (
                      !active && (
                        <div style={{ fontSize: 10.5, color: "#94A3B8", fontStyle: "italic", textAlign: "center", padding: 6 }}>
                          todos asignados
                        </div>
                      )
                    ) : (
                      free.map((n) => (
                        <Chip
                          key={n}
                          name={n}
                          selected={sel?.name === n}
                          onPick={(e) => {
                            e.stopPropagation();
                            pick(n, { di, key: "pool" });
                          }}
                        />
                      ))
                    )}
                  </div>
                </Cell>
              );
            })}

            {/* no disponibles — POR DÍA */}
            <RowLabel label="No disponibles" color="#DC2626" sub="rotación · vacaciones" />
            {DAYS.map((_, di) => (
              <Cell
                key={di}
                onClick={(e) => {
                  e.stopPropagation();
                  if (active) place("unavailable", di);
                }}
                tint={active ? "#FEF2F2" : "#FAFAFA"}
                ring={active ? "#F87171" : null}
                lastCol={di === 4}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 40 }}>
                  {week.days[di].unavailable.map((n) => (
                    <OutChip key={n} name={n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: "unavailable" }); }} selected={sel?.name === n} />
                  ))}
                  {active && (
                    <div style={{ fontSize: 10, color: "#EF4444", fontWeight: 600, textAlign: "center", padding: "1px 0" }}>
                      marcar solo el {DAYS[di].toLowerCase()}
                    </div>
                  )}
                  {!active && week.days[di].unavailable.length === 0 && <Dash />}
                </div>
              </Cell>
            ))}

            {/* observaciones */}
            <RowLabel label="Observaciones" color="#475569" />
            {DAYS.map((_, di) => (
              <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === 4}>
                <textarea
                  value={week.days[di].observaciones}
                  onChange={(e) => editText(di, "observaciones", e.target.value)}
                  placeholder="Supervisores, pases, avisos…"
                  style={TEXTAREA}
                />
              </Cell>
            ))}

            {/* recordatorios */}
            <RowLabel label="Recordatorios" color="#B45309" />
            {DAYS.map((_, di) => (
              <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === 4} lastRow>
                <textarea
                  value={week.days[di].recordatorios}
                  onChange={(e) => editText(di, "recordatorios", e.target.value)}
                  placeholder="Clases, ateneos, horarios…"
                  style={{ ...TEXTAREA, background: "#FFFBEB", borderColor: "#FDE68A", color: "#78350F" }}
                />
              </Cell>
            ))}
          </div>
        </div>
      )}

      <Legend />
    </div>
  );
}

/* ══════════════════ COMPONENTES ══════════════════ */

function Header({ monday, setMonday, status, menuOpen, setMenuOpen, onCopyPrev, onClear }) {
  const S = {
    saving: { t: "Guardando…", c: "#CBD5E1", b: "rgba(255,255,255,.12)" },
    saved: { t: "✓ Guardado", c: "#86EFAC", b: "rgba(34,197,94,.18)" },
    error: { t: "⚠ Sin conexión", c: "#FCA5A5", b: "rgba(239,68,68,.18)" },
  }[status];

  return (
    <div
      className="no-print"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        padding: "12px 16px",
        marginBottom: 12,
        borderRadius: 14,
        background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)",
        color: "#fff",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22 }}>🏥</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Scheduler UTI</div>
          <div style={{ fontSize: 10.5, opacity: 0.55, letterSpacing: 0.2 }}>Hospital Británico</div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={(e) => { e.stopPropagation(); setMonday(shift(monday, -7)); }} style={NAV} title="Semana anterior">◀</button>
        <div style={{ textAlign: "center", minWidth: 172 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>
            {dm(monday)} — {dm(shift(monday, 4))}
          </div>
          <input
            type="date"
            value={isoDate(monday)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => e.target.value && setMonday(mondayOf(new Date(e.target.value + "T12:00:00")))}
            style={{
              background: "rgba(255,255,255,.14)",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              padding: "3px 7px",
              fontSize: 10.5,
              marginTop: 3,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          />
        </div>
        <button onClick={(e) => { e.stopPropagation(); setMonday(shift(monday, 7)); }} style={NAV} title="Semana siguiente">▶</button>
        <button
          onClick={(e) => { e.stopPropagation(); setMonday(mondayOf(new Date())); }}
          style={{ ...NAV, width: "auto", padding: "6px 11px", fontSize: 11, fontWeight: 600 }}
        >
          Hoy
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
        {S && (
          <div style={{ fontSize: 10.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: S.b, color: S.c }}>
            {S.t}
          </div>
        )}
        <button onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }} style={{ ...NAV, width: "auto", padding: "6px 10px" }}>
          ⋯
        </button>
        {menuOpen && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              right: 0,
              background: "#fff",
              borderRadius: 10,
              boxShadow: "0 10px 30px rgba(15,23,42,.22)",
              border: "1px solid #E2E8F0",
              overflow: "hidden",
              zIndex: 40,
              minWidth: 210,
            }}
          >
            <MenuItem onClick={onCopyPrev}>📋 Copiar semana anterior</MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); window.print(); }}>🖨️ Imprimir / PDF</MenuItem>
            <MenuItem onClick={onClear} danger>🗑️ Vaciar semana</MenuItem>
          </div>
        )}
      </div>
    </div>
  );
}

const MenuItem = ({ children, onClick, danger }) => (
  <button
    onClick={onClick}
    style={{
      display: "block",
      width: "100%",
      textAlign: "left",
      padding: "10px 14px",
      border: "none",
      background: "transparent",
      fontSize: 12.5,
      fontFamily: "inherit",
      cursor: "pointer",
      color: danger ? "#DC2626" : "#334155",
      fontWeight: 500,
    }}
    onMouseEnter={(e) => (e.currentTarget.style.background = danger ? "#FEF2F2" : "#F8FAFC")}
    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
  >
    {children}
  </button>
);

const Banner = ({ tone, children }) => {
  const c =
    tone === "warn"
      ? { bg: "#FEF2F2", bd: "#FECACA", tx: "#991B1B", icon: "⛔" }
      : { bg: "#EFF6FF", bd: "#BFDBFE", tx: "#1E40AF", icon: "👆" };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        background: c.bg,
        border: `1px solid ${c.bd}`,
        color: c.tx,
        padding: "6px 12px",
        borderRadius: 9,
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      <span>{c.icon}</span>
      <span>{children}</span>
    </div>
  );
};

const Corner = () => (
  <div style={{ background: "#F8FAFC", borderBottom: "2px solid #E2E8F0", borderRight: "2px solid #E2E8F0" }} />
);

const DayHead = ({ name, date, isToday }) => (
  <div
    style={{
      padding: "9px 4px",
      textAlign: "center",
      background: isToday ? "#EFF6FF" : "#F8FAFC",
      borderBottom: "2px solid #E2E8F0",
      borderRight: "1px solid #F1F5F9",
    }}
  >
    <div style={{ fontWeight: 700, fontSize: 12.5, color: isToday ? "#1D4ED8" : "#0F172A" }}>{name}</div>
    <div style={{ fontSize: 10.5, color: isToday ? "#3B82F6" : "#94A3B8", fontWeight: isToday ? 700 : 500 }}>
      {dm(date)}
    </div>
  </div>
);

const RowLabel = ({ label, color, sub }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "flex-end",
      textAlign: "right",
      padding: "8px 10px",
      background: "#F8FAFC",
      borderRight: "2px solid #E2E8F0",
      borderBottom: "2px solid #D1D5DB",
      borderTop: "2px solid #D1D5DB",
    }}
  >
    <div style={{ fontWeight: 700, fontSize: 11, color, letterSpacing: 0.1 }}>{label}</div>
    {sub && <div style={{ fontSize: 8.5, color: "#94A3B8", marginTop: 1 }}>{sub}</div>}
  </div>
);

const Cell = ({ children, onClick, tint, ring, pad = 4, lastCol, lastRow }) => (
  <div
    onClick={onClick}
    style={{
      padding: pad,
      minHeight: 46,
      display: "flex",
      flexDirection: "column",
      gap: 3,
      background: tint,
      borderRight: lastCol ? "none" : "1px solid #F1F5F9",
      borderBottom: lastRow ? "none" : "1px solid #F1F5F9",
      boxShadow: ring ? `inset 0 0 0 1.5px ${ring}66` : "none",
      cursor: ring ? "pointer" : "default",
      transition: "background .12s, box-shadow .12s",
    }}
  >
    {children}
  </div>
);

function Chip({ name, selected, onPick, onRemove }) {
  const lv = LEVEL[name];
  const c = COLOR[lv];
  return (
    <div
      onClick={onPick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "3.5px 6px 3.5px 8px",
        borderRadius: 7,
        background: selected ? c.solid : c.bg,
        border: `1.5px solid ${selected ? c.solid : c.bd}`,
        color: selected ? "#fff" : c.tx,
        fontWeight: 600,
        fontSize: 11.5,
        cursor: "pointer",
        userSelect: "none",
        boxShadow: selected ? `0 0 0 3px ${c.solid}33` : "none",
        transition: "all .12s",
      }}
    >
      <span style={{ flex: 1, lineHeight: 1.3 }}>{name}</span>
      <span
        style={{
          fontSize: 8,
          fontWeight: 800,
          padding: "1px 3.5px",
          borderRadius: 3,
          background: selected ? "rgba(255,255,255,.28)" : c.solid,
          color: "#fff",
          letterSpacing: 0.2,
        }}
      >
        {lv}
      </span>
      {onRemove && (
        <span
          onClick={onRemove}
          title="Quitar"
          style={{ fontSize: 11, lineHeight: 1, opacity: 0.45, cursor: "pointer", padding: "0 1px" }}
        >
          ×
        </span>
      )}
    </div>
  );
}

const OutChip = ({ name, onPick, selected }) => (
  <div
    onClick={onPick}
    style={{
      display: "flex",
      alignItems: "center",
      gap: 4,
      padding: "3px 7px",
      borderRadius: 6,
      background: selected ? "#94A3B8" : "#E2E8F0",
      border: `1.5px solid ${selected ? "#94A3B8" : "#CBD5E1"}`,
      color: selected ? "#fff" : "#64748B",
      fontSize: 10.5,
      fontWeight: 600,
      textDecoration: "line-through",
      cursor: "pointer",
      userSelect: "none",
    }}
  >
    <span style={{ flex: 1 }}>{name}</span>
    <span style={{ fontSize: 7.5, fontWeight: 800, background: "#94A3B8", color: "#fff", padding: "1px 3px", borderRadius: 2.5 }}>
      {LEVEL[name]}
    </span>
  </div>
);

const GhostHint = ({ color, name }) => (
  <div style={{ fontSize: 10, color, opacity: 0.75, fontStyle: "italic", textAlign: "center", padding: "1px 0" }}>
    + {name}
  </div>
);

const Dash = () => (
  <div style={{ color: "#CBD5E1", fontSize: 11, textAlign: "center", padding: "10px 0" }}>—</div>
);

const Skeleton = () => (
  <div
    style={{
      height: 460,
      borderRadius: 14,
      background: "linear-gradient(90deg,#F1F5F9 25%,#E2E8F0 50%,#F1F5F9 75%)",
      backgroundSize: "200% 100%",
      animation: "sk 1.2s infinite",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "#94A3B8",
      fontSize: 13,
    }}
  >
    Cargando semana…
    <style>{`@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
  </div>
);

const Legend = () => (
  <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
    {Object.entries(COLOR).map(([lv, c]) => (
      <div key={lv} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748B", fontWeight: 500 }}>
        <span style={{ width: 11, height: 11, borderRadius: 3.5, background: c.bg, border: `1.5px solid ${c.bd}` }} />
        {lv}
      </div>
    ))}
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748B", fontWeight: 500 }}>
      <span style={{ width: 11, height: 11, borderRadius: 3.5, background: "#F5F3FF", border: "1.5px solid #DDD6FE" }} />
      Postguardia
    </div>
  </div>
);

/* ══════════════════ ESTILOS ══════════════════ */

const NAV = {
  background: "rgba(255,255,255,.14)",
  border: "none",
  borderRadius: 7,
  color: "#fff",
  padding: "6px 10px",
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 700,
  fontFamily: "inherit",
  lineHeight: 1.2,
};

const TEXTAREA = {
  width: "100%",
  minHeight: 52,
  padding: "6px 8px",
  borderRadius: 7,
  border: "1px solid #E2E8F0",
  background: "#fff",
  fontSize: 11.5,
  lineHeight: 1.45,
  color: "#1F2937",
  fontWeight: 500,
  fontFamily: "'Inter', system-ui, sans-serif",
  resize: "vertical",
  outline: "none",
  boxSizing: "border-box",
};
