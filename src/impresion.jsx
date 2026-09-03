/* ══════════════════════════════════════════════════════════════════════════
   Imprimir

   La app se usa mucho en papel: el cronograma pegado en la sala, las
   guardias del mes. Todo lo que arma una hoja para imprimir esta aca — el
   HTML, el CSS y el ajuste de escala para que entre en una A4.
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useRef, useMemo } from "react";
import { db } from "./firebase";
import { doc, getDoc } from "firebase/firestore";
import { shift, isoDate } from "./comunes";
import { ALL, COLOR, DAYS, EQUIPO_SLOTS, LEVEL, MES_INICIO_ESTADISTICAS, MONTHS, RESIDENTS, SLOTS, isWeekendIdx, porJerarquia } from "./config";
import { diOfDate, hoyTexto, lunesQueTocanElMes, mesDeLaSemana, mondayOf } from "./fechas";
import { TRAMOS_VACACIONES, emptyRotYear, emptyWeek, normalize, normalizeRot } from "./modelo";
import { Banner } from "./ui";

// Vista previa de una hoja. Es el mismo HTML que sale por la impresora, metido
// en un iframe y escalado para que entre en el ancho que haya. Se usa un
// iframe y no un div para que el CSS de la hoja no se mezcle con el de la app.
function HojaPreview({ html }) {
  const cont = useRef(null);
  const [k, setK] = useState(1);
  // Exactamente el área imprimible de una A4 apaisada a 96 dpi, la misma que
  // usa el ajuste dentro de la hoja. Así la vista previa es la hoja entera, ni
  // recortada ni con espacio de más.
  const ANCHO = 1030, alto = 716;
  useEffect(() => {
    const medir = () => {
      const w = cont.current ? cont.current.clientWidth : ANCHO;
      setK(Math.min(1, w / ANCHO));
    };
    medir();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(medir) : null;
    if (ro && cont.current) ro.observe(cont.current);
    window.addEventListener("resize", medir);
    return () => { if (ro) ro.disconnect(); window.removeEventListener("resize", medir); };
  }, []);
  return (
    <div ref={cont} style={{ width: "100%", height: alto * k, overflow: "hidden", borderRadius: 10, border: "1px solid #E2E8F0", background: "#fff" }}>
      {html
        ? <iframe title="vista previa" srcDoc={hojaAjustada(html, false)} sandbox="allow-scripts" scrolling="no"
            style={{ width: ANCHO, height: alto, border: "none", transform: `scale(${k})`, transformOrigin: "top left", display: "block" }} />
        : <div style={{ padding: 26, fontSize: 12.5, color: "#64748B" }}>Cargando el cronograma…</div>}
    </div>
  );
}

function ImpresionesView({ user, isAdmin }) {
  const mesDeHoy = () => {
    const h = new Date();
    const a = Math.max(0, (h.getFullYear() - MES_INICIO_ESTADISTICAS.anio) * 12 + h.getMonth() - MES_INICIO_ESTADISTICAS.mes);
    const d = new Date(MES_INICIO_ESTADISTICAS.anio, MES_INICIO_ESTADISTICAS.mes + a, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const [mesSel, setMesSel] = useState(mesDeHoy);
  const [mesOtro, setMesOtro] = useState(mesDeHoy);
  const [semanaSel, setSemanaSel] = useState(() => isoDate(mondayOf(new Date())));
  const [queOtro, setQueOtro] = useState("salas");
  const [bnOtro, setBnOtro] = useState(true);
  const [borradorPedido, setBorradorPedido] = useState(false);
  const [vista, setVista] = useState(false); // false = color en pantalla
  // Solo la jefatura puede emitir una hoja con sello DEFINITIVO. Para todos los
  // demás la hoja sale marcada como borrador, con marca de agua y con su mail
  // impreso al pie, así una copia que circule siempre se puede rastrear.
  const borrador = isAdmin ? borradorPedido : true;
  const emisor = user ? [user.displayName, user.email].filter(Boolean).join(" · ") : "";
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState(null);
  const [datosMes, setDatosMes] = useState(null);

  const [y, m] = mesSel.split("-").map(Number);
  const anio = y, mes = m - 1;

  // Trae todo lo que necesita una hoja del mes: las semanas que lo tocan, las
  // rotaciones del año y los equipos por UTI.
  const cargarMes = async (a, ms) => {
    const lunes = lunesQueTocanElMes(a, ms);
    const semanas = {};
    for (const l of lunes) {
      const snap = await getDoc(doc(db, "scheduler", `week-${isoDate(l)}`));
      semanas[isoDate(l)] = snap.exists() ? normalize(snap.data()) : emptyWeek();
    }
    const rotSnap = await getDoc(doc(db, "scheduler", `rotaciones-${a}`));
    const rot = rotSnap.exists() ? normalizeRot(rotSnap.data()) : emptyRotYear();
    const eqSnap = await getDoc(doc(db, "scheduler", "equipos"));
    const clave = `${a}-${String(ms + 1).padStart(2, "0")}`;
    const equipos = (eqSnap.exists() ? eqSnap.data() : {})[clave] || {};
    return { anio: a, mes: ms, lunes, semanas, rot, equipos };
  };

  // Los dos cronogramas de arriba se muestran solos al entrar y se rearman
  // cada vez que se cambia el mes.
  useEffect(() => {
    let vivo = true;
    setDatosMes(null); setAviso(null);
    cargarMes(anio, mes)
      .then((d) => { if (vivo) setDatosMes(d); })
      .catch((e) => { console.error(e); if (vivo) setAviso("No se pudieron leer los cronogramas de este mes."); });
    return () => { vivo = false; };
  }, [anio, mes]);

  const htmlSalas = useMemo(() => datosMes && htmlMes({ ...datosMes, tipo: "salas", borrador, emisor, bn: vista }), [datosMes, borrador, emisor, vista]);
  const htmlGuardias = useMemo(() => datosMes && htmlMes({ ...datosMes, tipo: "guardias", borrador, emisor, bn: vista }), [datosMes, borrador, emisor, vista]);

  // Imprimir lo que se está viendo: se rearma la hoja con el color pedido y se
  // abre en una pestaña nueva con el diálogo de impresión.
  const imprimirEsto = (tipo, bn) => {
    if (!datosMes) return;
    abrirBorrador({ ...datosMes, tipo, borrador, emisor, bn });
  };

  const generarOtro = async () => {
    setGenerando(true); setAviso(null);
    try {
      if (queOtro === "semana") {
        const lunes = new Date(`${semanaSel}T00:00:00`);
        const snap = await getDoc(doc(db, "scheduler", `week-${isoDate(lunes)}`));
        const week = snap.exists() ? normalize(snap.data()) : emptyWeek();
        const eqSnap = await getDoc(doc(db, "scheduler", "equipos"));
        const equipos = (eqSnap.exists() ? eqSnap.data() : {})[mesDeLaSemana(lunes)] || {};
        abrirSemana({ lunes, week, equipos, borrador, emisor, bn: bnOtro });
      } else {
        const [a, ms] = mesOtro.split("-").map(Number);
        const d = await cargarMes(a, ms - 1);
        abrirBorrador({ ...d, tipo: queOtro, borrador, emisor, bn: bnOtro });
      }
    } catch (e) {
      console.error(e); setAviso("No se pudo generar la hoja.");
    }
    setGenerando(false);
  };

  // Nada anterior a septiembre de 2026: antes de eso el scheduler no estaba
  // cargado y una hoja de esos meses saldría vacía.
  const opcionesMes = useMemo(() => {
    const hoy = new Date();
    const desde = new Date(MES_INICIO_ESTADISTICAS.anio, MES_INICIO_ESTADISTICAS.mes, 1);
    const hasta = new Date(hoy.getFullYear(), hoy.getMonth() + 5, 1);
    const out = [];
    for (const d = new Date(desde); d <= hasta; d.setMonth(d.getMonth() + 1)) {
      out.push({ clave: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
    }
    return out;
  }, []);

  // Las semanas de la lista arrancan también en septiembre de 2026.
  const opcionesSemana = useMemo(() => {
    const base = mondayOf(new Date());
    const piso = mondayOf(new Date(MES_INICIO_ESTADISTICAS.anio, MES_INICIO_ESTADISTICAS.mes, 1));
    const estaSemana = isoDate(base);
    const out = [];
    for (let i = -12; i <= 20; i++) {
      const l = shift(base, i * 7);
      if (isoDate(l) < isoDate(piso)) continue;
      const f = shift(l, 6);
      const mismo = l.getMonth() === f.getMonth();
      const label = mismo
        ? `${l.getDate()} al ${f.getDate()} de ${MONTHS[l.getMonth()].toLowerCase()} ${f.getFullYear()}`
        : `${l.getDate()} de ${MONTHS[l.getMonth()].toLowerCase()} al ${f.getDate()} de ${MONTHS[f.getMonth()].toLowerCase()} ${f.getFullYear()}`;
      out.push({ clave: isoDate(l), label: label + (isoDate(l) === estaSemana ? "  ·  esta semana" : "") });
    }
    return out;
  }, []);

  const btn = (bg) => ({ background: bg, color: "#fff", border: "none", borderRadius: 9, padding: "9px 16px", fontSize: 12.5, fontWeight: 700, cursor: generando ? "default" : "pointer", fontFamily: "inherit", opacity: generando ? 0.6 : 1 });
  const caja = { background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", padding: 16, marginBottom: 12 };
  const sel = { fontSize: 13, padding: "8px 10px", borderRadius: 8, border: "1px solid #E2E8F0", fontFamily: "inherit", color: "#334155" };
  const rotulo = { fontSize: 10.5, fontWeight: 700, color: "#64748B", marginBottom: 3 };

  const bloquePrevia = (titulo, bajada, color, tipo, html) => (
    <div style={caja}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 11 }}>
        <div style={{ flex: "1 1 300px" }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color, marginBottom: 2 }}>{titulo}</div>
          <div style={{ fontSize: 11.5, color: "#475569", lineHeight: 1.5 }}>{bajada}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => imprimirEsto(tipo, true)} disabled={!datosMes} style={{ ...btn("#0F172A"), opacity: datosMes ? 1 : 0.5 }}>◻︎ Imprimir en blanco y negro</button>
          <button onClick={() => imprimirEsto(tipo, false)} disabled={!datosMes} style={{ ...btn(color), opacity: datosMes ? 1 : 0.5 }}>🎨 Imprimir en color</button>
        </div>
      </div>
      <HojaPreview html={html} />
    </div>
  );

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <span style={{ fontSize: 22 }}>🖨️</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Ver cronogramas, guardias e imprimir</div>
          <div style={{ fontSize: 10.5, opacity: 0.7 }}>El mes en pantalla, tal cual sale por la impresora</div>
        </div>
      </div>

      {/* Mes que se está mirando, sello y color de la pantalla. */}
      <div style={{ ...caja, background: borrador ? "#FEF2F2" : "#fff", borderColor: borrador ? "#FECACA" : "#E2E8F0" }}>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>

          <div style={{ flex: "0 0 auto" }}>
            <div style={rotulo}>MES QUE SE VE</div>
            <select value={mesSel} onChange={(e) => setMesSel(e.target.value)} style={{ ...sel, fontWeight: 700 }}>
              {opcionesMes.map((o) => <option key={o.clave} value={o.clave}>{o.label}</option>)}
            </select>
          </div>

          <div style={{ flex: "0 0 auto" }}>
            <div style={rotulo}>CÓMO SE VE EN PANTALLA</div>
            <div style={{ display: "inline-flex", borderRadius: 9, border: "1px solid #E2E8F0", overflow: "hidden" }}>
              {[{ v: false, t: "🎨 Color" }, { v: true, t: "◻︎ Blanco y negro" }].map((o) => (
                <button key={String(o.v)} onClick={() => setVista(o.v)} style={{ border: "none", padding: "8px 13px", fontSize: 12.5, fontWeight: 700, fontFamily: "inherit", cursor: "pointer", background: vista === o.v ? "#0F172A" : "#fff", color: vista === o.v ? "#fff" : "#475569" }}>{o.t}</button>
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: "#64748B", marginTop: 5, maxWidth: 250, lineHeight: 1.45 }}>
              Es solo para mirar. Al imprimir elegís el color en cada cronograma.
            </div>
          </div>

          <div style={{ flex: "1 1 280px", borderLeft: "1px solid #E2E8F0", paddingLeft: 18 }}>
            <div style={{ ...rotulo, marginBottom: 6 }}>SELLO</div>
            {isAdmin ? (
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={borradorPedido} onChange={(e) => setBorradorPedido(e.target.checked)} style={{ width: 17, height: 17, marginTop: 1, accentColor: "#B91C1C", cursor: "pointer" }} />
                <span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: borrador ? "#B91C1C" : "#0F172A" }}>Marcar como borrador</span>
                  <span style={{ display: "block", fontSize: 11.5, color: "#475569", lineHeight: 1.5, marginTop: 2 }}>
                    {borrador
                      ? "Sale con sello rojo y marca de agua, para que nadie la tome como firme."
                      : "Sale como DEFINITIVO con la fecha de emisión. Tildá esto si todavía puede cambiar algo."}
                  </span>
                </span>
              </label>
            ) : (
              <div style={{ fontSize: 11.5, color: "#475569", lineHeight: 1.55 }}>
                <span style={{ display: "inline-block", fontSize: 10, fontWeight: 800, background: "#B91C1C", color: "#fff", padding: "2px 7px", borderRadius: 4, marginBottom: 5 }}>BORRADOR</span>
                <br />Todo lo que descargues sale marcado como borrador, con tu nombre y tu mail al pie de la hoja. La versión definitiva la emite únicamente la jefatura de residentes.
              </div>
            )}
          </div>

        </div>
      </div>

      {aviso && <Banner tone="warn">{aviso}</Banner>}

      {/* ── Los dos cronogramas del mes, a la vista ── */}
      {bloquePrevia(
        `🏥 Cobertura de salas · ${MONTHS[mes]} ${anio}`,
        "Las tres salas día por día, postguardia, guardia, equipos por UTI, días libres de los R4 y quién está afuera por rotación o vacaciones.",
        "#0F172A", "salas", htmlSalas)}

      {bloquePrevia(
        `🌙 Guardias · ${MONTHS[mes]} ${anio}`,
        "Solo quién está de guardia cada día, en grande, con el conteo por persona y por nivel. Es el que conviene pegar en la pared.",
        "#9F1239", "guardias", htmlGuardias)}

      {/* ── Cualquier otro cronograma ── */}
      <div style={caja}>
        <div style={{ fontSize: 13.5, fontWeight: 800, color: "#0F172A", marginBottom: 3 }}>⬇️ Descargar otro cronograma</div>
        <div style={{ fontSize: 11.5, color: "#475569", lineHeight: 1.55, marginBottom: 13 }}>
          Cualquier mes desde septiembre de 2026, o una semana suelta con la misma grilla de la pestaña Semana. Se abre el diálogo de impresión: elegí "Guardar como PDF" en Destino si querés el archivo.
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={rotulo}>QUÉ</div>
            <select value={queOtro} onChange={(e) => setQueOtro(e.target.value)} style={sel}>
              <option value="salas">🏥 Cobertura de salas del mes</option>
              <option value="guardias">🌙 Guardias del mes</option>
              <option value="semana">📅 Una semana</option>
            </select>
          </div>
          {queOtro === "semana" ? (
            <div>
              <div style={rotulo}>SEMANA</div>
              <select value={semanaSel} onChange={(e) => setSemanaSel(e.target.value)} style={sel}>
                {opcionesSemana.map((o) => <option key={o.clave} value={o.clave}>{o.label}</option>)}
              </select>
            </div>
          ) : (
            <div>
              <div style={rotulo}>MES</div>
              <select value={mesOtro} onChange={(e) => setMesOtro(e.target.value)} style={sel}>
                {opcionesMes.map((o) => <option key={o.clave} value={o.clave}>{o.label}</option>)}
              </select>
            </div>
          )}
          <div>
            <div style={rotulo}>COLOR</div>
            <select value={bnOtro ? "bn" : "color"} onChange={(e) => setBnOtro(e.target.value === "bn")} style={sel}>
              <option value="bn">◻︎ Blanco y negro</option>
              <option value="color">🎨 Color</option>
            </select>
          </div>
          <button onClick={generarOtro} disabled={generando} style={btn("#0E7490")}>
            {generando ? "Armando…" : "⬇️ Generar"}
          </button>
        </div>
        <div style={{ fontSize: 11, color: "#64748B", lineHeight: 1.5, marginTop: 11 }}>
          En blanco y negro el nivel se distingue por el borde del chip —R4 grueso, R3 fino, R2 punteado—, así que no hace falta color para leerlo.
        </div>
      </div>

      <div style={{ fontSize: 11, color: "#64748B", lineHeight: 1.55, padding: "4px 2px" }}>
        Todo lo que se emita queda firmado con {emisor ? <b>{emisor}</b> : "la cuenta con la que entraste"}.
      </div>
    </div>
  );
}

