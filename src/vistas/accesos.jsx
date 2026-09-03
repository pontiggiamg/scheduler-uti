/* ══════════════════════════════════════════════════════════════════════════
   La pestaña de accesos
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useMemo } from "react";
import { db } from "../firebase";
import { doc, setDoc, deleteDoc, collection } from "firebase/firestore";
import { escuchar, escribir } from "../nube";
import { Skeleton } from "../comunes";
import { fechaHoraAR } from "../fechas";

// Panel del admin para autorizar o revocar el acceso al scheduler privado.
// Los 12 residentes y la cuenta admin no aparecen acá: entran siempre por
// código (ver el gate en AuthenticatedApp), así que esta lista es solo para
// cuentas "de afuera" que pidieron entrar.
function AccesosView({ user }) {
  const [solicitudes, setSolicitudes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState(null);

  useEffect(() => {
    const unsub = escuchar(collection(db, "usuarios_autorizados"), (snap) => {
      setSolicitudes(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, "la lista de accesos", () => setLoading(false));
    return unsub;
  }, []);

  const revisar = async (id, estado) => {
    await escribir(setDoc(doc(db, "usuarios_autorizados", id), {
      estado,
      revisadoPor: user?.email || "",
      revisadoEn: new Date().toISOString(),
      revisadoEnAR: fechaHoraAR(new Date()),
    }, { merge: true }), estado === "aprobado" ? "aprobar el acceso" : "cambiar el estado del acceso");
  };

  const eliminar = async (id) => {
    await escribir(deleteDoc(doc(db, "usuarios_autorizados", id)), "borrar la solicitud de acceso");
    setConfirmId(null);
  };

  const orden = (a, b) => (b.solicitadoEn || "").localeCompare(a.solicitadoEn || "");
  const pendientes = useMemo(() => solicitudes.filter((s) => s.estado === "pendiente").sort(orden), [solicitudes]);
  const aprobados = useMemo(() => solicitudes.filter((s) => s.estado === "aprobado").sort(orden), [solicitudes]);
  const rechazados = useMemo(() => solicitudes.filter((s) => s.estado === "rechazado").sort(orden), [solicitudes]);

  if (loading) return <Skeleton />;

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <span style={{ fontSize: 22 }}>🔐</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Accesos</div>
          <div style={{ fontSize: 10.5, opacity: 0.7 }}>Quién puede entrar al scheduler privado</div>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.55, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: "9px 13px", marginBottom: 14 }}>
        Los 12 residentes y tu cuenta de administrador entran siempre, sin pedir permiso — no aparecen en estas listas. Acá solo caen las cuentas de Google que no están en ese grupo.
      </div>

      <SeccionAccesos titulo={`Pendientes de autorizar (${pendientes.length})`} vacio="No hay solicitudes esperando." items={pendientes} color="#B45309" bg="#FFFBEB" bd="#FDE68A">
        {(s) => (
          <>
            <button onClick={() => revisar(s.id, "aprobado")} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#16A34A", border: "none", borderRadius: 6, padding: "5px 11px", cursor: "pointer", fontFamily: "inherit" }}>✓ Autorizar</button>
            <button onClick={() => revisar(s.id, "rechazado")} style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 6, padding: "5px 11px", cursor: "pointer", fontFamily: "inherit" }}>✗ Rechazar</button>
          </>
        )}
      </SeccionAccesos>

      <SeccionAccesos titulo={`Con acceso (${aprobados.length})`} vacio="Todavía no autorizaste ninguna cuenta de afuera." items={aprobados} color="#15803D" bg="#F0FDF4" bd="#BBF7D0">
        {(s) => (
          <button onClick={() => revisar(s.id, "rechazado")} style={{ fontSize: 10.5, fontWeight: 700, color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 6, padding: "5px 11px", cursor: "pointer", fontFamily: "inherit" }}>Quitar acceso</button>
        )}
      </SeccionAccesos>

      <SeccionAccesos titulo={`Rechazados (${rechazados.length})`} vacio="Sin cuentas rechazadas." items={rechazados} color="#B91C1C" bg="#FEF2F2" bd="#FECACA">
        {(s) => (
          <>
            <button onClick={() => revisar(s.id, "aprobado")} style={{ fontSize: 10.5, fontWeight: 700, color: "#15803D", background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 6, padding: "5px 11px", cursor: "pointer", fontFamily: "inherit" }}>✓ Autorizar</button>
            {confirmId === s.id ? (
              <span style={{ display: "flex", gap: 4 }}>
                <button onClick={() => eliminar(s.id)} style={{ fontSize: 10, fontWeight: 700, color: "#fff", background: "#DC2626", border: "none", borderRadius: 5, padding: "4px 8px", cursor: "pointer", fontFamily: "inherit" }}>Sí, borrar</button>
                <button onClick={() => setConfirmId(null)} style={{ fontSize: 10, fontWeight: 700, color: "#64748B", background: "#F1F5F9", border: "none", borderRadius: 5, padding: "4px 8px", cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
              </span>
            ) : (
              <button onClick={() => setConfirmId(s.id)} title="Borrar el registro (si vuelve a entrar, pide permiso de nuevo)" style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>🗑️</button>
            )}
          </>
        )}
      </SeccionAccesos>
    </div>
  );
}

function SeccionAccesos({ titulo, vacio, items, color, bg, bd, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>{titulo}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "4px 2px" }}>{vacio}</div>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
          {items.map((s, i) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i === items.length - 1 ? "none" : "1px solid #F1F5F9", flexWrap: "wrap" }}>
              {s.photoURL
                ? <img src={s.photoURL} alt="" style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0 }} />
                : <span style={{ width: 26, height: 26, borderRadius: "50%", background: bg, border: `1px solid ${bd}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>👤</span>}
              <div style={{ flex: 1, minWidth: 150 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A" }}>{s.displayName || "Sin nombre"}</div>
                <div style={{ fontSize: 11, color: "#64748B", wordBreak: "break-all" }}>{s.email || s.id}</div>
                <div style={{ fontSize: 10, color: "#64748B", marginTop: 1 }}>Pidió acceso: {s.solicitadoEnAR || "—"}</div>
              </div>
              <span style={{ fontSize: 9.5, fontWeight: 700, color, background: bg, border: `1px solid ${bd}`, borderRadius: 999, padding: "2px 9px" }}>{s.estado}</span>
              {children(s)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export { AccesosView, SeccionAccesos };
