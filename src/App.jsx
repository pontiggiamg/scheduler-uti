import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react";
import { db, auth, googleProvider } from "./firebase";
import { doc, onSnapshot, setDoc, getDoc } from "firebase/firestore";
import { signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";

/* ══════════════════ CONFIGURACIÓN ══════════════════ */

const ADMIN_EMAIL = "pontiggiamg@gmail.com";

const RESIDENTS = {
  R2: ["Maca", "Andy", "Nata", "Nahuel"],
  R3: ["Chris", "Ulloa", "Varoli", "Gian"],
  R4: ["Dani", "Caro", "Leo", "Vani"],
};

const ALL = [...RESIDENTS.R2, ...RESIDENTS.R3, ...RESIDENTS.R4];

// Mapeo residente → email de Google. Se usa para identificar qué cuenta logueada
// corresponde a qué residente (ej. Procedimientos, donde cada uno carga lo suyo).
const RESIDENT_EMAIL = {
  Dani: "dpadillasalcedo@gmail.com",
  Caro: "caro146ro@gmail.com",
  Leo: "leonardohomar1894@gmail.com",
  Vani: "vaninagobatto23@gmail.com",
  Chris: "chrislombardo225@gmail.com",
  Ulloa: "nico24ulloa@gmail.com",
  Varoli: "Nico.a.Varoli@gmail.com",
  Gian: "giancarlomilemacci@gmail.com",
  Maca: "macagonzalezvirgili@gmail.com",
  Andy: "mportilla58@gmail.com",
  Nata: "nataciademoraes@gmail.com",
  Nahuel: "nahuelklahn@gmail.com",
};
const RESIDENT_BY_EMAIL = Object.fromEntries(Object.entries(RESIDENT_EMAIL).map(([name, email]) => [email.toLowerCase(), name]));

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
const WEEKDAYS_FULL = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

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

const emptyDay = () => ({ uti1: [], uti2: [], uti3: [], postguardia: [], unavailable: [], observaciones: "", recordatorios: "", deGuardia: "" });
const emptyDiasLibresR4 = () => Object.fromEntries(RESIDENTS.R4.map((n) => [n, ""]));
const emptyWeek = () => ({ days: DAYS.map(() => emptyDay()), diasLibresR4: emptyDiasLibresR4() });

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
    day.deGuardia = typeof d.deGuardia === "string" ? d.deGuardia : "";
  }
  const dl = raw.diasLibresR4 || {};
  for (const n of RESIDENTS.R4) week.diasLibresR4[n] = DAYS.includes(dl[n]) ? dl[n] : "";
  return week;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const isBlank = (w) => w.days.every((d) => SLOT_KEYS.every((k) => d[k].length === 0) && d.unavailable.length === 0 && !d.observaciones.trim() && !d.recordatorios.trim() && !d.deGuardia.trim()) && RESIDENTS.R4.every((n) => !w.diasLibresR4[n]);

/* ══════════════════ MODELO ROTACIONES ══════════════════ */

const emptyRotYear = () => { const m = {}; for (let i = 0; i < 12; i++) m[i] = { assignments: [], notes: "" }; return { months: m }; };

function normalizeRot(raw) {
  const year = emptyRotYear();
  if (!raw || typeof raw !== "object" || !raw.months) return year;
  for (let i = 0; i < 12; i++) { const m = raw.months[i]; if (m) { year.months[i].assignments = Array.isArray(m.assignments) ? m.assignments : []; year.months[i].notes = typeof m.notes === "string" ? m.notes : ""; } }
  return year;
}

/* ══════════════════ MODELO CALENDARIO ACADÉMICO ══════════════════ */

const emptyAcademico = () => ({ activities: [] });

function normalizeAcademico(raw) {
  if (!raw || !Array.isArray(raw.activities)) return emptyAcademico();
  const activities = raw.activities
    .filter((a) => a && typeof a === "object" && typeof a.date === "string" && a.date)
    .map((a) => ({
      id: typeof a.id === "string" && a.id ? a.id : `${a.date}-${Math.random().toString(36).slice(2, 9)}`,
      date: a.date,
      time: typeof a.time === "string" ? a.time : "",
      title: typeof a.title === "string" ? a.title : "",
      docente: typeof a.docente === "string" ? a.docente : "",
      notes: typeof a.notes === "string" ? a.notes : "",
    }));
  return { activities };
}

