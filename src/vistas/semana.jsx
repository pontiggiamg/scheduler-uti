/* ══════════════════════════════════════════════════════════════════════════
   La pestaña de semana
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react";
import { db } from "../firebase";
import { doc, setDoc, getDoc } from "firebase/firestore";
import { escuchar, escribir, useGuardadoConEspera, CARTEL_ESTADO } from "../nube";
import { useChico, shift, isoDate, Skeleton } from "../comunes";
import { ALL, ASIGNABLES, COLOR, DAYS, DIAS_LIBRES_OPCIONES, EQUIPO_MAX, EQUIPO_SLOTS, FILA_GUARDIA, LEVEL, MONTHS, RESIDENTS, SLOTS, SLOT_KEYS, isWeekendIdx, porJerarquia } from "../config";
import { dm, etiquetaMes, lunesDelMes, mesDeLaSemana, mondayOf, sameDay } from "../fechas";
import { analizarSemana, clone, emptyAcademico, emptyWeek, esResidente, isBlank, motivoNoDisponible, normalizarListaGuardia, normalize, normalizeAcademico, useRotaciones } from "../modelo";
import { AutoOutChip, Banner, Cell, Chip, ChipGuardia, Corner, Dash, DayHead, GhostHint, INPUT, Legend, MenuItem, NAV, OutChip, PanelAlertas, RowLabel, TEXTAREA } from "../ui";

function SchedulerView({ isAdmin }) {
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [week, setWeek] = useState(emptyWeek);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState(null);
  const [toast, setToast] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [academico, setAcademico] = useState(emptyAcademico);
  const [guardiaEdit, setGuardiaEdit] = useState(null); // índice del día cuya guardia se está editando
  const [feriadosOpen, setFeriadosOpen] = useState(false);
  const [aplicandoMes, setAplicandoMes] = useState(false);
  const [equiposDoc, setEquiposDoc] = useState({});

  /* En el celular la semana entera no entra: son 104 px de rótulo más siete
     columnas de 150, o sea 1154 px contra los 375 de un teléfono. Antes se
     resolvía con scroll horizontal, que obliga a arrastrar tres pantallas
     para ver el viernes y hace imposible comparar dos días.

     Abajo de 640 px se muestra UN día por vez, con flechas para moverse. La
     grilla es la misma —mismas celdas, mismos chips, mismo código—: lo único
     que cambia es cuántas columnas se dibujan. Arranca en el día de hoy, que
     es el que uno quiere ver cuando abre la app en el pasillo. */
  const chico = useChico();
  const [diaVis, setDiaVis] = useState(() => {
    const hoy = new Date();
    const i = Math.floor((hoy - mondayOf(hoy)) / 86400000);
    return i >= 0 && i < DAYS.length ? i : 0;
  });
  // Al imprimir manda la semana entera aunque estemos en el celular: el papel
  // no tiene el problema de ancho que tiene la pantalla, y un cronograma
  // impreso con un solo día no le sirve a nadie.
  const [imprimiendo, setImprimiendo] = useState(false);
  // Qué se ve: el día de hoy o la semana entera. Arranca en HOY en todas las
  // pantallas —no sólo en el celular— porque el 95% de las veces uno abre la
  // app para ver quién está hoy, y la grilla de siete días obliga a buscar la
  // columna correcta antes de leer nada. La semana completa sigue a un toque.
  const [verSemana, setVerSemana] = useState(false);
  const DIAS_VIS = (verSemana || imprimiendo) ? DAYS.map((_, i) => i) : [diaVis];

  const docId = `week-${isoDate(monday)}`;
  const dirty = useRef(false);
  const toastTimer = useRef(null);

  useEffect(() => {
    setLoading(true); setSel(null); dirty.current = false;
    const ref = doc(db, "scheduler", docId);
    // El `{ includeMetadataChanges: false }` que estaba acá era el valor por
    // defecto de onSnapshot, así que no hacía nada. `snap.metadata` sigue
    // llegando igual, que es lo que mira la línea de abajo.
    const unsub = escuchar(ref, (snap) => {
      if (snap.metadata.hasPendingWrites || dirty.current) { setLoading(false); return; }
      setWeek(snap.exists() ? normalize(snap.data()) : emptyWeek());
      setLoading(false);
    }, "el cronograma de la semana", () => setLoading(false));
    return unsub;
  }, [docId]);

  // Rotaciones y vacaciones del año (o de los dos años, si la semana cruza el
  // 31 de diciembre). Se usan para calcular quién queda fuera de la grilla de
  // camas sin marcarlo a mano.
  const aniosEnVista = useMemo(() => {
    const a = new Set();
    for (let i = 0; i < DAYS.length; i++) a.add(shift(monday, i).getFullYear());
    return [...a];
  }, [monday]);
  const rotPorAnio = useRotaciones(aniosEnVista);

  useEffect(() => {
    const unsub = escuchar(doc(db, "scheduler", "equipos"), (snap) => setEquiposDoc(snap.exists() ? snap.data() : {}), "los equipos por UTI");
    return unsub;
  }, []);

  // Recordatorios se nutre en modo lectura del Calendario académico: la fuente
  // de verdad es esa pestaña, acá solo se refleja si hay clase ese día.
  useEffect(() => {
    const ref = doc(db, "scheduler", "academico");
    const unsub = escuchar(ref, (snap) => setAcademico(snap.exists() ? normalizeAcademico(snap.data()) : emptyAcademico()), "el calendario académico");
    return unsub;
  }, []);

  /* Guardar la semana. La espera y el estado los maneja useGuardadoConEspera
     (ver nube.jsx); lo único propio de acá es `dirty`, que le dice al
     onSnapshot de arriba que ignore lo que llegue de la nube mientras haya
     cambios locales sin escribir — si no, lo que uno acaba de mover se
     revierte solo en pantalla al llegar el eco del guardado anterior. */
  // Beacon de emergencia: manda el cambio pendiente al endpoint del servidor
  // (api/guardar-emergencia.js) con navigator.sendBeacon, que el navegador
  // garantiza enviar aunque la pestaña se esté cerrando o recargando en ese
  // mismo instante — a diferencia del setDoc normal de Firestore, cuya
  // conexión el navegador puede cortar a mitad de camino. No reemplaza el
  // guardado normal, es la red de contención para ese instante puntual.
  const enviarBeacon = useCallback((payload) => {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
    try {
      const blob = new Blob([JSON.stringify({ docId, datos: payload })], { type: "application/json" });
      navigator.sendBeacon("/api/guardar-emergencia", blob);
    } catch (e) { console.error("beacon de emergencia:", e); }
  }, [docId]);

  const { guardar: guardarSemana, estado: status, forzar } = useGuardadoConEspera(
    async (payload) => {
      await setDoc(doc(db, "scheduler", docId), payload);
      dirty.current = false;
    },
    { etiqueta: "el cronograma de la semana", puede: isAdmin, espera: 350, alSalirDeEmergencia: enviarBeacon }
  );

  const commit = useCallback((next, delay) => {
    if (!isAdmin) return;
    setWeek(next); dirty.current = true;
    guardarSemana(next, delay);
  }, [guardarSemana, isAdmin]);

  // Cerrar la pestaña con algo sin guardar: se escribe ya (forzar) y además
  // se manda el beacon de emergencia, por si el setDoc normal no llega a
  // confirmarse antes de que el navegador corte la conexión al descargar la
  // página. El "pagehide" y el "visibilitychange" (los que funcionan en el
  // celular) ya cubren esto mismo desde useGuardadoConEspera; esto suma el
  // caso de escritorio con "beforeunload".
  useEffect(() => {
    const h = () => { if (dirty.current) enviarBeacon(week); forzar(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [forzar, enviarBeacon, week]);

  const flash = (msg) => { setToast(msg); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 2400); };

  const locationOf = (w, name, di) => { const d = w.days[di]; for (const k of SLOT_KEYS) if (d[k].includes(name)) return k; if (d.unavailable.includes(name)) return "unavailable"; return null; };
  const detach = (w, name, di) => { const d = w.days[di]; for (const k of SLOT_KEYS) d[k] = d[k].filter((n) => n !== name); d.unavailable = d.unavailable.filter((n) => n !== name); };

  // Motivo por el que alguien no debería estar en sala ese día (rotación,
  // vacaciones o día libre), o null si está disponible. No bloquea: la grilla
  // igual deja asignarlo, pero avisa antes y después marca el chip.
  const motivoDe = useCallback((name, di) => {
    const fecha = shift(monday, di);
    const diaLibre = RESIDENTS.R4.includes(name) && week.diasLibresR4[name] === DAYS[di] ? week.diasLibresR4[name] : null;
    return motivoNoDisponible(name, fecha, rotPorAnio, diaLibre);
  }, [monday, week, rotPorAnio]);

  const pool = useCallback((di) => {
    const d = week.days[di];
    const used = new Set([...SLOT_KEYS.flatMap((k) => d[k]), ...d.unavailable]);
    return ASIGNABLES.filter((n) => !used.has(n) && !motivoDe(n, di));
  }, [week, motivoDe]);

  // Los que quedan fuera automáticamente ese día, para mostrarlos en la fila de
  // "No disponibles" sin que nadie los haya marcado a mano.
  const autoNoDisponibles = useCallback((di) => {
    const d = week.days[di];
    const yaPuestos = new Set([...SLOT_KEYS.flatMap((k) => d[k]), ...d.unavailable]);
    return ASIGNABLES.filter((n) => !yaPuestos.has(n)).map((n) => ({ name: n, motivo: motivoDe(n, di) })).filter((x) => x.motivo);
  }, [week, motivoDe]);

  const pick = (name, from) => {
    if (!isAdmin) return;
    setSel((cur) => cur && cur.name === name && cur.from?.di === from?.di && cur.from?.key === from?.key ? null : { name, from });
  };

  // Sábado, domingo y feriado comparten el mismo régimen: sin camas fijas.
  const utiBloqueada = (di) => isWeekendIdx(di) || week.days[di].feriado;

  const place = (target, di) => {
    if (!sel || !isAdmin) return;
    if (utiBloqueada(di) && (target === "uti1" || target === "uti2" || target === "uti3")) return; // fin de semana o feriado: UTI 1/2/3 bloqueadas
    const { name, from } = sel; setSel(null);
    if (from && from.di === di && from.key === target) return;
    const next = clone(week);
    if (target === "pool") { detach(next, name, di); commit(next); return; }
    const already = locationOf(next, name, di);
    if (already && already !== from?.key) { const nice = already === "unavailable" ? "no disponible" : already.toUpperCase(); flash(`${name} ya figura el ${DAYS[di]} en ${nice}`); return; }
    // Avisa pero no frena: la realidad tiene excepciones. Si se asigna igual,
    // el chip queda marcado con ⚠️ y el motivo al pasar el mouse.
    if (target !== "unavailable" && target !== "pool") {
      const motivo = motivoDe(name, di);
      if (motivo) flash(`⚠️ ${motivo} — igual quedó asignado el ${DAYS[di].toLowerCase()}`);
    }
    if (from) detach(next, name, from.di);
    detach(next, name, di);
    next.days[di][target].push(name);
    commit(next);
  };

  // La guardia se edita aparte del sistema de "seleccionar y ubicar", porque
  // ese sistema es excluyente (mueve a la persona de un lugar a otro) y acá
  // justamente queremos que se superponga con lo que ya tenga ese día.
  const setGuardia = (di, lista) => { if (!isAdmin) return; const next = clone(week); next.days[di].deGuardia = lista; commit(next, 200); };

  const removeChip = (name, di) => { if (!isAdmin) return; const next = clone(week); detach(next, name, di); setSel(null); commit(next); };
  const editText = (di, field, value) => { if (!isAdmin) return; const next = clone(week); next.days[di][field] = value; commit(next, 700); };
  const setDiaLibre = (name, day) => { if (!isAdmin) return; const next = clone(week); next.diasLibresR4[name] = day; commit(next, 300); };

  // Comodín es sólo una marca visual (ver modelo.jsx): no toca disponibilidad
  // ni asignaciones, así que alcanza con prender/apagar el nombre en la lista.
  // Se guarda sin espera (delay 0): con debounce, alguien podía tocar el
  // comodín y cerrar la pestaña o apretar F5 antes de que el guardado
  // llegara a salir, y el cambio se perdía. Arrancar el guardado ya mismo le
  // da a Firestore el máximo margen posible para confirmar antes de que el
  // navegador corte la conexión.
  const toggleComodin = (name) => {
    if (!isAdmin) return;
    const next = clone(week);
    const set = new Set(next.comodines || []);
    set.has(name) ? set.delete(name) : set.add(name);
    next.comodines = [...set];
    commit(next, 0);
  };

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

  // Un feriado se cubre igual que un fin de semana: no hay grilla fija de
  // camas, solo guardia y postguardia. Por eso al marcarlo se vacían UTI 1/2/3
  // de ese día — si no, quedarían asignaciones invisibles (la fila está
  // bloqueada) pero que igual sacarían a esa gente de "Disponibles", que es
  // justo el tipo de estado fantasma que después nadie entiende. Se avisa
  // antes de borrar nada.
  // El día libre de los R4 se elige por mes, pero se guarda por semana para
  // poder hacer excepciones puntuales. Esto propaga lo que está cargado en la
  // semana actual a todas las semanas del mismo mes: se elige una vez y vale
  // para todo el mes, y si después hace falta cambiar una semana suelta, se
  // cambia solo ahí sin romper el resto.
  const aplicarDiasLibresAlMes = async () => {
    if (!isAdmin || aplicandoMes) return;
    const mes = monday.getMonth();
    const anio = monday.getFullYear();
    const lunes = lunesDelMes(anio, mes);
    if (!confirm(`Se van a copiar los días libres de esta semana a las ${lunes.length} semanas de ${MONTHS[mes].toLowerCase()}. ¿Continuar?`)) return;
    setAplicandoMes(true);
    try {
      for (const l of lunes) {
        const id = `week-${isoDate(l)}`;
        if (id === docId) continue; // la actual ya está guardada
        const ref = doc(db, "scheduler", id);
        const snap = await getDoc(ref);
        const base = snap.exists() ? normalize(snap.data()) : emptyWeek();
        base.diasLibresR4 = { ...week.diasLibresR4 };
        await setDoc(ref, base);
      }
      flash(`Días libres aplicados a ${MONTHS[mes].toLowerCase()}`);
    } catch (e) { console.error(e); flash("No se pudieron aplicar"); }
    setAplicandoMes(false);
  };

  const toggleFeriado = (di) => {
    if (!isAdmin) return;
    const next = clone(week);
    const d = next.days[di];
    if (!d.feriado) {
      const asignados = ["uti1", "uti2", "uti3"].reduce((n, k) => n + d[k].length, 0);
      if (asignados > 0 && !confirm(`El ${DAYS[di].toLowerCase()} tiene ${asignados} asignación${asignados === 1 ? "" : "es"} en UTI 1/2/3. Al marcarlo como feriado esas filas se bloquean y esas asignaciones se borran. ¿Continuar?`)) return;
      ["uti1", "uti2", "uti3"].forEach((k) => { d[k] = []; });
    }
    d.feriado = !d.feriado;
    commit(next, 200);
  };

  // Imprimir / PDF: se ajusta solo para que todo el calendario (hasta
  // Recordatorios) entre en una sola hoja A4 horizontal. Medimos el bloque
  // imprimible ya con el ancho fijo de la hoja y con los textos completos
  // (no el textarea recortado) para calcular cuánto hay que achicarlo.
  //
  // Usamos "zoom" en vez de "transform: scale()" para achicar el bloque:
  // transform solo cambia lo que se ve, pero el motor de impresión de Chrome
  // calcula los saltos de página con el tamaño ORIGINAL (sin escalar), así
  // que con transform el contenido se seguía recortando aunque visualmente
  // "entrara" en la vista previa. "zoom" en cambio reacomoda el layout de
  // verdad a la escala pedida, así que tanto el cálculo de página como lo
  // que se ve quedan consistentes.
  const printRef = useRef(null);
  // En el celular la grilla muestra un día; para imprimir hacen falta los
  // siete. Se enciende el flag, se espera un repintado —la medición de abajo
  // lee el DOM de forma síncrona, así que tiene que encontrar ya la semana
  // entera— y recién ahí se imprime.
  const handlePrint = () => {
    if (chico && !imprimiendo) {
      setImprimiendo(true);
      setTimeout(() => { imprimirAhora(); setTimeout(() => setImprimiendo(false), 600); }, 60);
      return;
    }
    imprimirAhora();
  };

  const imprimirAhora = () => {
    setMenuOpen(false);

    // El título de la pestaña lo cambiamos primero y antes que cualquier otra
    // cosa: Chrome usa el título de la pestaña (que se propaga al proceso del
    // navegador de forma asíncrona) para proponer el nombre del PDF al
    // "Guardar como". Si lo cambiamos recién justo antes de imprimir, a veces
    // el navegador todavía no llegó a enterarse del nuevo título y usa el
    // viejo. Por eso lo hacemos ya mismo, y dejamos varios milisegundos antes
    // de abrir el diálogo de impresión.
    const prevTitle = document.title;
    const inicio = shift(monday, 0);
    const fin = shift(monday, DAYS.length - 1);
    const mismoMes = inicio.getMonth() === fin.getMonth();
    const rango = mismoMes
      ? `${inicio.getDate()} al ${fin.getDate()} de ${MONTHS[inicio.getMonth()].toLowerCase()}`
      : `${inicio.getDate()} de ${MONTHS[inicio.getMonth()].toLowerCase()} al ${fin.getDate()} de ${MONTHS[fin.getMonth()].toLowerCase()}`;
    document.title = `Scheduler UTI — Semana del ${rango}`;

    const el = printRef.current;
    if (!el) {
      setTimeout(() => {
        window.print();
        setTimeout(() => { document.title = prevTitle; }, 300);
      }, 150);
      return;
    }

    const PAGE_W = 1020; // ancho útil en A4 horizontal (96dpi). Va con margen de
    const PAGE_H = 690;  // sobra sobre los 1062px teóricos: si el usuario deja
    // los márgenes "predeterminados" en el diálogo en vez de los 8mm de @page,
    // Chrome ignora la regla y el área imprimible se achica. Con este colchón
    // entra igual y solo se pierde un 3% de tamaño.

    const noPrintEls = el.querySelectorAll(".no-print");
    const printOnlyEls = el.querySelectorAll(".print-only, .print-only-block");
    const prevNoPrint = Array.from(noPrintEls).map((n) => n.style.display);
    const prevPrintOnly = Array.from(printOnlyEls).map((n) => n.style.display);

    // Simulamos por un instante cómo se va a ver impreso (textos completos en
    // vez de los textarea recortados) para medir el alto real.
    noPrintEls.forEach((n) => { n.style.display = "none"; });
    printOnlyEls.forEach((n) => { n.style.display = n.classList.contains("print-only-block") ? "block" : "inline"; });

    // La grilla vive dentro de un contenedor con overflow-x:auto para poder
    // scrollearla en pantalla. Eso rompía la impresión de dos maneras a la vez:
    // el contenedor recortaba la última columna (el domingo), y además su
    // scroll propio hacía que el ancho real de la grilla NO apareciera en el
    // scrollWidth del bloque de impresión — así que la medición daba "entra
    // justo", el zoom quedaba en 1 y nadie achicaba nada. Por eso, antes de
    // medir, abrimos esos contenedores.
    const scrollers = el.querySelectorAll(".print-scroll");
    const prevOverflow = Array.from(scrollers).map((n) => n.style.overflowX);
    scrollers.forEach((n) => { n.style.overflowX = "visible"; });

    const prevWidth = el.style.width;
    const prevZoom = el.style.zoom;
    el.style.zoom = "1";
    el.style.width = PAGE_W + "px";

    // Con los contenedores abiertos, scrollWidth ya incluye lo que se desborda.
    // Igual medimos también los hijos directos por si alguno desborda por su
    // cuenta, para no volver a subestimar el ancho.
    const anchoHijos = Array.from(el.querySelectorAll(".print-scroll > *")).map((n) => n.scrollWidth);
    const naturalW = Math.max(el.scrollWidth, ...anchoHijos, 1);
    const naturalH = el.scrollHeight;
    const scale = Math.min(1, PAGE_W / naturalW, PAGE_H / naturalH);

    // El ancho lo dejamos fijo (así el layout impreso es igual al que medimos)
    // y aplicamos el zoom recién calculado: esto sí reacomoda de verdad el
    // documento a ese tamaño, cosa que "transform" no hacía para la paginación.
    el.style.zoom = String(scale);

    const cleanup = () => {
      el.style.width = prevWidth;
      el.style.zoom = prevZoom;
      document.title = prevTitle;
      scrollers.forEach((n, i) => { n.style.overflowX = prevOverflow[i]; });
      noPrintEls.forEach((n, i) => { n.style.display = prevNoPrint[i]; });
      printOnlyEls.forEach((n, i) => { n.style.display = prevPrintOnly[i]; });
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);

    setTimeout(() => window.print(), 150);
  };

  const dates = useMemo(() => DAYS.map((_, i) => shift(monday, i)), [monday]);

  const alertas = useMemo(
    () => analizarSemana(week, monday, rotPorAnio, equiposDoc[mesDeLaSemana(monday)] || null),
    [week, monday, rotPorAnio, equiposDoc]
  );
  const today = new Date();
  const active = sel != null;

  useEffect(() => { const onKey = (e) => e.key === "Escape" && setSel(null); window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);

  return (
    <div onClick={() => { setSel(null); setMenuOpen(false); }}>
      <SchedulerHeader monday={monday} setMonday={setMonday} status={status} menuOpen={menuOpen} setMenuOpen={setMenuOpen} onCopyPrev={copyPrevWeek} onClear={clearWeek} onPrint={handlePrint} onFeriados={() => { setMenuOpen(false); setFeriadosOpen(true); }} isAdmin={isAdmin} />

      <div style={{ minHeight: 34, marginBottom: 6 }} className="no-print">
        {toast ? <Banner tone="warn">{toast}</Banner> : active ? <Banner tone="info"><b>{sel.name}</b> seleccionado — tocá una celda para ubicarlo, o Esc para cancelar</Banner> : <div style={{ fontSize: 12, color: "#64748B", padding: "6px 2px" }}>{isAdmin ? "Tocá un residente para seleccionarlo y después la celda donde va." : "Solo lectura — solo el administrador puede editar."}</div>}
      </div>

      {loading ? <Skeleton /> : (
        <div ref={printRef}>
          {isAdmin && <PanelAlertas duras={alertas.duras} suaves={alertas.suaves} />}
          <EquiposMes monday={monday} isAdmin={isAdmin} />
          <DiasLibresR4 week={week} isAdmin={isAdmin} onChange={setDiaLibre} onAplicarAlMes={aplicarDiasLibresAlMes} aplicando={aplicandoMes} />
          <ComodinesEditor week={week} isAdmin={isAdmin} onToggle={toggleComodin} />
          {/* Barra de día. Siempre visible: a la izquierda las flechas para
              moverse de día, a la derecha el botón que abre la semana entera.
              El botón dice qué vas a ver si lo tocás, no en qué estás. */}
          <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            {!verSemana && (
              <>
                <button onClick={() => setDiaVis((i) => (i - 1 + DAYS.length) % DAYS.length)}
                  aria-label="Día anterior"
                  style={{ fontFamily: "inherit", fontSize: 18, lineHeight: 1, fontWeight: 700, width: 44, height: 44, flex: "0 0 auto", borderRadius: 9, border: "1.5px solid #CBD5E1", background: "#fff", color: "#334155", cursor: "pointer" }}>‹</button>
                <div style={{ flex: 1, textAlign: "center", minWidth: 90 }}>
                  <div style={{ fontSize: 15.5, fontWeight: 800, color: "#0F172A" }}>{DAYS[diaVis]}</div>
                  <div style={{ fontSize: 11.5, color: "#64748B" }}>
                    {dates[diaVis]?.toLocaleDateString("es-AR", { day: "numeric", month: "long" })}
                    {sameDay(dates[diaVis], today) ? " · hoy" : ""}
                  </div>
                </div>
                <button onClick={() => setDiaVis((i) => (i + 1) % DAYS.length)}
                  aria-label="Día siguiente"
                  style={{ fontFamily: "inherit", fontSize: 18, lineHeight: 1, fontWeight: 700, width: 44, height: 44, flex: "0 0 auto", borderRadius: 9, border: "1.5px solid #CBD5E1", background: "#fff", color: "#334155", cursor: "pointer" }}>›</button>
              </>
            )}
            {verSemana && (
              <div style={{ flex: 1, fontSize: 15.5, fontWeight: 800, color: "#0F172A", minWidth: 90 }}>Semana completa</div>
            )}
            <button onClick={() => setVerSemana((v) => !v)}
              style={{ fontFamily: "inherit", fontSize: 13, fontWeight: 700, padding: "10px 14px", minHeight: 44, flex: "0 0 auto",
                borderRadius: 9, cursor: "pointer",
                border: "1.5px solid " + (verSemana ? "#CBD5E1" : "#0F172A"),
                background: verSemana ? "#fff" : "#0F172A", color: verSemana ? "#334155" : "#fff" }}>
              {verSemana ? "Ver día de hoy" : "Ver semana completa"}
            </button>
            {/* Si te fuiste de hoy navegando, un atajo para volver. */}
            {!verSemana && !sameDay(dates[diaVis], today) && (
              <button onClick={() => { const h = new Date(); const i = Math.floor((h - mondayOf(h)) / 86400000); setDiaVis(i >= 0 && i < DAYS.length ? i : 0); }}
                style={{ fontFamily: "inherit", fontSize: 13, fontWeight: 600, padding: "10px 12px", minHeight: 44, flex: "0 0 auto", borderRadius: 9, border: "1.5px solid #CBD5E1", background: "#fff", color: "#334155", cursor: "pointer" }}>
                Hoy
              </button>
            )}
          </div>
          <div className="print-scroll" style={{ overflowX: "auto", paddingBottom: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: `104px repeat(${DIAS_VIS.length}, minmax(150px, 1fr))`, background: "#fff", borderRadius: "14px 14px 0 0", overflow: "hidden", border: "1px solid #E2E8F0", borderBottom: "none", boxShadow: "0 1px 3px rgba(15,23,42,.06)", minWidth: 104 + DIAS_VIS.length * 150 }}>
            <Corner />{DIAS_VIS.map((i) => <DayHead key={DAYS[i]} name={DAYS[i]} date={dates[i]} isToday={sameDay(dates[i], today)} isWeekend={isWeekendIdx(i)} feriado={week.days[i].feriado} />)}

            {SLOTS.filter((s) => s.key !== "postguardia").map((slot, ri) => (
              <Fragment key={slot.key}>
                <RowLabel label={slot.label} color={slot.accent} fondo={slot.rotulo} />
                {DIAS_VIS.map((di) => (
                  utiBloqueada(di) ? (
                    <Cell key={di} tint={week.days[di].feriado ? "#FEF9E7" : "#F1F5F9"} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                      <div style={{ textAlign: "center", fontSize: 9.5, color: week.days[di].feriado ? "#B45309" : "#94A3B8", fontStyle: "italic", padding: "13px 2px", lineHeight: 1.3 }}>No aplica<br />{week.days[di].feriado ? "feriado" : "fin de semana"}</div>
                    </Cell>
                  ) : (
                    <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place(slot.key, di); }} tint={slot.tint} ring={active ? slot.accent : null} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 40 }}>
                        {[...week.days[di][slot.key]].sort(porJerarquia).map((n) => (
                          <Chip key={n} name={n} selected={sel?.name === n} alerta={motivoDe(n, di)} comodin={week.comodines?.includes(n)} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: slot.key }); }} onRemove={isAdmin ? (e) => { e.stopPropagation(); removeChip(n, di); } : null} />
                        ))}
                        {active && <GhostHint color={slot.accent} name={sel.name} />}
                        {!active && week.days[di][slot.key].length === 0 && <Dash />}
                      </div>
                    </Cell>
                  )
                ))}
              </Fragment>
            ))}

            <RowLabel label="De guardia" color={FILA_GUARDIA.accent} sub="se superpone" fondo={FILA_GUARDIA.rotulo} />
            {DIAS_VIS.map((di) => {
              const lista = week.days[di].deGuardia;
              return (
                <Cell key={di} onClick={(e) => { e.stopPropagation(); if (isAdmin) setGuardiaEdit(di); }} tint={FILA_GUARDIA.tint} pad={5} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, minHeight: 40, alignContent: "flex-start", cursor: isAdmin ? "pointer" : "default" }}>
                    {lista.length === 0 ? (
                      <div className="no-print" style={{ fontSize: 10, color: "#FDA4AF", fontStyle: "italic", padding: "10px 4px", width: "100%", textAlign: "center" }}>{isAdmin ? "+ elegir guardia" : "—"}</div>
                    ) : lista.map((n) => <ChipGuardia key={n} name={n} />)}
                  </div>
                  <div className="print-only-block" style={{ fontSize: 11.5, lineHeight: 1.4, color: FILA_GUARDIA.accent, fontWeight: 600, padding: "6px 8px" }}>{lista.length ? lista.join(", ") : "—"}</div>
                </Cell>
              );
            })}

            {SLOTS.filter((s) => s.key === "postguardia").map((slot) => (
              <Fragment key={slot.key}>
                <RowLabel label={slot.label} color={slot.accent} fondo={slot.rotulo} />
                {DIAS_VIS.map((di) => (
                  <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place(slot.key, di); }} tint={slot.tint} ring={active ? slot.accent : null} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 40 }}>
                      {[...week.days[di][slot.key]].sort(porJerarquia).map((n) => (
                        <Chip key={n} name={n} selected={sel?.name === n} alerta={motivoDe(n, di)} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: slot.key }); }} onRemove={isAdmin ? (e) => { e.stopPropagation(); removeChip(n, di); } : null} />
                      ))}
                      {active && <GhostHint color={slot.accent} name={sel.name} />}
                      {!active && week.days[di][slot.key].length === 0 && <Dash />}
                    </div>
                  </Cell>
                ))}
              </Fragment>
            ))}

            <RowLabel label="Observaciones" color="#854D0E" sub="importante" />
            {DIAS_VIS.map((di) => (
              <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                <textarea className="no-print" value={week.days[di].observaciones} onChange={(e) => editText(di, "observaciones", e.target.value)} placeholder="Supervisores, pases, avisos…" readOnly={!isAdmin} style={{ ...TEXTAREA, background: "#FEF9C3", borderColor: "#FDE047", color: "#713F12", fontWeight: 600, opacity: isAdmin ? 1 : 0.8, cursor: isAdmin ? "text" : "default" }} />
                <div className="print-only-block" style={{ whiteSpace: "pre-wrap", fontSize: 11.5, lineHeight: 1.4, color: "#713F12", fontWeight: 600, padding: "6px 8px" }}>{week.days[di].observaciones || "—"}</div>
              </Cell>
            ))}

            <RowLabel label="Recordatorios" color="#B45309" sub="+ Académico" />
            {DIAS_VIS.map((di) => {
              const clases = academico.activities.filter((a) => a.date === isoDate(dates[di]));
              return (
                <Cell key={di} onClick={(e) => e.stopPropagation()} tint="#fff" pad={5} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                  {clases.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 4 }}>
                      {clases.map((a) => (
                        <div key={a.id} title="Sincronizado desde Calendario académico" style={{ fontSize: 10.5, fontWeight: 700, background: "#FEF3C7", color: "#78350F", border: "1px solid #FDE68A", borderRadius: 6, padding: "3px 6px", lineHeight: 1.3 }}>
                          📚 {a.title || "Clase"}{a.time ? ` · ${a.time}` : ""}{a.docente ? ` · ${a.docente}` : ""}
                        </div>
                      ))}
                    </div>
                  )}
                  <textarea className="no-print" value={week.days[di].recordatorios} onChange={(e) => editText(di, "recordatorios", e.target.value)} placeholder="Clases, ateneos, horarios…" readOnly={!isAdmin} style={{ ...TEXTAREA, background: "#FFFBEB", borderColor: "#FDE68A", color: "#78350F", opacity: isAdmin ? 1 : 0.8, cursor: isAdmin ? "text" : "default" }} />
                  <div className="print-only-block" style={{ whiteSpace: "pre-wrap", fontSize: 11.5, lineHeight: 1.4, color: "#78350F", padding: "6px 8px" }}>{week.days[di].recordatorios || "—"}</div>
                </Cell>
              );
            })}
          </div>
          </div>
        </div>
      )}

      {/* Disponibles / No disponibles: solo en pantalla, nunca se imprimen — por
          eso son un segundo grid aparte, fuera de printRef. */}
      {!loading && (
        <div className="no-print" style={{ overflowX: "auto", paddingBottom: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: `104px repeat(${DIAS_VIS.length}, minmax(150px, 1fr))`, background: "#fff", borderRadius: "0 0 14px 14px", overflow: "hidden", border: "1px solid #E2E8F0", borderTop: "none", boxShadow: "0 1px 3px rgba(15,23,42,.06)", minWidth: 104 + DIAS_VIS.length * 150 }}>
            {/* "Disponibles" es sólo del admin: dice quién está libre para
                asignar, que es un dato de gestión interna (y desde acá se
                arrastra gente a la grilla) — no algo que el resto del
                plantel necesite ver. "No disponibles" sigue siendo de
                todos: a cualquiera le sirve saber quién no está por
                rotación o vacaciones. */}
            {isAdmin && <RowLabel label="Disponibles" color="#16A34A" />}
            {isAdmin && DIAS_VIS.map((di) => {
              const free = pool(di);
              return (
                <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place("pool", di); }} tint="#F0FDF4" ring={active ? "#22C55E" : null} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 50 }}>
                    {active && <div style={{ fontSize: 10, color: "#16A34A", fontWeight: 600, textAlign: "center", padding: "1px 0" }}>↩ liberar el {DAYS[di].toLowerCase()}</div>}
                    {free.length === 0 ? (!active && <div style={{ fontSize: 10.5, color: "#64748B", fontStyle: "italic", textAlign: "center", padding: 6 }}>todos asignados</div>) : free.map((n) => <Chip key={n} name={n} selected={sel?.name === n} comodin={week.comodines?.includes(n)} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: "pool" }); }} />)}
                  </div>
                </Cell>
              );
            })}

            <RowLabel label="No disponibles" color="#DC2626" sub="rotación · vacaciones" />
            {DIAS_VIS.map((di) => {
              const autos = autoNoDisponibles(di);
              return (
                <Cell key={di} onClick={(e) => { e.stopPropagation(); if (active) place("unavailable", di); }} tint="#FEF2F2" ring={active ? "#F87171" : null} lastCol={di === DIAS_VIS[DIAS_VIS.length - 1]} lastRow>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 40 }}>
                    {week.days[di].unavailable.map((n) => <OutChip key={n} name={n} onPick={(e) => { e.stopPropagation(); pick(n, { di, key: "unavailable" }); }} selected={sel?.name === n} />)}
                    {autos.map(({ name, motivo }) => <AutoOutChip key={name} name={name} motivo={motivo} />)}
                    {active && <div style={{ fontSize: 10, color: "#EF4444", fontWeight: 600, textAlign: "center", padding: "1px 0" }}>marcar solo el {DAYS[di].toLowerCase()}</div>}
                    {!active && week.days[di].unavailable.length === 0 && autos.length === 0 && <Dash />}
                  </div>
                </Cell>
              );
            })}
          </div>
        </div>
      )}
      <div className="no-print"><Legend /></div>

      {feriadosOpen && isAdmin && (
        <FeriadosEditor
          dates={dates}
          week={week}
          onToggle={toggleFeriado}
          onClose={() => setFeriadosOpen(false)}
        />
      )}

      {guardiaEdit !== null && isAdmin && (
        <GuardiaEditor
          fecha={dates[guardiaEdit]}
          dia={DAYS[guardiaEdit]}
          valor={week.days[guardiaEdit].deGuardia}
          onChange={(lista) => setGuardia(guardiaEdit, lista)}
          onClose={() => setGuardiaEdit(null)}
        />
      )}
    </div>
  );
}

