/* ══════════════════════════════════════════════════════════════════════════
   EL ARRANQUE

   Lo único que quedó acá es cómo entra la gente y qué pestaña se muestra: la
   ruta pública /hoy, el login con Google, el permiso de acceso y la barra de
   pestañas. Cada pantalla vive en su propio archivo, en vistas/.

   Todo lo que habla con la base pasa por nube.jsx, y vale la pena leer el
   encabezado de ese archivo: es lo que hace que un error de la base se vea en
   pantalla en vez de convertirse en una pantalla vacía y silenciosa.
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, lazy, Suspense } from "react";
import Lab, { isLabRoute } from "./Lab";
import { db, auth, googleProvider } from "./firebase";
import { doc, setDoc, collection } from "firebase/firestore";
import { signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";
import { escuchar, escribir, AvisoDeFallas } from "./nube";
import { isoDate, Skeleton } from "./comunes";
import { ADMIN_EMAIL, DEFAULT_TAB_ORDER, ROLES, TAB_META, TAB_RENOMBRADAS, isPublicRoute } from "./config";
import { fechaHoraAR } from "./fechas";
import { ImpresionesView } from "./impresion";
import { TabBtn } from "./ui";
import { AcademicoView } from "./vistas/academico";
import { AccesosView } from "./vistas/accesos";
import { ArticuloSemanaView } from "./vistas/articulo";
import { ChipaView } from "./vistas/chipa";
import { QuienEstaHoyView } from "./vistas/hoy";
import { LauraView } from "./vistas/laura";
import { PasesView } from "./vistas/pases";
import { RedcapView } from "./vistas/redcap";
import { RegistroView } from "./vistas/registro";
import { RotacionesView } from "./vistas/rotaciones";
import { SchedulerView } from "./vistas/semana";

/* La Pase App se carga aparte, no con el resto de la app.

   Son 2700 líneas —la pantalla más grande que hay— y sólo las necesita quien
   abre esa pestaña. Con este import dinámico, quien entra a ver el
   cronograma, o quien abre "¿Quién está hoy?" desde el celular en la puerta
   de la UTI, no baja nada de eso.

   Para que el que SÍ la va a usar no espere, se pide sola en segundo plano
   apenas la app termina de arrancar (ver el efecto de precarga más abajo):
   cuando toca la pestaña, ya está. */
const PaseAppView = lazy(() => import("./pase/vista"));

