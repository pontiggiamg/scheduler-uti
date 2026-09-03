/* ══════════════════════════════════════════════════════════════════════════
   La pestaña de redcap
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect } from "react";
import { db } from "../firebase";
import { doc, setDoc } from "firebase/firestore";
import { escuchar, escribir } from "../nube";
import { useChico, isoDate, Skeleton } from "../comunes";
import { paCamaOrden, paseNombreYEdad, usePaseDelDrive } from "../pase/motor";
import { REDCAP_COL, REDCAP_PREGUNTAS } from "../config";
import { timeAgo } from "../fechas";
import { colorUnidad, normalize } from "../modelo";

function RedcapView({ user }) {
  const [dia, setDia] = useState(() => isoDate(new Date()));
  // El documento del día entero: las respuestas más los arreglos al padrón.
  const [doc_, setDoc_] = useState({ camas: {}, extras: [], ajustes: {} });
  const [uSel, setUSel] = useState(null);
  const [estado, setEstado] = useState("");
  const [editandoPadron, setEditandoPadron] = useState(false);
  const [nuevo_, setNuevo_] = useState({ cama: "", nombre: "" });
  const [busqueda, setBusqueda] = useState("");
  const chico = useChico();

  const reg = doc_.camas || {};
  const extras = doc_.extras || [];
  const ajustes = doc_.ajustes || {};

  // El pase del Drive: la lista de camas ocupadas sale de ahí, igual que en
  // las otras pestañas. Así no hay que mantener un padrón aparte.
  const { foto, cargando } = usePaseDelDrive(paseNombreYEdad);
  useEffect(() => {
    if (foto && foto.unidades.length) setUSel((cur) => cur || foto.unidades[0]);
  }, [foto]);

  // Lo ya cargado ese día. Un documento por día con todo adentro: son
  // respuestas cortas, entran de sobra y se leen de una sola vez.
  useEffect(() => {
    if (!dia) return;
    const unsub = escuchar(doc(db, REDCAP_COL, dia), (snap) => {
      const d = snap.exists() ? snap.data() : {};
      setDoc_({ camas: d.camas || {}, extras: d.extras || [], ajustes: d.ajustes || {} });
    }, "el relevamiento del RedCap");
    return unsub;
  }, [dia]);

  const guardar = async (parche) => {
    const next = { ...doc_, ...parche };
    setDoc_(next);                    // que se vea ya, sin esperar la red
    const ok = await escribir(setDoc(doc(db, REDCAP_COL, dia), {
      fecha: dia, ...next, actualizado: new Date().toISOString(),
    }, { merge: true }), "el relevamiento del RedCap");
    setEstado(ok
      ? "Guardado " + new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
      : "No se pudo guardar");
  };

  /* ── El padrón del día ───────────────────────────────────────────────────
     La lista de camas sale del pase del Drive, pero el Drive se actualiza
     cuando los residentes llegan a cargarlo, y el que está al lado de la cama
     necesita relevar lo que ve ahora. Así que el padrón se puede arreglar acá
     mismo, de tres formas, que son los tres casos reales:

       · falta un paciente que sí está internado  → se agrega
       · el nombre o la cama están mal            → se corrigen
       · figura alguien que ya se fue             → se saca

     Los arreglos son compartidos: los ve y los puede hacer cualquiera, igual
     que las respuestas. No tocan el pase del Drive ni la Pase App — viven
     solamente en el relevamiento de ese día.

     Se guardan por día y no de forma permanente porque el padrón es parte del
     dato: el 2/9 había estas camas ocupadas. Si mañana el Drive sigue
     desactualizado hay que volver a agregarlo, y eso además avisa que el pase
     del Drive necesita atención. */

  const agregarPaciente = () => {
    const cama = nuevo_.cama.trim(), nombre = nuevo_.nombre.trim();
    if (!cama && !nombre) return;
    const p = {
      id: "x" + Date.now().toString(36),
      unidad: uSel, cama: cama || "—", nombre,
      quien: user?.displayName || user?.email || "—",
      cuando: new Date().toISOString(),
    };
    setNuevo_({ cama: "", nombre: "" });
    guardar({ extras: [...extras, p] });
  };

  const editarExtra = (id, campo, valor) =>
    guardar({ extras: extras.map((x) => x.id === id ? { ...x, [campo]: valor } : x) });

  const borrarExtra = (id) => {
    const camas = { ...reg };
    delete camas[id];                 // se lleva sus respuestas
    guardar({ extras: extras.filter((x) => x.id !== id), camas });
  };

  // Corrección sobre un paciente que vino del Drive. La clave sigue siendo la
  // original, así que las respuestas ya marcadas no se pierden al corregir el
  // nombre o la cama.
  const ajustar = (k, campo, valor) =>
    guardar({ ajustes: { ...ajustes, [k]: { ...(ajustes[k] || {}), [campo]: valor } } });

  const clave = (p) => p.id || `${p.unidad}__${p.cama}`;

  const marcar = (p, campo, valor) => {
    const k = clave(p);
    const previo = reg[k] || {};
    // Volver a tocar la misma respuesta la borra: es la forma de deshacer un
    // dedazo sin agregar un botón de "limpiar".
    const n = { ...previo };
    if (n[campo] === valor) delete n[campo];
    else n[campo] = valor;
    n._quien = user?.displayName || user?.email || "—";
    n._cuando = new Date().toISOString();
    n._nombre = p.nombre || "";
    guardar({ camas: { ...reg, [k]: n } });
  };

  /* La lista final de una unidad: los del Drive con sus correcciones
     aplicadas y sin los que se sacaron, más los agregados a mano. */
  const pacientesDe = (u) => {
    const delDrive = (foto?.pacientes || [])
      .filter((p) => p.unidad === u)
      .map((p) => {
        const k = `${p.unidad}__${p.cama}`;
        const a = ajustes[k] || {};
        return { ...p, nombre: a.nombre ?? p.nombre, cama: a.cama ?? p.cama, _k: k, _oculto: !!a.oculto };
      })
      .filter((p) => !p._oculto);
    const propios = extras.filter((x) => x.unidad === u);
    return [...delDrive, ...propios]
      .sort((a, b) => paCamaOrden(a.cama).localeCompare(paCamaOrden(b.cama)));
  };

  /* ── Buscar un paciente en toda la UTI ───────────────────────────────────
     Son cuatro unidades y casi treinta camas: el que está al lado del
     paciente sabe cómo se llama, no en qué unidad lo tiene cargado el pase.
     Buscar recorre UTI 1, 2, 3 y RECU juntas.

     Se compara sin acentos y sin distinguir mayúsculas, porque los nombres
     vienen del Drive escritos como cada uno los escribió: "MARTINEZ" y
     "Martínez" tienen que encontrarse igual.

     Cada palabra buscada se exige por separado y en cualquier orden, así
     "perez juan" encuentra a "Juan Pérez". También matchea el número de
     cama: si alguien tipea "1.4" es evidente qué está buscando. */
  const sinAcentos = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const terminos = sinAcentos(busqueda).split(/\s+/).filter(Boolean);
  const buscando = terminos.length > 0;

  const encontrados = !buscando ? [] : (foto?.unidades || [])
    .flatMap((u) => pacientesDe(u))
    .filter((p) => {
      const donde = sinAcentos(p.nombre) + " " + sinAcentos(p.cama);
      return terminos.every((t) => donde.includes(t));
    });

  // Para bajar y cargar en el RedCap. Sin esto los datos quedan encerrados en
  // la app, que es el problema que esta pestaña vino a resolver.
  const exportar = () => {
    const cols = ["fecha", "unidad", "cama", "paciente", "origen",
      ...REDCAP_PREGUNTAS.map(([k]) => k), "completado_por", "completado_el"];
    const filas = [cols.join(",")];
    for (const u of (foto?.unidades || [])) {
      for (const p of pacientesDe(u)) {
        const r = reg[clave(p)] || {};
        const val = (x) => x === true ? "1" : x === false ? "0" : "";
        const txt = (x) => `"${String(x == null ? "" : x).replace(/"/g, '""')}"`;
        filas.push([
          dia, txt(u), txt(p.cama), txt(p.nombre), txt(p.id ? "agregado a mano" : "pase del Drive"),
          ...REDCAP_PREGUNTAS.map(([k]) => val(r[k])),
          txt(r._quien || ""), txt(r._cuando || ""),
        ].join(","));
      }
    }
    // BOM adelante para que Excel en Windows respete los acentos.
    const blob = new Blob(["\ufeff" + filas.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `redcap-uti-${dia}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  if (cargando) return <Skeleton />;
  if (!foto) return (
    <div style={{ padding: 20, fontSize: 13.5, color: "#64748B" }}>
      Todavía no hay ningún pase cargado. Entrá una vez a la pestaña Pases para que se sincronice.
    </div>
  );

  const B = { fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 5, border: "1.5px solid #E2E8F0", background: "#fff", color: "#0F172A", cursor: "pointer" };
  const INP = { fontFamily: "inherit", fontSize: 13, padding: "7px 9px", border: "1.5px solid #CBD5E1", borderRadius: 5, minHeight: 38, boxSizing: "border-box" };
  // Lo que se está mirando: la unidad elegida, o el resultado de la búsqueda
  // si hay algo escrito en el buscador.
  const delDia = pacientesDe(uSel);
  const aMostrar = buscando ? encontrados : delDia;
  const completas = aMostrar.filter((p) => {
    const r = reg[clave(p)] || {};
    return REDCAP_PREGUNTAS.every(([k]) => typeof r[k] === "boolean");
  }).length;
  const hoy = isoDate(new Date());

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ background: "#0F172A", color: "#fff", borderRadius: 10, padding: "16px 18px", marginBottom: 14 }}>
        <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: -0.3 }}>Ayudanos con el RedCap</div>
        <div style={{ fontSize: 13, lineHeight: 1.55, opacity: 0.85, marginTop: 6 }}>
          Ocho preguntas por paciente, sí o no. Lo puede completar cualquiera y se guarda solo.
          Si el pase del Drive quedó desactualizado, podés arreglar la lista de camas acá mismo.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <label style={{ fontSize: 12.5, color: "#475569", display: "flex", alignItems: "center", gap: 6 }}>
          Día
          <input type="date" value={dia} max={hoy} onChange={(e) => setDia(e.target.value)}
            style={{ ...INP, minHeight: 34 }} />
        </label>
        {dia !== hoy && <button onClick={() => setDia(hoy)} style={B}>Volver a hoy</button>}
        <button onClick={exportar} style={B}>Bajar CSV de este día</button>
        {estado && <span style={{ fontSize: 11.5, color: "#64748B", marginLeft: "auto" }}>{estado}</span>}
      </div>

      {/* Buscar en las cuatro unidades a la vez. Va arriba de las pestañas de
          unidad porque cuando uno busca a alguien no sabe —ni le importa— en
          qué unidad está: ese es justamente el dato que viene a averiguar. */}
      <div style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 10 }}>
        <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, opacity: 0.5, pointerEvents: "none" }}>🔎</span>
          <input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setBusqueda("")}
            placeholder="Buscar paciente por nombre o apellido"
            style={{ ...INP, width: "100%", paddingLeft: 32 }} />
        </div>
        {buscando && (
          <button onClick={() => setBusqueda("")} style={B} title="Volver a ver por unidad">
            Limpiar
          </button>
        )}
      </div>

      {/* Con el buscador activo las unidades no se eligen: se está mirando
          todo junto. Se dejan a la vista igual, apagadas, para no hacer
          desaparecer media pantalla de golpe. */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12, opacity: buscando ? 0.45 : 1 }}>
        {/* El resaltado del botón elegido usa `border` entero y no
            `borderColor`: mezclar la forma corta con la larga sobre la misma
            propiedad hace que React avise en consola cada vez que el botón
            cambia de estado, y ahora cambia cada vez que se escribe o se
            limpia la búsqueda. */}
        {foto.unidades.map((u) => (
          <button key={u} onClick={() => { setBusqueda(""); setUSel(u); }}
            style={{ ...B, fontWeight: 700, ...(!buscando && u === uSel ? { background: "#0F172A", border: "1.5px solid #0F172A", color: "#fff" } : {}) }}>
            {u} <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 10, opacity: 0.7 }}>{pacientesDe(u).length}</span>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 12.5, color: "#475569" }}>
          {buscando ? (
            <>
              {aMostrar.length === 0
                ? <>Ningún paciente coincide con <b>“{busqueda.trim()}”</b> en las cuatro unidades.</>
                : <><b>{aMostrar.length}</b> {aMostrar.length === 1 ? "paciente encontrado" : "pacientes encontrados"} en toda la UTI · <b>{completas}</b> con las ocho respuestas</>}
            </>
          ) : (
            <>{uSel}: <b>{completas}</b> de <b>{delDia.length}</b> camas completas</>
          )}
          {dia !== hoy && <span style={{ color: "#8A4B00", marginLeft: 8 }}>· estás viendo el {dia.split("-").reverse().join("/")}</span>}
        </span>
        <button onClick={() => setEditandoPadron((v) => !v)}
          style={{ ...B, marginLeft: "auto", ...(editandoPadron ? { background: "#0F172A", borderColor: "#0F172A", color: "#fff" } : {}) }}>
          {editandoPadron ? "Listo" : "Corregir la lista de camas"}
        </button>
      </div>

      {/* Corregir nombres y camas anda igual buscando; lo que no tiene sentido
          durante una búsqueda es AGREGAR, porque se agrega a una unidad y en
          ese momento no hay ninguna elegida. */}
      {editandoPadron && (
        <div style={{ background: "#FFFBF3", border: "1.5px solid #E9C48A", borderRadius: 8, padding: "13px 15px", marginBottom: 12 }}>
          <div style={{ fontSize: 12.5, color: "#7A4B00", lineHeight: 1.5, marginBottom: buscando ? 0 : 10 }}>
            {buscando
              ? <>Podés corregir el nombre o la cama de los pacientes que encontraste. Para <b>agregar</b> uno nuevo, limpiá la búsqueda y elegí primero la unidad.</>
              : <>Agregá un paciente que el pase del Drive todavía no tiene, corregí un nombre o una cama,
                 o sacá a alguien que ya se fue. Es sólo para el relevamiento de este día y lo ven todos.</>}
          </div>
          <div style={{ display: buscando ? "none" : "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
            <input value={nuevo_.cama} placeholder="Cama"
              onChange={(e) => setNuevo_((n) => ({ ...n, cama: e.target.value }))}
              style={{ ...INP, width: 90, fontFamily: "ui-monospace,monospace" }} />
            <input value={nuevo_.nombre} placeholder="Nombre y apellido"
              onChange={(e) => setNuevo_((n) => ({ ...n, nombre: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && agregarPaciente()}
              style={{ ...INP, flex: 1, minWidth: 170 }} />
            <button onClick={agregarPaciente}
              style={{ ...B, background: "#0F172A", borderColor: "#0F172A", color: "#fff", minHeight: 38 }}>
              Agregar a {uSel}
            </button>
          </div>
        </div>
      )}

      {!buscando && delDia.length === 0 && (
        <div style={{ fontSize: 13, color: "#64748B", padding: "14px 2px" }}>
          No hay camas cargadas en {uSel}. Usá “Corregir la lista de camas” para agregarlas.
        </div>
      )}

      {aMostrar.map((p) => {
        const k = clave(p);
        const r = reg[k] || {};
        const listo = REDCAP_PREGUNTAS.every(([kk]) => typeof r[kk] === "boolean");
        const propio = !!p.id;
        return (
          <div key={k} style={{ background: "#fff", border: `1.5px solid ${listo ? "#86EFAC" : "#E2E8F0"}`, borderRadius: 8, padding: "12px 14px", marginBottom: 9 }}>
            {editandoPadron ? (
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", marginBottom: 9 }}>
                <input value={p.cama || ""}
                  onChange={(e) => propio ? editarExtra(p.id, "cama", e.target.value) : ajustar(p._k, "cama", e.target.value)}
                  style={{ ...INP, width: 90, fontFamily: "ui-monospace,monospace", fontWeight: 700 }} />
                <input value={p.nombre || ""} placeholder="Nombre y apellido"
                  onChange={(e) => propio ? editarExtra(p.id, "nombre", e.target.value) : ajustar(p._k, "nombre", e.target.value)}
                  style={{ ...INP, flex: 1, minWidth: 160 }} />
                <button
                  onClick={() => propio ? borrarExtra(p.id) : ajustar(p._k, "oculto", true)}
                  title={propio ? "Sacar esta cama que agregaste" : "Este paciente ya no está en la UTI"}
                  style={{ ...B, color: "#B91C1C", border: "1.5px solid #FCA5A5", minHeight: 38 }}>
                  Sacar
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap", marginBottom: 9 }}>
                {/* Buscando, la unidad es el dato que se vino a averiguar: va
                    primero y bien visible. Viendo una unidad sola, sobra. */}
                {buscando && (
                  <span style={{ fontSize: 11.5, fontWeight: 800, color: colorUnidad(p.unidad).fuerte, background: colorUnidad(p.unidad).suave, borderRadius: 5, padding: "2px 8px" }}>
                    {p.unidad}
                  </span>
                )}
                <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 16, fontWeight: 800 }}>{p.cama}</span>
                <span style={{ fontSize: 14.5, fontWeight: 700 }}>{p.nombre || "—"}</span>
                {p.edad && <span style={{ fontSize: 11.5, color: "#64748B" }}>{p.edad} años</span>}
                {propio && (
                  <span title={`Agregado por ${p.quien}`}
                    style={{ fontSize: 11, fontWeight: 700, color: "#7A4B00", background: "#FFFBF3", border: "1px solid #E9C48A", borderRadius: 999, padding: "2px 9px" }}>
                    agregado a mano
                  </span>
                )}
                {listo && <span style={{ fontSize: 11, fontWeight: 700, color: "#166534", background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 999, padding: "2px 9px" }}>completo</span>}
              </div>
            )}

            {REDCAP_PREGUNTAS.map(([campo, rot]) => (
              <div key={campo} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", flexWrap: "wrap", borderTop: "1px solid #F1F5F9" }}>
                <span style={{ flex: 1, fontSize: 13, color: "#334155", minWidth: 165 }}>{rot}</span>
                {[["Sí", true], ["No", false]].map(([txt, val]) => {
                  const activo = r[campo] === val;
                  return (
                    <button key={txt} onClick={() => marcar(p, campo, val)}
                      title={activo ? "Tocá de nuevo para desmarcar" : ""}
                      style={{ fontFamily: "inherit", fontSize: 13, fontWeight: 700,
                        minWidth: chico ? 62 : 54, minHeight: 38, borderRadius: 6, cursor: "pointer",
                        border: `1.5px solid ${activo ? (val ? "#166534" : "#B91C1C") : "#CBD5E1"}`,
                        background: activo ? (val ? "#166534" : "#B91C1C") : "#fff",
                        color: activo ? "#fff" : "#475569" }}>
                      {txt}
                    </button>
                  );
                })}
              </div>
            ))}

            {r._quien && (
              <div style={{ fontSize: 11, color: "#64748B", marginTop: 8, paddingTop: 7, borderTop: "1px dashed #E2E8F0" }}>
                Última marca de <b>{r._quien}</b>
                {r._cuando && " · " + new Date(r._cuando).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.55, padding: "6px 2px 30px" }}>
        Se guarda solo, sin botón de confirmar. Tocá de nuevo una respuesta para desmarcarla.
        Las camas salen del último pase del Drive ({foto.tomado ? timeAgo(foto.tomado) : "sin fecha"}),
        más los arreglos que se hayan hecho para este día.
      </div>
    </div>
  );
}

export { RedcapView };