/* ══════════════════ APP PRINCIPAL ══════════════════ */

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = no user, object = logged in
  const [tab, setTab] = useState("scheduler");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (u && u.email) {
        try {
          await setDoc(doc(db, "access_logs", `${u.uid}-${Date.now()}`), {
            email: u.email,
            uid: u.uid,
            loginAt: new Date().toISOString(),
            displayName: u.displayName || "Sin nombre",
          });
        } catch (e) { console.error("log de acceso", e); }
      }
      setUser(u || null);
    });
    return unsub;
  }, []);

  if (user === undefined) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Inter', system-ui, sans-serif", color: "#94A3B8", fontSize: 14 }}>Cargando…</div>;

  if (user === null) return <LoginScreen />;

  const isAdmin = user.email === ADMIN_EMAIL;

  return (
    <div style={{ maxWidth: 1500, margin: "0 auto", padding: "14px 12px 40px", fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* User bar */}
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, padding: "6px 12px", background: "#F8FAFC", borderRadius: 10, border: "1px solid #E2E8F0", fontSize: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {user.photoURL && <img src={user.photoURL} alt="" style={{ width: 24, height: 24, borderRadius: "50%" }} />}
          <span style={{ color: "#475569", fontWeight: 500 }}>{user.displayName || user.email}</span>
          {isAdmin && <span style={{ fontSize: 9, fontWeight: 700, background: "#0F172A", color: "#fff", padding: "2px 6px", borderRadius: 4 }}>ADMIN</span>}
          {!isAdmin && <span style={{ fontSize: 9, fontWeight: 600, background: "#E2E8F0", color: "#64748B", padding: "2px 6px", borderRadius: 4 }}>SOLO LECTURA</span>}
        </div>
        <button onClick={() => signOut(auth)} style={{ background: "none", border: "none", color: "#94A3B8", fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: 500 }}>Cerrar sesión</button>
      </div>

      {/* Tabs */}
      <div className="no-print" style={{ display: "flex", gap: 0, marginBottom: 14 }}>
        <TabBtn active={tab === "scheduler"} onClick={() => setTab("scheduler")}>📅 Semana</TabBtn>
        <TabBtn active={tab === "rotaciones"} onClick={() => setTab("rotaciones")}>🔄 Rotaciones</TabBtn>
        <TabBtn active={tab === "pases"} onClick={() => setTab("pases")}>🛏️ Pases</TabBtn>
        <TabBtn active={tab === "academico"} onClick={() => setTab("academico")}>📚 Académico</TabBtn>
      </div>

      {tab === "scheduler" && <SchedulerView isAdmin={isAdmin} />}
      {tab === "rotaciones" && <RotacionesView isAdmin={isAdmin} />}
      {tab === "pases" && <PasesView isAdmin={isAdmin} />}
      {tab === "academico" && <AcademicoView isAdmin={isAdmin} />}
    </div>
  );
}

function LoginScreen() {
  const [error, setError] = useState(null);
  const login = async () => {
    try { await signInWithPopup(auth, googleProvider); } catch (e) { console.error(e); setError("No se pudo iniciar sesión. Intentá de nuevo."); }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ textAlign: "center", padding: "40px 36px", background: "#fff", borderRadius: 16, boxShadow: "0 4px 24px rgba(15,23,42,.1)", border: "1px solid #E2E8F0", maxWidth: 340 }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>🏥</div>
        <div style={{ fontWeight: 800, fontSize: 18, color: "#0F172A", marginBottom: 4 }}>Scheduler UTI</div>
        <div style={{ fontSize: 12, color: "#94A3B8", marginBottom: 24 }}>Hospital Británico</div>
        <button onClick={login} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "11px 16px", borderRadius: 10, border: "1px solid #E2E8F0", background: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", color: "#334155", boxShadow: "0 1px 3px rgba(15,23,42,.08)", transition: "box-shadow .15s" }}>
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>
          Iniciar sesión con Google
        </button>
        {error && <div style={{ color: "#DC2626", fontSize: 11.5, marginTop: 12, fontWeight: 500 }}>{error}</div>}
      </div>
    </div>
  );
}

const TabBtn = ({ active, onClick, children }) => (
  <button onClick={onClick} style={{ padding: "10px 22px", fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: "pointer", background: active ? "#0F172A" : "#E2E8F0", color: active ? "#fff" : "#64748B", border: "none", borderRadius: "10px 10px 0 0", transition: "all .15s", letterSpacing: 0.1 }}>{children}</button>
);

/* ══════════════════ SCHEDULER VIEW ══════════════════ */