// Hoja de una semana suelta: es la grilla de la pestaña Semana pasada a una
// tabla propia, en vez de imprimir el DOM de la app. Se genera igual que las
// hojas del mes (ventana nueva con su CSS), así se puede imprimir cualquier
// semana sin tener que navegar hasta ella primero.
// ── Cocina común de las hojas impresas ────────────────────────────────────
// Las tres hojas (semana, cobertura del mes, guardias del mes) comparten la
// paleta, el sello, la marca de agua y el ajuste a una sola página. Todo lo que
// cambie acá cambia en las tres a la vez, que es justamente lo que se quiere.

// Modo color y modo blanco y negro. El modo B/N no es "el color pasado a
// gris": los grises quedan todos parecidos al imprimir en láser. Lo que hace
// es cambiar el canal por el que se distingue el nivel — en vez del color del
// chip, el borde: R4 grueso, R3 fino, R2 punteado, JR doble — y dejar el resto
// en blanco y negro puro, que es lo que mejor sale en cualquier impresora.
function paletaImpresion(bn) {
  if (!bn) {
    return {
      bn: false,
      chips: { R2: ["#DBEAFE", "#93C5FD", "#1E3A8A", "#3B82F6"], R3: ["#D1FAE5", "#6EE7B7", "#065F46", "#10B981"], R4: ["#FFEDD5", "#FDBA74", "#9A3412", "#F97316"], JR: ["#FEF3C7", "#FCD34D", "#78350F", "#D97706"] },
      borde: { R2: "1.2px solid", R3: "1.2px solid", R4: "1.2px solid", JR: "1.2px solid" },
      fila: { uti1: "#0E7490", uti2: "#BE185D", uti3: "#A16207", postguardia: "#A855F7", guardia: "#9F1239", fuera: "#475569" },
      finde: "#F8FAFC", off: "#F1F5F9", obs: ["#FEF9C3", "#713F12"], rec: ["#EFF6FF", "#1E3A8A"],
      leyenda: "",
      tagBorrador: "#B91C1C",
    };
  }
  return {
    bn: true,
    chips: { R2: ["#fff", "#111827", "#111827", "#111827"], R3: ["#fff", "#111827", "#111827", "#111827"], R4: ["#fff", "#111827", "#111827", "#111827"], JR: ["#fff", "#111827", "#111827", "#111827"] },
    borde: { R2: "1.2px dashed", R3: "1.2px solid", R4: "2.2px solid", JR: "3px double" },
    fila: { uti1: "#111827", uti2: "#374151", uti3: "#4B5563", postguardia: "#6B7280", guardia: "#111827", fuera: "#6B7280" },
    finde: "#EEEEEE", off: "#DDDDDD", obs: ["#fff", "#111827"], rec: ["#fff", "#111827"],
    leyenda: " · <b>Niveles:</b> R4 borde grueso · R3 borde fino · R2 borde punteado · JR borde doble.",
    tagBorrador: "#111827",
  };
}