// Punto de entrada real. Antes de cualquier hook de autenticación, se fija si
// la URL pedida es la ruta pública /hoy: en ese caso se renderiza solo
// QuienEstaHoyView (sin login, de solo lectura) y ni se monta el resto de la
// app. Esta función no llama ningún hook, así que evaluar la condición acá
// (en vez de adentro de AuthenticatedApp) no rompe las reglas de hooks de
// React.
export default function Root() {
  // Laboratorio de versiones: ruta oculta, no enlazada desde ninguna pestaña.
  if (isLabRoute()) return <Lab />;
  if (isPublicRoute()) return <QuienEstaHoyView isAdmin={false} embedded={false} />;
  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = no user, object = logged in
  const [tab, setTab] = useState("scheduler");
  const [tabOrder, setTabOrder] = useState(DEFAULT_TAB_ORDER);
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const [acceso, setAcceso] = useState("cargando"); // cargando | ok | sin-rol
  const [rol, setRol] = useState(null);
  const [rolesConfig, setRolesConfig] = useState(null);
  const [cuentasSinRol, setCuentasSinRol] = useState(0);

  useEffect(() => {
    const ref = doc(db, "scheduler", "ui-config");
    const unsub = escuchar(ref, (snap) => {
      const guardado = snap.exists() ? snap.data().tabOrder : null;
      const stored = Array.isArray(guardado) ? guardado.map((k) => TAB_RENOMBRADAS[k] || k) : null;
      if (Array.isArray(stored) && stored.length) {
        const known = stored.filter((k, i) => DEFAULT_TAB_ORDER.includes(k) && stored.indexOf(k) === i);
        const missing = DEFAULT_TAB_ORDER.filter((k) => !known.includes(k));
        setTabOrder([...known, ...missing]);
      } else {
        setTabOrder(DEFAULT_TAB_ORDER);
      }
    }, null);   // cosmético: si falla, se usa el orden por defecto y nadie nota nada
    return unsub;
  }, []);

  const persistTabOrder = (next) => {
    setTabOrder(next);
    escribir(setDoc(doc(db, "scheduler", "ui-config"), { tabOrder: next }, { merge: true }), "el orden de las pestañas");
  };

  const handleTabDragStart = (i) => (e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; };
  const handleTabDragEnter = (i) => (e) => { e.preventDefault(); if (dragIdx !== null) setOverIdx(i); };
  const handleTabDragOver = (e) => { e.preventDefault(); };
  const handleTabDragEnd = () => { setDragIdx(null); setOverIdx(null); };
  const handleTabDrop = (i) => (e) => {
    e.preventDefault();
    const from = dragIdx;
    setDragIdx(null); setOverIdx(null);
    if (from === null || from === i) return;
    const next = [...tabOrder];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    persistTabOrder(next);
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (u && u.email) {
        try {
          await setDoc(doc(db, "access_logs", `${u.uid}-${Date.now()}`), {
            email: u.email,
            uid: u.uid,
            loginAt: new Date().toISOString(),
            loginAtAR: fechaHoraAR(new Date()),
            displayName: u.displayName || "Sin nombre",
          });
          localStorage.setItem("uti-last-access-log", isoDate(new Date()));
        } catch (e) { console.error("log de acceso", e); }
      }
      setUser(u || null);
    });
    return unsub;
  }, []);

  // El registro de arriba solo se dispara en el login (o al recargar la página),
  // así que si alguien deja la pestaña abierta varios días sin recargar no queda
  // registro de esos días. Pero tampoco queremos contar "pestaña abierta sin
  // tocar" como uso — lo que interesa es actividad real: que la persona haya
  // navegado o tocado algo en la app ese día. Por eso enganchamos cualquier
  // click dentro de la app (cambiar de pestaña, tocar un botón, etc.) y, la
  // primera vez que eso pasa en el día, registramos el ingreso.
  useEffect(() => {
    if (!user || !user.email) return;
    const registrarSiNoHoy = async () => {
      const hoy = isoDate(new Date());
      if (localStorage.getItem("uti-last-access-log") === hoy) return;
      try {
        await setDoc(doc(db, "access_logs", `${user.uid}-${Date.now()}`), {
          email: user.email,
          uid: user.uid,
          loginAt: new Date().toISOString(),
          loginAtAR: fechaHoraAR(new Date()),
          displayName: user.displayName || "Sin nombre",
        });
        localStorage.setItem("uti-last-access-log", hoy);
      } catch (e) { console.error("log de acceso diario", e); }
    };
    document.addEventListener("click", registrarSiNoHoy);
    return () => document.removeEventListener("click", registrarSiNoHoy);
  }, [user]);

  // ── Control de acceso al scheduler privado (roles) ───────────────────────
  // Desde el 5/9/2026 reemplaza al sistema viejo (12 residentes hardcodeados
  // + aprobación manual por mail vía usuarios_autorizados). Ahora cada cuenta
  // de Google tiene un rol asignado a mano por el admin en la pestaña
  // Accesos (colección `cuentas`, documento por mail), y qué pestañas ve cada
  // rol se define EN VIVO desde esa misma pestaña (`scheduler/roles_config`).
  //
  // La cuenta admin (ADMIN_EMAIL) es la única excepción: nunca depende de
  // esta colección, siempre entra y siempre ve todo — así el jefe de
  // residentes no puede quedar bloqueado de su propia app por un typo o un
  // rol mal configurado. Cualquier otra cuenta sin rol asignado ve la
  // pantalla de espera hasta que se le asigne uno.
  useEffect(() => {
    if (!user || !user.email) { setAcceso("cargando"); setRol(null); return; }
    const email = user.email.toLowerCase();
    if (email === ADMIN_EMAIL.toLowerCase()) { setAcceso("ok"); setRol("admin"); return; }

    const ref = doc(db, "cuentas", email);
    const unsub = escuchar(ref, (snap) => {
      const r = snap.exists() ? snap.data().rol : null;
      if (r && ROLES[r]) { setRol(r); setAcceso("ok"); }
      else { setRol(null); setAcceso("sin-rol"); }
    }, "tu rol de acceso", () => setAcceso("sin-rol"));
    return unsub;
  }, [user]);

  // Qué pestañas puede ver cada rol. Documento único, editable desde Accesos.
  // Si todavía no existe (primera vez que se sube este sistema) o un rol no
  // tiene entrada, esa cuenta no ve ninguna pestaña hasta que el admin se lo
  // configure — a propósito: mejor "no veo nada, aviso al jefe" que exponer
  // de más por un default optimista.
  useEffect(() => {
    if (!user) { setRolesConfig(null); return; }
    const unsub = escuchar(doc(db, "scheduler", "roles_config"), (snap) => {
      setRolesConfig(snap.exists() ? snap.data() : {});
    }, null);   // cosmético: mientras no llegue, se ve como "sin pestañas" un instante
    return unsub;
  }, [user]);

  /* Precarga de la Pase App. Se pide el archivo apenas la app está en pie,
     sin esperarlo y sin bloquear nada: para cuando alguien toca la pestaña
     ya está en el navegador. Si falla, no importa —el import de la pestaña
     lo vuelve a pedir—, por eso el catch vacío. */
  useEffect(() => {
    if (!user) return;
    const t = setTimeout(() => { import("./pase/vista").catch(() => {}); }, 1500);
    return () => clearTimeout(t);
  }, [user]);

  // Cantidad de cuentas que ya entraron alguna vez (según access_logs) pero
  // todavía no tienen rol asignado, para el badge rojo de la pestaña Accesos.
  // Es justamente lo que el jefe de residentes pidió: que no se le pase por
  // alto una cuenta que ya está usando la app sin que él la haya visto.
  useEffect(() => {
    if (!user || user.email !== ADMIN_EMAIL) { setCuentasSinRol(0); return; }
    let logs = null, cuentas = null;
    const recalcular = () => {
      if (!logs || !cuentas) return;
      const conRol = new Set(cuentas.map((c) => c.id));
      const vistos = new Set();
      logs.forEach((l) => { if (l.email) vistos.add(l.email.toLowerCase()); });
      let n = 0;
      vistos.forEach((email) => { if (email !== ADMIN_EMAIL.toLowerCase() && !conRol.has(email)) n++; });
      setCuentasSinRol(n);
    };
    const unsub1 = escuchar(collection(db, "access_logs"), (snap) => {
      logs = snap.docs.map((d) => d.data());
      recalcular();
    }, null);
    const unsub2 = escuchar(collection(db, "cuentas"), (snap) => {
      cuentas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      recalcular();
    }, null);
    return () => { unsub1(); unsub2(); };
  }, [user]);

  if (user === undefined) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Inter', system-ui, sans-serif", color: "#64748B", fontSize: 14 }}>Cargando…</div>;

  if (user === null) return <LoginScreen />;

  const isAdmin = user.email === ADMIN_EMAIL;

  if (acceso === "cargando") return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Inter', system-ui, sans-serif", color: "#64748B", fontSize: 14 }}>Verificando acceso…</div>;
  if (acceso !== "ok") return <PantallaEspera user={user} />;

  // Pestañas visibles para el rol actual. El admin siempre ve todas, sin
  // mirar roles_config — ver el comentario más arriba sobre por qué. Para el
  // resto, `tabsDelRol` viene de scheduler/roles_config[rol].tabs; hasta que
  // el admin lo configure, la lista sale vacía y esa cuenta no ve pestañas
  // (a propósito: mejor pedirle que avise que exponer de más por default).
  const tabsDelRol = isAdmin ? null : (rolesConfig && rol ? (rolesConfig[rol]?.tabs || []) : []);
  const puedeVerTab = (key) => tabsDelRol === null || tabsDelRol.includes(key);

  return (
    <div style={{ maxWidth: 1500, margin: "0 auto", padding: "14px 12px 40px", fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Lo que la base no pudo leer o guardar, dicho en pantalla. Va arriba
          de todo a propósito: si algo no se está guardando, eso es más
          importante que cualquier cosa que se vea abajo. Cuando no hay nada
          fallando no ocupa espacio. Ver nube.jsx. */}
      <AvisoDeFallas />

      {/* User bar */}
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, padding: "6px 12px", background: "#F8FAFC", borderRadius: 10, border: "1px solid #E2E8F0", fontSize: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {user.photoURL && <img src={user.photoURL} alt="" style={{ width: 24, height: 24, borderRadius: "50%" }} />}
          <span style={{ color: "#475569", fontWeight: 500 }}>{user.displayName || user.email}</span>
          {isAdmin && <span style={{ fontSize: 9, fontWeight: 700, background: "#0F172A", color: "#fff", padding: "2px 6px", borderRadius: 4 }}>ADMIN</span>}
          {!isAdmin && rol && <span style={{ fontSize: 9, fontWeight: 700, background: "#E2E8F0", color: "#334155", padding: "2px 6px", borderRadius: 4 }}>{ROLES[rol]?.icon} {ROLES[rol]?.label?.toUpperCase()}</span>}
          {!isAdmin && <span style={{ fontSize: 9, fontWeight: 600, background: "#E2E8F0", color: "#64748B", padding: "2px 6px", borderRadius: 4 }}>SOLO LECTURA</span>}
        </div>
        <button onClick={() => signOut(auth)} style={{ background: "none", border: "none", color: "#64748B", fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: 500 }}>Cerrar sesión</button>
      </div>

      {/* Tabs */}
      {isAdmin && <div className="no-print" style={{ fontSize: 10, color: "#64748B", marginBottom: 4, paddingLeft: 2 }}>Arrastrá una pestaña para reordenarlas</div>}
      <div className="no-print" style={{ display: "flex", gap: 0, marginBottom: 14, flexWrap: "wrap" }}>
        {tabOrder.map((key, i) => {
          const meta = TAB_META[key];
          if (!meta) return null;
          if (meta.soloAdmin && !isAdmin) return null;
          if (!puedeVerTab(key)) return null;
          return (
            <TabBtn
              key={key}
              active={tab === key}
              onClick={() => setTab(key)}
              badge={key === "accesos" ? cuentasSinRol : 0}
              draggable={isAdmin}
              dragging={dragIdx === i}
              dropTarget={isAdmin && overIdx === i && dragIdx !== null && dragIdx !== i}
              onDragStart={handleTabDragStart(i)}
              onDragEnter={handleTabDragEnter(i)}
              onDragOver={handleTabDragOver}
              onDrop={handleTabDrop(i)}
              onDragEnd={handleTabDragEnd}
            >
              {meta.icon} {meta.label}
              {/* Etiqueta 'Alpha': avisa que la pestaña está en prueba y que lo
                  que se guarde ahí puede cambiar de forma sin aviso. */}
              {meta.tag && <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", background: tab === key ? "#334155" : "#CBD5E1", color: tab === key ? "#E2E8F0" : "#475569", borderRadius: 4, padding: "1px 5px" }}>{meta.tag}</span>}
            </TabBtn>
          );
        })}
      </div>

      {!isAdmin && tabsDelRol && tabsDelRol.length === 0 && (
        <div style={{ fontSize: 12, color: "#92400E", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "12px 14px", marginBottom: 14, lineHeight: 1.5 }}>
          Tu rol ({ROLES[rol]?.label || rol}) todavía no tiene ninguna pestaña habilitada. Avisale al jefe de residentes para que te las configure desde Accesos.
        </div>
      )}

      {/* Cada pestaña se filtra también acá, no solo en la barra: si el rol
          de alguien cambia mientras tiene una pestaña abierta que ya no le
          corresponde, deja de verse el contenido en el próximo render, no
          solo el botón. */}
      {tab === "scheduler" && puedeVerTab("scheduler") && <SchedulerView isAdmin={isAdmin} />}
      {tab === "rotaciones" && puedeVerTab("rotaciones") && <RotacionesView isAdmin={isAdmin} />}
      {tab === "pases" && puedeVerTab("pases") && <PasesView isAdmin={isAdmin} />}
      {/* Mientras baja el archivo de la Pase App se ve el mismo "Cargando…"
          que ya se veía mientras llegaban sus datos, así que en la práctica
          no cambia nada de lo que ve la persona. */}
      {tab === "paseapp" && puedeVerTab("paseapp") && (
        <Suspense fallback={<Skeleton />}>
          <PaseAppView user={user} />
        </Suspense>
      )}
      {tab === "chipa" && puedeVerTab("chipa") && <ChipaView isAdmin={isAdmin} user={user} />}
      {tab === "laura" && puedeVerTab("laura") && <LauraView isAdmin={isAdmin} user={user} />}
      {tab === "academico" && puedeVerTab("academico") && <AcademicoView isAdmin={isAdmin} />}
      {tab === "articulo" && puedeVerTab("articulo") && <ArticuloSemanaView isAdmin={isAdmin} />}
      {tab === "registro" && puedeVerTab("registro") && <RegistroView isAdmin={isAdmin} user={user} />}
      {tab === "redcap" && puedeVerTab("redcap") && <RedcapView user={user} />}
      {tab === "hoy" && puedeVerTab("hoy") && <QuienEstaHoyView isAdmin={isAdmin} embedded />}
      {tab === "accesos" && isAdmin && <AccesosView user={user} />}
      {tab === "impresiones" && puedeVerTab("impresiones") && <ImpresionesView user={user} isAdmin={isAdmin} />}
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
        <div style={{ fontSize: 12, color: "#64748B", marginBottom: 24 }}>Hospital Británico</div>
        <button onClick={login} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "11px 16px", borderRadius: 10, border: "1px solid #E2E8F0", background: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", color: "#334155", boxShadow: "0 1px 3px rgba(15,23,42,.08)", transition: "box-shadow .15s" }}>
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>
          Iniciar sesión con Google
        </button>
        {error && <div style={{ color: "#DC2626", fontSize: 11.5, marginTop: 12, fontWeight: 500 }}>{error}</div>}
      </div>
    </div>
  );
}

// Lo que ve alguien que inició sesión pero todavía no tiene un rol asignado.
// No muestra ningún dato de la app. Cuando el admin le asigna un rol desde la
// pestaña Accesos, el onSnapshot de AuthenticatedApp lo detecta solo y esta
// pantalla desaparece, sin necesidad de recargar. Ya no hay estado
// "pendiente"/"rechazado" ni solicitud automática: el admin ve la cuenta en
// la lista de "sin rol" (viene de access_logs, que registra cualquier login)
// y le asigna un rol cuando corresponda.
function PantallaEspera({ user }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 20, fontFamily: "'Inter', system-ui, sans-serif", background: "#F1F5F9" }}>
      <div style={{ textAlign: "center", padding: "36px 32px", background: "#fff", borderRadius: 16, boxShadow: "0 4px 24px rgba(15,23,42,.1)", border: "1px solid #E2E8F0", maxWidth: 380 }}>
        <div style={{ fontSize: 38, marginBottom: 10 }}>⏳</div>
        <div style={{ fontWeight: 800, fontSize: 17, color: "#0F172A", marginBottom: 8 }}>Todavía no tenés acceso</div>
        <div style={{ fontSize: 12.5, color: "#64748B", lineHeight: 1.6, marginBottom: 18 }}>
          Tu cuenta inició sesión correctamente, pero el jefe de residentes todavía no te asignó un rol. Avisale directamente — esta pantalla se va a desbloquear sola en cuanto lo haga, sin que tengas que recargar ni volver a entrar.
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 9, padding: "8px 12px", marginBottom: 16 }}>
          {user.photoURL && <img src={user.photoURL} alt="" style={{ width: 22, height: 22, borderRadius: "50%" }} />}
          <span style={{ fontSize: 11.5, color: "#475569", fontWeight: 600, wordBreak: "break-all" }}>{user.email}</span>
        </div>
        <button onClick={() => signOut(auth)} style={{ background: "none", border: "none", color: "#64748B", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Cerrar sesión</button>
      </div>
    </div>
  );
}