function SchedulerView({ isAdmin }) {
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
    if (!isAdmin) return;
    setWeek(next); dirty.current = true; pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delay);
  }, [flush, isAdmin]);

  useEffect(() => { const h = () => { if (pending.current) flush(); }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, [flush]);

  const flash = (msg) => { setToast(msg); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 2400); };

  const locationOf = (w, name, di) => { const d = w.days[di]; for (const k of SLOT_KEYS) if (d[k].includes(name)) return k; if (d.unavailable.includes(name)) return "unavailable"; return null; };
  const detach = (w, name, di) => { const d = w.days[di]; for (const k of SLOT_KEYS) d[k] = d[k].filter((n) => n !== name); d.unavailable = d.unavailable.filter((n) => n !== name); };

  const pool = useCallback((di) => {
    const d = week.days[di];
    const used = new Set([...SLOT_KEYS.flatMap((k) => d[k]), ...d.unavailable]);
    return ALL.filter((n) => !used.has(n));
  }, [week]);

  const pick = (name, from) => {
    if (!isAdmin) return;
    setSel((cur) => cur && cur.name === name && cur.from?.di === from?.di && cur.from?.key === from?.key ? null : { name, from });
  };

  const place = (target, di) => {
    if (!sel || !isAdmin) return;
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

  const removeChip = (name, di) => { if (!isAdmin) return; const next = clone(week); detach(next, name, di); setSel(null); commit(next); };
  const editText = (di, field, value) => { if (!isAdmin) return; const next = clone(week); next.days[di][field] = value; commit(next, 700); };
  const setDiaLibre = (name, day) => { if (!isAdmin) return; const next = clone(week); next.diasLibresR4[name] = day; commit(next, 300); };

  const copyPrevWeek = async () => {
    if (!isAdmin) return;
    setMenuOpen(false);
    if (!isBlank(week) && !confirm("Esto reemplaza la semana actual. ¿Continuar?")) return;
    try { const prevId = `week-${isoDate(shift(monday, -7))}`; const snap = await getDoc(doc(db, "scheduler", prevId));
      if (!snap.exists()) return flash("La semana anterior está vacía");
      commit(normalize(snap.data()), 0); flash("Semana anterior copiada");
    } catch (e) { console.error(e); flash("No se pudo copiar"); }
  };

  const clearWeek = () => { if (!isAdmin) return; setMenuOpen(false); if (!confirm("¿Vaciar toda la semana?")) return; setSel(null); commit(emptyWeek(), 0); };

  const dates = useMemo(() => DAYS.map((_, i) => shift(monday, i)), [monday]);
  const today = new Date();
  const active = sel != null;

  useEffect(() => { const onKey = (e) => e.key === "Escape" && setSel(null); window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);

  return (
    <div onClick={() => { setSel(null); setMenuOpen(false); }}>
      <SchedulerHeader monday={monday} setMonday={setMonday} status={status} menuOpen={menuOpen} setMenuOpen={setMenuOpen} onCopyPrev={copyPrevWeek} onClear={clearWeek} isAdmin={isAdmin} />

      <div style={{ minHeight: 34, marginBottom: 6 }} className="no-print">
        {toast ? <Banner tone="warn">{toast}</Banner> : active ? <Banner tone="info"><b>{sel.name}</b> seleccionado — tocá una celda para ubicarlo, o Esc para cancelar</Banner> : <div style={{ fontSize: 12, color: "#94A3B8", padding: "6px 2px" }}>{isAdmin ? "Tocá un residente para seleccionarlo y después la celda donde va." : "Solo lectura — solo el administrador puede editar."}</div>}
      </div>

      {!loading && <DiasLibresR4 week={week} isAdmin={isAdmin} onChange={setDiaLibre} />}

      {loading ? <Skeleton /> : (
        <div style={{ overflowX: "auto", paddingBottom: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: "104px repeat(5, minmax(178px, 1fr))", background: "#fff", borderRadius: 14, overflow: "hidden", border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(15,23,42,.06)", minWidth: 1000 }}>
            <Corner />{DAYS.map((d, i) => <DayHead key={d} name={d} date={dates[i]} isToday={sameDay(dates[i], today)} />)}

            {SLOTS.filter((s) => s.key !== "postguardia").map((slot, ri) => (
              <Fragment key={slot.key}>
                <RowLabel label={slot.label} color={slot.accent} />
                {DAYS.map((_, di) => (
                  <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place(slot.key, di); }} tint={slot.tint} ring={active ? slot.accent : null} lastCol={di === 4}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 40 }}>
                      {week.days[di][slot.key].sort((a, b) => { const order = { R4: 0, R3: 1, R2: 2 }; return (order[LEVEL[a]] || 3) - (order[LEVEL[b]] || 3); }).map((n) => (
                        <Chip key={n} name={n} selected={sel?.name === n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: slot.key }); }} onRemove={isAdmin ? (e) => { e.stopPropagation(); removeChip(n, di); } : null} />
                      ))}
                      {active && <GhostHint color={slot.accent} name={sel.name} />}
                      {!active && week.days[di][slot.key].length === 0 && <Dash />}
                    </div>
                  </Cell>
                ))}
              </Fragment>
            ))}

            <RowLabel label="De guardia" color="#0EA5E9" sub="texto libre" />
            {DAYS.map((_, di) => (
              <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === 4}>
                <textarea value={week.days[di].deGuardia} onChange={(e) => editText(di, "deGuardia", e.target.value)} placeholder="Quién queda de guardia…" readOnly={!isAdmin} style={{ ...TEXTAREA, minHeight: 40, background: "#F0F9FF", borderColor: "#BAE6FD", color: "#0C4A6E", opacity: isAdmin ? 1 : 0.8, cursor: isAdmin ? "text" : "default" }} />
              </Cell>
            ))}

            {SLOTS.filter((s) => s.key === "postguardia").map((slot) => (
              <Fragment key={slot.key}>
                <RowLabel label={slot.label} color={slot.accent} />
                {DAYS.map((_, di) => (
                  <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place(slot.key, di); }} tint={slot.tint} ring={active ? slot.accent : null} lastCol={di === 4}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 40 }}>
                      {week.days[di][slot.key].sort((a, b) => { const order = { R4: 0, R3: 1, R2: 2 }; return (order[LEVEL[a]] || 3) - (order[LEVEL[b]] || 3); }).map((n) => (
                        <Chip key={n} name={n} selected={sel?.name === n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: slot.key }); }} onRemove={isAdmin ? (e) => { e.stopPropagation(); removeChip(n, di); } : null} />
                      ))}
                      {active && <GhostHint color={slot.accent} name={sel.name} />}
                      {!active && week.days[di][slot.key].length === 0 && <Dash />}
                    </div>
                  </Cell>
                ))}
              </Fragment>
            ))}

            <RowLabel label="Observaciones" color="#475569" />
            {DAYS.map((_, di) => (
              <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === 4}>
                <textarea value={week.days[di].observaciones} onChange={(e) => editText(di, "observaciones", e.target.value)} placeholder="Supervisores, pases, avisos…" readOnly={!isAdmin} style={{ ...TEXTAREA, opacity: isAdmin ? 1 : 0.8, cursor: isAdmin ? "text" : "default" }} />
              </Cell>
            ))}

            <RowLabel label="Recordatorios" color="#B45309" />
            {DAYS.map((_, di) => (
              <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === 4}>
                <textarea value={week.days[di].recordatorios} onChange={(e) => editText(di, "recordatorios", e.target.value)} placeholder="Clases, ateneos, horarios…" readOnly={!isAdmin} style={{ ...TEXTAREA, background: "#FFFBEB", borderColor: "#FDE68A", color: "#78350F", opacity: isAdmin ? 1 : 0.8, cursor: isAdmin ? "text" : "default" }} />
              </Cell>
            ))}

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