// Un chip de residente, en el modo que corresponda. Se usa igual en las tres
// hojas para que un papel se lea igual que otro.
function chipImpreso(n, P, esc) {
  const lv = LEVEL[n];
  const c = P.chips[lv] || (P.bn ? ["#fff", "#6B7280", "#374151", "#6B7280"] : ["#F1F5F9", "#CBD5E1", "#475569", "#94A3B8"]);
  const b = P.borde[lv] || (P.bn ? "1px dotted" : "1.2px solid");
  return `<span class="chip" style="background:${c[0]};border:${b} ${c[1]};color:${c[2]}">${esc(n)}${lv ? `<b style="background:${c[3]}">${lv}</b>` : ""}</span>`;
}

// Sello, marca de agua y pie de autoría. Solo el admin puede emitir una hoja
// con sello DEFINITIVO: para cualquier otra persona la hoja sale marcada como
// borrador, con marca de agua y con su mail impreso, así una copia que circule
// siempre se puede rastrear hasta quién la sacó.
function selloImpresion({ borrador, emisor, esc }) {
  const fecha = hoyTexto();
  if (borrador) {
    return {
      sello: '<div class="tag borrador">BORRADOR — SUJETO A CAMBIOS</div>',
      agua: '<div class="agua">BORRADOR</div>',
      pie: `<b>Borrador.</b> No es la versión definitiva del cronograma. Descargado por ${esc(emisor || "usuario sin identificar")} el ${fecha}.`,
    };
  }
  return {
    sello: `<div class="tag firme">DEFINITIVO<span>emitido el ${fecha}</span></div>`,
    agua: "",
    pie: `<b>Versión definitiva.</b> Emitida por la jefatura de residentes el ${fecha}.`,
  };
}

