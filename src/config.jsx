/* ══════════════════════════════════════════════════════════════════════════
   La gente y las constantes

   Quienes son los residentes, sus mails, los colores de cada nivel, como se
   llaman las pestañas, cuantas guardias entran por mes. Nada de esto tiene
   logica: son los datos fijos del servicio, y estan todos juntos para que
   cambiar uno no sea una expedicion.
   ══════════════════════════════════════════════════════════════════════════ */


const ADMIN_EMAIL = "pontiggiamg@gmail.com";

// Pestañas de nivel superior de la app. El orden por defecto se usa si todavía
// no hay nada guardado en Firestore (scheduler/ui-config); el admin puede
// reordenarlas arrastrando y ese orden se guarda ahí, compartido para todos.
// DEFAULT_TAB_ORDER se arma solo a partir de TAB_META, más abajo. Antes era
// una lista escrita a mano y pasó lo que tenía que pasar: al agregar la
// pestaña del RedCap quedó fuera de esta lista y no se dibujaba, aunque
// estuviera declarada y ruteada. Dos listas que hay que mantener iguales a
// mano son una lista de más.
// La pestaña se llamaba "borradores" y pasó a llamarse "impresiones": lo que
// sale de ahí es definitivo salvo que se lo marque expresamente como borrador.
// El orden de pestañas guardado en Firestore puede tener todavía el nombre
// viejo, así que se traduce al leerlo en vez de pedirle a nadie que lo
// reordene de nuevo.
const TAB_RENOMBRADAS = { borradores: "impresiones" };

const TAB_META = {
  scheduler: { icon: "📅", label: "Semana" },
  rotaciones: { icon: "🔄", label: "Rotaciones y Vacaciones" },
  pases: { icon: "🛏️", label: "Pases" },
  // Pase App: el pase de guardia editable. Cada residente tiene su propia copia
  // guardada en su cuenta, así que la pestaña la ve cualquiera que entró a la
  // app, no solo la jefatura.
  paseapp: { icon: "🩺", label: "Pase App", tag: "Alpha" },
  // El 🥐 es el ícono de la pestaña y le corresponde a la chipa; el ✨ va pegado
  // a "Aura" en la etiqueta para que cada votación tenga su símbolo a la vista.
  chipa: { icon: "🥐", label: "Chipa y Aura ✨" },
  // Votación auspiciada por el Dr. Elías. Funciona igual que Chipa y Aura
  // (misma semana, mismos candidatos), pero es una sola votación.
  laura: { icon: "🎗️", label: "Votación de Laura" },
  academico: { icon: "📚", label: "Calendario Académico" },
  articulo: { icon: "📄", label: "Artículo de la semana" },
  registro: { icon: "📋", label: "Registro" },
  // Relevamiento diario para la base de investigación del servicio. La ve y
  // la completa cualquiera que entra: cuantas más manos, menos tarda.
  redcap: { icon: "🧪", label: "Ayudanos con el RedCap" },
  hoy: { icon: "📱", label: "¿Quién está hoy?" },
  accesos: { icon: "🔐", label: "Accesos", soloAdmin: true },
  impresiones: { icon: "🖨️", label: "Ver cronogramas, guardias e Imprimir" },
};

// El orden por defecto es el orden en que están escritas arriba. Una pestaña
// nueva aparece sola con sólo agregarla a TAB_META.
const DEFAULT_TAB_ORDER = Object.keys(TAB_META);

// ── Roles ────────────────────────────────────────────────────────────────
// Reemplaza al viejo sistema de "12 residentes hardcodeados + aprobación
// manual por mail" (ver la migración del 5/9/2026). Ahora cada cuenta de
// Google que usa la app tiene un rol asignado a mano desde la pestaña
// Accesos, y cada rol define qué pestañas puede ver — eso último se
// configura EN VIVO desde la misma pestaña (colección roles_config), no
// acá, porque el jefe de residentes quería poder cambiarlo sin depender de
// un deploy. Esta lista es solo el catálogo de roles que existen: agregar uno
// nuevo es agregar una línea acá.
//
// "admin" es especial: no se le asigna a nadie desde la pestaña Accesos (la
// tiene fija ADMIN_EMAIL) y siempre ve todas las pestañas, sin importar lo
// que diga roles_config — así el jefe de residentes nunca puede quedar
// bloqueado de su propia app.
const ROLES = {
  admin: { label: "Admin", icon: "👑" },
  residente: { label: "Residente", icon: "🩺" },
  staff: { label: "Staff", icon: "🧑‍⚕️" },
  enfermeria: { label: "Enfermería", icon: "💉" },
  rotante: { label: "Rotante", icon: "🔄" },
};

