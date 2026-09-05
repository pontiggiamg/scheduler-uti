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
import { escuchar, escribir, registrarFalla, AvisoDeFallas } from "./nube";
import { isoDate, Skeleton } from "./comunes";
import { ADMIN_EMAIL, DEFAULT_TAB_ORDER, RESIDENT_BY_EMAIL, TAB_META, TAB_RENOMBRADAS, isPublicRoute } from "./config";
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
  const [acceso, setAcceso] = useState("cargando"); // cargando | ok | pendiente | rechazado
  const [pendientesAcceso, setPendientesAcceso] = useState(0);

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

  // ── Control de acceso al scheduler privado ───────────────────────────────
  // Cualquiera puede iniciar sesión con Google, pero solo entra si el jefe de
  // residentes lo autorizó. Dos excepciones que entran siempre y nunca piden
  // permiso: la cuenta admin y los 12 residentes ya mapeados en
  // RESIDENT_EMAIL — así un deploy nuevo jamás deja afuera a la gente que ya
  // venía usando la app. Para el resto se crea (una sola vez) un documento en
  // usuarios_autorizados con estado "pendiente" y se dispara el aviso por
  // Telegram. Como quedamos escuchando ese documento con onSnapshot, cuando
  // el admin aprueba desde su celular la app se desbloquea sola, sin que la
  // persona tenga que recargar nada.
  useEffect(() => {
    if (!user || !user.email) { setAcceso("cargando"); return; }
    const email = user.email.toLowerCase();
    if (email === ADMIN_EMAIL.toLowerCase() || RESIDENT_BY_EMAIL[email]) { setAcceso("ok"); return; }

    const ref = doc(db, "usuarios_autorizados", email);
    let pedidoEnviado = false;
    const unsub = escuchar(ref, async (snap) => {
      if (!snap.exists()) {
        if (pedidoEnviado) return;
        pedidoEnviado = true;
        setAcceso("pendiente");
        try {
          await setDoc(ref, {
            email: user.email,
            displayName: user.displayName || "",
            photoURL: user.photoURL || "",
            estado: "pendiente",
            solicitadoEn: new Date().toISOString(),
            solicitadoEnAR: fechaHoraAR(new Date()),
          });
          // El aviso es "mejor esfuerzo": si el bot de Telegram no está
          // configurado o falla, la solicitud igual queda registrada y el
          // admin la ve con el badge de la pestaña Accesos.
          fetch("/api/notificar-acceso", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: user.email, displayName: user.displayName || "" }),
          }).catch(() => {});
        } catch (e) { registrarFalla("tu pedido de acceso", e, "escritura"); }
        return;
      }
      const estado = snap.data().estado;
      setAcceso(estado === "aprobado" ? "ok" : estado === "rechazado" ? "rechazado" : "pendiente");
    }, "tu estado de acceso", () => setAcceso("pendiente"));
    return unsub;
  }, [user]);

  // Cantidad de solicitudes sin revisar, para el badge rojo de la pestaña
  // Accesos. Solo lo mira la cuenta admin.
  /* Precarga de la Pase App. Se pide el archivo apenas la app está en pie,
     sin esperarlo y sin bloquear nada: para cuando alguien toca la pestaña
     ya está en el navegador. Si falla, no importa —el import de la pestaña
     lo vuelve a pedir—, por eso el catch vacío. */
  useEffect(() => {
    if (!user) return;
    const t = setTimeout(() => { import("./pase/vista").catch(() => {}); }, 1500);
    return () => clearTimeout(t);
  }, [user]);

  useEffect(() => {
    if (!user || user.email !== ADMIN_EMAIL) { setPendientesAcceso(0); return; }
    const unsub = escuchar(collection(db, "usuarios_autorizados"), (snap) => {
      setPendientesAcceso(snap.docs.filter((d) => d.data().estado === "pendiente").length);
    }, null);   // cosmético: es solo el numerito del badge
    return unsub;
  }, [user]);

  if (user === undefined) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Inter', system-ui, sans-serif", color: "#64748B", fontSize: 14 }}>Cargando…</div>;

  if (user === null) return <LoginScreen />;

  const isAdmin = user.email === ADMIN_EMAIL;

  if (acceso === "cargando") return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Inter', system-ui, sans-serif", color: "#64748B", fontSize: 14 }}>Verificando acceso…</div>;
  if (acceso !== "ok") return <PantallaEspera user={user} rechazado={acceso === "rechazado"} />;

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
          return (
            <TabBtn
              key={key}
              active={tab === key}
              onClick={() => setTab(key)}
              badge={key === "accesos" ? pendientesAcceso : 0}
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

      {tab === "scheduler" && <SchedulerView isAdmin={isAdmin} />}
      {tab === "rotaciones" && <RotacionesView isAdmin={isAdmin} />}
      {tab === "pases" && <PasesView isAdmin={isAdmin} />}
      {/* Mientras baja el archivo de la Pase App se ve el mismo "Cargando…"
          que ya se veía mientras llegaban sus datos, así que en la práctica
          no cambia nada de lo que ve la persona. */}
      {tab === "paseapp" && (
        <Suspense fallback={<Skeleton />}>
          <PaseAppView user={user} />
        </Suspense>
      )}
      {tab === "chipa" && <ChipaView isAdmin={isAdmin} user={user} />}
      {tab === "laura" && <LauraView isAdmin={isAdmin} user={user} />}
      {tab === "academico" && <AcademicoView isAdmin={isAdmin} />}
      {tab === "articulo" && <ArticuloSemanaView isAdmin={isAdmin} />}
      {tab === "registro" && <RegistroView isAdmin={isAdmin} user={user} />}
      {tab === "redcap" && <RedcapView user={user} />}
      {tab === "hoy" && <QuienEstaHoyView isAdmin={isAdmin} embedded />}
      {tab === "accesos" && isAdmin && <AccesosView user={user} />}
      {tab === "impresiones" && <ImpresionesView user={user} isAdmin={isAdmin} />}
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

// Lo que ve alguien que inició sesión pero todavía no fue autorizado (o fue
// rechazado). No muestra ningún dato de la app. Cuando el admin aprueba, el
// onSnapshot de AuthenticatedApp cambia el estado y esta pantalla desaparece
// sola, sin necesidad de recargar.
function PantallaEspera({ user, rechazado }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 20, fontFamily: "'Inter', system-ui, sans-serif", background: "#F1F5F9" }}>
      <div style={{ textAlign: "center", padding: "36px 32px", background: "#fff", borderRadius: 16, boxShadow: "0 4px 24px rgba(15,23,42,.1)", border: "1px solid #E2E8F0", maxWidth: 380 }}>
        <div style={{ fontSize: 38, marginBottom: 10 }}>{rechazado ? "⛔" : "⏳"}</div>
        <div style={{ fontWeight: 800, fontSize: 17, color: "#0F172A", marginBottom: 8 }}>
          {rechazado ? "Acceso no autorizado" : "Esperando autorización"}
        </div>
        <div style={{ fontSize: 12.5, color: "#64748B", lineHeight: 1.6, marginBottom: 18 }}>
          {rechazado ? (
            <>Tu cuenta no tiene acceso a esta aplicación. Si creés que es un error, hablá con el jefe de residentes.</>
          ) : (
            <>Tu solicitud ya fue enviada al jefe de residentes. En cuanto la apruebe, esta pantalla se va a desbloquear sola — no hace falta que recargues ni que vuelvas a entrar.</>
          )}
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