// CSS que comparten las tres hojas.
const CSS_IMPRESION = `
@page{size:A4 landscape;margin:8mm}
/* En el diálogo de Chrome la casilla "Gráficos de fondo" viene DESTILDADA por
   defecto, y sin esto los chips salen en blanco: se pierde el color y, peor, en
   blanco y negro se pierde el relleno que separa un chip del otro. Puesto en *
   y no solo en body para que no dependa de la herencia. */
*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Inter',system-ui,sans-serif;color:#0F172A;font-size:10px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1{font-size:17px;letter-spacing:-.3px}
.sub{font-size:10px;color:#475569}
.head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2.5px solid #0F172A;padding-bottom:4px;margin-bottom:5px}
.tag{font-size:9.5px;font-weight:800;color:#fff;padding:3px 9px;border-radius:5px;white-space:nowrap}
.tag.firme{background:#0F172A}
.tag.firme span{display:block;font-size:7.5px;font-weight:600;opacity:.75;letter-spacing:.2px}
.tag.borrador{background:#B91C1C}
.agua{position:fixed;top:30%;left:0;right:0;text-align:center;font-size:130px;font-weight:800;color:rgba(120,120,120,.13);letter-spacing:16px;transform:rotate(-18deg);pointer-events:none;z-index:0}
.head,.bloques,table,.pie{position:relative;z-index:1}
.bloques{display:flex;gap:7px;margin-bottom:5px}
.bloque{flex:1;border:1.5px solid #94A3B8;border-radius:7px;padding:4px 7px}
.bloque h3{font-size:8.5px;text-transform:uppercase;letter-spacing:.5px;color:#334155;margin-bottom:2px}
.eq,.par{display:inline-flex;align-items:center;gap:4px;margin:0 8px 1px 0;flex-wrap:wrap}
.eqn{font-size:11px;font-weight:800;padding:2.5px 7px;border-radius:4px}
.txt{font-size:11px;color:#334155}
/* Los chips son lo que la gente lee de lejos y a contraluz en el office, así que
   van grandes a propósito y todo lo demás de la hoja se apretó para pagarlos.
   Suena contraintuitivo agrandarlos cuando la hoja tiene que entrar en una
   página, pero funciona: el ajuste maqueta el body a 1030/zoom px de
   ancho, así que un tipo más grande baja el zoom y a la vez ensancha las
   columnas en la misma proporción. Lo único que se paga es el tamaño relativo
   del título y los rótulos, que es exactamente lo que sobra en esta hoja.
   El badge de nivel va en em para que crezca con el chip. */
.chip{display:inline-flex;align-items:center;gap:3px;border-radius:10px;padding:1.5px 7px;font-size:17px;font-weight:700;margin:.5px;white-space:nowrap}
.chip b{font-size:.6em;color:#fff;padding:.5px 3.5px;border-radius:3px;font-weight:800}
table{width:100%;border-collapse:collapse;table-layout:fixed}
.nota{font-size:11px;color:#64748B;font-style:italic}
.pie{margin-top:4px;font-size:8px;color:#334155;line-height:1.4;border-top:1px solid #94A3B8;padding-top:4px;break-inside:avoid;page-break-inside:avoid}
table{break-inside:auto}
tr{break-inside:avoid;page-break-inside:avoid}
`;