// Roles que se pueden asignar desde la pestaña Accesos (todos menos "admin",
// que es fijo).
const ROLES_ASIGNABLES = Object.keys(ROLES).filter((r) => r !== "admin");

// Ruta pública sin login para compartir a otros servicios del hospital: entra
// directo a "¿Quién está en la UTI hoy?" (hasta Postguardia inclusive), sin
// pasar por la pantalla de login de Google. Como las reglas de Firestore ya
// son de lectura pública, alcanza con esquivar la pantalla de login de esta
// SPA en el propio cliente — no hace falta backend aparte.
const PUBLIC_ROUTE_PATH = "/hoy";

function isPublicRoute() {
  if (typeof window === "undefined") return false;
  return window.location.pathname.replace(/\/+$/, "") === PUBLIC_ROUTE_PATH;
}

const RESIDENTS = {
  R2: ["Maca", "Andy", "Nata", "Nahuel"],
  R3: ["Chris", "Ulloa", "Varoli", "Gian"],
  R4: ["Dani", "Caro", "Leo", "Vani"],
};

const ALL = [...RESIDENTS.R2, ...RESIDENTS.R3, ...RESIDENTS.R4];

// El jefe de residentes no es un residente más: no hace procedimientos, no
// vota la Chipa, no da clases del programa ni tiene cupo de guardias. Pero sí
// puede cubrir una sala cuando falta un superior o un inferior, así que existe
// como ficha propia en el calendario y nada más. Por eso ALL (los 12) y
// ASIGNABLES (los 12 + el jefe) son listas distintas: todo lo que es "carrera
// de residencia" usa ALL; solo la grilla usa ASIGNABLES.
const JEFE = "Gonzalo";

const ASIGNABLES = [...ALL, JEFE];

// Mapeo residente → email de Google. Se usa para identificar qué cuenta logueada
// corresponde a qué residente (ej. Procedimientos, donde cada uno carga lo suyo).
//
// ⚠️ ESTA LISTA TAMBIÉN VIVE EN firestore.rules (función residenteFundador).
// Es la misma idea acá y allá —estos 12 entran sin pedir permiso, sin pasar
// por usuarios_autorizados— pero son DOS listas separadas que hay que
// mantener iguales A MANO: nada las sincroniza. El 3/9/2026 se rompió por
// esto: acá dejaba pasar a Nahuel y a Ulloa (entre otros) sin problema, pero
// las reglas de Firestore no tenían la excepción, así que cada lectura a la
// base les daba PERMISSION_DENIED en silencio y la app se veía vacía
// ("Actualizado nunca", meses en blanco) sin ningún error visible. Si agregás,
// sacás o cambiás un mail ACÁ, hacé el mismo cambio en firestore.rules y
// volvé a publicar las reglas en la consola de Firebase — un git push no
// las aplica solo.
const RESIDENT_EMAIL = {
  Dani: "dpadillasalcedo@gmail.com",
  Caro: "caro146ro@gmail.com",
  Leo: "leonardohomar1894@gmail.com",
  Vani: "vaninagobatto23@gmail.com",
  Chris: "chrislombardo225@gmail.com",
  Ulloa: "nico24ulloa@gmail.com",
  Varoli: "Nico.a.Varoli@gmail.com",
  Gian: "giancarlomilemacci@gmail.com",
  Maca: "macagonzalezvirgili@gmail.com",
  Andy: "mportilla58@gmail.com",
  Nata: "nataciademoraes@gmail.com",
  Nahuel: "nahuelklahn@gmail.com",
};

const RESIDENT_BY_EMAIL = Object.fromEntries(Object.entries(RESIDENT_EMAIL).map(([name, email]) => [email.toLowerCase(), name]));

