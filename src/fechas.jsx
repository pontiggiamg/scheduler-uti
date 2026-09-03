/* ══════════════════════════════════════════════════════════════════════════
   Fechas y horas

   Todo lo que la app hace con el calendario. Vive aparte porque lo usan
   todas las pantallas y porque un error acá se propaga a todas: si
   `mondayOf` se corre un día, se corre el cronograma entero.
   ══════════════════════════════════════════════════════════════════════════ */

import { shift, isoDate } from "./comunes";
import { DAYS, HORA_CAMBIO_DIA, MONTHS, WEEKDAYS_FULL } from "./config";

function mondayOf(date) {
  const d = new Date(date);
  const wd = d.getDay();
  d.setDate(d.getDate() - wd + (wd === 0 ? -6 : 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

const dm = (d) => `${d.getDate()}/${d.getMonth() + 1}`;

const sameDay = (a, b) => isoDate(a) === isoDate(b);

// Formato legible en hora de Argentina (fija UTC-3, sin horario de verano),
// para que los registros (ej. access_logs) se puedan leer directo en la
// consola de Firebase sin tener que restar horas a mano.
const fechaHoraAR = (d) => new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "medium", timeZone: "America/Argentina/Buenos_Aires" }).format(d);

/* ══════════════════ MODELO SEMANA ══════════════════ */

// Las semanas del mes, por criterio de mayoría: una semana "es" de este mes si
// al menos 4 de sus 7 días caen en él. Hace falta porque las semanas cruzan
// meses — septiembre 2026 arranca un martes, así que mirar solo el lunes
// dejaría afuera la primera semana entera.
function lunesDelMes(anio, mes) {
  const diasDelMes = (l) => {
    let n = 0;
    for (let i = 0; i < DAYS.length; i++) { const d = shift(l, i); if (d.getMonth() === mes && d.getFullYear() === anio) n++; }
    return n;
  };
  const out = [];
  let cur = mondayOf(new Date(anio, mes, 1));
  const fin = new Date(anio, mes + 1, 0);
  while (cur <= fin) { if (diasDelMes(cur) >= 4) out.push(new Date(cur)); cur = shift(cur, 7); }
  return out;
}

// Todas las semanas que TOCAN el mes, aunque sea por un día. Distinto de
// lunesDelMes, que usa el criterio de mayoría para decidir a qué mes
// pertenece cada semana: eso sirve para los equipos o el día libre, pero para
// imprimir un calendario hay que mostrar el mes completo. Si no, un mes que
// termina martes se queda sin sus últimos días.
function lunesQueTocanElMes(anio, mes) {
  const out = [];
  let cur = mondayOf(new Date(anio, mes, 1));
  const fin = new Date(anio, mes + 1, 0);
  while (cur <= fin) { out.push(new Date(cur)); cur = shift(cur, 7); }
  return out;
}

function timeAgo(iso) {
  if (!iso) return "nunca";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "recién";
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

function formatFechaHora(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const fecha = `${WEEKDAYS_FULL[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()].toLowerCase()}`;
  const hora = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${fecha} · ${hora}`;
}

function fechaCorta(fecha) {
  if (!fecha) return "—";
  const [, m, d] = fecha.split("-");
  return `${d}/${m}`;
}

function mesLargo(clave) {
  const [y, m] = clave.split("-").map(Number);
  return `${MONTHS[m - 1] || ""} ${y}`;
}

// Convierte un Date de JS (donde domingo = 0) al índice usado en DAYS y en
// week.days (donde lunes = 0 … domingo = 6), para poder leer el día
// correcto dentro del documento semanal que ya arma SchedulerView.
function diOfDate(d) {
  return (d.getDay() + 6) % 7;
}

// Se usa en dos lugares con el MISMO componente: como pestaña "¿Quién está
// hoy?" dentro de la app logueada (embedded=true, con controles de edición
// si isAdmin) y como el contenido completo de la ruta pública /hoy
// (embedded=false, isAdmin siempre false, sin ningún control de edición —
// ver Root() más arriba, que ni siquiera monta el login para esa ruta).
// Muestra el día actual y el siguiente, hasta Postguardia inclusive (no
// incluye Observaciones ni Recordatorios del calendario semanal — esta
// pantalla tiene su propio campo de observaciones, independiente).
// Cuánto tiempo se guarda el teléfono de un "invitado" (alguien de guardia
// que escribieron en el texto libre y que no es ninguno de los 12
// residentes — ej. un médico de planta cubriendo, o un nombre suelto) antes
// de descartarse solo, para no ir acumulando contactos viejos para siempre.
// Hora actual en Buenos Aires (00-23), independiente de la zona horaria del
// celular de quien mira la página — puede estar consultando desde otro lado.
function horaAR() {
  return Number(new Intl.DateTimeFormat("es-AR", { hour: "2-digit", hourCycle: "h23", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date()));
}

// La fecha "de hoy" según el servicio, no según el reloj. Se calcula en hora de
// Buenos Aires para que dé lo mismo desde dónde se mire la página: alguien
// consultando desde otro huso tiene que ver el día que se está trabajando acá.
function fechaDeServicio() {
  const ymd = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  const d = new Date(`${ymd}T00:00:00`);
  if (horaAR() < HORA_CAMBIO_DIA) d.setDate(d.getDate() - 1);
  return d;
}

// Arma el mes entero en una sola hoja A4 horizontal, listo para imprimir o
// guardar como PDF y repartir en papel. Lee las semanas reales de Firestore,
// así que siempre refleja lo que está cargado hoy. Se abre en una ventana
// nueva con su propio CSS de impresión, igual que el PDF de procedimientos.
// Fecha de emisión, para el sello de las hojas definitivas.
function hoyTexto() {
  const h = new Date();
  return `${h.getDate()} de ${MONTHS[h.getMonth()].toLowerCase()} de ${h.getFullYear()}`;
}

// A qué mes "pertenece" una semana: la que tiene 4 o más de sus 7 días en él.
// Las semanas cruzan meses, así que mirar solo el lunes daría mal (septiembre
// 2026 arranca un martes).
function mesDeLaSemana(monday) {
  const cuenta = {};
  for (let i = 0; i < DAYS.length; i++) {
    const d = shift(monday, i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    cuenta[k] = (cuenta[k] || 0) + 1;
  }
  return Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a])[0];
}

function etiquetaMes(clave) {
  const [y, m] = clave.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export { diOfDate, dm, etiquetaMes, fechaCorta, fechaDeServicio, fechaHoraAR, formatFechaHora, horaAR, hoyTexto, lunesDelMes, lunesQueTocanElMes, mesDeLaSemana, mesLargo, mondayOf, sameDay, timeAgo };
