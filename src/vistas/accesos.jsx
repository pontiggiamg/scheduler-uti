/* ══════════════════════════════════════════════════════════════════════════
   La pestaña de accesos

   Rediseñada el 5/9/2026: reemplaza al viejo sistema de "12 residentes
   hardcodeados + aprobación manual por mail" por roles. Tres cosas separadas
   acá adentro:

     1. AUDITORÍA — todas las cuentas de Google que alguna vez entraron a la
        app (según access_logs, que ya registraba cada login) cruzadas contra
        quién tiene rol asignado. Esto es lo que el jefe de residentes pidió
        explícitamente: poder ver si hay cuentas usando la app que él no vio
        nunca en esta pantalla. Antes esto no existía — la lista vieja de
        "solicitudes" solo mostraba a quien pasaba por el flujo de pedir
        acceso, y una cuenta que entraba por otro lado (ej. estaba en la
        lista hardcodeada de residentes) no dejaba ningún rastro visible acá.

     2. ROLES POR CUENTA — asignar o cambiar el rol de cada cuenta. Sin rol,
        la cuenta ve la pantalla de espera y no entra a ninguna pestaña.

     3. PESTAÑAS POR ROL — qué pestañas puede ver cada rol, configurable en
        vivo desde acá (colección scheduler/roles_config), sin necesidad de
        tocar código ni hacer un deploy nuevo. El admin no aparece en esta
        sección: siempre ve todas las pestañas, sin excepción.
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useMemo } from "react";
import { db } from "../firebase";
import { doc, setDoc, deleteDoc, collection } from "firebase/firestore";
import { escuchar, escribir } from "../nube";
import { Skeleton } from "../comunes";
import { fechaHoraAR } from "../fechas";
import { ADMIN_EMAIL, ROLES, ROLES_ASIGNABLES, TAB_META } from "../config";

// Una cuenta cuenta como "activa" si su último ingreso registrado (ver
// access_logs más abajo) cayó dentro de las últimas 24 horas. `access_logs`
// no se escribe solo al hacer login: se escribe en cada carga de la app y en
// cada renovación de sesión de Firebase (cada más o menos una hora mientras
// la pestaña sigue abierta), así que en la práctica funciona como un "última
// vez que esta cuenta tuvo la app abierta" — no hace falta agregar un
// registro nuevo por cada cambio de pestaña adentro de la app para tener una
// señal de actividad razonable.
const VEINTICUATRO_HS_MS = 24 * 60 * 60 * 1000;
const activo24h = (loginAtISO) => !!loginAtISO && (Date.now() - new Date(loginAtISO).getTime()) < VEINTICUATRO_HS_MS;

// Una cuenta SIN rol que hace más de 48 hs que no entra se deja de mostrar
// acá — el servidor además la borra de verdad de access_logs (ver
// api/limpiar-accesos.js, corre solo una vez por día), pero esto hace que la
// lista ya se vea limpia al instante, sin esperar a que corra ese cron. Si la
// cuenta entra de nuevo, genera un registro nuevo y reaparece.
const CUARENTA_Y_OCHO_HS_MS = 48 * 60 * 60 * 1000;
const dentroDe48hs = (loginAtISO) => !!loginAtISO && (Date.now() - new Date(loginAtISO).getTime()) < CUARENTA_Y_OCHO_HS_MS;

// "hace 5 min" / "hace 3 h" / "hace 2 d" — más rápido de leer de un vistazo
// que la fecha y hora completas cuando lo que importa es "¿esto es reciente?".
function haceRelativo(loginAtISO) {
  if (!loginAtISO) return null;
  const ms = Date.now() - new Date(loginAtISO).getTime();
  if (ms < 0) return "recién";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const hs = Math.floor(min / 60);
  if (hs < 24) return `hace ${hs} h`;
  const dias = Math.floor(hs / 24);
  return `hace ${dias} d`;
}

function AccesosView({ user }) {
  const [logs, setLogs] = useState([]);
  const [cuentas, setCuentas] = useState([]);
  const [rolesConfig, setRolesConfig] = useState({});
  const [loading, setLoading] = useState(true);
  const [seccion, setSeccion] = useState("cuentas"); // cuentas | roles
  const [soloActivos, setSoloActivos] = useState(false);

  useEffect(() => {
    const unsub = escuchar(collection(db, "access_logs"), (snap) => {
      setLogs(snap.docs.map((d) => d.data()));
      setLoading(false);
    }, "el registro de accesos", () => setLoading(false));
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = escuchar(collection(db, "cuentas"), (snap) => {
      setCuentas(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, "las cuentas con rol asignado");
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = escuchar(doc(db, "scheduler", "roles_config"), (snap) => {
      setRolesConfig(snap.exists() ? snap.data() : {});
    }, "la configuración de roles");
    return unsub;
  }, []);

  // "hace 5 min" y el punto verde de actividad dependen de la hora actual, no
  // solo de los datos — sin esto quedarían congelados en lo que decían cuando
  // llegó el último cambio de Firestore, y "hace 2 min" se leería igual media
  // hora después. Un tick por minuto alcanza para esta pantalla.
  const [, forzarTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forzarTick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, []);

  // Una fila por cuenta que alguna vez entró (de access_logs), con su último
  // ingreso y el rol que tenga asignado, si tiene. Se arma agrupando por
  // email porque access_logs tiene un documento por CADA login, no uno por
  // persona — puede haber cientos de filas de la misma cuenta.
  const cuentasVistas = useMemo(() => {
    const porEmail = new Map();
    for (const l of logs) {
      if (!l.email) continue;
      const email = l.email.toLowerCase();
      const prev = porEmail.get(email);
      if (!prev || (l.loginAt || "") > (prev.loginAt || "")) {
        porEmail.set(email, { email, displayName: l.displayName || "", loginAt: l.loginAt || "", loginAtAR: l.loginAtAR || "" });
      }
    }
    const cuentaPorEmail = new Map(cuentas.map((c) => [c.id, c]));
    return [...porEmail.values()]
      .map((v) => ({ ...v, cuenta: cuentaPorEmail.get(v.email) || null }))
      .sort((a, b) => (b.loginAt || "").localeCompare(a.loginAt || ""));
  }, [logs, cuentas]);

  const esAdminEmail = (email) => email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  // Sin rol Y hace más de 48 hs que no entra: se saca de la vista (ver
  // dentroDe48hs más arriba). A alguien CON rol nunca se le aplica este corte,
  // por eso conRolTodas no lo usa.
  const sinRolTodas = useMemo(() => cuentasVistas.filter((c) => !esAdminEmail(c.email) && !c.cuenta && dentroDe48hs(c.loginAt)), [cuentasVistas]);
  const conRolTodas = useMemo(() => cuentasVistas.filter((c) => !esAdminEmail(c.email) && c.cuenta), [cuentasVistas]);
  const sinRol = sinRolTodas;
  const conRol = useMemo(() => soloActivos ? conRolTodas.filter((c) => activo24h(c.loginAt)) : conRolTodas, [conRolTodas, soloActivos]);
  const activosCount = useMemo(() => conRolTodas.filter((c) => activo24h(c.loginAt)).length, [conRolTodas]);

  const asignarRol = async (email, rol) => {
    await escribir(setDoc(doc(db, "cuentas", email), {
      email,
      rol,
      displayName: (cuentasVistas.find((c) => c.email === email) || {}).displayName || "",
      asignadoPor: user?.email || "",
      asignadoEn: new Date().toISOString(),
      asignadoEnAR: fechaHoraAR(new Date()),
    }, { merge: true }), "asignar el rol");
  };

  const quitarRol = async (email) => {
    await escribir(deleteDoc(doc(db, "cuentas", email)), "quitar el acceso");
  };

  const toggleTabRol = async (rol, tabKey) => {
    const actuales = new Set((rolesConfig[rol] || {}).tabs || []);
    actuales.has(tabKey) ? actuales.delete(tabKey) : actuales.add(tabKey);
    const next = { ...rolesConfig, [rol]: { tabs: [...actuales] } };
    setRolesConfig(next); // optimista: se ve al toque, sin esperar la vuelta de Firestore
    await escribir(setDoc(doc(db, "scheduler", "roles_config"), next), "la configuración de pestañas por rol");
  };

  if (loading) return <Skeleton />;

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <span style={{ fontSize: 22 }}>🔐</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Accesos</div>
          <div style={{ fontSize: 10.5, opacity: 0.7 }}>Quién puede entrar al scheduler y qué ve cada uno</div>
        </div>
      </div>

      <div className="no-print" style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        <button onClick={() => setSeccion("cuentas")} style={tabSeccion(seccion === "cuentas")}>👤 Cuentas {sinRol.length > 0 && <Badge n={sinRol.length} />}</button>
        <button onClick={() => setSeccion("roles")} style={tabSeccion(seccion === "roles")}>🗂️ Pestañas por rol</button>
      </div>

      {seccion === "cuentas" ? (
        <CuentasSeccion sinRol={sinRol} conRol={conRol} totalConRol={conRolTodas.length} activosCount={activosCount}
          soloActivos={soloActivos} onToggleActivos={() => setSoloActivos((v) => !v)}
          onAsignar={asignarRol} onQuitar={quitarRol} />
      ) : (
        <RolesSeccion rolesConfig={rolesConfig} onToggle={toggleTabRol} />
      )}
    </div>
  );
}

const tabSeccion = (activo) => ({
  fontSize: 12, fontWeight: 700, padding: "7px 14px", borderRadius: 8, border: `1.5px solid ${activo ? "#0F172A" : "#E2E8F0"}`,
  background: activo ? "#0F172A" : "#fff", color: activo ? "#fff" : "#475569", cursor: "pointer", fontFamily: "inherit",
  display: "flex", alignItems: "center", gap: 6,
});

function Badge({ n }) {
  return <span style={{ fontSize: 10, fontWeight: 800, background: "#DC2626", color: "#fff", borderRadius: 999, padding: "1px 6px" }}>{n}</span>;
}

// ── Sección 1 y 2: auditoría de cuentas + asignación de rol ────────────────
function CuentasSeccion({ sinRol, conRol, totalConRol, activosCount, soloActivos, onToggleActivos, onAsignar, onQuitar }) {
  return (
    <div>
      {sinRol.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#B45309", marginBottom: 6 }}>⚠️ Sin rol asignado ({sinRol.length})</div>
          <div style={{ fontSize: 11, color: "#92400E", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "7px 11px", marginBottom: 8, lineHeight: 1.5 }}>
            Estas cuentas ya iniciaron sesión en la app (quedó registrado en el ingreso) pero no ven ninguna pestaña hasta que les asignes un rol. Si alguna no te suena, es justamente lo que esta lista está para mostrarte. Si no le asignás nada, desaparece sola de acá a las 48 hs de su último ingreso — no hace falta que la borres vos.
          </div>
          <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
            {sinRol.map((c, i) => <FilaCuenta key={c.email} c={c} i={i} total={sinRol.length} onAsignar={onAsignar} onQuitar={onQuitar} />)}
          </div>
        </div>
      )}

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>Con rol asignado ({totalConRol})</div>
          {/* Filtro de actividad: pensado para chequear rápido, antes de una
              guardia o a la mañana, quién efectivamente abrió la app en las
              últimas 24 hs — sin tener que leer fecha por fecha en la lista
              completa. "Activo" acá quiere decir "tuvo la app abierta en
              algún momento de las últimas 24 hs", no "la tiene abierta ahora
              mismo" (ver nota en activo24h más arriba). */}
          <button onClick={onToggleActivos} style={{ ...tabSeccion(soloActivos), padding: "5px 11px", fontSize: 11 }}>
            🟢 Activos últimas 24 h ({activosCount}/{totalConRol})
          </button>
        </div>
        {totalConRol === 0 ? (
          <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "4px 2px" }}>Todavía no le asignaste rol a ninguna cuenta.</div>
        ) : conRol.length === 0 ? (
          <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", padding: "4px 2px" }}>Nadie con rol asignado entró en las últimas 24 hs.</div>
        ) : (
          <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", overflow: "hidden" }}>
            {conRol.map((c, i) => <FilaCuenta key={c.email} c={c} i={i} total={conRol.length} onAsignar={onAsignar} onQuitar={onQuitar} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function FilaCuenta({ c, i, total, onAsignar, onQuitar }) {
  const rol = c.cuenta?.rol;
  const activo = activo24h(c.loginAt);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i === total - 1 ? "none" : "1px solid #F1F5F9", flexWrap: "wrap" }}>
      <span title={activo ? "Entró en las últimas 24 hs" : "No entró en las últimas 24 hs"} style={{ width: 26, height: 26, borderRadius: "50%", background: "#F1F5F9", border: "1px solid #E2E8F0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0, position: "relative" }}>
        👤
        <span style={{ position: "absolute", bottom: -1, right: -1, width: 9, height: 9, borderRadius: "50%", background: activo ? "#22C55E" : "#CBD5E1", border: "1.5px solid #fff" }} />
      </span>
      <div style={{ flex: 1, minWidth: 150 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A" }}>{c.displayName || "Sin nombre"}</div>
        <div style={{ fontSize: 11, color: "#64748B", wordBreak: "break-all" }}>{c.email}</div>
        <div style={{ fontSize: 10, color: activo ? "#16A34A" : "#94A3B8", marginTop: 1, fontWeight: activo ? 700 : 400 }}>
          Último ingreso: {c.loginAtAR || "—"}{c.loginAt && ` · ${haceRelativo(c.loginAt)}`}
        </div>
      </div>
      {/* El selector solo cambia ENTRE roles — bajarla a "Sin rol…" desde acá
          quedó sacado a propósito. Eliminar el acceso de alguien es una
          acción con consecuencias reales (la próxima vez que la persona
          abra la app se encuentra con la pantalla de "no tenés acceso" y
          tiene que esperar a que se lo reasignen), así que tiene su propio
          botón bien visible en vez de ser una opción más de un desplegable
          donde un clic de más la dispara sin querer. */}
      <select value={rol || ""} onChange={(e) => onAsignar(c.email, e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 11.5, fontFamily: "inherit", background: "#fff", color: rol ? "#0F172A" : "#94A3B8" }}>
        {!rol && <option value="">Sin rol…</option>}
        {ROLES_ASIGNABLES.map((r) => <option key={r} value={r}>{ROLES[r].icon} {ROLES[r].label}</option>)}
      </select>
      {rol && (
        <button
          onClick={() => {
            if (confirm(`¿Eliminar el acceso de ${c.displayName || c.email}?\n\nLa próxima vez que intente entrar a la app va a ver la pantalla de "no tenés acceso" hasta que le vuelvas a asignar un rol desde acá. No se borra su historial (pases, procedimientos, etc.), solo el permiso para entrar.`)) onQuitar(c.email);
          }}
          title="Eliminar acceso — va a tener que pedirlo de nuevo"
          style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid #FECACA", background: "#FEF2F2", color: "#DC2626", cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
        >
          🗑️
        </button>
      )}
    </div>
  );
}

// ── Sección 3: qué pestañas ve cada rol ─────────────────────────────────────
function RolesSeccion({ rolesConfig, onToggle }) {
  const tabs = Object.entries(TAB_META).filter(([key, meta]) => !meta.soloAdmin && key !== "accesos");
  return (
    <div>
      <div style={{ fontSize: 11, color: "#64748B", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "7px 11px", marginBottom: 14, lineHeight: 1.5 }}>
        Tildá qué pestañas puede ver cada rol. Se guarda al toque y aplica a todas las cuentas con ese rol, sin que nadie tenga que recargar. El admin no está en esta lista: siempre ve todas las pestañas.
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11.5 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "6px 10px", color: "#64748B", fontWeight: 700, fontSize: 10.5, position: "sticky", left: 0, background: "#fff" }}>Pestaña</th>
              {ROLES_ASIGNABLES.map((r) => (
                <th key={r} style={{ padding: "6px 8px", color: "#334155", fontWeight: 700, whiteSpace: "nowrap" }}>{ROLES[r].icon} {ROLES[r].label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tabs.map(([key, meta], i) => (
              <tr key={key} style={{ background: i % 2 ? "#F8FAFC" : "#fff" }}>
                <td style={{ padding: "7px 10px", fontWeight: 600, color: "#0F172A", whiteSpace: "nowrap", position: "sticky", left: 0, background: i % 2 ? "#F8FAFC" : "#fff" }}>{meta.icon} {meta.label}</td>
                {ROLES_ASIGNABLES.map((r) => {
                  const on = ((rolesConfig[r] || {}).tabs || []).includes(key);
                  return (
                    <td key={r} style={{ textAlign: "center", padding: "7px 8px" }}>
                      <input type="checkbox" checked={on} onChange={() => onToggle(r, key)} style={{ cursor: "pointer", width: 16, height: 16 }} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export { AccesosView };