// Nombre completo para mostrar en pantallas públicas (por ahora, solo
// "¿Quién está hoy?"). El resto de la app sigue usando el nombre corto de
// siempre como identificador interno (RESIDENTS, LEVEL, COLOR, todas las
// colecciones de Firestore) — este mapeo es puramente de presentación.
const DISPLAY_NAME = {
  Nahuel: "Nahuel",
  Maca: "Macarena",
  Gian: "Giancarlo",
  Nata: "Natacia",
  Andy: "Andrés",
  Leo: "Leonardo",
  Caro: "Carolina",
  Vani: "Vanina",
  Dani: "Daniel",
  Ulloa: "Ulloa",
  Varoli: "Varoli",
  Chris: "Christian",
};

const nombrePublico = (n) => DISPLAY_NAME[n] || n;

// Registro: llegadas tarde, faltas y guardias son eventos con fecha que carga
// el admin a mano (colección registro_eventos, campo "tipo"). Procedimientos
// es aparte: cada residente carga los suyos y el admin los aprueba/rechaza
// (colección "procedimientos"). La lista de procedimientos disponibles vive
// en Firestore (scheduler/registro-config) para que el admin la pueda ajustar
// sin tocar código; esta es solo la lista inicial con la que arranca.
const EVENTO_TIPOS = {
  tarde: { label: "Llegadas tarde", singular: "llegada tarde", icon: "⏰", color: "#B45309", bg: "#FFFBEB", bd: "#FDE68A" },
  falta: { label: "Faltas", singular: "falta", icon: "🚫", color: "#B91C1C", bg: "#FEF2F2", bd: "#FECACA" },
  guardia: { label: "Guardias", singular: "guardia", icon: "🌙", color: "#5B21B6", bg: "#F5F3FF", bd: "#DDD6FE" },
};

const DEFAULT_PROCEDIMIENTOS = [
  "Vía venosa central",
  "Vía arterial",
  "Intubación orotraqueal",
  "Traqueostomía percutánea",
  "Toracocentesis",
  "Avenamiento pleural (tubo de tórax)",
  "Paracentesis",
  "Punción lumbar",
  "Colocación de catéter de hemodiálisis",
  "Cardioversión eléctrica",
  "Broncoscopía",
  "Sonda nasogástrica / nasoyeyunal",
  "Cricotiroidotomía",
  "Pericardiocentesis",
  "Ecografía point-of-care (FAST/POCUS)",
];

// Cobertura de sala por R2/R3 (colección "cobertura_sala"): quién cubrió,
// qué día, y si fue en calidad de "post guardia" o "rotación". Solo aplica a
// R2 y R3 (los R4 no cubren sala de esta forma).
const COBERTURA_RESIDENTS = [...RESIDENTS.R2, ...RESIDENTS.R3];

const COBERTURA_TIPOS = {
  post_guardia: { label: "Post guardia", short: "PG" },
  rotacion: { label: "Rotación", short: "Rot" },
};

// Clases/presentaciones dadas por cada residente (colección "registro_clases"),
// contadas por módulo. Aplica a R2, R3 y R4 (todos).
const MODULOS_CLASE = ["Fisiología", "Shock", "Respiratorio", "Medio Interno", "Neuro intensivo", "Misceláneas"];

// Sub-pestañas de Registro: el orden por defecto se usa si todavía no hay
// nada guardado; el admin puede arrastrarlas para reordenarlas y ese orden
// se guarda compartido para todos (mismo doc que el orden de las pestañas
// principales, campo distinto).
// Las estadísticas del servicio (guardias hechas y cobertura de sala) arrancan
// en septiembre de 2026. Lo anterior existió mientras se armaba la app y no
// representa cómo funciona el servicio, así que no se cuenta ni se muestra.
// El artículo de la semana, los procedimientos y el calendario académico NO se
// cortan: ahí el historial completo sí sirve.
const INICIO_ESTADISTICAS = "2026-09-01";

const MES_INICIO_ESTADISTICAS = { anio: 2026, mes: 8 };

const DEFAULT_REGISTRO_SUB_ORDER = ["tarde", "falta", "guardias_mes", "procedimientos", "cobertura", "clases"];

