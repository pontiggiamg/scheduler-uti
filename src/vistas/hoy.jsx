/* ══════════════════════════════════════════════════════════════════════════
   La pestaña de hoy
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useMemo } from "react";
import { db } from "../firebase";
import { doc, setDoc } from "firebase/firestore";
import { escuchar, escribir, AvisoDeFallas } from "../nube";
import { shift, isoDate, Skeleton } from "../comunes";
import { COLOR, FILA_GUARDIA, HORA_AVISO_TARDE, HORA_CAMBIO_DIA, HORA_FIN_GUARDIA, INVITADO_VIGENCIA_MS, LEVEL, MONTHS, PUBLIC_ROUTE_PATH, SKIN_JR, SLOTS, WEEKDAYS_FULL, isWeekendIdx, nombrePublico } from "../config";
import { diOfDate, fechaDeServicio, horaAR, mondayOf } from "../fechas";
import { emptyWeek, esResidente, limpiarTelefono, normalize, parseDeGuardia } from "../modelo";
import { INPUT, NAV, TEXTAREA } from "../ui";

function QuienEstaHoyView({ isAdmin, embedded }) {
  // El día se recalcula solo. Esta pantalla suele quedar abierta toda la noche
  // en el office o en un celular apoyado, así que si el día cambiara únicamente
  // al recargar, a las 6 de la mañana seguiría mostrando el día anterior.
  const [hoyIso, setHoyIso] = useState(() => isoDate(fechaDeServicio()));
  useEffect(() => {
    const t = setInterval(() => setHoyIso((cur) => {
      const ahora = isoDate(fechaDeServicio());
      return ahora === cur ? cur : ahora;
    }), 60 * 1000);
    return () => clearInterval(t);
  }, []);
  const hoy = useMemo(() => new Date(`${hoyIso}T00:00:00`), [hoyIso]);
  const manana = useMemo(() => shift(hoy, 1), [hoy]);
  const ayer = useMemo(() => shift(hoy, -1), [hoy]);
  // Ayer, hoy y mañana pueden caer en hasta tres documentos semanales
  // distintos (si hoy es lunes o domingo), así que se cargan por id y se
  // guardan en un mapa en vez de tener una variable por semana.
  const idsSemanas = useMemo(() => [...new Set([ayer, hoy, manana].map((d) => isoDate(mondayOf(d))))], [ayer, hoy, manana]);
  const claveIds = idsSemanas.join(",");

  const [semanas, setSemanas] = useState({});
  const [telefonosDoc, setTelefonosDoc] = useState({ numeros: {}, invitados: {} });
  const [nota, setNota] = useState("");
  const [loading, setLoading] = useState(true);

  const [openPerson, setOpenPerson] = useState(null); // { tipo, key, nombre }
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [editingNota, setEditingNota] = useState(false);
  const [notaDraft, setNotaDraft] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsubs = claveIds.split(",").map((id) =>
      escuchar(doc(db, "scheduler", `week-${id}`), (snap) => {
        setSemanas((cur) => ({ ...cur, [id]: snap.exists() ? normalize(snap.data()) : emptyWeek() }));
        setLoading(false);
      }, "quién está de sala hoy", () => setLoading(false))
    );
    return () => unsubs.forEach((u) => u());
  }, [claveIds]);

  useEffect(() => {
    const unsub = escuchar(doc(db, "scheduler", "telefonos"), (snap) => {
      const d = snap.exists() ? snap.data() : {};
      setTelefonosDoc({ numeros: d.numeros || {}, invitados: d.invitados || {} });
    }, "los teléfonos internos");
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = escuchar(doc(db, "scheduler", "quien-esta-hoy"), (snap) => setNota(snap.exists() && typeof snap.data().observaciones === "string" ? snap.data().observaciones : ""), "la nota del día");
    return unsub;
  }, []);

  // Limpieza de invitados vencidos (>15 días): solo la dispara la sesión de
  // admin dentro de la app (nunca la ruta pública /hoy, para que un visitante
  // externo jamás escriba en Firestore). Si no hay nada vencido, no hace
  // ninguna escritura — así no repite el mismo trabajo en cada snapshot.
  useEffect(() => {
    if (!(embedded && isAdmin)) return;
    const invitados = telefonosDoc.invitados || {};
    const ahora = Date.now();
    const vigentes = {};
    let huboVencidos = false;
    Object.entries(invitados).forEach(([k, v]) => {
      const creado = v && v.creadoEn ? new Date(v.creadoEn).getTime() : NaN;
      if (!creado || ahora - creado > INVITADO_VIGENCIA_MS) { huboVencidos = true; return; }
      vigentes[k] = v;
    });
    if (huboVencidos) {
      setDoc(doc(db, "scheduler", "telefonos"), { invitados: vigentes }, { merge: true }).catch((e) => console.error("limpieza de invitados vencidos", e));
    }
  }, [telefonosDoc, embedded, isAdmin]);

  const diaDe = (fecha) => {
    const w = semanas[isoDate(mondayOf(fecha))];
    return w ? w.days[diOfDate(fecha)] : null;
  };
  const diaHoy = diaDe(hoy);
  const diaManana = diaDe(manana);

  // Quién está realmente en el hospital en este momento. La guardia arranca a
  // la tarde y termina a la mañana siguiente, así que de madrugada el que está
  // es el de la guardia de AYER, no el de hoy. Durante el día (08 a 17) está
  // todo el mundo, así que no hay a quién advertir.
  const guardiaActiva = useMemo(() => {
    const h = horaAR();
    // De la tarde en adelante, y también de madrugada, el que está es el equipo
    // de guardia del día de servicio en curso — que de madrugada ya es el día
    // anterior del calendario, porque el día recién cambia a las 6.
    if (h >= HORA_AVISO_TARDE || h < HORA_CAMBIO_DIA) return parseDeGuardia((diaHoy || {}).deGuardia);
    // Entre las 6 y las 8 el día ya dio vuelta pero la guardia de anoche sigue
    // en el hospital hasta que entrega.
    if (h < HORA_FIN_GUARDIA) return parseDeGuardia((diaDe(ayer) || {}).deGuardia);
    return null; // horario de actividad normal: nadie está "fuera del hospital"
  }, [semanas, diaHoy, ayer, hoy]);

  const guardarTelefono = async (persona, valor) => {
    const parche = persona.tipo === "residente"
      ? { numeros: { ...(telefonosDoc.numeros || {}), [persona.key]: valor.trim() } }
      : { invitados: { ...(telefonosDoc.invitados || {}), [persona.key]: { nombre: persona.nombre, telefono: valor.trim(), creadoEn: new Date().toISOString() } } };
    await escribir(setDoc(doc(db, "scheduler", "telefonos"), parche, { merge: true }), "el teléfono");
  };

  const guardarNota = async (valor) => {
    await escribir(setDoc(doc(db, "scheduler", "quien-esta-hoy"), { observaciones: valor.trim() }, { merge: true }), "la nota del día");
  };

  const telefonoDe = (persona) => (persona.tipo === "residente" ? (telefonosDoc.numeros || {})[persona.key] : (telefonosDoc.invitados || {})[persona.key]?.telefono) || "";

  const abrirPersona = (persona) => { setOpenPerson(persona); setEditingPhone(false); setPhoneDraft(telefonoDe(persona)); };
  const cerrarPersona = () => { setOpenPerson(null); setEditingPhone(false); };

  const copiarLink = async () => {
    const url = `${window.location.origin}${PUBLIC_ROUTE_PATH}`;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2200); }
    catch (e) { window.prompt("Copiá el link:", url); }
  };

  return (
    <div style={{ minHeight: embedded ? "auto" : "100vh", background: embedded ? "transparent" : "#CBD5E1" }}>
      <div style={{ maxWidth: embedded ? "none" : 560, margin: embedded ? 0 : "0 auto", padding: embedded ? 0 : "14px 12px 40px", fontFamily: "'Inter', system-ui, sans-serif" }}>
        {/* En /hoy esta pantalla se muestra sola, sin el resto de la app, así
            que el aviso de fallas tiene que ir acá también: es la pantalla que
            mira el resto del hospital, y es peor que nadie que ver una lista
            de guardias incompleta creyendo que está completa. Adentro de la
            app (embedded) el aviso ya lo pone AuthenticatedApp. */}
        {!embedded && <AvisoDeFallas />}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>📱</span>
            <div><div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>¿Quién está en la UTI hoy?</div><div style={{ fontSize: 10.5, opacity: 0.55 }}>Hospital Británico</div></div>
          </div>
          <button onClick={copiarLink} style={{ ...NAV, width: "auto", padding: "6px 12px", fontSize: 11 }}>{copied ? "✓ Copiado" : "🔗 Copiar link"}</button>
        </div>

        {/* Pista discreta: sin esto no es obvio que los chips son tocables. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11.5, color: "#475569", marginBottom: 12 }}>
          <span style={{ fontSize: 12 }}>💬</span>
          <span style={{ fontStyle: "italic" }}>Presioná en el nombre para enviar un WhatsApp</span>
        </div>

        {loading ? <Skeleton /> : (
          <>
            {(nota.trim() || (embedded && isAdmin)) && (
              <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 12, padding: "10px 14px", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: "#B45309", letterSpacing: 0.4, textTransform: "uppercase" }}>📌 Observaciones</div>
                  {embedded && isAdmin && !editingNota && (
                    <button onClick={() => { setNotaDraft(nota); setEditingNota(true); }} style={{ background: "none", border: "none", color: "#B45309", fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{nota.trim() ? "✏️ Editar" : "+ Agregar"}</button>
                  )}
                </div>
                {editingNota ? (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                    <textarea value={notaDraft} onChange={(e) => setNotaDraft(e.target.value)} placeholder="Nota visible en esta pantalla, independiente de las Observaciones del calendario semanal…" style={{ ...TEXTAREA, minHeight: 60, background: "#fff" }} />
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button onClick={() => { guardarNota(notaDraft); setEditingNota(false); }} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓ Guardar</button>
                      <button onClick={() => setEditingNota(false)} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
                    </div>
                  </div>
                ) : nota.trim() ? (
                  <div style={{ fontSize: 12.5, color: "#78350F", lineHeight: 1.5, marginTop: 4, whiteSpace: "pre-wrap" }}>{nota}</div>
                ) : (
                  <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", marginTop: 4 }}>Sin observaciones cargadas.</div>
                )}
              </div>
            )}

            <DiaCard label="Hoy" emoji="🔵" fecha={hoy} dia={diaHoy} onPick={abrirPersona} />
            <DiaCard label="Mañana" emoji="🌙" fecha={manana} dia={diaManana} onPick={abrirPersona} />
          </>
        )}
      </div>

      {openPerson && (
        <PersonaModal
          persona={openPerson}
          telefono={telefonoDe(openPerson)}
          guardiaActiva={guardiaActiva}
          isAdmin={embedded && isAdmin}
          editing={editingPhone}
          draft={phoneDraft}
          onDraftChange={setPhoneDraft}
          onEdit={() => setEditingPhone(true)}
          onSave={() => { guardarTelefono(openPerson, phoneDraft); setEditingPhone(false); }}
          onCancelEdit={() => setEditingPhone(false)}
          onClose={cerrarPersona}
        />
      )}
    </div>
  );
}

function DiaCard({ label, emoji, fecha, dia, onPick }) {
  const di = diOfDate(fecha);
  const weekend = isWeekendIdx(di);
  const feriado = !!(dia && dia.feriado);
  // Un feriado se cubre igual que un fin de semana: sin camas fijas.
  const sinCamas = weekend || feriado;
  const fechaLabel = `${WEEKDAYS_FULL[fecha.getDay()]} ${fecha.getDate()} de ${MONTHS[fecha.getMonth()].toLowerCase()}`;

  if (!dia) {
    return (
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 16, marginBottom: 12, textAlign: "center", color: "#64748B", fontSize: 12.5 }}>
        {emoji} {label} — todavía no hay calendario cargado para esta semana.
      </div>
    );
  }

  return (
    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(15,23,42,.04)", overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "11px 16px", background: "#F8FAFC", borderBottom: "1px solid #F1F5F9", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: "#0F172A" }}>{emoji} {label}</div>
          <div style={{ fontSize: 10.5, color: "#64748B", marginTop: 1, textTransform: "capitalize" }}>{fechaLabel}</div>
        </div>
        {feriado
          ? <span style={{ fontSize: 9.5, fontWeight: 800, color: "#92400E", background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 999, padding: "2px 9px" }}>🎌 FERIADO</span>
          : weekend && <span style={{ fontSize: 9.5, fontWeight: 800, color: "#64748B", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 999, padding: "2px 9px" }}>FIN DE SEMANA</span>}
      </div>

      <div style={{ padding: "10px 16px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        <FilaDeGuardia lista={dia.deGuardia} onPick={onPick} />

        {sinCamas ? (
          <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic" }}>UTI 1, UTI 2 y UTI 3 no aplican {feriado ? "los feriados" : "los fines de semana"} — cobertura por guardia y postguardia.</div>
        ) : (
          SLOTS.filter((s) => s.key !== "postguardia").map((slot) => (
            <FilaResidentes key={slot.key} label={slot.label} color={slot.accent} nombres={dia[slot.key]} onPick={onPick} />
          ))
        )}

        <FilaResidentes label="Postguardia" color={SLOTS[3].accent} nombres={dia.postguardia} onPick={onPick} />
      </div>
    </div>
  );
}

// La fila de "De guardia" es la más importante de la pantalla (es a quién
// hay que llamar primero), así que se destaca con una tarjeta propia en vez
// de ir mezclada con el resto — más contraste de color, borde e ícono más
// grande que las demás filas. Los nombres se parsean del texto libre del
// calendario (parseDeGuardia) para que también sean chips clickeables, con
// el mismo aspecto que los de UTI/Postguardia para los residentes
// reconocidos, y un chip gris aparte para cualquier nombre que no matchee
// con ningún residente (típicamente alguien cubriendo desde otro servicio).
function FilaDeGuardia({ lista, onPick }) {
  const personas = useMemo(() => parseDeGuardia(lista), [lista]);
  return (
    <div style={{ background: FILA_GUARDIA.tint, border: `1.5px solid ${FILA_GUARDIA.rotulo}`, borderRadius: 12, padding: "9px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 800, color: FILA_GUARDIA.accent, letterSpacing: 0.4, textTransform: "uppercase" }}>
          <span style={{ fontSize: 13 }}>🌙</span> De guardia
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: "#BE586B" }}>(a partir de las 16:00 hs)</span>
      </div>
      {personas.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "#FDA4AF", fontStyle: "italic" }}>Sin cargar.</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {personas.map((p, i) => (
            <ChipPersona key={`${p.key}-${i}`} persona={p} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilaResidentes({ label, color, nombres, onPick }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 800, color, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 5 }}>{label}</div>
      {nombres && nombres.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {nombres.map((n) => (
            <ChipPersona key={n} persona={{ tipo: "residente", key: n, nombre: nombrePublico(n) }} onPick={onPick} />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic" }}>Sin asignar.</div>
      )}
    </div>
  );
}

// Chip chico y clickeable para una persona: coloreado por nivel (R2/R3/R4)
// si es un residente reconocido, o gris neutro si es un "invitado" que no
// matchea con ningún residente (ver parseDeGuardia). Más chico que los chips
// grandes del calendario semanal — acá lo que importa es poder tocarlo
// rápido desde el celular, no la lectura a distancia.
function ChipPersona({ persona, onPick }) {
  const esResidente = persona.tipo === "residente";
  const c = esResidente ? (COLOR[LEVEL[persona.key]] || COLOR.R2) : { bg: "#F1F5F9", bd: "#CBD5E1", tx: "#475569", solid: "#94A3B8" };
  return (
    <button onClick={() => onPick(persona)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 9px", borderRadius: 999, background: c.bg, border: `1.5px solid ${c.bd}`, color: c.tx, fontWeight: 700, fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", ...(esResidente && LEVEL[persona.key] === "JR" ? SKIN_JR : {}) }}>
      {esResidente && LEVEL[persona.key] === "JR" && "👑"}
      {persona.nombre}
      <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: esResidente && LEVEL[persona.key] === "JR" ? "rgba(69,26,3,.55)" : c.solid, color: "#fff", textShadow: "none" }}>{esResidente ? LEVEL[persona.key] : "—"}</span>
    </button>
  );
}

function PersonaModal({ persona, telefono, isAdmin, editing, draft, onDraftChange, onEdit, onSave, onCancelEdit, onClose, guardiaActiva }) {
  const esResidente = persona.tipo === "residente";
  // Si hay una guardia activa (tarde/noche/madrugada) y esta persona no está
  // en ella, no está en el hospital ahora. Se avisa, pero el teléfono y el
  // botón de WhatsApp se muestran igual: puede haber motivos para llamarla.
  const fueraDelHospital = !!guardiaActiva && !guardiaActiva.some((p) => p.key === persona.key);
  const c = esResidente ? (COLOR[LEVEL[persona.key]] || COLOR.R2) : { bg: "#F1F5F9", bd: "#CBD5E1", tx: "#475569", solid: "#94A3B8" };
  const limpio = limpiarTelefono(telefono);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "18px 18px 0 0", padding: "18px 20px 26px", width: "100%", maxWidth: 420, boxShadow: "0 -8px 30px rgba(15,23,42,.25)" }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "#E2E8F0", margin: "0 auto 14px" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 17, color: "#0F172A" }}>{persona.nombre}</div>
          <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4, background: c.solid, color: "#fff" }}>{esResidente ? LEVEL[persona.key] : "INVITADO/A"}</span>
        </div>

        {fueraDelHospital && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}>
            <span style={{ fontSize: 15, lineHeight: 1.2 }}>🌙</span>
            <div style={{ fontSize: 12, color: "#92400E", lineHeight: 1.5, fontWeight: 600 }}>
              No se encuentra en el hospital en este momento, contáctese con los médicos de guardia.
            </div>
          </div>
        )}

        {isAdmin && editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            <input value={draft} onChange={(e) => onDraftChange(e.target.value)} placeholder="Ej: 5491122334455 (con 549 adelante, sin espacios ni guiones)" style={{ ...INPUT, width: "100%", boxSizing: "border-box" }} />
            {!esResidente && <div style={{ fontSize: 10.5, color: "#64748B", lineHeight: 1.4 }}>Este contacto no es ninguno de los 12 residentes, así que se guarda solo 15 días y después se borra solo, para no acumular números viejos.</div>}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button onClick={onSave} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 7, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓ Guardar</button>
              <button onClick={onCancelEdit} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 7, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: 14 }}>
            {telefono ? (
              <div style={{ fontSize: 13, color: "#334155", fontWeight: 600 }}>📞 {telefono}</div>
            ) : (
              <div style={{ fontSize: 12.5, color: "#64748B", fontStyle: "italic" }}>Todavía no hay un teléfono cargado para {persona.nombre}.</div>
            )}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {limpio && !editing && (
            <a href={`https://wa.me/${limpio}`} target="_blank" rel="noopener noreferrer" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "#16A34A", color: "#fff", textDecoration: "none", borderRadius: 12, padding: "13px 16px", fontWeight: 700, fontSize: 14.5 }}>
              💬 Enviar WhatsApp
            </a>
          )}
          {isAdmin && !editing && (
            <button onClick={onEdit} style={{ background: "#F1F5F9", color: "#475569", border: "1px solid #E2E8F0", borderRadius: 12, padding: "11px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>✏️ {telefono ? "Editar teléfono" : "Agregar teléfono"}</button>
          )}
          <button onClick={onClose} style={{ background: "none", color: "#64748B", border: "none", padding: "8px 16px", fontWeight: 600, fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" }}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════ IMPRESIONES ══════════════════ */

export { ChipPersona, DiaCard, FilaDeGuardia, FilaResidentes, PersonaModal, QuienEstaHoyView };