// El ajuste a una sola página corre DENTRO de la hoja, no desde la app. Así la
// misma hoja se comporta igual en la ventana de impresión y en el iframe de la
// vista previa: lo que se ve en pantalla es literalmente lo que sale impreso.
//
// Cómo funciona: la hoja se maqueta a PW/z píxeles de ancho y después se escala
// por z, así que el alto impreso es alto(PW/z) * z. Se busca el z más grande
// que todavía entra, por bisección.
//
// OJO, dos cosas que ya se aprendieron a los golpes y no hay que deshacer:
//
// 1) Acá antes había un punto fijo (z = PH/alto, repetido) y ESTABA MAL.
//    Oscilaba en vez de converger: al bajar el zoom la hoja se maqueta más
//    ancha, entonces se vuelve más baja, entonces permite subir el zoom, que la
//    angosta de nuevo. Con letra chica el rebote no se notaba; al agrandar los
//    chips se hizo grande y la hoja salía en dos páginas.
// 2) La altura se mide aplicando el zoom de verdad, no escalando una medición
//    hecha a zoom 1. Chrome redondea cada caja al aplicar zoom y con treinta y
//    pico de filas ese redondeo suma varios puntos porcentuales de alto.
//
// El zoom puede pasar de 1: si sobra papel la hoja se agranda hasta llenar la
// página, que es lo que hace que un mes flaco no salga con letra diminuta.
const AJUSTE_HOJA_JS = `
(function(){
  var body=document.body, PW=1030, MAXZ=1.75;
  // Cuánto alto queda para la hoja. En una compu son 716 px: A4 apaisada a
  // 96 dpi menos los márgenes de @page.
  //
  // En iPhone y iPad hay que reservar más. El diálogo de impresión de iOS
  // estampa SIEMPRE un encabezado y un pie propios —la URL, la fecha y el
  // "Página 1 de 2"— y, a diferencia de Chrome en la compu, no hay ninguna
  // casilla para desactivarlos. Eso se come alto de la hoja, y como el sistema
  // no expone cuánto se quedó, no queda otra que reservárselo de antemano. Sin
  // esta reserva la hoja pasa apenas del alto útil y septiembre salía en dos
  // páginas: la primera completa y la segunda con el pie de la hoja solo.
  var esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var PH = esIOS ? 652 : 716;
  // OJO: acá NO se puede usar documentElement.scrollHeight. Nunca devuelve menos
  // que el alto del viewport, así que en una ventana alta —la de cualquiera con
  // la pantalla maximizada— el alto medido se quedaba clavado en el alto de la
  // ventana por más que la hoja se achicara, la bisección se iba hasta el piso
  // y la hoja salía maquetada a tres mil y pico de píxeles: en el papel, una
  // guarda chiquita arriba de una hoja vacía. En headless no se veía porque la
  // ventana es más baja que la hoja. body.scrollHeight es el alto real del
  // contenido y no depende del viewport; por el zoom va en unidades locales,
  // así que se multiplica por z para tenerlo en píxeles impresos.
  function alturaCon(z){ _z=z; body.style.width=(PW/z)+"px"; body.style.zoom=String(z); return body.scrollHeight*z; }
  function anchoDesborda(){ return body.scrollWidth*z0() > PW+2; }
  var _z=1; function z0(){ return _z; }
  function ajustar(){
    var z=1;
    try{
      if(alturaCon(1)>PH){
        var lo=0.3,hi=1;
        for(var i=0;i<12;i++){ var m=(lo+hi)/2; if(alturaCon(m)<=PH) lo=m; else hi=m; }
        z=lo;
      } else if(!anchoDesborda()){
        var lo2=1,hi2=MAXZ;
        for(var j=0;j<10;j++){ var m2=(lo2+hi2)/2;
          if(alturaCon(m2)<=PH && !anchoDesborda()) lo2=m2; else hi2=m2; }
        z=lo2;
      }
      alturaCon(z);
    }catch(e){ /* si algo falla se muestra igual, sin ajustar */ }
  }
  function arrancar(){ ajustar(); if(window.__imprimirAlAjustar){ setTimeout(function(){ window.focus(); window.print(); }, 150); } }
  var f=document.fonts && document.fonts.ready;
  if(f && typeof f.then==="function") f.then(function(){ setTimeout(arrancar,80); }).catch(function(){ setTimeout(arrancar,400); });
  else setTimeout(arrancar,400);
})();`;