const REGISTRO_SUB_META = {
  tarde: { ...EVENTO_TIPOS.tarde },
  falta: { ...EVENTO_TIPOS.falta },
  guardias_mes: { label: "Guardias por residente", icon: "🌙", color: "#9F1239", bg: "#FFF1F2", bd: "#FECDD3" },
  procedimientos: { label: "Procedimientos", icon: "🩺", color: "#0F766E", bg: "#F0FDFA", bd: "#99F6E4" },
  cobertura: { label: "R2 y R3 que cubrieron sala post guardia o en rotación", icon: "🔁", color: "#1D4ED8", bg: "#EFF6FF", bd: "#BFDBFE" },
  clases: { label: "Cantidad de clases/presentaciones", icon: "🎓", color: "#7C2D12", bg: "#FFF7ED", bd: "#FED7AA" },
};

const LEVEL = {
  ...Object.fromEntries(Object.entries(RESIDENTS).flatMap(([lv, names]) => names.map((n) => [n, lv]))),
  [JEFE]: "JR",
};

const COLOR = {
  // Dorado para el jefe: bien lejos del azul/verde/naranja de los tres niveles,
  // para que se distinga de un vistazo que esa cobertura es una excepción.
  JR: { bg: "#FEF3C7", bd: "#FCD34D", tx: "#78350F", solid: "#D97706" },
  R2: { bg: "#DBEAFE", bd: "#93C5FD", tx: "#1E3A8A", solid: "#3B82F6" },
  R3: { bg: "#D1FAE5", bd: "#6EE7B7", tx: "#065F46", solid: "#10B981" },
  R4: { bg: "#FFEDD5", bd: "#FDBA74", tx: "#9A3412", solid: "#F97316" },
};

/* ── Pantalla chica ────────────────────────────────────────────────────────
   La app se usa sobre todo desde el celular, parado, con una mano y en
   vertical. Este hook dice si estamos en esa situación para que cada pantalla
   pueda cambiar de forma —no sólo achicarse— cuando el ancho no alcanza.

   El corte en 640 px es el habitual: por debajo entra un celular en vertical;
   por encima, uno apaisado, una tablet o la PC. Se escucha el resize porque
   girar el teléfono no recarga la página. */

const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

// Índice (dentro de DAYS) a partir del cual el día es fin de semana. En sábado
// y domingo no se arma la grilla de camas fija (UTI 1/2/3): esos días la
// cobertura de terapia se cubre de otra forma (guardia + postguardia), así
// que esas tres filas quedan bloqueadas y no se pueden usar.
const WEEKEND_START_IDX = 5;

const isWeekendIdx = (di) => di >= WEEKEND_START_IDX;

const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

const WEEKDAYS_FULL = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

// Cada fila de UTI tiene su propio color para distinguirse a simple vista,
// elegidos a propósito lejos del azul de R2 y el verde de R3 (ver COLOR más
// abajo) para que el chip del residente nunca se camufle contra el fondo.
const SLOTS = [
  { key: "uti1", label: "UTI 1", accent: "#0E7490", tint: "#CFFAFE" },
  { key: "uti2", label: "UTI 2", accent: "#BE185D", tint: "#FCE7F3" },
  { key: "uti3", label: "UTI 3", accent: "#A16207", tint: "#FEF3C7" },
  { key: "postguardia", label: "Postguardia", accent: "#A855F7", tint: "#E9D5FF" },
];

// La fila de guardia no es un slot de sala pero necesita sus mismos colores.
const FILA_GUARDIA = { accent: "#9F1239", tint: "#FFF1F2", rotulo: "#FECDD3" };

const SLOT_KEYS = SLOTS.map((s) => s.key);

// Orden en que se muestran los chips dentro de una celda: del más senior al
// menos. Ojo con el detalle que hacía que los R4 aparecieran últimos: si el
// primer nivel vale 0, un `order[x] || 9` lo convierte en 9 porque el cero es
// falsy en JavaScript. Por eso se usa ?? y no ||.
const ORDEN_JERARQUIA = { JR: 0, R4: 1, R3: 2, R2: 3 };

const porJerarquia = (a, b) => (ORDEN_JERARQUIA[LEVEL[a]] ?? 9) - (ORDEN_JERARQUIA[LEVEL[b]] ?? 9);