// Marcar feriados de la semana. Vive en el menú "⋯" en vez de tener un control
// en cada celda: es algo que se toca pocas veces al año y no queremos sumarle
// ruido visual a la grilla. Marcar un día NO cambia cómo se arma la semana
// (las camas se siguen asignando igual); es solo el dato que después permite
// contar las guardias de cada residente separadas por hábil, fin de semana y
// feriado.
function FeriadosEditor({ dates, week, onToggle, onClose }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: "18px 20px 20px", width: "100%", maxWidth: 400, maxHeight: "88vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(15,23,42,.28)", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <div style={{ fontWeight: 800, fontSize: 15.5, color: "#0F172A" }}>🎌 Marcar feriado</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748B", fontSize: 18, cursor: "pointer", fontFamily: "inherit", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          Tocá los días de esta semana que sean feriado. No cambia las asignaciones — sirve para contar después las guardias por tipo de día.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {DAYS.map((d, di) => {
            const on = week.days[di].feriado;
            return (
              <div key={d} onClick={() => onToggle(di)} style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 13px", borderRadius: 10, background: on ? "#FEF3C7" : "#F8FAFC", border: `1.5px solid ${on ? "#FCD34D" : "#E2E8F0"}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 14 }}>{on ? "🎌" : "📅"}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: on ? "#92400E" : "#334155" }}>{d}</div>
                    <div style={{ fontSize: 10.5, color: on ? "#B45309" : "#94A3B8" }}>{dm(dates[di])}</div>
                  </div>
                </div>
                {on && <span style={{ fontSize: 9.5, fontWeight: 800, color: "#92400E", background: "#FDE68A", borderRadius: 999, padding: "3px 10px" }}>FERIADO</span>}
              </div>
            );
          })}
        </div>

        <button onClick={onClose} style={{ width: "100%", marginTop: 16, background: "#16A34A", color: "#fff", border: "none", borderRadius: 10, padding: "11px 16px", fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Listo</button>
      </div>
    </div>
  );
}