// Le pega el ajuste a la hoja. Con imprimir=true además dispara la impresión.
function hojaAjustada(html, imprimir) {
  const script = `<script>${imprimir ? "window.__imprimirAlAjustar=true;" : ""}${AJUSTE_HOJA_JS}<\/script></body>`;
  return html.replace("</body>", script);
}

// Las hojas se arman como un documento HTML completo y recién después se decide
// a dónde va: a una ventana nueva para imprimir, o al iframe de la vista previa.
function abrirHoja(html) {
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(hojaAjustada(html, true));
  win.document.close();
}

function htmlSemana({ lunes, week, equipos, borrador, emisor, bn }) {
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const P = paletaImpresion(bn);
  const chip = (n) => chipImpreso(n, P, esc);
  const { sello, agua, pie } = selloImpresion({ borrador, emisor, esc });

  const fechas = DAYS.map((_, i) => shift(lunes, i));
  const fin = fechas[6];
  const rango = lunes.getMonth() === fin.getMonth()
    ? `${lunes.getDate()} al ${fin.getDate()} de ${MONTHS[lunes.getMonth()].toLowerCase()} de ${fin.getFullYear()}`
    : `${lunes.getDate()} de ${MONTHS[lunes.getMonth()].toLowerCase()} al ${fin.getDate()} de ${MONTHS[fin.getMonth()].toLowerCase()} de ${fin.getFullYear()}`;

  const celdaSlot = (key, di) => {
    const d = week.days[di];
    const bloqueada = (isWeekendIdx(di) || d.feriado) && key !== "postguardia";
    if (bloqueada) return `<td class="finde"><span class="nota">sin sala</span></td>`;
    const gente = [...(d[key] || [])].sort(porJerarquia);
    return `<td class="${isWeekendIdx(di) || d.feriado ? "finde" : ""}">${gente.length ? gente.map(chip).join("") : '<span class="nota">—</span>'}</td>`;
  };
  const filaSlot = (sl) => `<tr><th class="lbl" style="background:${P.fila[sl.key]}">${sl.label}</th>${DAYS.map((_, di) => celdaSlot(sl.key, di)).join("")}</tr>`;

  const filaGuardia = `<tr><th class="lbl" style="background:${P.fila.guardia}">De guardia<span>desde las 16 h</span></th>${DAYS.map((_, di) => {
    const g = [...(week.days[di].deGuardia || [])].sort(porJerarquia);
    return `<td class="g">${g.length ? g.map(chip).join("") : '<span class="nota">sin cargar</span>'}</td>`;
  }).join("")}</tr>`;

  const filaTexto = (label, campo, clase) => {
    if (!DAYS.some((_, di) => (week.days[di][campo] || "").trim())) return "";
    return `<tr><th class="lbl" style="background:#94A3B8">${label}</th>${DAYS.map((_, di) =>
      `<td class="${clase}">${esc((week.days[di][campo] || "").trim())}</td>`).join("")}</tr>`;
  };

  const libresHtml = RESIDENTS.R4.filter((n) => week.diasLibresR4[n]).map((n) =>
    `<span class="par">${chip(n)}<span class="txt">${week.diasLibresR4[n]}</span></span>`).join("") || '<span class="nota">sin cargar</span>';
  const eqHtml = EQUIPO_SLOTS.filter((sl) => (equipos[sl.key] || []).length).map((sl) =>
    `<span class="par"><span class="eqn" style="background:${P.bn ? "#E5E7EB" : sl.tint};color:${P.bn ? "#111827" : sl.accent}">${sl.label}</span>${[...(equipos[sl.key] || [])].sort(porJerarquia).map(chip).join("")}</span>`).join("") || '<span class="nota">sin equipos armados</span>';

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${borrador ? "Borrador — " : ""}Scheduler UTI — Semana del ${rango}</title><style>
${CSS_IMPRESION}
.tag.borrador{background:${P.tagBorrador}}
col.lblcol{width:74px}
thead th{font-size:12.5px;background:#0F172A;color:#fff;padding:4px 3px;border:1px solid #0F172A}
thead th small{display:block;font-size:10px;font-weight:600;opacity:.8}
thead th.fs{background:#475569}
th.lbl{font-size:11.5px;font-weight:800;color:#fff;border:1px solid #94A3B8;padding:3px;vertical-align:middle;line-height:1.2}
th.lbl span{display:block;font-size:8.5px;font-weight:600;opacity:.85}
td{border:1px solid #94A3B8;vertical-align:top;padding:3px;height:52px}
td.finde{background:${P.finde}}
td.g{background:${P.bn ? "#F3F4F6" : "#FFF1F2"};height:46px}
td.obs{background:${P.obs[0]};color:${P.obs[1]};font-size:10.5px;line-height:1.3;height:auto;padding:4px;${P.bn ? "border-left:3px solid #111827;" : ""}}
td.rec{background:${P.rec[0]};color:${P.rec[1]};font-size:10.5px;line-height:1.3;height:auto;padding:4px;${P.bn ? "border-left:3px dashed #111827;" : ""}}
</style></head><body>
${agua}
<div class="head"><div><h1>Semana del ${rango}</h1><div class="sub">Residencia de Terapia Intensiva — Hospital Británico</div></div>${sello}</div>
<div class="bloques">
  <div class="bloque"><h3>Equipos por UTI del mes</h3>${eqHtml}</div>
  <div class="bloque" style="flex:0 0 300px"><h3>Días libres de los R4</h3>${libresHtml}</div>
</div>
<table>
<colgroup><col class="lblcol">${DAYS.map(() => "<col>").join("")}</colgroup>
<thead><tr><th></th>${DAYS.map((d, i) => `<th class="${isWeekendIdx(i) ? "fs" : ""}">${d}<small>${fechas[i].getDate()}/${fechas[i].getMonth() + 1}${week.days[i].feriado ? " · FERIADO" : ""}</small></th>`).join("")}</tr></thead>
<tbody>
${SLOTS.map(filaSlot).join("")}
${filaGuardia}
${filaTexto("Observaciones", "observaciones", "obs")}
${filaTexto("Recordatorios", "recordatorios", "rec")}
</tbody></table>
<div class="pie">${pie}<br><b>Referencias:</b> la guardia empieza a las 16 h. Sábados, domingos y feriados no llevan grilla de salas.${P.leyenda}</div>
</body></html>`;
}

function abrirSemana(opts) { abrirHoja(htmlSemana(opts)); }

function htmlMes({ anio, mes, lunes, semanas, rot, equipos, tipo, borrador, emisor, bn }) {
  const soloGuardias = tipo === "guardias";
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const P = paletaImpresion(bn);
  const chip = (n) => chipImpreso(n, P, esc);
  const { sello, agua, pie } = selloImpresion({ borrador, emisor, esc });

  const datosMes = rot.months[mes] || { assignments: [], vacaciones: [] };
  const diaLibrePrimeraSemana = (semanas[isoDate(lunes[0])] || emptyWeek()).diasLibresR4;

  const celda = (fecha) => {
    const dentro = fecha.getMonth() === mes;
    const w = semanas[isoDate(mondayOf(fecha))];
    if (!dentro || !w) return `<td class="off"><div class="num">${fecha.getDate()}/${fecha.getMonth() + 1}</div><div class="nota">${dentro ? "" : "otro mes"}</div></td>`;
    const d = w.days[diOfDate(fecha)];
    const finde = isWeekendIdx(diOfDate(fecha)) || d.feriado;
    const fila = (lbl, key, gente) => gente && gente.length ? `<div class="fila"><span class="lbl" style="background:${P.fila[key]}">${lbl}</span>${[...gente].sort(porJerarquia).map(chip).join("")}</div>` : "";
    if (soloGuardias) {
      const g = [...(d.deGuardia || [])].sort(porJerarquia);
      return `<td class="${finde ? "finde" : ""} g-solo"><div class="num">${fecha.getDate()}${d.feriado ? ' <span class="fer">FERIADO</span>' : ""}</div>` +
        (g.length ? `<div class="gbig">${g.map(chip).join("")}</div>` : '<div class="nota">sin cargar</div>') + "</td>";
    }
    return `<td class="${finde ? "finde" : ""}"><div class="num">${fecha.getDate()}${d.feriado ? ' <span class="fer">FERIADO</span>' : ""}</div>` +
      (finde ? '<div class="nota">sin sala</div>' : fila("U1", "uti1", d.uti1) + fila("U2", "uti2", d.uti2) + fila("U3", "uti3", d.uti3) + fila("PG", "postguardia", d.postguardia)) +
      fila("G", "guardia", d.deGuardia) +
      (d.observaciones ? `<div class="obs">${esc(d.observaciones)}</div>` : "") +
      "</td>";
  };

  const filas = lunes.map((l) => `<tr>${DAYS.map((_, i) => celda(shift(l, i))).join("")}</tr>`).join("");

  const cuenta = {};
  lunes.forEach((l) => DAYS.forEach((_, i) => {
    const f = shift(l, i);
    if (f.getMonth() !== mes) return;
    const w = semanas[isoDate(mondayOf(f))];
    if (!w) return;
    (w.days[diOfDate(f)].deGuardia || []).forEach((n) => { cuenta[n] = (cuenta[n] || 0) + 1; });
  }));
  const porNivel = { R4: 0, R3: 0, R2: 0 };
  Object.entries(cuenta).forEach(([n, c]) => { if (porNivel[LEVEL[n]] !== undefined) porNivel[LEVEL[n]] += c; });
  const bloqueConteo = ["R4", "R3", "R2"].map((lv) => {
    const gente = ALL.filter((n) => LEVEL[n] === lv && cuenta[n]);
    if (!gente.length) return "";
    return `<div class="eq"><span class="eqn" style="background:${P.bn ? "#E5E7EB" : P.chips[lv][0]};color:#111827">${lv} · ${porNivel[lv]}</span>${gente.map((n) => `${chip(n)}<span class="cnt">${cuenta[n]}</span>`).join("")}</div>`;
  }).join("");
  const eqHtml = EQUIPO_SLOTS.filter((sl) => (equipos[sl.key] || []).length).map((sl) =>
    `<div class="eq"><span class="eqn" style="background:${P.bn ? "#E5E7EB" : sl.tint};color:${P.bn ? "#111827" : sl.accent}">${sl.label}</span>${[...(equipos[sl.key] || [])].sort(porJerarquia).map(chip).join("")}</div>`).join("") || '<div class="nota">Sin equipos armados</div>';
  const libresHtml = RESIDENTS.R4.filter((n) => diaLibrePrimeraSemana[n]).map((n) =>
    `<div class="eq">${chip(n)}<span class="txt">${diaLibrePrimeraSemana[n]}</span></div>`).join("") || '<div class="nota">Sin días libres cargados</div>';
  const rotan = (datosMes.assignments || []).map((x) => `${x.resident} (${x.place}${x.exterior ? " ✈️" : ""})`).join(" · ") || "nadie";
  const exterior = (datosMes.assignments || []).filter((x) => x.exterior).map((x) => `${x.resident} (${x.place})`).join(" · ") || "nadie";
  const vac = (datosMes.vacaciones || []).map((v) => `${v.nombre} (${(TRAMOS_VACACIONES[v.tramo] || TRAMOS_VACACIONES.mes).corto})`).join(" · ") || "nadie";

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${borrador ? "Borrador — " : ""}${soloGuardias ? "Guardias" : "Cobertura de salas"} — ${MONTHS[mes]} ${anio}</title><style>
${CSS_IMPRESION}
.tag.borrador{background:${P.tagBorrador}}
thead th{font-size:13px;background:#0F172A;color:#fff;padding:3px;border:1px solid #0F172A}
td{border:1px solid #94A3B8;vertical-align:top;padding:2px 3px}
td.g-solo{height:82px;text-align:center;vertical-align:middle}
td.g-solo .num{font-size:15px;text-align:left}
.gbig{display:flex;flex-direction:column;align-items:center;gap:4px;margin-top:5px}
.gbig .chip{font-size:15px;padding:3.5px 12px;border-radius:16px}
.gbig .chip b{font-size:9.5px;padding:1px 4px}
.cnt{font-size:12px;font-weight:800;color:#1F2937;margin:0 7px 0 1px}
td.off{background:${P.off}}td.finde{background:${P.finde}}
.num{font-size:14px;font-weight:800;margin-bottom:1px}
.fer{font-size:9px;background:${P.bn ? "#111827" : "#FDE68A"};color:${P.bn ? "#fff" : "#92400E"};padding:1px 4px;border-radius:6px;vertical-align:middle}
.fila{display:flex;align-items:flex-start;gap:3px;margin-bottom:0;flex-wrap:wrap;line-height:1.05}
.fila .lbl{font-size:11.5px;font-weight:800;color:#fff;border-radius:4px;padding:2px 5px;min-width:26px;text-align:center;flex-shrink:0;margin-top:2px}
.obs{font-size:10px;color:${P.obs[1]};background:${P.obs[0]};border-radius:3px;padding:1px 3px;margin-top:1px;line-height:1.25;${P.bn ? "border-left:2.5px solid #111827;" : ""}}
</style></head><body>
${agua}
<div class="head"><div><h1>${soloGuardias ? "Guardias" : "Cobertura de salas"} · ${MONTHS[mes]} ${anio}</h1><div class="sub">Residencia de Terapia Intensiva — Hospital Británico</div></div>${sello}</div>
<div class="bloques">
${soloGuardias
  ? `<div class="bloque"><h3>Guardias del mes por residente</h3>${bloqueConteo || '<div class="nota">Sin guardias cargadas</div>'}</div>
     <div class="bloque" style="flex:0 0 250px"><h3>No hacen guardia este mes</h3><div class="txt" style="line-height:1.6"><b>Fuera del país:</b> ${esc(exterior)}<br><b>Vacaciones:</b> ${esc(vac)}</div></div>`
  : `<div class="bloque"><h3>Equipos por UTI</h3>${eqHtml}</div>
     <div class="bloque"><h3>Días libres R4</h3>${libresHtml}</div>
     <div class="bloque"><h3>Fuera de sala este mes</h3><div class="txt" style="line-height:1.6"><b>Rotan:</b> ${esc(rotan)}<br><b>Vacaciones:</b> ${esc(vac)}<br><span style="color:#64748B">Los que rotan dentro del país siguen haciendo guardias.</span></div></div>`}
</div>
<table>
<colgroup>${DAYS.map((_, i) => `<col style="width:${soloGuardias ? 100 / 7 : isWeekendIdx(i) ? 9 : 16.4}%">`).join("")}</colgroup>
<thead><tr>${DAYS.map((d) => `<th>${d}</th>`).join("")}</tr></thead><tbody>${filas}</tbody></table>
<div class="pie">${pie}<br>${soloGuardias ? "<b>La guardia empieza a las 16 h.</b> Siempre dos residentes, uno de ellos R3 o R4. Los fines de semana, un R3 con un R2." : "<b>Referencias:</b> U1/U2/U3 = sala · PG = postguardia · G = de guardia (desde las 16 h)."}${P.leyenda}</div>
</body></html>`;
}

function abrirBorrador(opts) { abrirHoja(htmlMes(opts)); }


/* ══════════════════ GUARDIAS POR RESIDENTE ══════════════════ */

export { AJUSTE_HOJA_JS, CSS_IMPRESION, HojaPreview, ImpresionesView, abrirBorrador, abrirHoja, abrirSemana, chipImpreso, hojaAjustada, htmlMes, htmlSemana, paletaImpresion, selloImpresion };