// "Skin" del jefe de residentes: degradado dorado con brillo diagonal, para
// que su ficha se distinga al instante de las de los tres niveles. Se aplica
// encima del estilo normal del chip, así el resto del layout no cambia.
const SKIN_JR = {
  background: "linear-gradient(115deg,#7C2D12 0%,#B45309 32%,#D97706 50%,#B45309 68%,#7C2D12 100%)",
  borderColor: "#FCD34D",
  color: "#FFFBEB",
  textShadow: "0 1px 2px rgba(69,26,3,.75)",
  boxShadow: "0 0 0 1px rgba(252,211,77,.5), 0 2px 7px rgba(120,53,15,.45)",
};



/* ══════════════════ FECHAS ══════════════════ */

// Un color por unidad. Tonos apagados, de informe: la idea es ubicarse de un
// vistazo en qué sala se está mirando, no decorar. Cada uno tiene su versión
// fuerte (para la pestaña activa y la barra lateral) y una muy clarita para
// el fondo, que tiene que dejar leer el texto en negro sin esfuerzo.
const PASE_COLOR = {
  "UTI 1": { fuerte: "#1E3A5F", suave: "#EEF2F7" },
  "UTI 2": { fuerte: "#3F5F3A", suave: "#EFF4EE" },
  "UTI 3": { fuerte: "#6B4423", suave: "#F6F1EC" },
  "RECU":  { fuerte: "#4A3B63", suave: "#F2F0F6" },
  "UCO":   { fuerte: "#5A3A44", suave: "#F5F0F1" },
};

// A partir de acá el resumen de pases se considera viejo y se vuelve a pedir al
// abrir la pestaña. Quince minutos es, en la práctica, "se actualiza cada vez
// que alguien entra": los pases de Drive se editan durante todo el día, así que
// un umbral largo dejaba ver un resumen de una hora aunque hubiera alguien
// mirando. No se pone en cero para que, si varios entran seguido, no se
// dispare una sincronización por cada click.
const PASES_FRESCO_MS = 15 * 60 * 1000;

// Dos votaciones por semana, con los MISMOS candidatos y opuestas en signo: la
// chipa es el castigo y el aura es el premio. Cada uno vota una vez en cada
// una, y las dos son independientes: se puede ganar las dos la misma semana.
const PREMIOS = {
  chipa: {
    clave: "chipa",
    titulo: "Chipa de la semana",
    emoji: "🥐",
    campoVotos: "counts",
    campoVotantes: "voted",
    degrade: "linear-gradient(135deg,#7C2D12,#9A3412 60%,#C2410C)",
    acento: "#C2410C",
    ganadorBg: "#FFF7ED",
    ganadorBd: "#FB923C",
    ganadorTx: "#9A3412",
    trofeo: "🥐",
    yaVotaste: "✓ Ya votaste la chipa de esta semana",
    invitacion: "Tocá a quien se ganó la chipa. El voto es anónimo y no se puede cambiar.",
    vacio: "Nadie disponible esa semana.",
  },
  aura: {
    clave: "aura",
    titulo: "Aura de la semana",
    emoji: "✨",
    campoVotos: "countsAura",
    campoVotantes: "votedAura",
    degrade: "linear-gradient(135deg,#4C1D95,#6D28D9 60%,#8B5CF6)",
    acento: "#7C3AED",
    ganadorBg: "#F5F3FF",
    ganadorBd: "#A78BFA",
    ganadorTx: "#5B21B6",
    trofeo: "🏆",
    yaVotaste: "✓ Ya votaste el aura de esta semana",
    invitacion: "Tocá a quien tuvo el aura. El voto es anónimo y no se puede cambiar.",
    vacio: "Nadie disponible esa semana.",
  },
};

// A partir de esta hora ya solo queda el equipo de guardia en el hospital.
const HORA_AVISO_TARDE = 17;

// Hasta esta hora de la mañana sigue en el hospital la guardia de la noche
// anterior; después arranca la actividad normal y está todo el mundo.
const HORA_FIN_GUARDIA = 8;

// A qué hora cambia el día para el servicio. NO es la medianoche: a las 3 de la
// mañana del jueves el que está en la UTI sigue siendo el equipo del miércoles,
// así que hasta esta hora la pantalla tiene que seguir mostrando el miércoles.
const HORA_CAMBIO_DIA = 6;

const INVITADO_VIGENCIA_MS = 15 * 24 * 60 * 60 * 1000; // 15 días