function RotacionesView({ isAdmin }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState(emptyRotYear);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("idle");
  const [editing, setEditing] = useState(null);

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
    if (!isAdmin) return;
    setData(next); pending.current = next; setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { await setDoc(doc(db, "scheduler", docId), pending.current); setStatus("saved");
        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus("idle"), 1600);
      } catch (e) { console.error(e); setStatus("error"); }
    }, 400);
  }, [docId, isAdmin]);

  const addAssignment = (mi) => { if (!isAdmin) return; setEditing({ month: mi, mode: "new", resident: "", place: "" }); };

  const saveAssignment = (mi, resident, place, idx) => {
    if (!resident.trim() || !place.trim()) return;
    const next = clone(data);
    if (idx !== undefined && idx !== null) { next.months[mi].assignments[idx] = { resident: resident.trim(), place: place.trim() }; }
    else { next.months[mi].assignments.push({ resident: resident.trim(), place: place.trim() }); }
    save(next); setEditing(null);
  };

  const removeAssignment = (mi, idx) => { if (!isAdmin) return; const next = clone(data); next.months[mi].assignments.splice(idx, 1); save(next); };

  const editNotes = (mi, val) => { if (!isAdmin) return; const next = clone(data); next.months[mi].notes = val; save(next); };

  const S = { saving: { t: "Guardando…", c: "#CBD5E1" }, saved: { t: "✓ Guardado", c: "#86EFAC" }, error: { t: "⚠ Error", c: "#FCA5A5" } }[status];

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
          return (
            <div key={mi} style={{ background: "#fff", borderRadius: 12, border: isCurrentMonth ? "2px solid #3B82F6" : "1px solid #E2E8F0", overflow: "hidden", boxShadow: isCurrentMonth ? "0 0 0 3px #3B82F633" : "0 1px 3px rgba(15,23,42,.04)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: isCurrentMonth ? "#EFF6FF" : "#F8FAFC", borderBottom: "1px solid #E2E8F0" }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: isCurrentMonth ? "#1D4ED8" : "#0F172A" }}>{mName}</div>
                {isAdmin && <button onClick={() => addAssignment(mi)} style={{ background: "#E2E8F0", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", color: "#475569", fontFamily: "inherit" }}>+ Agregar</button>}
              </div>
              <div style={{ padding: "8px 14px" }}>
                {month.assignments.length === 0 && !(editing && editing.month === mi) ? (
                  <div style={{ fontSize: 11.5, color: "#94A3B8", fontStyle: "italic", padding: "6px 0" }}>Sin rotaciones este mes</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: month.assignments.length > 0 ? 8 : 0 }}>
                    {month.assignments.map((a, idx) => {
                      const lv = LEVEL[a.resident];
                      const c = lv ? COLOR[lv] : { bg: "#F1F5F9", bd: "#CBD5E1", tx: "#475569", solid: "#64748B" };
                      const isEditingThis = editing && editing.month === mi && editing.idx === idx;
                      if (isEditingThis) {
                        return <EditForm key={idx} resident={editing.resident} place={editing.place} onResChange={(v) => setEditing({ ...editing, resident: v })} onPlaceChange={(v) => setEditing({ ...editing, place: v })} onSave={() => saveAssignment(mi, editing.resident, editing.place, idx)} onCancel={() => setEditing(null)} />;
                      }
                      return (
                        <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, background: c.bg, border: `1.5px solid ${c.bd}`, fontSize: 12 }}>
                          <span style={{ fontWeight: 700, color: c.tx }}>{a.resident}</span>
                          <span style={{ color: "#64748B", fontWeight: 500 }}>({a.place})</span>
                          {lv && <span style={{ fontSize: 8, fontWeight: 800, background: c.solid, color: "#fff", padding: "1px 4px", borderRadius: 3 }}>{lv}</span>}
                          {isAdmin && <span onClick={() => setEditing({ month: mi, idx, resident: a.resident, place: a.place })} style={{ cursor: "pointer", fontSize: 11, opacity: 0.4 }} title="Editar">✏️</span>}
                          {isAdmin && <span onClick={() => removeAssignment(mi, idx)} style={{ cursor: "pointer", fontSize: 11, opacity: 0.4 }} title="Eliminar">✕</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
                {editing && editing.month === mi && editing.mode === "new" && (
                  <EditForm resident={editing.resident} place={editing.place} onResChange={(v) => setEditing({ ...editing, resident: v })} onPlaceChange={(v) => setEditing({ ...editing, place: v })} onSave={() => saveAssignment(mi, editing.resident, editing.place)} onCancel={() => setEditing(null)} />
                )}
                <textarea value={month.notes} onChange={(e) => editNotes(mi, e.target.value)} placeholder="Vacaciones del mes…" readOnly={!isAdmin} style={{ ...TEXTAREA, minHeight: 32, marginTop: 4, fontSize: 11, fontStyle: month.notes ? "normal" : "italic", color: month.notes ? "#92400E" : "#94A3B8", background: month.notes ? "#FFFBEB" : "#FAFAFA", borderColor: month.notes ? "#FDE68A" : "#E2E8F0", opacity: isAdmin ? 1 : 0.8, cursor: isAdmin ? "text" : "default" }} />
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

/* ══════════════════ PASES VIEW ══════════════════ */

const PASE_FIELDS = [
  ["req", "Requerimientos / Intercurrencias"],
  ["ea", "Enfermedad actual"],
  ["ap", "Antecedentes"],
  ["tto", "Tratamiento"],
  ["accesos", "Accesos"],
  ["cultivos", "Cultivos"],
  ["estudios", "Complementarios"],
  ["labo", "Laboratorio"],
  ["eab", "EAB"],
  ["pendiente", "Pendientes"],
];

function timeAgo(iso) {
  if (!iso) return "nunca";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "recién";
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

function PasesView({ isAdmin }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [unit, setUnit] = useState(null);
  const [open, setOpen] = useState({});
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "scheduler", "pases-latest"), (snap) => {
      setData(snap.exists() ? snap.data() : null);
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, []);

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
        <div style={{ textAlign: "center", padding: "50px 20px", color: "#94A3B8", fontSize: 13, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
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
                <button key={u} onClick={() => { setUnit(u); setOpen({}); }} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 999, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, background: on ? "#0F172A" : "#E2E8F0", color: on ? "#fff" : "#64748B", display: "flex", alignItems: "center", gap: 6 }}>
                  {u}
                  <span style={{ fontSize: 10, fontWeight: 800, background: on ? "rgba(255,255,255,.22)" : "#CBD5E1", color: on ? "#fff" : "#475569", padding: "1px 6px", borderRadius: 999 }}>{n}</span>
                </button>
              );
            })}
          </div>

          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por cama, nombre o diagnóstico…" className="no-print" style={{ width: "100%", padding: "9px 12px", borderRadius: 10, border: "1px solid #E2E8F0", fontSize: 12.5, fontFamily: "inherit", marginBottom: 10, outline: "none", boxSizing: "border-box", color: "#0F172A" }} />

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {patients.length === 0 ? (
              <div style={{ textAlign: "center", padding: 30, color: "#94A3B8", fontSize: 12.5, background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0" }}>
                {q ? "Ningún paciente coincide con la búsqueda" : "Sin pacientes en esta unidad"}
              </div>
            ) : patients.map((p) => {
              const isOpen = !!open[p.bed];
              return (
                <div key={p.bed} style={{ background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0", overflow: "hidden", boxShadow: "0 1px 3px rgba(15,23,42,.04)" }}>
                  <div onClick={() => setOpen((o) => ({ ...o, [p.bed]: !o[p.bed] }))} style={{ padding: "11px 13px", cursor: "pointer", display: "flex", gap: 11, alignItems: "flex-start" }}>
                    <div style={{ flexShrink: 0, minWidth: 40, textAlign: "center", background: "#0F172A", color: "#fff", borderRadius: 8, padding: "5px 7px", fontWeight: 800, fontSize: 13, lineHeight: 1.2 }}>{p.bed}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 700, fontSize: 13.5, color: "#0F172A" }}>{p.name || "—"}</span>
                        {p.age && <span style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600 }}>{p.age} a</span>}
                      </div>
                      {p.flags?.length > 0 && (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                          {p.flags.map((f, i) => (
                            <span key={i} style={{ fontSize: 9.5, fontWeight: 700, background: "#FEF2F2", color: "#B91C1C", border: "1px solid #FECACA", padding: "2px 6px", borderRadius: 5 }}>{f}</span>
                          ))}
                        </div>
                      )}
                      {p.mi && <div style={{ fontSize: 12, color: "#1D4ED8", fontWeight: 600, marginTop: 4, lineHeight: 1.35 }}>{p.mi}</div>}
                      {p.status && <div style={{ fontSize: 11.5, color: "#475569", marginTop: 5, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: isOpen ? "unset" : 2, WebkitBoxOrient: "vertical", overflow: isOpen ? "visible" : "hidden" }}>{p.status}</div>}
                    </div>
                    <div style={{ flexShrink: 0, color: "#CBD5E1", fontSize: 12, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▼</div>
                  </div>

                  {isOpen && (
                    <div style={{ borderTop: "1px solid #F1F5F9", padding: "4px 13px 12px" }}>
                      {PASE_FIELDS.filter(([k]) => p.fields?.[k]).map(([k, label]) => (
                        <div key={k} style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
                          <div style={{ fontSize: 11.5, color: "#334155", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{p.fields[k]}</div>
                        </div>
                      ))}
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

/* ══════════════════ CALENDARIO ACADÉMICO VIEW ══════════════════ */

function AcademicoView({ isAdmin }) {
  const [data, setData] = useState(emptyAcademico);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("idle");
  const [editing, setEditing] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  const docId = "academico";
  const pending = useRef(null);
  const timer = useRef(null);
  const statusTimer = useRef(null);

  useEffect(() => {
    setLoading(true);
    const ref = doc(db, "scheduler", docId);
    const unsub = onSnapshot(ref, (snap) => {
      setData(snap.exists() ? normalizeAcademico(snap.data()) : emptyAcademico());
      setLoading(false);
    }, () => setLoading(false));
    return () => { unsub(); if (timer.current) clearTimeout(timer.current); };
  }, []);

  const save = useCallback((next) => {
    if (!isAdmin) return;
    setData(next); pending.current = next; setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { await setDoc(doc(db, "scheduler", docId), pending.current); setStatus("saved");
        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus("idle"), 1600);
      } catch (e) { console.error(e); setStatus("error"); }
    }, 400);
  }, [isAdmin]);

  const addActivity = () => { if (!isAdmin) return; setEditing({ mode: "new", date: isoDate(new Date()), time: "", title: "", docente: "", notes: "" }); };
  const editActivity = (a) => { if (!isAdmin) return; setEditing({ mode: "edit", id: a.id, date: a.date, time: a.time, title: a.title, docente: a.docente, notes: a.notes }); };

  const saveActivity = () => {
    if (!editing || !editing.date.trim() || !editing.title.trim()) return;
    const next = clone(data);
    const record = { id: editing.mode === "edit" ? editing.id : `${editing.date}-${Math.random().toString(36).slice(2, 9)}`, date: editing.date, time: editing.time.trim(), title: editing.title.trim(), docente: editing.docente.trim(), notes: editing.notes.trim() };
    if (editing.mode === "edit") { const idx = next.activities.findIndex((a) => a.id === editing.id); if (idx >= 0) next.activities[idx] = record; }
    else next.activities.push(record);
    save(next); setEditing(null);
  };

  const removeActivity = (id) => { if (!isAdmin) return; if (!confirm("¿Eliminar esta actividad?")) return; const next = clone(data); next.activities = next.activities.filter((a) => a.id !== id); save(next); };

  const S = { saving: { t: "Guardando…", c: "#CBD5E1" }, saved: { t: "✓ Guardado", c: "#86EFAC" }, error: { t: "⚠ Error", c: "#FCA5A5" } }[status];

  if (loading) return <Skeleton />;

  const now = new Date();
  const nowKey = `${isoDate(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const key = (a) => `${a.date} ${a.time || "00:00"}`;

  const upcoming = data.activities.filter((a) => key(a) >= nowKey).sort((x, y) => key(x).localeCompare(key(y)));
  const past = data.activities.filter((a) => key(a) < nowKey).sort((x, y) => key(y).localeCompare(key(x)));

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>📚</span>
          <div><div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Calendario académico</div><div style={{ fontSize: 10.5, opacity: 0.55 }}>Hospital Británico</div></div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {S && <div style={{ fontSize: 10.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: "rgba(255,255,255,.12)", color: S.c }}>{S.t}</div>}
          {isAdmin && <button onClick={addActivity} style={{ ...NAV, width: "auto", padding: "6px 12px", fontSize: 11 }}>+ Agregar actividad</button>}
        </div>
      </div>

      {editing && editing.mode === "new" && (
        <div style={{ marginBottom: 8 }}>
          <AcademicoEditForm editing={editing} setEditing={setEditing} onSave={saveActivity} onCancel={() => setEditing(null)} />
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {upcoming.length === 0 && !(editing && editing.mode === "new") ? (
          <div style={{ textAlign: "center", padding: 30, color: "#94A3B8", fontSize: 12.5, background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0" }}>Sin actividades próximas{isAdmin ? " — tocá \"Agregar actividad\" para cargar la primera." : "."}</div>
        ) : upcoming.map((a) => (
          editing && editing.mode === "edit" && editing.id === a.id
            ? <AcademicoEditForm key={a.id} editing={editing} setEditing={setEditing} onSave={saveActivity} onCancel={() => setEditing(null)} />
            : <AcademicoCard key={a.id} activity={a} isAdmin={isAdmin} onEdit={() => editActivity(a)} onRemove={() => removeActivity(a.id)} />
        ))}
      </div>

      {past.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <button className="no-print" onClick={() => setShowHistory((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, color: "#64748B", padding: "4px 2px", marginBottom: 8 }}>
            <span style={{ display: "inline-block", transform: showHistory ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
            Historial ({past.length})
          </button>
          {showHistory && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {past.map((a) => (
                editing && editing.mode === "edit" && editing.id === a.id
                  ? <AcademicoEditForm key={a.id} editing={editing} setEditing={setEditing} onSave={saveActivity} onCancel={() => setEditing(null)} />
                  : <AcademicoCard key={a.id} activity={a} isAdmin={isAdmin} onEdit={() => editActivity(a)} onRemove={() => removeActivity(a.id)} dimmed />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AcademicoCard({ activity, isAdmin, onEdit, onRemove, dimmed }) {
  const d = new Date(`${activity.date}T${activity.time || "00:00"}:00`);
  const dateLabel = `${WEEKDAYS_FULL[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()].toLowerCase()}`;
  return (
    <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(15,23,42,.04)", padding: "11px 14px", display: "flex", gap: 12, alignItems: "flex-start", opacity: dimmed ? 0.6 : 1 }}>
      <div style={{ flexShrink: 0, minWidth: 58, textAlign: "center", background: dimmed ? "#F1F5F9" : "#0F172A", color: dimmed ? "#64748B" : "#fff", borderRadius: 8, padding: "6px 7px" }}>
        <div style={{ fontWeight: 800, fontSize: 14, lineHeight: 1.15 }}>{d.getDate()}</div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", opacity: 0.8 }}>{MONTHS[d.getMonth()].slice(0, 3)}</div>
        {activity.time && <div style={{ fontSize: 9.5, fontWeight: 700, marginTop: 3, opacity: 0.85 }}>{activity.time}</div>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10.5, color: "#94A3B8", fontWeight: 600, marginBottom: 2 }}>{dateLabel}</div>
        <div style={{ fontWeight: 700, fontSize: 13.5, color: dimmed ? "#64748B" : "#0F172A" }}>{activity.title || "(sin nombre)"}</div>
        {activity.docente && <div style={{ fontSize: 12, color: dimmed ? "#94A3B8" : "#1D4ED8", fontWeight: 600, marginTop: 2 }}>{activity.docente}</div>}
        {activity.notes && <div style={{ fontSize: 11.5, color: "#475569", marginTop: 4, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{activity.notes}</div>}
      </div>
      {isAdmin && (
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <span onClick={onEdit} title="Editar" style={{ cursor: "pointer", fontSize: 12, opacity: 0.4 }}>✏️</span>
          <span onClick={onRemove} title="Eliminar" style={{ cursor: "pointer", fontSize: 12, opacity: 0.4 }}>✕</span>
        </div>
      )}
    </div>
  );
}

const AcademicoEditForm = ({ editing, setEditing, onSave, onCancel }) => (
  <div style={{ background: "#F8FAFC", border: "1.5px solid #CBD5E1", borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <input type="date" value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} style={INPUT} />
      <input type="time" value={editing.time} onChange={(e) => setEditing({ ...editing, time: e.target.value })} style={INPUT} />
      <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="Nombre de la clase" style={{ ...INPUT, flex: 1, minWidth: 160 }} />
      <input value={editing.docente} onChange={(e) => setEditing({ ...editing, docente: e.target.value })} placeholder="Docente" style={{ ...INPUT, minWidth: 130 }} />
    </div>
    <textarea value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} placeholder="Observaciones…" style={{ ...TEXTAREA, minHeight: 40 }} />
    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
      <button onClick={onSave} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓ Guardar</button>
      <button onClick={onCancel} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
    </div>
  </div>
);

/* ══════════════════ DÍAS LIBRES R4 ══════════════════ */

const DIAS_LIBRES_OPCIONES = ["Lunes", "Miércoles", "Viernes"];

function DiasLibresR4({ week, isAdmin, onChange }) {
  const any = RESIDENTS.R4.some((n) => week.diasLibresR4[n]);
  if (!isAdmin && !any) return null;
  return (
    <div className="no-print" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, padding: "8px 12px", marginBottom: 10, borderRadius: 10, background: "#FFF7ED", border: "1px solid #FED7AA" }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "#9A3412" }}>🗓️ Días libres R4 esta semana:</span>
      {RESIDENTS.R4.map((n) => (
        <div key={n} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: "#7C2D12" }}>{n}</span>
          {isAdmin ? (
            <select value={week.diasLibresR4[n]} onChange={(e) => onChange(n, e.target.value)} style={{ fontSize: 11, padding: "2px 5px", borderRadius: 5, border: "1px solid #FDBA74", background: "#fff", color: "#7C2D12", fontFamily: "inherit" }}>
              <option value="">—</option>
              {DIAS_LIBRES_OPCIONES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          ) : (
            week.diasLibresR4[n] && <span style={{ fontSize: 11, fontWeight: 700, background: "#FDBA74", color: "#7C2D12", padding: "1px 7px", borderRadius: 999 }}>{week.diasLibresR4[n]}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/* ══════════════════ SCHEDULER HEADER ══════════════════ */

function SchedulerHeader({ monday, setMonday, status, menuOpen, setMenuOpen, onCopyPrev, onClear, isAdmin }) {
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
        {isAdmin && <button onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }} style={{ ...NAV, width: "auto", padding: "6px 10px" }}>⋯</button>}
        {menuOpen && isAdmin && (
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

const INPUT = { padding: "6px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", background: "#fff", color: "#0F172A" };

const TEXTAREA = { width: "100%", minHeight: 52, padding: "6px 8px", borderRadius: 7, border: "1px solid #E2E8F0", background: "#fff", fontSize: 11.5, lineHeight: 1.45, color: "#1F2937", fontWeight: 500, fontFamily: "'Inter', system-ui, sans-serif", resize: "vertical", outline: "none", boxSizing: "border-box" };