// Editor de la guardia de un día. Se abre tocando la celda y es independiente
// del sistema de seleccionar-y-ubicar: acá se marcan residentes sin sacarlos
// de la UTI donde ya estén ni de "no disponibles". Además permite sumar a
// alguien que no es residente (planta, otro servicio) escribiendo el nombre.
function GuardiaEditor({ fecha, dia, valor, onChange, onClose }) {
  const [nuevo, setNuevo] = useState("");
  const seleccion = valor || [];
  const invitados = seleccion.filter((n) => !esResidente(n));

  const toggle = (n) => onChange(seleccion.includes(n) ? seleccion.filter((x) => x !== n) : [...seleccion, n]);
  const quitar = (n) => onChange(seleccion.filter((x) => x !== n));
  const agregarInvitado = () => {
    const v = nuevo.trim();
    if (!v) return;
    // Si lo que escribió es en realidad un residente (por nombre corto o por
    // nombre público), se guarda como residente en vez de crear un duplicado
    // suelto que después no sumaría en el conteo.
    onChange(normalizarListaGuardia([...seleccion, v]));
    setNuevo("");
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: "18px 20px 20px", width: "100%", maxWidth: 460, maxHeight: "88vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(15,23,42,.28)", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <div style={{ fontWeight: 800, fontSize: 15.5, color: "#0F172A" }}>🌙 De guardia</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748B", fontSize: 18, cursor: "pointer", fontFamily: "inherit", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 14 }}>{dia} {dm(fecha)}</div>

        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 6, letterSpacing: 0.3 }}>RESIDENTES</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {ASIGNABLES.map((n) => {
            const on = seleccion.includes(n);
            const c = COLOR[LEVEL[n]];
            return (
              <div key={n} onClick={() => toggle(n)} style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 5, padding: "6px 11px", borderRadius: 8, background: on ? c.solid : "#F8FAFC", border: `1.5px solid ${on ? c.solid : "#E2E8F0"}`, color: on ? "#fff" : "#64748B", fontWeight: 600, fontSize: 12.5 }}>
                {on && "✓ "}{n}
                <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: on ? "rgba(255,255,255,.28)" : c.solid, color: "#fff" }}>{LEVEL[n]}</span>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 10.5, color: "#64748B", lineHeight: 1.45, marginBottom: 16 }}>
          Marcar a alguien acá no lo saca de la UTI que tenga asignada ese día ni de "no disponibles" — la guardia se superpone con el resto.
        </div>

        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 6, letterSpacing: 0.3 }}>OTRA PERSONA (PLANTA, OTRO SERVICIO)</div>
        {invitados.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {invitados.map((n) => (
              <div key={n} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 6px 5px 11px", borderRadius: 8, background: "#F1F5F9", border: "1.5px solid #CBD5E1", color: "#475569", fontWeight: 600, fontSize: 12.5 }}>
                {n}
                <button onClick={() => quitar(n)} style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 14, fontFamily: "inherit", lineHeight: 1, padding: 0 }}>×</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          <input value={nuevo} onChange={(e) => setNuevo(e.target.value)} placeholder="Nombre y apellido…" onKeyDown={(e) => e.key === "Enter" && agregarInvitado()} style={{ ...INPUT, flex: 1, fontSize: 12.5, padding: "8px 10px" }} />
          <button onClick={agregarInvitado} style={{ background: "#0F172A", color: "#fff", border: "none", borderRadius: 7, padding: "8px 15px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>+ Agregar</button>
        </div>

        <button onClick={onClose} style={{ width: "100%", marginTop: 18, background: "#16A34A", color: "#fff", border: "none", borderRadius: 10, padding: "11px 16px", fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Listo</button>
      </div>
    </div>
  );
}

/* ══════════════════ ROTACIONES VIEW ══════════════════ */

// Se trata de que cada residente vea la misma sala con los mismos compañeros
// durante todo el mes. Esto guarda ese armado (hasta 4 por UTI) en
// scheduler/equipos, con una clave por mes. Es informativo: no condiciona la
// grilla, solo la tenés a la vista mientras armás la semana.
function EquiposMes({ monday, isAdmin }) {
  const clave = useMemo(() => mesDeLaSemana(monday), [monday]);
  const [todos, setTodos] = useState({});
  const [editando, setEditando] = useState(false);

  useEffect(() => {
    const unsub = escuchar(doc(db, "scheduler", "equipos"), (snap) => {
      setTodos(snap.exists() ? snap.data() : {});
    }, "los equipos por UTI");
    return unsub;
  }, []);

  const equipos = todos[clave] || {};
  const conGente = EQUIPO_SLOTS.filter((s) => (equipos[s.key] || []).length > 0);

  const guardar = async (next) => {
    await escribir(setDoc(doc(db, "scheduler", "equipos"), { [clave]: next }, { merge: true }), "los equipos por UTI");
  };

  // Alguien pertenece a una sola UTI por mes: ponerlo en otra lo saca de la
  // anterior, que es como funciona en la realidad.
  const toggle = (slotKey, nombre) => {
    if (!isAdmin) return;
    const next = {};
    EQUIPO_SLOTS.forEach((s) => { next[s.key] = (equipos[s.key] || []).filter((n) => n !== nombre); });
    const yaEstaba = (equipos[slotKey] || []).includes(nombre);
    if (!yaEstaba) {
      if (next[slotKey].length >= EQUIPO_MAX) return; // tope de 4
      next[slotKey] = [...next[slotKey], nombre];
    }
    guardar(next);
  };

  // Si no hay nada cargado y no sos admin, ni se muestra: no deja hueco.
  if (conGente.length === 0 && !isAdmin) return null;

  return (
    <div className="no-print" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, padding: "7px 12px", borderRadius: 10, background: "#F8FAFC", border: "1px solid #E2E8F0" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#475569", whiteSpace: "nowrap" }}>👥 Equipos por UTI · {etiquetaMes(clave)}</span>

        {conGente.length === 0 ? (
          <span style={{ fontSize: 10.5, color: "#64748B", fontStyle: "italic" }}>Sin equipos armados este mes.</span>
        ) : (
          conGente.map((s) => (
            <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
              <span style={{ fontSize: 9.5, fontWeight: 800, color: s.accent, background: s.tint, borderRadius: 5, padding: "2px 6px", whiteSpace: "nowrap" }}>{s.label}</span>
              {[...(equipos[s.key] || [])].sort(porJerarquia).map((n) => {
                const c = COLOR[LEVEL[n]] || COLOR.R2;
                return (
                  <span key={n} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 7px", borderRadius: 999, background: c.bg, border: `1px solid ${c.bd}`, color: c.tx, fontWeight: 600, fontSize: 10.5 }}>
                    {n}
                    <span style={{ fontSize: 7, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: c.solid, color: "#fff" }}>{LEVEL[n]}</span>
                  </span>
                );
              })}
            </span>
          ))
        )}

        {isAdmin && (
          <button onClick={() => setEditando(true)} style={{ marginLeft: "auto", background: "none", border: "none", color: "#64748B", fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
            {conGente.length === 0 ? "+ Armar equipos" : "✏️ Editar"}
          </button>
        )}
      </div>

      {editando && isAdmin && (
        <EquiposEditor clave={clave} equipos={equipos} onToggle={toggle} onClose={() => setEditando(false)} />
      )}
    </div>
  );
}

function EquiposEditor({ clave, equipos, onToggle, onClose }) {
  const asignados = {};
  EQUIPO_SLOTS.forEach((s) => (equipos[s.key] || []).forEach((n) => { asignados[n] = s.key; }));

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: "18px 20px 20px", width: "100%", maxWidth: 520, maxHeight: "88vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(15,23,42,.28)", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <div style={{ fontWeight: 800, fontSize: 15.5, color: "#0F172A" }}>👥 Equipos por UTI</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748B", fontSize: 18, cursor: "pointer", fontFamily: "inherit", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          {etiquetaMes(clave)} · hasta {EQUIPO_MAX} por sala. Cada residente va en una sola UTI: si lo ponés en otra, sale de la anterior.
        </div>

        {EQUIPO_SLOTS.map((s) => {
          const miembros = [...(equipos[s.key] || [])].sort(porJerarquia);
          const lleno = miembros.length >= EQUIPO_MAX;
          return (
            <div key={s.key} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: s.accent, background: s.tint, borderRadius: 5, padding: "2px 7px" }}>{s.label}</span>
                <span style={{ fontSize: 10.5, color: lleno ? "#B45309" : "#94A3B8", fontWeight: 600 }}>{miembros.length}/{EQUIPO_MAX}{lleno ? " · completo" : ""}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {ALL.map((n) => {
                  const aca = miembros.includes(n);
                  const enOtra = asignados[n] && asignados[n] !== s.key;
                  const bloqueado = !aca && lleno;
                  const c = COLOR[LEVEL[n]];
                  return (
                    <div
                      key={n}
                      onClick={() => !bloqueado && onToggle(s.key, n)}
                      title={enOtra ? `Ahora está en ${EQUIPO_SLOTS.find((x) => x.key === asignados[n]).label}` : bloqueado ? `${s.label} ya tiene ${EQUIPO_MAX}` : undefined}
                      style={{ cursor: bloqueado ? "not-allowed" : "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 4, padding: "4px 9px", borderRadius: 7, background: aca ? c.solid : "#F8FAFC", border: `1.5px solid ${aca ? c.solid : "#E2E8F0"}`, color: aca ? "#fff" : enOtra ? "#CBD5E1" : "#64748B", fontWeight: 600, fontSize: 11.5, opacity: bloqueado ? 0.4 : 1 }}
                    >
                      {aca && "✓ "}{n}
                      <span style={{ fontSize: 7.5, fontWeight: 800, padding: "1px 3px", borderRadius: 2.5, background: aca ? "rgba(255,255,255,.28)" : c.solid, color: "#fff" }}>{LEVEL[n]}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <button onClick={onClose} style={{ width: "100%", marginTop: 4, background: "#16A34A", color: "#fff", border: "none", borderRadius: 10, padding: "11px 16px", fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Listo</button>
      </div>
    </div>
  );
}

/* ══════════════════ DÍAS LIBRES R4 ══════════════════ */

function DiasLibresR4({ week, isAdmin, onChange, onAplicarAlMes, aplicando }) {
  const any = RESIDENTS.R4.some((n) => week.diasLibresR4[n]);
  if (!isAdmin && !any) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, padding: "8px 12px", marginBottom: 10, borderRadius: 10, background: "#FFF7ED", border: "1px solid #FED7AA" }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "#9A3412" }}>🗓️ Días libres R4 esta semana:</span>
      {RESIDENTS.R4.map((n) => (
        <div key={n} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: "#7C2D12" }}>{n}</span>
          {isAdmin ? (
            <>
              <select className="no-print" value={week.diasLibresR4[n]} onChange={(e) => onChange(n, e.target.value)} style={{ fontSize: 11, padding: "2px 5px", borderRadius: 5, border: "1px solid #FDBA74", background: "#fff", color: "#7C2D12", fontFamily: "inherit" }}>
                <option value="">—</option>
                {DIAS_LIBRES_OPCIONES.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <span className="print-only" style={{ fontSize: 11, fontWeight: 700, background: "#FDBA74", color: "#7C2D12", padding: "1px 7px", borderRadius: 999 }}>{week.diasLibresR4[n] || "—"}</span>
            </>
          ) : (
            week.diasLibresR4[n] && <span style={{ fontSize: 11, fontWeight: 700, background: "#FDBA74", color: "#7C2D12", padding: "1px 7px", borderRadius: 999 }}>{week.diasLibresR4[n]}</span>
          )}
        </div>
      ))}
      {isAdmin && any && (
        <button onClick={onAplicarAlMes} disabled={aplicando} className="no-print" title="Copia estos días libres a todas las semanas de este mes" style={{ marginLeft: "auto", background: "#EA580C", color: "#fff", border: "none", borderRadius: 7, padding: "5px 11px", fontSize: 10.5, fontWeight: 700, cursor: aplicando ? "default" : "pointer", fontFamily: "inherit", opacity: aplicando ? 0.6 : 1 }}>
          {aplicando ? "Aplicando…" : "📅 Aplicar a todo el mes"}
        </button>
      )}
    </div>
  );
}

// Comodín: quién se adapta a cualquier sala esta semana. Sólo marca — no
// cambia disponibilidad ni saca a nadie de la grilla —, así que alcanza con
// una fila de botones para prender/apagar el nombre. El chip de esa persona
// en toda la grilla (y en "Disponibles") se dibuja con el 🃏 automáticamente,
// ver Chip en ui.jsx.
function ComodinesEditor({ week, isAdmin, onToggle }) {
  const activos = week.comodines || [];
  if (!isAdmin && activos.length === 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, padding: "8px 12px", marginBottom: 10, borderRadius: 10, background: "#F5F3FF", border: "1px solid #DDD6FE" }}>
      <span title="Se adapta a cualquier sala en la semana para mantener parejo el número de gente por UTI" style={{ fontSize: 11, fontWeight: 700, color: "#5B21B6", cursor: "help" }}>🃏 Comodín esta semana:</span>
      {isAdmin ? (
        ALL.map((n) => {
          const on = activos.includes(n);
          return (
            <button key={n} onClick={() => onToggle(n)} className="no-print" style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, border: `1.5px solid ${on ? "#7C3AED" : "#DDD6FE"}`, background: on ? "#7C3AED" : "#fff", color: on ? "#fff" : "#5B21B6", cursor: "pointer", fontFamily: "inherit" }}>
              {n}
            </button>
          );
        })
      ) : (
        activos.map((n) => <span key={n} style={{ fontSize: 11, fontWeight: 700, background: "#DDD6FE", color: "#5B21B6", padding: "1px 8px", borderRadius: 999 }}>{n}</span>)
      )}
      {isAdmin && activos.length === 0 && <span style={{ fontSize: 10.5, color: "#7C3AED", fontStyle: "italic" }}>nadie marcado</span>}
    </div>
  );
}

/* ══════════════════ SCHEDULER HEADER ══════════════════ */

function SchedulerHeader({ monday, setMonday, status, menuOpen, setMenuOpen, onCopyPrev, onClear, onPrint, onFeriados, isAdmin }) {
  const S = CARTEL_ESTADO[status];   // ver nube.jsx
  return (
    <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22 }}>🏥</span>
        <div><div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Scheduler UTI</div><div style={{ fontSize: 10.5, opacity: 0.55, letterSpacing: 0.2 }}>Hospital Británico</div></div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={(e) => { e.stopPropagation(); setMonday(shift(monday, -7)); }} style={NAV}>◀</button>
        <div style={{ textAlign: "center", minWidth: 172 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{dm(monday)} — {dm(shift(monday, DAYS.length - 1))}</div>
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
            <MenuItem onClick={onFeriados}>🎌 Marcar feriado</MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); onPrint(); }}>🖨️ Imprimir / PDF</MenuItem>
            <MenuItem onClick={onClear} danger>🗑️ Vaciar semana</MenuItem>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════ COMPONENTES COMPARTIDOS ══════════════════ */

export { DiasLibresR4, EquiposEditor, EquiposMes, FeriadosEditor, GuardiaEditor, SchedulerHeader, SchedulerView };