/* ══════════════════════════════════════════════════════════════════════════
   AYUDANOS CON EL REDCAP

   Ocho preguntas de sí o no por paciente, para alimentar una base de datos de
   investigación. La idea es que relevar la UTI entera sea cuestión de minutos
   y lo pueda hacer cualquiera que pase por la app, no una tarea que espera a
   que alguien se siente con una planilla.

   POR QUÉ UN REGISTRO POR DÍA
   ---------------------------
   Un paciente que hoy está intubado mañana puede no estarlo, y eso —cuándo
   cambió— es justamente el dato que un RedCap quiere. Si hubiera un solo
   registro por paciente, la respuesta de mañana pisaría la de hoy y quedaría
   una foto sin historia. Cada día tiene su propio documento y arranca vacío.

   El id es `AAAA-MM-DD__unidad__cama`, así que el día, el sector y la cama ya
   están en la clave: se puede traer un día entero de una y no hace falta
   inventar un identificador de paciente que el Drive no da.

   QUIÉN Y CUÁNDO
   --------------
   Cada respuesta guarda quién la marcó y a qué hora. No es control sobre la
   gente: es que si un dato llama la atención al analizarlo, se sepa a quién
   preguntarle. Gana la última respuesta, sin bloqueos ni avisos.

   Se guarda apenas se toca el botón, sin "guardar" que apretar: en una
   guardia, un formulario que se pierde porque nadie confirmó es un formulario
   que no se completa nunca.
   ══════════════════════════════════════════════════════════════════════════ */
const REDCAP_COL = "redcap_diario";

const REDCAP_PREGUNTAS = [
  ["analgesicos", "Uso de analgésicos"],
  ["sedantes", "Uso de sedantes"],
  ["relajantes", "Uso de relajantes musculares"],
  ["monitoreo", "Tiene monitoreo hemodinámico"],
  ["vasoactivos", "Se encuentra con vasoactivos"],
  ["iot", "Está IOT"],
  ["sondaVesical", "Tiene sonda vesical"],
  ["avc", "Tiene acceso venoso central"],
];

// Cupo de guardias por nivel y por mes. Cada noche lleva dos residentes, asi
// que el total del mes son dias x 2. R4 y R3 tienen cupo fijo y los R2 se
// llevan el resto: por eso en un mes de 30 dias los R2 hacen 26 y no 28.
const CUPO_MES = { R4: 14, R3: 20 };

// Topes de día libre de los R4, por día de la semana.
const TOPE_DIA_LIBRE = { Lunes: 1, Miércoles: 2, Viernes: 2 };

const EQUIPO_MAX = 4;

const EQUIPO_SLOTS = SLOTS.filter((s) => s.key !== "postguardia");

const DIAS_LIBRES_OPCIONES = ["Lunes", "Miércoles", "Viernes"];

export { ADMIN_EMAIL, ALL, ASIGNABLES, COBERTURA_RESIDENTS, COBERTURA_TIPOS, COLOR, CUPO_MES, DAYS, DEFAULT_PROCEDIMIENTOS, DEFAULT_REGISTRO_SUB_ORDER, DEFAULT_TAB_ORDER, DIAS_LIBRES_OPCIONES, DISPLAY_NAME, EQUIPO_MAX, EQUIPO_SLOTS, EVENTO_TIPOS, FILA_GUARDIA, HORA_AVISO_TARDE, HORA_CAMBIO_DIA, HORA_FIN_GUARDIA, INICIO_ESTADISTICAS, INVITADO_VIGENCIA_MS, JEFE, LEVEL, MES_INICIO_ESTADISTICAS, MODULOS_CLASE, MONTHS, ORDEN_JERARQUIA, PASES_FRESCO_MS, PASE_COLOR, PREMIOS, PUBLIC_ROUTE_PATH, REDCAP_COL, REDCAP_PREGUNTAS, REGISTRO_SUB_META, RESIDENTS, RESIDENT_BY_EMAIL, RESIDENT_EMAIL, ROLES, ROLES_ASIGNABLES, SKIN_JR, SLOTS, SLOT_KEYS, TAB_META, TAB_RENOMBRADAS, TOPE_DIA_LIBRE, WEEKDAYS_FULL, WEEKEND_START_IDX, isPublicRoute, isWeekendIdx, nombrePublico, porJerarquia };
