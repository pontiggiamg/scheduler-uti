/* ══════════════════════════════════════════════════════════════════════════
   LO POCO QUE COMPARTE TODA LA APP

   Cuatro cosas que usan tanto App.jsx como la Pase App, que vive en su
   propio archivo. Están acá y no en App.jsx para que la Pase App no tenga
   que importar App.jsx entera —eso sería un círculo— ni para que haya dos
   copias de lo mismo, que es como empiezan los bugs donde una pantalla
   redondea distinto que la otra.
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect } from "react";

// ¿La pantalla es de celular? 640 px es el corte: abajo de eso la app cambia
// de forma (menos columnas, botones más grandes para el dedo).
const PA_CORTE_CEL = 640;
function useChico(corte = PA_CORTE_CEL) {
  const [chico, setChico] = useState(
    typeof window !== "undefined" ? window.innerWidth < corte : false);
  useEffect(() => {
    const onResize = () => setChico(window.innerWidth < corte);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, [corte]);
  return chico;
}

// Correr una fecha n días. Devuelve una fecha nueva: no toca la original.
const shift = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

// La fecha como AAAA-MM-DD, que es la forma en que se guardan y se
// comparan en toda la app.
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// El cartel de "Cargando…" mientras una pantalla espera sus datos.
const Skeleton = () => (<div style={{ height: 460, borderRadius: 14, background: "linear-gradient(90deg,#F1F5F9 25%,#E2E8F0 50%,#F1F5F9 75%)", backgroundSize: "200% 100%", animation: "sk 1.2s infinite", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748B", fontSize: 13 }}>Cargando…<style>{`@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style></div>);

export { PA_CORTE_CEL, useChico, shift, isoDate, Skeleton };
