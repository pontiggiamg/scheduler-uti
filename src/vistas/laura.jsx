/* ══════════════════════════════════════════════════════════════════════════
   La pestaña de la Votación de Laura — auspiciada por el Dr. Elías.
   Funciona igual que Chipa y Aura (misma semana, mismos candidatos, un voto
   por persona, historial), pero es una sola votación en vez de dos.
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useMemo } from "react";
import { db } from "../firebase";
import { doc, setDoc, deleteDoc, collection, getDocs, query, orderBy, increment, arrayUnion } from "firebase/firestore";
import { escuchar, escribir, registrarFalla, CARTEL_ESTADO } from "../nube";
import { shift, isoDate, Skeleton } from "../comunes";
import { ALL, COLOR, LEVEL } from "../config";
import { dm } from "../fechas";
import { disponiblesEsaSemana, normalizeLauraWeek, semanaDeVotacionPorDefecto, useRotaciones } from "../modelo";
import { NAV } from "../ui";
import FOTO_LAURA_URL from "../assets/laura.jpg";

// Foto de portada de la votación. Vive como archivo local en vez de un link
// de Google Drive: los links de Drive embebidos como <img src> se rompen
// seguido por CORS/permisos aunque el archivo esté compartido públicamente.

function LauraView({ isAdmin, user }) {
  const realMonday = useMemo(() => semanaDeVotacionPorDefecto(), []);
  const realWeekId = isoDate(realMonday);
  const [monday, setMonday] = useState(() => realMonday);
  const weekId = isoDate(monday);
  const isRealWeek = weekId === realWeekId;

  const [week, setWeek] = useState({ weekStart: weekId, candidates: [], counts: {} });
  const [loading, setLoading] = useState(true);
  const [voted, setVoted] = useState(null); // null = todavía no se sabe, true/false ya resuelto
  const [status, setStatus] = useState("idle");
  const [editingCandidates, setEditingCandidates] = useState(false);
  const [pickerSel, setPickerSel] = useState([]);
  const [voting, setVoting] = useState(false);
  const [history, setHistory] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [borrando, setBorrando] = useState(false);   // "confirmar" | "yendo" | false
  const [textoBorrar, setTextoBorrar] = useState("");

  useEffect(() => {
    setLoading(true);
    const ref = doc(db, "laura_votes", weekId);
    const unsub = escuchar(ref, (snap) => {
      setWeek(snap.exists() ? normalizeLauraWeek(snap.data(), weekId) : { weekStart: weekId, candidates: [], counts: {} });
      setLoading(false);
    }, "la votación de Laura de la semana", () => setLoading(false));
    return unsub;
  }, [weekId]);

  useEffect(() => {
    if (!user?.uid) return;
    const ref = doc(db, "laura_voters", weekId);
    const unsub = escuchar(ref, (snap) => {
      const d = snap.exists() ? snap.data() : {};
      setVoted(Array.isArray(d.voted) && d.voted.includes(user.uid));
    }, "quiénes ya votaron", () => setVoted(false));
    return unsub;
  }, [weekId, user?.uid]);

  // Rotaciones y vacaciones del año (y del siguiente, para la semana que cruza
  // diciembre), que es lo que define quién está disponible esa semana.
  const aniosSemana = useMemo(() => [...new Set([monday.getFullYear(), shift(monday, 6).getFullYear()])], [weekId]);
  const rotPorAnio = useRotaciones(aniosSemana);

  // Los candidatos se arman solos con los que estuvieron esa semana. Si la
  // jefatura guardó una lista a mano para esa semana, esa manda: sirve de
  // escape y además es lo que mantiene intacto el historial viejo, que se
  // cargaba siempre a mano.
  const candidatos = useMemo(() => (
    week.candidates.length ? week.candidates : disponiblesEsaSemana(monday, rotPorAnio)
  ), [week.candidates, weekId, rotPorAnio]);

  useEffect(() => { setEditingCandidates(false); }, [weekId]);

  const openPicker = () => { setPickerSel(candidatos); setEditingCandidates(true); };
  const toggleCandidate = (n) => setPickerSel((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]));

  const saveCandidates = async () => {
    if (!isAdmin) return;
    setStatus("guardando");
    const ok = await escribir(setDoc(doc(db, "laura_votes", weekId), { weekStart: weekId, candidates: pickerSel }, { merge: true }), "los candidatos de la votación");
    setStatus(ok ? "guardado" : "error");
    if (ok) setTimeout(() => setStatus("idle"), 1500);
    setEditingCandidates(false);
  };

  // Un voto por persona y por semana.
  const castVote = async (name) => {
    if (!user?.uid || voted || voting || !candidatos.includes(name)) return;
    setVoting(true);
    try {
      await setDoc(doc(db, "laura_votes", weekId), { weekStart: weekId, counts: { [name]: increment(1) } }, { merge: true });
      await setDoc(doc(db, "laura_voters", weekId), { voted: arrayUnion(user.uid) }, { merge: true });
    } catch (e) { registrarFalla("tu voto", e, "escritura"); }
    setVoting(false);
  };

  const loadHistory = async () => {
    if (history) { setShowHistory((v) => !v); return; }
    setHistoryLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "laura_votes"), orderBy("weekStart", "desc")));
      const conAlgo = (w) => w.candidates.length > 0 || Object.keys(w.counts || {}).length > 0;
      const weeks = snap.docs.map((d) => normalizeLauraWeek(d.data(), d.id)).filter((w) => w.weekStart < realWeekId && conAlgo(w));
      setHistory(weeks);
      setShowHistory(true);
    } catch (e) { console.error(e); }
    setHistoryLoading(false);
  };

  // Vaciar el historial. Borra las dos colecciones enteras: los votos y también
  // quiénes votaron, así las semanas quedan como nuevas y se podría volver a
  // votar cualquiera de ellas. No hay vuelta atrás, por eso pide escribir
  // BORRAR: un solo click de confirmación es demasiado poco para algo que no se
  // puede deshacer.
  const borrarHistorial = async () => {
    if (!isAdmin || textoBorrar.trim().toUpperCase() !== "BORRAR") return;
    setBorrando("yendo");
    try {
      for (const col of ["laura_votes", "laura_voters"]) {
        const snap = await getDocs(collection(db, col));
        await Promise.all(snap.docs.map((d) => deleteDoc(doc(db, col, d.id))));
      }
      setHistory(null); setShowHistory(false);
      setWeek({ weekStart: weekId, candidates: [], counts: {} });
      setVoted(false);
      setStatus("guardado"); setTimeout(() => setStatus("idle"), 1800);
    } catch (e) { console.error("borrar historial", e); setStatus("error"); }
    setBorrando(false); setTextoBorrar("");
  };

  const S = CARTEL_ESTADO[status];   // ver nube.jsx

  if (loading) return <Skeleton />;

  const cuenta = (n) => (week.counts || {})[n] || 0;
  const maxVotos = Math.max(0, ...candidatos.map(cuenta));
  const total = candidatos.reduce((s, n) => s + cuenta(n), 0);

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#701A75,#A21CAF 60%,#D946EF)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🎗️</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Votación de Laura</div>
            <div style={{ fontSize: 10.5, opacity: 0.75 }}>Auspiciada por el Dr. Elías</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={() => setMonday(shift(monday, -7))} style={{ ...NAV, background: "rgba(255,255,255,.14)" }}>◀</button>
          <div style={{ textAlign: "center", minWidth: 90 }}>
            <div style={{ fontWeight: 700, fontSize: 12.5 }}>{dm(monday)} — {dm(shift(monday, 6))}</div>
          </div>
          <button onClick={() => setMonday(shift(monday, 7))} style={{ ...NAV, background: "rgba(255,255,255,.14)" }}>▶</button>
          {!isRealWeek && <button onClick={() => setMonday(realMonday)} style={{ ...NAV, width: "auto", padding: "6px 11px", fontSize: 11, fontWeight: 600 }}>Hoy</button>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {S && <div style={{ fontSize: 10.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: "rgba(255,255,255,.16)", color: S.c }}>{S.t}</div>}
          {isAdmin && !editingCandidates && <button onClick={openPicker} style={{ ...NAV, width: "auto", padding: "6px 12px", fontSize: 11, background: "rgba(255,255,255,.18)" }}>✏️ Elegir candidatos</button>}
        </div>
      </div>

      {!isRealWeek && (
        <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "5px 10px", marginBottom: 10 }}>
          📍 Estás viendo otra semana, no la actual — lo que edites o votes acá corresponde a esa semana.
        </div>
      )}

      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", border: "1px solid #E2E8F0", borderRadius: 14, padding: 12, marginBottom: 14 }}>
        <img src={FOTO_LAURA_URL} alt="Votación de Laura" style={{ width: 84, height: 84, borderRadius: 12, objectFit: "cover", flexShrink: 0, background: "#F1F5F9" }} />
        <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.5 }}>
          Votación auspiciada por el <b>Dr. Elías</b>. Los candidatos son los que están esa semana, igual que en Chipa y Aura.
        </div>
      </div>

      {editingCandidates ? (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "#64748B", fontWeight: 600, marginBottom: 4 }}>Tocá para agregar o sacar candidatos de esta semana:</div>
          <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 10 }}>Normalmente no hace falta: la lista sale sola de quiénes están en el servicio esa semana. Guardar acá la fija a mano para esta semana.</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
            {ALL.map((n) => {
              const on = pickerSel.includes(n);
              const c = COLOR[LEVEL[n]];
              return (
                <div key={n} onClick={() => toggleCandidate(n)} style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 8, background: on ? c.solid : "#F1F5F9", border: `1.5px solid ${on ? c.solid : "#E2E8F0"}`, color: on ? "#fff" : "#64748B", fontWeight: 600, fontSize: 12 }}>
                  {on && "✓ "}{n}
                  <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: on ? "rgba(255,255,255,.28)" : c.solid, color: "#fff" }}>{LEVEL[n]}</span>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={saveCandidates} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 8, padding: "7px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓ Guardar candidatos</button>
            <button onClick={() => setEditingCandidates(false)} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 8, padding: "7px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 20 }}>
          <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "11px 15px", marginBottom: 10, borderRadius: 13, background: "linear-gradient(135deg,#701A75,#A21CAF 60%,#D946EF)", color: "#fff" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 21 }}>🎗️</span>
              <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: -0.3 }}>Votación de Laura</div>
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85 }}>{total} voto{total === 1 ? "" : "s"}</div>
          </div>

          {candidatos.length === 0 ? (
            <div style={{ textAlign: "center", padding: "26px 20px", color: "#64748B", fontSize: 12.5, background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0" }}>
              🎗️ Nadie disponible esa semana.
              <div style={{ fontSize: 11.5, marginTop: 8 }}>Los candidatos salen solos de quiénes están en el servicio.{isAdmin ? ' Podés forzar una lista con "Elegir candidatos".' : ""}</div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
                {candidatos.map((n) => (
                  <LauraCandidateCard key={n} name={n} count={cuenta(n)} isWinner={maxVotos > 0 && cuenta(n) === maxVotos}
                    disabled={!!voted || voting} onVote={() => castVote(n)} />
                ))}
              </div>
              <div style={{ textAlign: "center", padding: "4px 4px", fontSize: 12, fontWeight: 600, color: voted ? "#A21CAF" : "#94A3B8" }}>
                {voted ? "✓ Ya votaste en la Votación de Laura de esta semana" : "Tocá a quien elegís. El voto es anónimo y no se puede cambiar."}
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <button className="no-print" onClick={loadHistory} disabled={historyLoading} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, color: "#64748B", padding: "4px 2px", marginBottom: 8, opacity: historyLoading ? 0.5 : 1 }}>
          <span style={{ display: "inline-block", transform: showHistory ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
          {historyLoading ? "Cargando historial…" : `Historial${history ? ` (${history.length})` : ""}`}
        </button>
        {showHistory && history && (
          history.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "4px 2px" }}>Sin semanas anteriores todavía.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {history.map((w) => <LauraHistoryRow key={w.weekStart} week={w} />)}
            </div>
          )
        )}

        {isAdmin && showHistory && (
          <div className="no-print" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #E2E8F0" }}>
            {borrando ? (
              <div style={{ background: "#FEF2F2", border: "1.5px solid #FECACA", borderRadius: 12, padding: "12px 14px" }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: "#B91C1C", marginBottom: 3 }}>Vaciar el historial de la Votación de Laura</div>
                <div style={{ fontSize: 11.5, color: "#7F1D1D", lineHeight: 1.5, marginBottom: 10 }}>
                  Se borran todas las semanas y también quiénes votaron, así que las semanas quedan como nuevas y se puede volver a votar. <b>No se puede deshacer.</b> Escribí BORRAR para confirmar.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input value={textoBorrar} onChange={(e) => setTextoBorrar(e.target.value)} placeholder="BORRAR" disabled={borrando === "yendo"}
                    style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, padding: "7px 11px", borderRadius: 8, border: "1.5px solid #FECACA", fontFamily: "inherit", color: "#0F172A", width: 130 }} />
                  <button onClick={borrarHistorial} disabled={borrando === "yendo" || textoBorrar.trim().toUpperCase() !== "BORRAR"}
                    style={{ background: textoBorrar.trim().toUpperCase() === "BORRAR" ? "#B91C1C" : "#CBD5E1", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12.5, fontWeight: 700, fontFamily: "inherit", cursor: textoBorrar.trim().toUpperCase() === "BORRAR" ? "pointer" : "default" }}>
                    {borrando === "yendo" ? "Borrando…" : "Vaciar el historial"}
                  </button>
                  <button onClick={() => { setBorrando(false); setTextoBorrar(""); }} disabled={borrando === "yendo"}
                    style={{ background: "none", color: "#7F1D1D", border: "none", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", padding: "8px 4px" }}>Cancelar</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setBorrando("confirmar")}
                style={{ background: "none", border: "none", fontFamily: "inherit", fontSize: 11.5, fontWeight: 600, color: "#B91C1C", cursor: "pointer", padding: "2px 0" }}>
                Vaciar el historial de la Votación de Laura
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LauraCandidateCard({ name, count, isWinner, disabled, onVote }) {
  const c = COLOR[LEVEL[name]];
  const gana = isWinner && count > 0;
  return (
    <div onClick={disabled ? undefined : onVote} style={{ cursor: disabled ? "default" : "pointer", userSelect: "none", flex: "1 1 130px", maxWidth: 180, textAlign: "center", padding: "16px 10px", borderRadius: 14, background: gana ? "#FDF4FF" : "#fff", border: `2px solid ${gana ? "#E9A8F2" : "#E2E8F0"}`, boxShadow: gana ? "0 0 0 3px #E9A8F244" : "0 1px 3px rgba(15,23,42,.04)", transition: "transform .1s", opacity: disabled ? 0.75 : 1 }}>
      <div style={{ fontSize: 26, marginBottom: 4 }}>{gana ? "🏆" : "🎗️"}</div>
      <div style={{ fontWeight: 800, fontSize: 14, color: "#0F172A" }}>{name}</div>
      <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 5px", borderRadius: 3, background: c.solid, color: "#fff", letterSpacing: 0.2 }}>{LEVEL[name]}</span>
      <div style={{ marginTop: 8, fontSize: 20, fontWeight: 800, color: gana ? "#86198F" : "#334155" }}>{count}</div>
      <div style={{ fontSize: 9.5, color: "#64748B", fontWeight: 600 }}>voto{count === 1 ? "" : "s"}</div>
    </div>
  );
}

function LauraHistoryRow({ week }) {
  const monday = new Date(`${week.weekStart}T12:00:00`);
  // Desde que los candidatos se arman solos, las semanas nuevas no guardan la
  // lista. Para el historial no hace falta: alcanza con quién recibió votos.
  const nombres = week.candidates.length
    ? week.candidates
    : ALL.filter((n) => (week.counts || {})[n]);
  const cuenta = (n) => (week.counts || {})[n] || 0;
  const max = Math.max(0, ...nombres.map(cuenta));
  const ganadores = max > 0 ? nombres.filter((n) => cuenta(n) === max) : [];
  const ordenados = [...nombres].sort((a, b) => cuenta(b) - cuenta(a)).filter(cuenta);
  return (
    <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E2E8F0", padding: "9px 13px" }}>
      <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>{dm(monday)} — {dm(shift(monday, 6))}</div>
      <div style={{ marginTop: 5 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#A21CAF" }}>
          🎗️ {ganadores.length === 0 ? "Sin votos" : `🏆 ${ganadores.join(" y ")}`}
        </div>
        {ordenados.length > 0 && (
          <div style={{ fontSize: 11, color: "#64748B", marginTop: 2 }}>
            {ordenados.map((n) => `${n} (${cuenta(n)})`).join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

export { LauraCandidateCard, LauraHistoryRow, LauraView };
