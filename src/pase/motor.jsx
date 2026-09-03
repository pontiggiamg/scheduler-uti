/* ══════════════════════════════════════════════════════════════════════════
   EL MOTOR DEL PASE — cómo se lee, se limpia y se muestra un pase

   Acá vive todo lo que interpreta el texto que escribe el servicio en el
   Drive: cómo se separa un nombre de su edad, cómo se normalizan las siglas,
   cómo se ordenan los cultivos, qué renglón es un laboratorio y cuál un
   estudio. Es texto adentro, texto afuera: no hay pantalla en este archivo.

   Está separado de la pantalla (pase/vista.jsx) por una razón concreta: la
   pestaña Pases y la pestaña RedCap también necesitan leer el pase, pero no
   necesitan la Pase App entera. Con el corte, lo que se baja siempre son
   estas ~950 líneas, y las ~2700 de la Pase App se bajan solo cuando alguien
   abre esa pestaña.

   El corte no se eligió a ojo: es exactamente lo que el resto de la app usa,
   más todo lo que eso arrastra.
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useRef } from "react";
import { db } from "../firebase";
import { doc } from "firebase/firestore";
import { escuchar } from "../nube";




/* ══════════════════ PASE APP (alpha) ══════════════════

   El pase de guardia editable. Arranca de la foto que el sync trae del Drive y
   cada residente edita SU copia, que se guarda en Firestore bajo su uid. Nadie
   ve la copia de nadie: es una libreta personal, no el registro del servicio.

   Tres decisiones que conviene entender antes de tocar esto:

   1) La foto del Drive NO se toca nunca. Se guarda entera junto con la copia
      editada, y de la comparación entre las dos sale el resaltado de lo que se
      agregó. Por eso no hacen falta versiones: hay dos textos y un interruptor.

   2) Lo editado se marca con un diff POR PALABRAS, no por carácter. Agregar
      "PL s/p" tiene que verse como dos palabras nuevas y no como siete letras
      sueltas intercaladas.

   3) Las anotaciones son temporales por definición. Hasta el 3/9/2026 no se
      borraban solas —había que usar el botón explícito— para no comerse una
      nota a mitad de guardia con un borrado automático mal calculado.

      A pedido de Gonzalo eso cambió: ahora se borran solas, sin pedir
      confirmación, pasadas 26 horas desde que se escribieron (no 24: una
      guardia puede estirarse, y el margen es a propósito más largo que un
      día entero para no cortar una nota en medio de una guardia larga). Cada
      anotación nueva guarda su hora completa en `ts` (fecha y hora, no sólo
      "08:43" como antes); las que ya existían sin `ts` no se tocan, porque no
      hay forma de saber su antigüedad real. Ver `purgarAnotacionesViejas`.
*/

// Una anotación se borra sola pasadas estas horas desde que se escribió.
// Ver el punto 3 de arriba.

const PA_FARMACOS = new Set(["BISO", "LACOSAMIDA", "ZOLPIDEM", "HIDRO", "MESTINON",
  "PREGABALINA", "MEPREDNISONA", "ARIPIPRAZOL", "VALPROICO", "OLANZAPINA", "QUETIAPINA",
  "METADONA", "SANDOSTATIN", "PARACETAMOL", "TRAMADOL", "NIMODIPINA", "METOCLOPRAMIDA",
  "ONDANSETRON", "MORFINA", "BUPRENORFINA", "DEXAMETASONA", "HALOPERIDOL", "LORAZEPAM",
  "ENOXAPARINA", "LEVETIRACETAM", "FENITOINA",
  // Sumados el 2/9/2026 al arreglar el patrón dosis/intervalo: son los que
  // aparecen en el pase con "droga dosis/horas" y no encajaban en ningún
  // sufijo conocido.
  "CARVEDILOL", "FUROSEMIDA", "ESPIRONOLACTONA", "DIGOXINA", "LEVOTIROXINA",
  "PREDNISONA", "HIDROCORTISONA", "INSULINA", "CLONAZEPAM", "MIDAZOLAM",
  "AMIODARONA", "ATORVASTATINA", "ROSUVASTATINA", "CLOPIDOGREL", "ASPIRINA",
  "OMEPRAZOL", "PANTOPRAZOL", "DIPIRONA", "KETOROLAC", "GABAPENTINA",
  "SERTRALINA", "TRAZODONA", "RISPERIDONA", "BACLOFENO", "ALOPURINOL",
  "TAMSULOSINA", "DOXAZOSINA", "AMLODIPINA", "ENALAPRIL", "LOSARTAN",
  "ATENOLOL", "BISOPROLOL", "NEBIVOLOL", "HIDRALAZINA", "NITROGLICERINA"]);

// ── Nombres ────────────────────────────────────────────────────────────────
// El pase mezcla dos convenciones de sexo: F/H (femenino/hombre) y M
// (masculino). "Laluf, Carla Yamela, M" y "Fuentes Armando, M" no pueden ser la
// misma M, así que la M sola se descarta en vez de adivinar.

const PA_SEXO = { F: "Femenino", H: "Masculino" };

const PA_CHICAS = new Set(["de", "del", "la", "las", "los", "y", "da", "di", "van", "von"]);

const paTitulo = (s) => s.split(/\s+/).map((w, i) => {
  const lw = w.toLowerCase();
  return i > 0 && PA_CHICAS.has(lw) ? lw : lw.charAt(0).toUpperCase() + lw.slice(1);
}).join(" ");

/* ── Nombres de pila ───────────────────────────────────────────────────────
   Sirven para una sola cosa: decidir el orden cuando el pase no lo aclara.
   "FUENTES ARMANDO, M, 77" tiene coma, pero la coma separa el sexo, no el
   apellido; sin esta lista la app mostraba "Fuentes Armando" al revés.

   Es una lista, no una regla: no hay ninguna forma de saber por la forma de
   la palabra si "Armando" es nombre o apellido —de hecho Armando Espasandín
   y Armando Fuentes están los dos en el pase, uno con Armando de nombre y el
   otro también—. Por eso sólo se da vuelta el nombre cuando UNA de las dos
   palabras está acá y la otra no. Si están las dos, o ninguna, se respeta el
   orden en que lo escribieron: "Juan Máximo" queda "Juan Máximo".

   Están los de uso corriente en el plantel de pacientes del servicio. Si
   aparece uno que falta y sale al revés, se agrega acá y listo. */

const PA_PILA = new Set([
  // Masculinos
  "JUAN", "JOSE", "JOSÉ", "LUIS", "CARLOS", "JORGE", "MIGUEL", "ANGEL", "ÁNGEL",
  "MANUEL", "PEDRO", "PABLO", "RICARDO", "ROBERTO", "RAUL", "RAÚL", "OSCAR",
  "OSVALDO", "HECTOR", "HÉCTOR", "HUGO", "ALBERTO", "ADOLFO", "ANDRES", "ANDRÉS",
  "ANTONIO", "ARMANDO", "ARTURO", "DANIEL", "DAVID", "DIEGO", "DOMINGO", "EDUARDO",
  "ENRIQUE", "ERNESTO", "FEDERICO", "FELIX", "FÉLIX", "FERNANDO", "FRANCISCO",
  "GABRIEL", "GERARDO", "GUILLERMO", "GUSTAVO", "HORACIO", "IGNACIO", "JAVIER",
  "JULIO", "LEANDRO", "LEONARDO", "LORENZO", "LUCAS", "MARCELINO", "MARCELO",
  "MARCOS", "MARIANO", "MARIO", "MARTIN", "MARTÍN", "MATIAS", "MATÍAS", "MAURICIO",
  "MAXIMO", "MÁXIMO", "NESTOR", "NÉSTOR", "NICOLAS", "NICOLÁS", "NORBERTO",
  "OMAR", "PATRICIO", "RAMON", "RAMÓN", "RODOLFO", "RODRIGO", "RUBEN", "RUBÉN",
  "SANTIAGO", "SEBASTIAN", "SEBASTIÁN", "SERGIO", "TOMAS", "TOMÁS", "VICENTE",
  "VICTOR", "VÍCTOR", "WALTER", "ADRIAN", "ADRIÁN", "ALEJANDRO", "ALFREDO",
  "CRISTIAN", "DARIO", "DARÍO", "EMILIO", "ESTEBAN", "EZEQUIEL", "FABIAN", "FABIÁN",
  "GONZALO", "JOAQUIN", "JOAQUÍN", "LUCIANO", "MAXIMILIANO", "AGUSTIN", "AGUSTÍN",
  // Femeninos
  "MARIA", "MARÍA", "ANA", "CARMEN", "CRISTINA", "GRACIELA", "SUSANA", "SILVIA",
  "PATRICIA", "MONICA", "MÓNICA", "BEATRIZ", "LAURA", "MARTA", "NORMA", "ELENA",
  "ROSA", "TERESA", "ALICIA", "ANDREA", "CLAUDIA", "GABRIELA", "MARCELA",
  "VERONICA", "VERÓNICA", "ADRIANA", "SANDRA", "VIVIANA", "LILIANA", "MIRTA",
  "NELIDA", "NÉLIDA", "OLGA", "IRMA", "ELSA", "HILDA", "JULIA", "LUCIA", "LUCÍA",
  "FLORENCIA", "SOFIA", "SOFÍA", "VALERIA", "NATALIA", "NATALY", "CAROLINA",
  "CARLA", "KARINA", "PAULA", "LUISANA", "ROMINA", "YAMELA", "CECILIA", "DANIELA",
  "ESTELA", "INES", "INÉS", "IRENE", "ISABEL", "JOSEFA", "JUANA", "LIDIA", "LUISA",
  "MERCEDES", "NORA", "RAQUEL", "SARA", "STELLA", "VICTORIA", "AGUSTINA",
  "CAMILA", "MICAELA", "ROCIO", "ROCÍO", "SOLEDAD", "VANESA", "XIMENA",
]);

const esPila = (w) => PA_PILA.has((w || "").toUpperCase());

/* Decide el orden de "PALABRA PALABRA" cuando el pase no lo aclara con una
   coma. Devuelve el texto reordenado como "nombre apellido", o el mismo
   texto si no hay una razón clara para darlo vuelta. */

function paOrdenNombre(t) {
  const ws = t.split(/\s+/).filter(Boolean);
  if (ws.length < 2) return t;
  const pilas = ws.map(esPila);
  const cuantas = pilas.filter(Boolean).length;
  // Ninguna reconocida, o todas: no hay información para decidir. Se respeta
  // lo escrito, que es lo que pidió Gonzalo para los casos dudosos.
  if (cuantas === 0 || cuantas === ws.length) return t;

  // Los nombres de pila van juntos: o están todos al principio (ya está bien)
  // o todos al final (hay que darlo vuelta). Si están intercalados, es un
  // nombre raro y no se toca.
  const primera = pilas.indexOf(true), ultima = pilas.lastIndexOf(true);
  if (ultima - primera + 1 !== cuantas) return t;

  if (primera === 0) return t;                       // "Armando Fuentes": ya está

  // Sólo se da vuelta el caso de dos palabras: "FUENTES ARMANDO" → "Armando
  // Fuentes". Con tres o más no alcanza para decidir. "HASAN NICOLÁS DANIEL"
  // puede ser apellido Hasan con dos nombres, o dos apellidos con Daniel de
  // nombre; las dos lecturas son razonables y dar vuelta una a la fuerza
  // acierta la mitad de las veces. En la duda se respeta lo escrito, y si
  // está mal se corrige a mano desde "editar ficha".
  if (ws.length === 2 && ultima === ws.length - 1)
    return [ws[1], ws[0]].join(" ");
  return t;
}

function paNombre(raw) {
  let t = (raw || "").replace(/\s+/g, " ").trim();
  let edad = null, sexo = null;
  let m = t.match(/(\d{1,3})\s*(?:AÑOS?|Años?|años?)?\s*$/);
  if (m) { const e = +m[1]; if (e > 0 && e < 120) { edad = e; t = t.slice(0, m.index); } }
  t = t.replace(/[\s,.]+$/, "");
  m = t.match(/,\s*([FHM])\s*$/);
  if (m) { sexo = PA_SEXO[m[1]] || null; t = t.slice(0, m.index).replace(/[\s,.]+$/, ""); }
  let nombre;
  if (t.includes(",")) {
    const [ap, no] = t.split(/,(.+)/);
    // La coma dice "apellido, nombre" y casi siempre acierta. Pero hay pases
    // escritos "FUENTES ARMANDO, M, 77", donde la coma separaba el sexo y ya
    // se la comió el paso de arriba: lo que queda antes de la coma es el
    // nombre completo, no sólo el apellido. Si de ese lado hay un nombre de
    // pila reconocible, mandan las palabras y no la coma.
    nombre = no === undefined
      ? paTitulo(paOrdenNombre(ap.trim()))
      : `${paTitulo(no.trim())} ${paTitulo(ap.trim())}`;
  } else {
    // Sin coma no se sabe dónde termina el apellido. Se da vuelta sólo si una
    // de las palabras es un nombre de pila conocido y la otra no; si no, se
    // respeta el orden, porque invertir a ciegas convierte "Hasan Nicolás
    // Daniel" en "Daniel Hasan Nicolás".
    nombre = paTitulo(paOrdenNombre(t));
  }
  return { nombre: nombre.trim(), edad, sexo };
}

// Acentos que el pase escribe en mayúscula sin tilde y se pierden al bajar.

const PA_ACENTOS = {
  // Sumados el 2/9/2026 mirando un pase real: son los que quedaban sin tilde
  // a la vista en la pantalla.
  medico: "médico", medica: "médica", cardiaca: "cardíaca", cardiacas: "cardíacas",
  dilatacion: "dilatación", mejorara: "mejorará", asintomatico: "asintomático",
  asintomatica: "asintomática", somnolienta: "somnolienta", somnoliento: "somnoliento",
  taquipneica: "taquipneica",
  espirometria: "espirometría", ecocardiograma: "ecocardiograma", akinesia: "acinesia",
  aquinesia: "acinesia", hipoquinesia: "hipocinesia", hipokinesia: "hipocinesia",
  paralitico: "paralítico", paralitica: "paralítica", colectomia: "colectomía",
  debito: "débito",
  lucido: "lúcido", lucida: "lúcida", distension: "distensión", serohematico: "serohemático",
  cateter: "catéter", via: "vía", vias: "vías", dias: "días", ultima: "última", ultimo: "último",
  septico: "séptico", septica: "séptica", hipotension: "hipotensión", infeccion: "infección",
  internacion: "internación", evolucion: "evolución", reaccion: "reacción", cirugia: "cirugía",
  oxigeno: "oxígeno", clinico: "clínico", clinica: "clínica", cronico: "crónico", cronica: "crónica",
  toracico: "torácico", toracica: "torácica", gastrico: "gástrico", hepatico: "hepático",
  pulmon: "pulmón", cardiaco: "cardíaco", neurologico: "neurológico", antibiotico: "antibiótico",
  antibioticos: "antibióticos", sedacion: "sedación", intubacion: "intubación",
  extubacion: "extubación", traqueostomia: "traqueostomía", laparotomia: "laparotomía",
  coleccion: "colección", colecciones: "colecciones", perforacion: "perforación",
  fistula: "fístula", neumonia: "neumonía", transfusion: "transfusión", funcion: "función",
  presion: "presión", hemodinamico: "hemodinámico", organico: "orgánico",
  sintomas: "síntomas", subito: "súbito", subita: "súbita", hipoventilacion: "hipoventilación",
  liquido: "líquido", tonico: "tónico", clonicas: "clónicas", clonico: "clónico",
  analgesia: "analgesia", diuresis: "diuresis", peritonitis: "peritonitis",
  quirurgico: "quirúrgico", quirurgica: "quirúrgica", anemia: "anemia",
  hematico: "hemático", hematoma: "hematoma", craneo: "cráneo", torax: "tórax",
  abdomen: "abdomen", cefalea: "cefalea", vomitos: "vómitos", disnea: "disnea",
  astenia: "astenia", somnolencia: "somnolencia", fiebre: "fiebre",
  colonizacion: "colonización", aislamiento: "aislamiento", desaturacion: "desaturación",
  mecanica: "mecánica", ventilatoria: "ventilatoria", ultrasonido: "ultrasonido",
  gastroenterologia: "gastroenterología", nefrologia: "nefrología", oncologico: "oncológico",
  metastasis: "metástasis", diagnostico: "diagnóstico", pronostico: "pronóstico",
  terapeutico: "terapéutico", farmacologico: "farmacológico", isquemico: "isquémico",
  hemorragico: "hemorrágico", trombotico: "trombótico", embolico: "embólico",
  respiratorio: "respiratorio", renal: "renal", hepatica: "hepática",
  arteria: "arteria", venosa: "venosa", radiologia: "radiología", tomografia: "tomografía",
  // Las que ya vienen acentuadas EN MAYÚSCULA necesitan su entrada igual: al
  // bajarlas quedan con la tilde puesta ("Órdenes") y parecen nombre propio.
  "órdenes": "órdenes", ordenes: "órdenes", "última": "última", "último": "último",
  "lúcida": "lúcida", "lúcido": "lúcido", "hepático": "hepático", "ángulo": "ángulo",
  "cráneo": "cráneo", "tórax": "tórax", "vómitos": "vómitos", "síntomas": "síntomas",
  "mecánica": "mecánica", "línea": "línea", "días": "días", "día": "día",
};
// Palabras que SÍ se bajan a minúscula aunque sean cortas. Sin esto, "TC DE
// ABDOMEN Y PELVIS" queda como "TC DE abdomen Y pelvis": las siglas de 2-4
// letras se respetan por defecto (QX, TAP, HDE son vocabulario real), y eso
// mismo dejaba en mayúscula a los conectores. La regla no puede ser sólo el
// largo, hay que nombrarlos.

const PA_COMUNES = new Set(["SIN", "POR", "CON", "PARA", "DEL", "LOS", "LAS", "UNA", "UNO", "UNOS", "UNAS",
  "NO", "SI", "SE", "SU", "SUS", "AL", "EN", "MAS", "ANTE", "TRAS", "SOBRE", "HOY", "DIA", "DIAS",
  "FOCO", "DOLOR", "LEVE", "ALTA", "BAJA", "ESTA", "ESTE", "CADA", "TODO", "TODA",
  // "E" es la conjunción delante de palabra que empieza con i: "colectomía
  // derecha ampliada E ILEOSTOMÍA" es "…ampliada e ileostomía". Sin ella acá,
  // la letra suelta se tomaba por sigla y quedaba en mayúscula en medio de la
  // frase. Lo mismo "U" delante de o- ("doce U ocho").
  "DE", "Y", "E", "O", "U", "A", "EL", "LA", "LO", "UN", "ES", "HA", "HAY", "QUE", "COMO", "DESDE",
  // Palabras castellanas cortas que aparecen seguido en los informes y que,
  // por tener menos de cinco letras, quedaban gritando en mayúscula.
  "ALTO", "ALTA", "BAJO", "PASA", "PASO", "VAN", "VA", "SON", "ERA", "FUE", "TUVO",
  "MISMO", "MISMA", "OTRO", "OTRA", "OTROS", "OTRAS", "ANTES", "LUEGO", "FUGA",
  "HASTA", "ENTRE", "DURANTE", "SEGUN", "SOLO", "YA", "MUY", "BIEN", "MAL", "CUATRO",
  "TRES", "DOS", "CINCO", "SEIS", "NUEVA", "NUEVO", "MENOR", "MAYOR", "AMBOS", "AMBAS",
  "ANTERIOR", "POSTERIOR", "DERECHA", "DERECHO", "IZQUIERDA", "IZQUIERDO", "BILATERAL",
  // Palabras corrientes y unidades que quedaban gritando en el tratamiento:
  // "PESO 60 KG", "FURO 20 DIA". No son siglas, son palabras cortas.
  // "MG" no está acá a propósito: en laboratorio es el magnesio y debe quedar
  // como sigla. Cuando es la unidad viene pegada a un número y la regla de
  // unidades de PA_EXPANDIR ya la baja a "mg".
  "PESO", "KG", "ML", "DIA", "DIAS", "NOCHE", "HS", "GR", "MCG", "AMP", "GOTAS",
  "DIETA", "BLANDA", "AGUA", "LIBRE", "VIA", "ORAL", "TOTAL", "PARCIAL", "PLAN",
  "ALTA", "PASE", "CAMA", "SALA", "TURNO", "CONTROL", "SEGUIR", "IGUAL", "MISMO",
  "AYER", "MAÑANA", "TARDE", "SEMANA", "MES", "AÑO", "AÑOS", "VECES", "CADA",
  "AUTO", "MALA", "MALO", "BUENA", "BUENO", "ORDENES", "ÓRDENES", "ULTIMA", "ÚLTIMA",
  "NOCHE", "NOCTURNO", "NIEGA", "REFIERE", "PERSISTE", "CONTINUA", "SIGUE",
  "BILIOSO", "SEROSO", "SEROSOS", "SEROHEMATICO", "SEROHEMÁTICO", "PURULENTO",
  "CERV", "CERVICAL", "DISTENDIDO", "BLANDO", "DEPRESIBLE", "DOLOROSO",
  // Palabras castellanas que el pase escribe en mayúscula y no son siglas.
  // Sin esto el detector las marca como jerga desconocida y hace ruido.
  "LADO", "TOMA", "MASA", "MIDE", "HACE", "FOSA", "BASE", "NIVEL", "CURSO",
  "CAMBIOS", "AUMENTO", "MENOR", "MAYOR", "LIBRE", "MEDIA", "GUARDIA", "SALA",
  "NEGATIVO", "POSITIVO", "PERSISTE", "INICIA", "SUSP", "STOP", "VIAS", "VÍAS",
  "DERRAME", "PLEURAL", "HEMATOMA", "SUBDURAL", "PARIETAL", "FRONTO", "PARIETO",
  "INSULAR", "INFERIOR", "SUPERIOR", "ANTERIOR", "ESPESOR", "MULTIPLES",
  "MÚLTIPLES", "CONTEXTO", "PREVIO", "HACIA", "TURBIO", "SEDACIÓN", "SEDACION",
  "STATUS", "FIEBRE", "DOLOR", "EDEMA", "ASTA", "DIFUSA", "SIGNOS", "AUSENTE",
  "AUSENTES", "PRESENTE", "VITAL", "FUNCIONANTE", "CUBIERTAS", "GASAS"]);

// Abreviaturas de fármacos que se escriben cortas pero son nombres, no siglas:
// conviene verlas con inicial mayúscula y no en bloque. Se resuelven en
// PA_ACENTOS con su forma prolija.

const PA_DROGAS_CORTAS = {
  // Los ANTIBIÓTICOS ya no están acá: van siempre en mayúscula y abreviados
  // (MERO, VANCO, PTZ...), y de eso se ocupa PA_EXPANDIR. Si siguieran en
  // esta tabla se los expandiría a nombre largo en minúscula y las dos reglas
  // se pelearían. Acá quedan sólo las drogas que sí se escriben con nombre.
  furo: "Furosemida", dexa: "Dexametasona", lora: "Lorazepam",
  // "leve" NO va acá: en los informes de imágenes "LEVE AUMENTO", "LEVE
  // EDEMA" son el adjetivo castellano, y el diccionario, que mira palabra por
  // palabra sin contexto, los convertía en "Levetiracetam". En un renglón de
  // tratamiento eso es peligroso. Se resuelve en PA_EXPANDIR exigiendo que
  // atrás venga una dosis, que es como se escribe la droga de verdad.
  dipi: "Dipirona", para: "Paracetamol", keta: "Ketamina",
  nora: "Noradrenalina", biso: "Bisoprolol", diclo: "Diclofenac", hidro: "Hidrocortisona",
};

const PA_EXPANDIR = [
  [/\bHDE\b/gi, "hemodinámicamente estable"], [/\bHDI\b/gi, "hemodinámicamente inestable"],
  // "VE" tiene una variante por residente. Todas dicen lo mismo: si respira
  // solo y con cuánto oxígeno. Se unifican como "VE sin O₂" / "VE con O₂ a
  // N L/min", que es la forma corta que ya se lee de un vistazo.
  [/\bVE\s*S\/?\s*O\s*2\b/gi, "VE sin O₂"],
  [/\bVE\s+SIN\s+O\s*2\b/gi, "VE sin O₂"],
  [/\bVE\s+SIN\s+REQ\.?\s*(?:DE)?\s*O\s*2\b/gi, "VE sin O₂"],
  [/\bVE\s+O2A?\s*([\d.,]+)\s*L(?:TS?|\/M(?:IN)?)?\b/gi, "VE con O₂ a $1 L/min"],
  [/\bVE\s+([\d.,]+)\s*L(?:TS?|\/M(?:IN)?)?\b/gi, "VE con O₂ a $1 L/min"],
  [/\bEOT\b/gi, "extubación"],
  [/\bVVC\b/gi, "vía venosa central"], [/\bDVE\b/gi, "drenaje ventricular externo"],
  [/\bTAP\b/gi, "tubo pleural"], [/\bNET\b/gi, "nutrición enteral total"],
  [/\bNPT\b/gi, "nutrición parenteral total"], [/\bNE\b/gi, "nutrición enteral"],
  [/\bDICLO\b/gi, "diclofenac"], [/\bBISO\b/gi, "bisoprolol"], [/\bPRECEDEX\b/gi, "dexmedetomidina"],
  // LEVE es levetiracetam sólo si atrás viene una dosis ("LEVE 500 MG C/12",
  // "LEVE 1 GR"). "LEVE AUMENTO", "LEVE EDEMA" y demás quedan como el
  // adjetivo, que es lo que son en los informes de imágenes.
  [/\bLEVE\s+(?=\d)/gi, "Levetiracetam "],
  [/\bRHA\s*\+/gi, "ruidos hidroaéreos presentes"],
  [/\bRHA\b/gi, "ruidos hidroaéreos"], [/\bISQX\b/gi, "infección de sitio quirúrgico"],
  [/\bEPM\b/gi, "episodio psicomotriz"], [/\bVEDA\b/gi, "videoendoscopia digestiva alta"],
  [/\bVATS\b/gi, "cirugía toracoscópica videoasistida"],
  // "CBO" y el tipeo "CBRO" son los dos cerebro; "RESO" es resonancia.
  [/\bCBRO\b/gi, "cerebro"], [/\bCBO\b/gi, "cerebro"], [/\bRESO\b/gi, "resonancia"],
  // Unidades pegadas al número: "120MG" → "120 mg", "20ML" → "20 ml".
  // "MG" pegado al número es miligramos ("1000MG"); separado y seguido de otro
  // número es el magnesio del laboratorio ("PLQ 85 MG 1.8"), que se deja como
  // sigla. Sin esta distinción el analito se convertía en unidad.
  [/(\d)MG\b/gi, "$1 mg"],
  [/(\d)\s+MG\b(?!\s*[\d.,])/gi, "$1 mg"],
  [/(\d)\s*ML\b/gi, "$1 ml"], [/(\d)\s*KG\b/gi, "$1 kg"],
  [/(\d)\s*MCG\b/gi, "$1 mcg"], [/(\d)\s*GRS?\b/gi, "$1 g"],
  // "FURO 20 DIA" quiere decir 20 por día, no "20 día".
  [/(\d)\s+D[IÍ]A\b/gi, "$1 por día"],
  [/\bDIA\b/g, "día"], [/\bdia\b/g, "día"], [/\bDIAS\b/g, "días"], [/\bdias\b/g, "días"],
  // ── Examen físico y estado, según los patrones del pase ──────────────────
  // Estas salen de mirar los 25 pases: son las formas que realmente se usan.
  // La idea no es traducir palabra por palabra sino que la frase se lea como
  // una oración ("abdomen doloroso a la palpación profunda").
  [/\bABD\b/gi, "abdomen"], [/\bABDI\b/gi, "abdomen"],
  [/\bA\s+PALP\.?\s+PROFUNDA\b/gi, "a la palpación profunda"],
  [/\bPALP\b\.?/gi, "palpación"],
  [/\bMMII\b/gi, "miembros inferiores"], [/\bMMSS\b/gi, "miembros superiores"],
  [/\bFII\b/gi, "fosa ilíaca izquierda"], [/\bFID\b/gi, "fosa ilíaca derecha"],
  [/\bHD\b(?!E)/gi, "hipocondrio derecho"], [/\bHI\b/gi, "hipocondrio izquierdo"],
  [/\bDER\b\.?/gi, "derecha"], [/\bIZQ\b\.?/gi, "izquierda"],
  [/\bSNG\b/gi, "sonda nasogástrica"], [/\bSV\b/gi, "sonda vesical"],
  [/\bTAP\b/gi, "tubo pleural"], [/\bVAC\b/gi, "sistema VAC"],
  [/\bAT\b/gi, "aspirado traqueal"],
  // "2 DJES" son dos drenajes, no "2 drenaje": el plural se respeta.
  [/\b(\d+)\s+DJE?S\b/gi, "$1 drenajes"], [/\bDJES\b/gi, "drenajes"],
  [/\bDJE\b/gi, "drenaje"], [/\bDJP\b/gi, "drenaje"], [/\bDREN\b/gi, "drenaje"],
  // "ABDI RHA AUSENTES" es abdomen CON ruidos ausentes.
  [/\bABDI?\s+(?=RHA|RUIDOS)/gi, "abdomen con "],
  [/\bS\/\s*P\b/gi, "sin particularidades"],
  [/\bAFEBRIL\b/gi, "afebril"], [/\bSUBFEBRIL\b/gi, "subfebril"],
  [/\bESCARA\b/gi, "escara"],
  // Antihipertensivos y demás que el pase abrevia. Confirmadas con Gonzalo.
  [/\bDOXA\b/gi, "doxazosina"], [/\bAMLO\b/gi, "amlodipina"],
  [/\bNXB\b/gi, "nada por boca"], [/\bNPO\b/gi, "nada por boca"],
  // "HASAT RODILLAS" es "hasta las rodillas": un tipeo, no una sigla.
  [/\bHASAT\b/gi, "hasta"],
  // "Carvedilol 12.5/12" = 12,5 mg cada 12 h. El patrón dosis/intervalo es
  // constante en el pase, así que se escribe como se lee en voz alta.
  // "Carvedilol 12.5/12" = 12,5 mg cada 12 h. PERO sólo si la palabra de
  // adelante es un fármaco de verdad: sin esa condición, "TAC TX/abdomen
  // 22/8" —que es una fecha— salía como "abdomen 22 mg cada 8 h", o sea una
  // dosis inventada dentro de un informe de imágenes. Es el peor tipo de
  // error que puede cometer esta app, así que la lista manda y lo que no está
  // en ella se deja como vino.
  // "Carvedilol 12.5/12" = 12,5 mg cada 12 h. Distinguir esto de una fecha es
  // delicado y se equivocó en las dos direcciones antes de quedar así:
  //
  //   · Sin pedir que sea un fármaco, "TAC TX/abdomen 22/8" salía como
  //     "abdomen 22 mg cada 8 h": una dosis inventada dentro de un informe de
  //     imágenes, que es el peor error posible acá.
  //   · Pidiendo sólo que sea un fármaco, "25/8 FEP/METRO/FLUCO 26/8 VANCO"
  //     convertía en dosis el 26/8, que es el día en que se agregó la
  //     vancomicina.
  //
  // Lo que separa los dos casos es el segundo número. Como intervalo sólo
  // valen 4, 6, 8, 12 y 24 horas; como mes vale cualquier cosa de 1 a 12. El
  // solapamiento real es 4, 6, 8 y 12, así que ahí manda una segunda pista:
  // si adelante hay una fecha suelta —el patrón "25/8 ATB 26/8 ATB"— todo el
  // renglón está fechado y el par es una fecha más. Cuando no hay ninguna
  // fecha en el renglón, es una dosis.
  [/\b([A-Za-zÁÉÍÓÚÑáéíóúñ]{4,})\s+([\d.,]+)\s*\/\s*(4|6|8|12|24)\b(?!\s*\/)/g,
    function (m, palabra, dosis, cada, off, todo) {
      const p = palabra.toUpperCase();
      const esDroga = PA_FARMACOS.has(p) || PA_DROGAS_CORTAS[palabra.toLowerCase()] ||
        /(CILINA|MICINA|AZOL|PENEM|PRAZOL|OLOL|PINA|PAMO|SARTAN|DIPINA|FLOXACINA|CICLINA|TIDINA|ZEPAM|SETRON|DONA|FENAC|AMOL|EPINA|IRINA|ARINA|OXINA|TOINA|MIDA|ACETAM)$/.test(p);
      if (!esDroga) return m;
      // ¿Hay una fecha escrita antes, en este mismo renglón? Se mira sólo
      // hacia atrás desde acá hasta el salto de línea anterior.
      const desde = todo.lastIndexOf("\n", off) + 1;
      const antes = todo.slice(desde, off);
      const hayFecha = /(?:^|\s)(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])(?:\/\d{2,4})?(?=\s)/.test(antes);
      const entero = !/[.,]/.test(dosis) && +dosis >= 1 && +dosis <= 31;
      if (hayFecha && entero) return m;      // "25/8 FLUCO 26/8 VANCO"
      return `${palabra} ${dosis} mg cada ${cada} h`;
    }],
  [/\bC\/\s*(4|6|8|12|24)\s*(?:HS?)?\b/gi, "cada $1 h"],
  // El balance del día al final del renglón, en palabras.
  [/,\s*(\d{2,4})\s*-\s*(\d{2,4})\s*$/gm, ". Ingresos $1 ml, diuresis $2 ml"],
  // ── Sacadas del contexto de los propios pases (barrido de las 25 camas) ──
  // Antibióticos y microbiología: aparecen siempre dentro de listas de ATB o
  // de cultivos, así que el contexto no deja lugar a dudas.
  // ── Antibióticos: SIEMPRE en mayúscula y abreviados ─────────────────────
  // Regla de Gonzalo del 2/9/2026. En un pase los ATB son lo que uno busca
  // primero, y en mayúscula saltan a la vista dentro de un renglón de texto
  // corrido. Además la forma corta es la que se usa hablando, así que el
  // papel y la conversación coinciden.
  //
  // Van todos a la MISMA forma vengan como vengan: "meropenem", "MERO" y
  // "Meropenem" terminan los tres en MERO.
  [/\b(?:TIGECICLINA|TIGE)\b/gi, "TIGE"],
  [/\b(?:CEFTRIAXONA|CRO)\b/gi, "CRO"],
  [/\b(?:CEFTAZIDIMA[\s-]*AVIBACTAM|CAZ\s*\/\s*AVI|CEFTA\s+AVI)\b/gi, "CAZ/AVI"],
  [/\b(?:CEFEPIME|FEP)\b/gi, "FEP"],
  [/\b(?:DAPTOMICINA|DAPTO)\b/gi, "DAPTO"],
  [/\b(?:METRONIDAZOL|METRO)\b/gi, "METRO"],
  [/\b(?:ANIDULAFUNGINA|ANIDULA)\b/gi, "ANIDULA"],
  [/\b(?:LEVOFLOXACINA|LEVO)\b/gi, "LEVO"],
  [/\b(?:MEROPENEM|MERO)\b/gi, "MERO"],
  [/\b(?:VANCOMICINA|VANCO)\b/gi, "VANCO"],
  [/\b(?:PIPERACILINA[\s-]*TAZOBACTAM|PIPE[\s-]*TAZO|PTZ)\b/gi, "PTZ"],
  [/\b(?:COLISTINA|COLI|COL)\b/gi, "COLI"],
  [/\b(?:AMPICILINA[\s-]*SULBACTAM|AMS)\b/gi, "AMS"],
  [/\b(?:CLARITROMICINA|CLARITRO)\b/gi, "CLARITRO"],
  [/\b(?:FLUCONAZOL|FLUCO)\b/gi, "FLUCO"],
  [/\b(?:ACICLOVIR|ACICLO)\b/gi, "ACICLO"],
  [/\b(?:ANFOTERICINA|ANFO)\b/gi, "ANFO"],
  [/\b(?:CIPROFLOXACINA|CIPRO)\b/gi, "CIPRO"],
  [/\b(?:AMIKACINA|AMIKA)\b/gi, "AMIKA"],
  [/\b(?:GENTAMICINA|GENTA)\b/gi, "GENTA"],
  [/\b(?:LINEZOLID|LINE)\b/gi, "LINEZOLID"],
  [/\b(?:CASPOFUNGINA|CASPO)\b/gi, "CASPO"],
  [/\b(?:TRIMETOPRIMA[\s-]*SULFAMETOXAZOL|TMS|TMP[\s-]*SMX)\b/gi, "TMS"],
  [/\b(?:CEFTAZIDIMA|CAZ)\b/gi, "CAZ"],
  [/\b(?:CEFTAROLINA|CEFTARO)\b/gi, "CEFTARO"],
  [/\b(?:MINOCICLINA|MINO)\b/gi, "MINO"],
  [/\b(?:RIFAMPICINA|RIFA)\b/gi, "RIFA"],
  [/\bCGP\b/gi, "cocos gram positivos"], [/\bBGN\b/gi, "bacilos gram negativos"],
  [/\bEVR\b/gi, "enterococo vancomicina resistente"],
  [/\bTCD\b/gi, "toxina de Clostridioides difficile"],
  // Estudios y antecedentes.
  [/\bEFR\b/gi, "espirometría"], [/\bCRM\b/gi, "cirugía de revascularización miocárdica"],
  [/\bDLP\b/gi, "dislipemia"], [/\bACO\b/gi, "anticoagulación"],
  [/\bFQ\b/gi, "fisicoquímico"], [/\bDIFU\b/gi, "difusión"],
  // "ASCITIS GII" es grado II; el recuento del líquido usa RTO y MONO.
  [/\bG(I{1,3}|IV)\b/g, (m, r) => "grado " + r],
  [/\bRTO\b/gi, "recuento"], [/\bMONO\b/gi, "mononucleares"],
  [/\bRMN\b/gi, "resonancia"], [/\bRXTX\b/gi, "radiografía de tórax"],
  [/\bITU\b/gi, "infección urinaria"], [/\bKPN\b/gi, "Klebsiella pneumoniae"],
  [/\bFBC\b/gi, "fibrobroncoscopía"], [/\bHPB\b/gi, "hiperplasia prostática benigna"],
  [/\bACM\b/gi, "arteria cerebral media"], [/\bDTC\b/gi, "doppler transcraneal"],
  [/\bDM\b/gi, "diabetes mellitus"], [/\bVO\b/gi, "vía oral"],
  // ── Ambiguas: se resuelven por contexto, nunca a ciegas ──────────────────
  // NIR va siempre pegado a diabetes; DOB es daño de órgano blanco.
  [/\bNIR\b/gi, "no insulinorrequiriente"], [/\bDOB\b/g, "daño de órgano blanco"],
  [/\bRZO\b/gi, "realizó"],
  // ISQX es siempre infección de sitio quirúrgico. ISQ a secas depende: con
  // ACV o con un miembro es isquémico/isquemia; sólo se expande cuando el
  // contexto lo dice, y si no queda como está.
  [/\bISQX\b/gi, "infección de sitio quirúrgico"],
  [/\bACV\s+ISQ\b/gi, "ACV isquémico"],
  [/\bISQ\s+(MMII|MII|MSI|MSD|MID)\b/gi, "isquemia de $1"],
  // AA con cirugía o laparotomía es abdomen agudo; con infrarrenal o aorta es
  // aneurisma. Sin ninguna de las dos pistas, se deja sin tocar.
  [/\bAA\s+(QX|LAP|PERFORATIVO|OBSTRUCTIVO)\b/gi, "abdomen agudo $1"],
  [/\bAA\s+(INFRARENAL|INFRARRENAL|AORT[AI]CO|DE\s+AORTA)\b/gi, "aneurisma $1"],
  // Tipeos que se repiten en el pase. Se corrigen porque leer "incian" o
  // "cvoid" hace dudar de todo el renglón.
  [/\bINCIAN\b/gi, "inician"], [/\bCVOID\b/gi, "COVID"], [/\bCOVID\b/gi, "COVID"],
  [/\bINSUF\.?\s+RESP\b/gi, "insuficiencia respiratoria"],
  [/\bINSUF\.?\s+CARD[IÍ]ACA\b/gi, "insuficiencia cardíaca"],
  [/\bASINTOMAT\.?\b/gi, "asintomática"],
  [/\bOSELTA\b/gi, "OSELTA"],   // antiviral: va con los ATB, en mayúscula
  [/\bPEND\b/gi, "pendiente"], [/\bCIR\b/gi, "catéter peridural"], [/\bTFG\b/gi, "filtrado glomerular"],
  // ── Sumadas el 2/9/2026 ──────────────────────────────────────────────────
  // Normalizaciones de laboratorio: el pase escribe la misma cosa de tres
  // maneras según quién la anota. Se unifican a la forma que usa el servicio.
  // Ojo: acá NO se expanden a la palabra completa, se corrige la sigla, que
  // es como se lee mejor en una lista de valores.
  [/\bHGB\b/g, "Hb"], [/\bHB\b/g, "Hb"], [/\bHEMOGLOBINA\b/gi, "Hb"],
  [/\bPLT\b/g, "PLQ"], [/\bPLAQ\b/g, "PLQ"], [/\bPLAQUETAS\b/gi, "PLQ"],
  // MG en laboratorio es magnesio y se deja MG. Pero "20MG" ya se convirtió
  // en "20 mg" más arriba, así que lo que queda suelto es el analito.
  // Términos de cirugía y abdomen confirmados con Gonzalo.
  [/\bSOI\b/gi, "suboclusión intestinal"],
  [/\bBHN\b/gi, "balance hídrico negativo"],
  [/\bBHP\b/gi, "balance hídrico positivo"],
  [/\bASAS\b/gi, "asas"],
  // LAP es laparoscopía sola, o laparoscópico cuando adjetiva a la cirugía.
  [/\b(COLECISTECTOM[IÍ]A|APENDICECTOM[IÍ]A|GASTRECTOM[IÍ]A|CIRUG[IÍ]A)\s+LAP\b/gi, "$1 laparoscópica"],
  [/\bLAP\s+(EXPLORADORA|DIAGN[OÓ]STICA)\b/gi, "laparoscopía $1"],
  [/\bLAP\b/gi, "laparoscopía"],
  // ILEO depende del contexto: solo se toca cuando el propio renglón lo
  // aclara. "ILEOCOLICO", "ILEOSTOMIA" y demás no se rompen porque el \b
  // exige que la palabra termine ahí.
  //
  // Cuando es el cuadro clínico va en minúscula, porque es una palabra
  // castellana y no una sigla: "íleo funcional", "íleo paralítico". ILEO en
  // mayúscula queda sólo cuando abrevia ILEOSTOMÍA, que sí es una sigla.
  [/\b[IÍ]LEO\s+(PARAL[IÍ]TICO|FUNCIONAL|OBSTRUCTIVO|MEC[AÁ]NICO|ADIN[AÁ]MICO|POSTOPERATORIO|POSTQUIR[UÚ]RGICO|PROLONGADO|PERSISTENTE)\b/gi,
    (m, tipo) => "íleo " + tipo.toLowerCase()],
  [/\bILEOSTOM[IÍ]A\b/gi, "ileostomía"],
  // CTE es contraste cuando habla una tomografía; si no, se deja.
  [/\b(TC|TAC|RMN|RESONANCIA|TOMOGRAF[IÍ]A)\s*(C\/|CON\s+|S\/|SIN\s+)?CTE\b/gi,
    (m, est, prep) => `${est} ${prep ? prep.replace(/^C\/$/i, "con ").replace(/^S\/$/i, "sin ") : ""}contraste`.replace(/\s+/g, " ")],
  [/\bC\/\s*CTE\b/gi, "con contraste"], [/\bS\/\s*CTE\b/gi, "sin contraste"],
  // ── CM: centímetros o Clínica Médica ─────────────────────────────────────
  // Pegado a un número es la unidad ("mide 3 CM" → "3 cm"). Si no hay número,
  // en este servicio es el otro servicio: el paciente que viene de sala, o al
  // que se le pide interconsulta. Se escriben distinto a propósito para que
  // no haya que adivinar leyendo.
  [/(\d)\s*CM\b/gi, "$1 cm"],
  [/\b(A|DE|POR|CON|PARA|IC|INTERCONSULTA|PASA|PASE|DERIVA|DERIVADO|CAMA)\s+CM\b/gi,
    (m, prev) => `${prev} clínica médica`],
  [/\bCM\s+(EVAL[UÚ]A|EVALUA|VE|SIGUE|CONTROLA|INTERNA|INDICA|SUGIERE)\b/gi,
    (m, verbo) => `Clínica médica ${verbo.toLowerCase()}`],

  // ── Cultivos: forma canónica de las siglas ───────────────────────────────
  // Hemocultivos y material quirúrgico se escriben de seis maneras distintas
  // según quién anota. Se llevan todas a la misma: HCx2 con la equis chica,
  // MatQx con las mayúsculas donde van. Es la forma que usa el servicio y la
  // que hace que dos renglones del mismo germen se vean iguales.
  [/\bH(?:C|MC)\s*[xX×]\s*(\d)\b/g, "HCx$1"],
  [/\bHEMOCULTIVOS?\s*(?:X|POR)?\s*(\d)\b/gi, "HCx$1"],
  [/\bHEMOCULTIVOS?\b/gi, "HC"],
  [/\bMAT\s*\/?\s*QX\b/gi, "MatQx"],
  [/\bMATERIAL\s+QUIR[UÚ]RGICO\b/gi, "MatQx"],

  // ── Accesos: qué vena y de qué lado ──────────────────────────────────────
  // YD/YI/FD/FI dicen dónde está el catéter. Se expanden sólo cuando el
  // renglón habla de un acceso; sueltas no se tocan, porque FI también es
  // "fecha de inicio" y convertirla en "femoral izquierda" sería inventar un
  // catéter que nadie puso.
  [/\b(VVC|CVC|V[IÍ]A\s+VENOSA\s+CENTRAL|CAT[EÉ]TER|PICC|ACCESO|VVP)\s+YD\b/gi, "$1 yugular derecha"],
  [/\b(VVC|CVC|V[IÍ]A\s+VENOSA\s+CENTRAL|CAT[EÉ]TER|PICC|ACCESO|VVP)\s+YI\b/gi, "$1 yugular izquierda"],
  [/\b(VVC|CVC|V[IÍ]A\s+VENOSA\s+CENTRAL|CAT[EÉ]TER|PICC|ACCESO|VVP)\s+FD\b/gi, "$1 femoral derecha"],
  [/\b(VVC|CVC|V[IÍ]A\s+VENOSA\s+CENTRAL|CAT[EÉ]TER|PICC|ACCESO|VVP)\s+FI\b/gi, "$1 femoral izquierda"],

  // RNM y RMN son la misma resonancia; el servicio la escribe RMN. La "x" de
  // "DIFU X RNM" es la preposición "por", no una multiplicación.
  [/\bDIFU(?:SI[ÓO]N)?\s*[xX×]\s*RN?MN?\b/g, "difusión por RMN"],
  [/\bRNM\b/g, "RMN"],
  [/\b([A-Za-zÁÉÍÓÚÑáéíóúñ]{3,})\s+[xX×]\s+(RMN|TC|TAC|ECO|EEG)\b/g, "$1 por $2"],

  // MM pegado a un número es milímetros; suelto puede ser otra cosa y no se toca.
  [/(\d)\s*MM\b/g, "$1 mm"],
];

// ── Detector de abreviaturas que la app todavía no entiende ────────────────
//
// El pase suma jerga nueva todo el tiempo y hasta ahora la cazábamos de a una,
// leyendo pases a mano. Esto la junta sola: una sigla que sobrevive a
// paLimpiar() —queda en mayúscula, no está en ningún diccionario y no es un
// laboratorio ni una unidad— es candidata a que alguien la explique.
//
// A propósito NO adivina el significado: sólo señala. Inventar una expansión
// plausible en un pase de terapia es peor que dejar la sigla cruda.

const PA_MUESTRAS = [
  [/^HMC\s*X\s*(\d)/i, (m) => `HMCx${m[1]}`], [/^HMC\b/i, () => "HMC"],
  [/^HC\s*X\s*(\d)/i, (m) => `HCx${m[1]}`],
  [/^H\s*X\s*(\d)/i, (m) => `HCx${m[1]}`], [/^HC\b/i, () => "HC"],
  [/^UC\b/i, () => "UC"], [/^RC\b/i, () => "RC"], [/^AT\b/i, () => "AT"],
  [/^MAT\s*\/?\s*QX\b/i, () => "Mat Qx"], [/^MATQX\b/i, () => "Mat Qx"],
  [/^LCR\b/i, () => "LCR"], [/^COPRO\b/i, () => "Copro"],
  [/^MPX\b/i, () => "MPX"], [/^TCD\b/i, () => "TCD"],
  [/^PC\b/i, () => "PC"], [/^MINIBAL\b/i, () => "Minibal"], [/^BAL\b/i, () => "BAL"],
];

// ── Reordenar lo clínico según QUÉ es, no dónde lo escribieron ────────────
//
// En el Drive los cuatro campos de resultados —laboratorio, EAB, cultivos y
// estudios— se usan como cajones sueltos: lo que se escribe primero cae donde
// haya lugar. En la cama 1.3 del 31/8, el campo "cultivos" tenía adentro tres
// EEG, una resonancia y el laboratorio completo; y el campo "estudios" tenía
// los cultivos. Leído así, para saber si creció algo hay que barrer los cuatro
// campos, que es justo lo que uno no quiere hacer a las tres de la mañana.
//
// Esto reparte cada renglón según lo que dice, no según dónde estaba. Un EEG
// va a estudios aunque lo hayan escrito en cultivos; un hemocultivo va a
// cultivos aunque esté en estudios; una tira de GB/HB/PLAQ va a laboratorio.
//
// Criterio conservador a propósito: lo que NO se puede clasificar con certeza
// se queda donde estaba. Mover mal un dato es peor que dejarlo en un cajón
// raro — al menos ahí el residente sabe buscarlo.

const PA_ES_ESTUDIO = /\b(EEG|RNM|RMN|RESONANCIA|TAC|TC|TCTX|RX|RXTX|RADIOGRAF|ECO|ECOCARDIO|DOPPLER|ANGIO|DIFU|DIFUSI[ÓO]N|VEDA|ENDOSCOPIA|CENTELLO|PET|TOMOGRAF|ESPIROMETR|FIBROBRONCO|FBC|ANGIOTC|ANGIOTAC|DTC|ETE|ETT|ECODOPPLER|FIBRO\s*BRONCO|RM\b|MINIMENTAL|POLISOMNO)\b/i;

const PA_ES_CULTIVO = /\b(HMC|HC|HX\d|HCX\d|HMCX\d|UC|RC|AT|MAT\s*\/?\s*QX|MATQX|MPX|TCD|COPRO|MINIBAL|BAL|HISOPADO|PUNTA|RETRO|MICOL[ÓO]GICO|BACTERIOL[ÓO]GICO|CRIPTOCOCO|GDH)\b/i;

const PA_ES_GERMEN = /\b(SAMS|SAMR|SAMR?S|KPC|KPN|BGN|CGP|EVR|BLEE|E\.?\s*COLI|KLEBSIELLA|STREPTO|STAPH|S\.\s*EPIDERMIDIS|ENTEROCOCO|E\.?\s*FAECIUM|CANDIDA|SERRATIA|PSEUDOMONA|ACINETOBACTER|BACTEROIDES|ENTEROBACTER|CLOACAE|MET[AI]P?NEUMO|MTP|ANGINOSUS|CONSTELLATUS|PARAPSILOSIS|KRUSEI|GLABRATA|CAPITIS|LENTUS|MARCENSES|MICROCOCUSS?|OXYTOCA|PNEUMONIA[E]?)\b/i;
// El fisicoquímico del líquido cefalorraquídeo: es el resultado de una punción,
// no un cultivo ni una tira de sangre. Sin esta regla el mismo LCR cae en
// laboratorio o en estudios según cuántos valores le hayan escrito ese día.

const PA_ES_LCR_FQ = /\bLCR\b[\s\S]{0,40}?(TURBIO|L[ÍI]MPIDO|INCOLORO|LEUCOS?|GLUCORRAQUIA|PROTEINORRAQUIA|MONONUCLEAR|PMN)/i;
// Una tira de laboratorio: tres o más analitos con su número.

const PA_ANALITOS = /\b(GB|HB|HTO?|PLAQ|TP|APTT|RIN|NA|K|CL|UREA|CREA|CA|P|MG|GOT|TGO|TGP|FAL|BT|BILI|ALB|PROT|LDH|AMILASA|TAG|TG|GLU|LEUCOS|PMN|LAC)\s*[<>]?\s*\d/gi;
// El EAB se escribe como una tira de barras que arranca con un pH: 7.40/34.5/…

const PA_ES_EAB = /(^|\s)7[.,]\d{2}\s*\/\s*\d/;

function paQueEs(txt) {
  const t = (txt || "").trim();
  if (!t) return null;
  if (/^LABORATORIO\b/i.test(t)) return "labo";
  if (PA_ES_EAB.test(t) || /^EAB\b/i.test(t)) return "eab";
  // El orden importa: "25/08 HMC X2, UC, cultivos LCR: pendiente" tiene
  // siglas de cultivo Y la palabra LCR; manda el cultivo.
  if (PA_ES_CULTIVO.test(t) || PA_ES_GERMEN.test(t)) return "cultivos";
  if (PA_ES_LCR_FQ.test(t)) return "estudios";
  if (PA_ES_ESTUDIO.test(t)) return "estudios";
  const analitos = (t.match(PA_ANALITOS) || []).length;
  if (analitos >= 3) return "labo";
  return null;   // no se sabe: se queda donde estaba
}

// Parte un campo en trozos con fecha, igual que los cultivos: una fecha nueva
// arranca un dato nuevo, y el que viene sin fecha hereda la anterior.

function paTrozos(txt) {
  const FECHA = /((?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])(?:\/\d{2,4})?)/;
  const out = [];
  let ultima = "";
  for (const bloque of (txt || "").split(/\s*\/\/\s*|\n/)) {
    const re = new RegExp(FECHA.source + "(?=\\s)", "g");
    const cortes = [];
    let m;
    while ((m = re.exec(bloque))) if (m.index > 0) cortes.push(m.index);
    let ant = 0;
    for (const c of [...cortes, bloque.length]) {
      const t = bloque.slice(ant, c).trim();
      ant = c;
      if (!t) continue;
      const mf = t.match(new RegExp("^" + FECHA.source));
      if (mf) ultima = mf[1];
      out.push({ fecha: mf ? mf[1] : ultima, texto: mf ? t.slice(mf[0].length).replace(/^\s*[:\-]?\s*/, "") : t });
    }
  }
  return out;
}

function paReordenarClinicos(campos) {
  const CAJONES = ["labo", "eab", "cultivos", "estudios"];
  if (!CAJONES.some((k) => campos[k])) return campos;

  const nuevos = { labo: [], eab: [], cultivos: [], estudios: [] };
  let movidos = 0;

  for (const origen of CAJONES) {
    if (!campos[origen]) continue;
    for (const tr of paTrozos(campos[origen])) {
      const destino = paQueEs(tr.texto) || origen;
      if (destino !== origen) movidos++;
      // La etiqueta "LABORATORIO" sobra una vez que está en su propio campo.
      const limpio = tr.texto.replace(/^LABORATORIO\s*[:\-]?\s*/i, "").replace(/^[\s,;:]+/, "").trim();
      if (limpio) nuevos[destino].push((tr.fecha ? tr.fecha + " " : "") + limpio);
    }
  }

  if (!movidos) return campos;   // ya estaba todo en su lugar
  const salida = { ...campos };
  for (const k of CAJONES) {
    // El mismo dato suele estar escrito en dos campos ("25/08 HMC X2" aparece
    // en cultivos y en estudios). Al juntarlos quedaría dos veces, así que se
    // deja uno: se compara sin mayúsculas ni puntuación para que "HMC X2" y
    // "HMCX2:" cuenten como el mismo renglón.
    const vistos = new Set();
    const unicos = nuevos[k].filter((linea) => {
      const clave = linea.toUpperCase().replace(/[^A-Z0-9ÁÉÍÓÚÑ]/g, "");
      if (vistos.has(clave)) return false;
      vistos.add(clave);
      return true;
    });
    const v = unicos.join("\n");
    if (v) salida[k] = v; else delete salida[k];
  }
  return salida;
}

/* ── Formato de laboratorios, estudios y cultivos ─────────────────────────
   Regla que fijó Gonzalo el 2/9/2026: cada renglón de estas tres secciones se
   escribe *fecha estudio resultado. El asterisco adelante y la fecha después,
   siempre en ese orden.

   Lo que llega del Drive tiene todas las variantes: la fecha adelante sin
   asterisco, el asterisco pegado a la fecha, la fecha con dos puntos, o el
   asterisco puesto a mitad del renglón. Esto las lleva a todas a la misma
   forma, sin inventar una fecha donde no la hay: un renglón sin fecha se deja
   como está, porque poner la de hoy sería afirmar algo que nadie escribió. */

function paFormatoAsterisco(txt) {
  if (!txt) return txt;
  const FECHA = /(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])(?:\/\d{2,4})?/;
  const salida = [];
  for (const linea of txt.split("\n")) {
    let l = linea.trim();
    if (!l) { salida.push(l); continue; }
    // Los cultivos ya salen de paCultivos con su propio encabezado «fecha:».
    // Ese formato es el que se acordó para esa sección y no se pisa acá.
    if (l.startsWith("«")) { salida.push(l); continue; }
    // Se sacan los asteriscos que haya en cualquier lado y se vuelve a poner
    // uno solo adelante, para no acumular "**" al pasar dos veces.
    l = l.replace(/\*+/g, " ").replace(/\s*\/\/\s*/g, " ").replace(/\s{2,}/g, " ").trim();

    // Un estudio por renglón. En el Drive tres tomografías de tres días
    // distintas suelen venir pegadas en un párrafo: la fecha de la segunda
    // queda enterrada a mitad de la oración y no se ve al pasar la vista.
    // Se corta en cada fecha que arranca un estudio nuevo.
    //
    // Sólo cortan las fechas que están al principio de una oración — después
    // de un punto, o al empezar el renglón. Una fecha en el medio de una
    // frase ("previo del 24/8") es parte del texto, no un estudio nuevo, y
    // cortar ahí partiría la oración al medio.
    const re = new RegExp("(?:(?<=[.;])\\s+|^)(" + FECHA.source + ")(?=[\\s:,\\-])", "g");
    const cortes = [];
    let m;
    while ((m = re.exec(l))) cortes.push(m.index + m[0].length - m[1].length);
    const trozos = [];
    for (let i = 0; i < cortes.length; i++) {
      if (i === 0 && cortes[0] > 0) trozos.push(l.slice(0, cortes[0]));
      trozos.push(l.slice(cortes[i], cortes[i + 1] ?? l.length));
    }
    if (!trozos.length) trozos.push(l);

    for (const tr of trozos) {
      const t = tr.trim().replace(/[.;,\s]+$/, (x) => (x.includes(".") ? "." : ""));
      if (!t) continue;
      const mf = t.match(new RegExp("^(" + FECHA.source + ")\\s*[:\\-]?\\s*([\\s\\S]*)$"));
      if (!mf) { salida.push(t); continue; }  // sin fecha adelante: no se toca
      const resto = mf[2].trim();
      salida.push(resto ? `*${mf[1]} ${resto}` : `*${mf[1]}`);
    }
  }
  return salida.join("\n");
}

function paCultivos(txt) {
  if (!txt) return txt;
  // Una fecha de verdad: día 1-31 y mes 1-12. Sin esto, "RC 2/2" (dos frascos
  // de dos) se lee como fecha y parte la muestra al medio.
  const FECHA = /((?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])(?:\/\d{2,4})?)/;
  // Distinguir una fecha de un recuento de frascos ("RC 2/2", "HMC 6/7") es el
  // punto delicado, porque "2/2" también es 2 de febrero. Cortar por fecha y
  // después mirar qué había antes no sirve: para cuando se corta, la sigla ya
  // quedó del otro lado. Así que primero se BLINDAN los recuentos —toda
  // "SIGLA n/m" se reemplaza por un marcador— y recién después se corta por
  // fecha. Al final se restauran.
  const blindados = [];
  // Sólo cuenta como recuento de frascos si el denominador es chico (≤9) y el
  // numerador no lo supera: "RC 2/2" y "HMC 1/2" sí, "HMC 28/07" no —eso es
  // una fecha, y convertirla en "28 de 07" arruina el renglón.
  let t0 = txt.replace(/\b(HMC|HC|H|RC|UC|AT|HX\d|HCX\d|HMCX\d)\s+(\d{1,2})\s*\/\s*(\d)\b(?!\/|\d)/gi,
    (m, sig, a, b) => {
      if (+a > +b) return m;
      blindados.push(`${sig} ${a} de ${b}`);
      return `\u0001${blindados.length - 1}\u0001`;
    });
  const restaurar = (x) => x.replace(/\u0001(\d+)\u0001/g, (m, i) => blindados[+i]);

  const trozos = [];
  for (const bloque of t0.split(/\s*\/\/\s*/)) {
    const re = new RegExp(FECHA.source + "(?=\\s)", "g");
    let ult = 0, m;
    while ((m = re.exec(bloque))) {
      if (m.index === 0) continue;
      const t = bloque.slice(ult, m.index).trim();
      if (t) trozos.push(t);
      ult = m.index;
    }
    const fin2 = bloque.slice(ult).trim();
    if (fin2) trozos.push(fin2);
  }

  const out = [];
  let ultimaFecha = "";
  for (const trozo of trozos) {
    const mf = trozo.match(new RegExp("^" + FECHA.source + "\\s*[:\\-]?\\s*"));
    let resto = trozo, fecha = ultimaFecha;
    if (mf) { fecha = mf[1]; ultimaFecha = fecha; resto = trozo.slice(mf[0].length); }

    // Dentro del trozo puede haber más de una muestra separada por coma o
    // barra, pero sólo si lo que sigue arranca con una sigla de muestra: así
    // "MAT/QX" no se parte al medio.
    // Sólo se parte si lo que sigue es una sigla de muestra conocida: un
    // "Bacteroides+ S. Epidermidis" es UN resultado con dos gérmenes, no dos
    // muestras, y partirlo por la coma lo rompería.
    const SIG = "(?:HMC|HC|H|UC|RC|AT|MAT\\s*\\/?\\s*QX|MATQX|LCR|COPRO|MPX|TCD|PC|MINIBAL|BAL)";
    const sub = restaurar(resto).split(new RegExp(`\\s*[,;]\\s*(?=${SIG}\\b)|\\s+\\/\\s*(?=${SIG}\\b)`, "i"));
    for (const x of sub) {
      const t = x.trim().replace(/^[\/,;\s]+|[\/,;\s]+$/g, "");
      if (!t) continue;
      out.push({ fecha, texto: t });
    }
  }

  // Red de seguridad. Este campo lo escribe cada uno como puede, y hay pases
  // —2.1 al 31/8— donde la cadena es tan enredada que cualquier regla la
  // desarma mal. Si el resultado tiene renglones sin muestra ni germen, o
  // encabezados que claramente no son fechas, se devuelve el texto original
  // prolijado y nada más: peor que un párrafo denso es un párrafo denso mal
  // partido, que hace perder un cultivo de vista.
  // Se descarta el reordenado si aparece cualquiera de estas señales de que la
  // cadena no se dejó partir bien: renglones sin contenido, o encabezados que
  // no son fechas plausibles (un "6/7" suelto encabezando es un recuento que
  // se coló, no un 6 de julio).
  // "25/08 HMCx2, UC: pendiente" son dos muestras que comparten el resultado:
  // la primera queda sin cuerpo. En vez de descartar todo el reordenado, se
  // pega con la siguiente, que es lo que el pase quiere decir.
  for (let i = out.length - 2; i >= 0; i--) {
    const cuerpoVacio = !out[i].texto || !/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(out[i].texto.replace(/^\s*[A-ZÁÉÍÓÚÑ]{1,6}X?\d?\s*[:,]?\s*/i, ""));
    if (cuerpoVacio && out[i].fecha === out[i + 1].fecha) {
      // Las dos muestras van juntas en el encabezado ("HMCx2 y UC: pendiente"),
      // no una pegada al cuerpo de la otra con una coma suelta.
      // Minúscula en la unión: "HMCx2 y UC: pendiente", no "…Y UC".
      const izq = out[i].texto.replace(/[\s,;:]+$/, "");
      const der = out[i + 1].texto.replace(/^[\s,;:yY]+\s*/, "");
      out[i + 1].texto = izq + " y " + der;
      out.splice(i, 1);
    }
  }

  // Segunda pasada: si después de unir quedó alguno sin nada, se une con el
  // siguiente aunque cambie la fecha (es la misma tanda de cultivos).
  for (let i = out.length - 2; i >= 0; i--) {
    if (!out[i].texto || !out[i].texto.trim()) {
      out[i + 1].texto = out[i + 1].texto;
      out.splice(i, 1);
    }
  }

  const vacios = out.filter((x) => !x.texto || x.texto.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "").length < 3).length;
  const raros = out.filter((x) => /^\d\/\d$/.test(x.fecha || "")).length;
  if (vacios >= 1 || raros >= 1) return paLimpiar(restaurar(txt));

  return out.map(({ fecha, texto }) => {
    let t = texto;
    // "½" y "1/2" y "2/2" son cuántos frascos crecieron.
    t = t.replace(/½/g, "1 de 2").replace(/^\s*(\d)\s*\/\s*(\d)\b(?!\d)/, "$1 de $2");
    // La sigla de muestra, escrita prolija, y dos puntos antes del germen.
    let muestra = "";
    for (const [re, fn] of PA_MUESTRAS) {
      const m = t.match(re);
      if (m) { muestra = fn(m); t = t.slice(m[0].length).replace(/^\s*[:\-]?\s*/, ""); break; }
    }
    // Si tras la sigla viene otra fecha ("Mat Qx 23/06: …"), ésa es la fecha de
    // ESA muestra y pisa a la heredada.
    let f2 = fecha;
    const mi = t.match(new RegExp("^\\s*" + FECHA.source + "\\s*[:\\-]?\\s*"));
    if (mi) { f2 = mi[1]; t = t.slice(mi[0].length); }
    let cuerpo = paLimpiar(t).replace(/^[:\-\s]+/, "");
    // La "y" que une dos muestras no arranca oración: minúscula.
    cuerpo = cuerpo.replace(/^Y\s+/, "").replace(/\sY\s(?=[a-záéíóúñ])/g, " y ");
    const cab = [f2, muestra].filter(Boolean).join(" ");
    // El marcador «» lo convierte a negrita el renderizador; en texto plano
    // queda como un par de comillas angulares y no molesta.
    // Puntuación colgando al principio del cuerpo: queda cuando la muestra se
    // separó de una lista ("HMC X2, UC, cultivos LCR: pendiente").
    cuerpo = cuerpo.replace(/^[\s,;:]+/, "");
    cuerpo = cuerpo.replace(/^[\s,;:]+/, "");
    return cab ? `«${cab}:» ${cuerpo}` : cuerpo;
  }).reduce((acc, linea) => {
    // Un renglón que quedó con encabezado y sin resultado ("«25/08 HMCx2:»")
    // es una muestra que comparte el resultado con la siguiente: se juntan los
    // dos encabezados en vez de dejar una línea huérfana.
    const vacio = /^«[^»]*»\s*$/.test(linea);
    if (vacio) { acc.pendiente = (acc.pendiente || "") + linea.replace(/^«|:»\s*$/g, "") + " y "; return acc; }
    if (acc.pendiente) {
      linea = linea.replace(/^«/, "«" + acc.pendiente.replace(/\s+y\s*$/, " y "));
      acc.pendiente = "";
    }
    acc.lineas.push(linea);
    return acc;
  }, { lineas: [], pendiente: "" }).lineas
    // "25/08 HMCx2 y 25/08 UC" → "25/08 HMCx2 y UC": la fecha repetida sobra.
    .map((linea) => linea.replace(/^«([^»]*)»/, (m, cab) => {
      const f = (cab.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/) || [])[1];
      if (!f) return m;
      const partes = cab.split(" y ").map((x, i) => (i > 0 && x.startsWith(f + " ") ? x.slice(f.length + 1) : x));
      return "«" + partes.join(" y ") + "»";
    }))
    .join("\n");
}

/* Clave para ordenar camas como las cuenta una persona y no como las ordena
   una computadora. Cada tanda de dígitos se rellena con ceros a la izquierda,
   así "1.2" queda antes que "1.10" y "R3" antes que "R12". Comparar los
   textos crudos daría el orden alfabético, donde "1.10" viene antes que
   "1.2" porque el "1" pesa menos que el "2". */

function paCamaOrden(cama) {
  return String(cama || "").replace(/\d+/g, (n) => n.padStart(6, "0"));
}

function paLimpiar(txt) {
  if (!txt) return txt;
  let t = txt.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  // Renglones que el Drive pegó sin salto: "…8/12QUETIAPINA 25/12" o
  // "…cada 12 hQuetiapina". Va acá arriba, sobre el texto crudo, porque más
  // abajo ya se bajó todo a minúscula y el límite entre las dos palabras se
  // vuelve invisible. Leer dos fármacos pegados en un renglón es exactamente
  // cómo se saltea una indicación al pasar la vista.
  //
  // Se corta después de un dígito o de una minúscula, nunca entre dos
  // mayúsculas: "FEP/METRO" y "TAC TX" tienen que quedar como están.
  t = t.replace(/(\d)([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ]{3,})/g, "$1\n$2")
       .replace(/([a-záéíóúñ])([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/g, "$1\n$2");
  const letras = t.replace(/[^a-zA-ZáéíóúñÁÉÍÓÚÑ]/g, "");
  const mays = (t.match(/[A-ZÁÉÍÓÚÑ]/g) || []).length;
  if (letras.length && mays / letras.length >= 0.55) {
    // Solo palabras de 5+ letras o conectores comunes: las siglas cortas (QX,
    // TAP, HDE) son el vocabulario real del servicio y se respetan.
    // Ojo con \b: JavaScript no considera letra a la "Á", así que /\b[A-ZÁ...]+\b/
    // partía "ÓRDENES" en "Ó" + "RDENES" y sólo bajaba la segunda mitad, dejando
    // "Órdenes" como si fuera nombre propio. Se delimita a mano con lookarounds
    // sobre el conjunto completo de letras.
    const L = "A-Za-zÁÉÍÓÚÜÑáéíóúüñ";
    t = t.replace(new RegExp(`(?<![${L}])[A-ZÁÉÍÓÚÜÑ]+(?![${L}])`, "g"), (w) => {
      if (/\d/.test(w)) return w;
      const low = w.toLowerCase();
      if (PA_DROGAS_CORTAS[low]) return PA_DROGAS_CORTAS[low];
      if (!PA_COMUNES.has(w) && w.length < 5) return w;
      return PA_ACENTOS[low] || low;
    });
    t = t.replace(/(^|\n|(?<=[.;:] )|(?<=→ ))([a-záéíóúñ])/g, (m, a, b) => a + b.toUpperCase());
    // "Si síntomas → toraco" y no "Si sintomas → Toraco": después de flecha
    // sigue la misma idea, así que se capitaliza sólo si arranca oración.
    t = t.replace(/(→ )([A-ZÁÉÍÓÚÑ])(?=[a-záéíóúñ])/g, (m, a, b) => a + b.toLowerCase());
  }
  for (const [re, rep] of PA_EXPANDIR) t = t.replace(re, rep);
  // Puntuación: el pase se escribe rápido y quedan ", ,", espacios antes de
  // la coma y comas colgando al final del renglón.
  t = t.replace(/([,;:])(?=[A-Za-zÁÉÍÓÚÑáéíóúñ])/g, "$1 ")  // "PIR,hemodinámicamente"
       .replace(/\s+([,.;:])/g, "$1")
       .replace(/([,;])\s*(?=[,;])/g, "")
       .replace(/,\s*$/gm, "")
       .replace(/\s{2,}/g, " ");
  // La capitalización va DESPUÉS de expandir las siglas: si no, "HDE. VE S/O2"
  // se expande a "hemodinámicamente estable. ventilando..." con la minúscula
  // ya cristalizada después del punto.
  t = t.replace(/(^|\n|(?<=[.;:] ))([a-záéíóúñ])/g, (m, a, b) => a + b.toUpperCase());
  // Último corte de renglones pegados. Va acá, al final, porque "…8/12MH:
  // LORAZEPAM" recién se convierte en "…cada 8 hLorazepam" DESPUÉS de expandir
  // las siglas: antes de este punto las dos palabras todavía no existen como
  // tales. Se corta después de una unidad, que es donde termina una indicación.
  t = t.replace(/(\d\s*(?:h|mg|ml|g|kg|mcg|kg\/h))([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/g, "$1\n$2")
       // ...y también cuando lo que sigue es una sigla en mayúsculas
       // ("cada 12 hMH aspirina"), que la regla de arriba no veía porque
       // esperaba una minúscula después de la primera letra.
       .replace(/(\d\s*(?:h|mg|ml|g|kg|mcg))([A-ZÁÉÍÓÚÑ]{2,})/g, "$1\n$2");
  return t;
}

// Marca de cuándo se relevó un ingreso o egreso. Día y hora, porque una
// guardia cruza la medianoche y "14:20" solo sería ambiguo.

function paPartirTto(txt) {
  if (!txt) return { tto: txt, dieta: "", peso: null };
  const ls = String(txt).split("\n");
  const primera = (ls[0] || "").trim();
  // Tiene que ser un renglón CORTO que arranque con el peso: si es largo,
  // seguramente ya trae medicación pegada y partirlo perdería información.
  // Con o sin "KG": el pase escribe "PESO 60 KG DIETA BLANDA" y también
  // "Peso 80" a secas. Sin la palabra PESO adelante se sigue exigiendo la
  // unidad, porque un número suelto al principio del tratamiento podría ser
  // cualquier cosa.
  const m = primera.match(/^PESO\s*(?:REAL\s*)?(?:ESTIMADO\s*)?(?:DE\s*)?:?\s*(\d{2,3})\s*(?:KG\b)?\.?\s*(.*)$/i)
         || primera.match(/^(\d{2,3})\s*KG\b\.?\s*(.*)$/i);
  if (!m || primera.length > 90) return { tto: txt, dieta: "", peso: null };
  const resto = (m[2] || "").trim();
  // Lo que sobra después del peso es la dieta ("dieta blanda", "NXB", "NTE 21").
  const esDieta = /^(DIETA|NADA POR BOCA|NXB|NPO|N[EPT]{1,2}\b|AYUNO|V[IÍ]A ORAL|NUTRICI[ÓO]N)/i.test(resto);
  // El peso se DEVUELVE, no se tira. Antes este renglón se borraba del
  // tratamiento y recién después se buscaba el peso en el texto: para
  // entonces ya no estaba, así que el paciente quedaba sin peso y todas sus
  // dosis se calculaban sobre los 70 kg supuestos. El bug lo tapaba el hecho
  // de que casi todos los pases escriben además "PESO n KG" en otro lado.
  const n = +m[1];
  return {
    tto: ls.slice(1).join("\n").replace(/^\n+/, ""),
    dieta: esDieta || resto ? resto : "",
    peso: n >= 30 && n <= 250 ? n : null,
  };
}

function paPartirAccesos(txt) {
  const out = { accesos: [], imagenes: [], arm: [] };
  if (!txt) return { accesos: "", imagenes: "", arm: "" };
  const esImagen = /^(IM[ÁA]GENES|TAC|TC|RX|RXTX|TCTX|ECO|ECOGRAF|RM|RMN|ANGIO|DOPPLER|RADIOGRAF)/i;
  const esArm = /^(ARM|VNI|VENTILACI[ÓO]N|MODO)\b/i;
  for (const trozo of txt.split(/\s*\/\/\s*|\n/)) {
    const t = trozo.trim();
    if (!t) continue;
    if (esArm.test(t)) out.arm.push(t);
    else if (esImagen.test(t.replace(/^\d{1,2}\/\d{1,2}\s*/, ""))) out.imagenes.push(t);
    else out.accesos.push(t);
  }
  return { accesos: out.accesos.join("\n"), imagenes: out.imagenes.join("\n"), arm: out.arm.join("\n") };
}

// ── Parseo de infusiones y pendientes ──────────────────────────────────────

function conNegritas(txt, key) {
  // El asterisco de "*25/8 TAC ..." también entra: la fecha va en negrita, que
  // es para lo que se puso el formato. El asterisco queda porque es la marca
  // que usa el servicio y se escribe igual acá y en el Drive.
  if (!txt || (!txt.includes("«") && !txt.includes("+") && !txt.includes("*"))) return txt;
  const out = [];
  const re = /«([^»]*)»|(\s\+\s)|(?:^|(?<=\n))(\*\s?(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])(?:\/\d{2,4})?)/g;
  let ult = 0, m, i = 0;
  while ((m = re.exec(txt))) {
    if (m.index > ult) out.push(<span key={`${key}t${i++}`}>{txt.slice(ult, m.index)}</span>);
    out.push(m[1] !== undefined
      ? <b key={`${key}b${i++}`}>{m[1]}</b>
      : m[3] !== undefined
      ? <b key={`${key}f${i++}`}>{m[3]}</b>
      : <b key={`${key}p${i++}`}> + </b>);
    ult = m.index + m[0].length;
  }
  if (ult < txt.length) out.push(<span key={`${key}t${i++}`}>{txt.slice(ult)}</span>);
  return <>{out}</>;
}

/* ── Resaltado de renglones ────────────────────────────────────────────────
   Marcar con amarillo o verde lo que uno quiere volver a mirar. La marca vive
   dentro del propio texto, como un caracter invisible al principio del
   renglón, para que viaje con el campo: se guarda, se sincroniza y sobrevive
   a mover renglones sin ninguna estructura aparte que mantener en orden.

   Se eligieron caracteres de control, que no aparecen nunca en un pase y no
   se ven si por algún motivo se escapan a la pantalla. */


// Para quien quiere el paciente tal cual vino del Drive, sin tocarlo.
const paseCrudo = (p) => p;

/* Nombre y edad de un paciente del pase, para las pantallas que solo listan
   camas (RedCap). La edad viene en `p.age`: el parser del servidor
   (api/_parser.js) ya la separó del nombre al leer el Drive, así que buscarla
   dentro de `p.name` casi nunca la encuentra. `paNombre` queda de respaldo
   para los pases viejos que todavía la tengan pegada al nombre. */
function paseNombreYEdad(p, unidad) {
  const n = paNombre(p.name || "");
  const edad = (typeof p.age === "number" && p.age > 0) ? p.age : n.edad;
  return { unidad, cama: p.bed, nombre: n.nombre, edad };
}

/* El pase del Drive (scheduler/pases-latest).

   `procesar` decide qué se hace con cada paciente crudo, que es lo único que
   cambia entre pestañas: Pases lo quiere tal cual viene, RedCap quiere nombre
   y edad, Pase App lo pasa por el motor completo. Devuelve además `crudo`,
   el documento entero, para quien necesite mirar otros campos. */
function usePaseDelDrive(procesar) {
  const [foto, setFoto] = useState(null);
  const [cargando, setCargando] = useState(true);
  // El procesador se guarda en una ref para que cambiarlo no reconecte la
  // escucha: la suscripción se arma una sola vez y vive lo que vive la pestaña.
  const procesarRef = useRef(procesar);
  procesarRef.current = procesar;

  useEffect(() => {
    return escuchar(doc(db, "scheduler", "pases-latest"), (snap) => {
      if (!snap.exists()) { setFoto(null); setCargando(false); return; }
      const d = snap.data();
      // Si el sync no dejó unitOrder se usan las claves de units: sin esto,
      // un campo faltante deja la pantalla sin ninguna unidad.
      const unidades = d.unitOrder?.length ? d.unitOrder : Object.keys(d.units || {});
      const pacientes = unidades.flatMap((u) =>
        (d.units?.[u] || []).map((p) => procesarRef.current(p, u)));
      setFoto({ tomado: d.updatedAt, unidades, pacientes, crudo: d });
      setCargando(false);
    }, "el pase del Drive", () => setCargando(false));
  }, []);

  return { foto, cargando };
}


const PASE_FIELDS = [
  ["ap", "Antecedentes"],
  ["ea", "Enfermedad actual"],
  ["req", "Requerimientos / Intercurrencias"],
  ["tto", "Tratamiento"],
  ["labo", "Laboratorio"],
  ["eab", "EAB"],
  ["cultivos", "Cultivos"],
  ["estudios", "Complementarios"],
  ["accesos", "Accesos"],
  ["imagenes", "Imágenes"],
  // Los pendientes NO se muestran acá: la pestaña Pases es la foto del estado
  // de cada paciente, y los pendientes son tarea de guardia — viven en la Pase
  // App, por paciente, donde se pueden tachar. Mostrarlos en los dos lados
  // hace que uno no sepa cuál de las dos listas es la buena.
];

export {
  PASE_FIELDS,
  paseCrudo,
  paseNombreYEdad,
  usePaseDelDrive,
  PA_ACENTOS,
  PA_ANALITOS,
  PA_CHICAS,
  PA_COMUNES,
  PA_DROGAS_CORTAS,
  PA_ES_CULTIVO,
  PA_ES_EAB,
  PA_ES_ESTUDIO,
  PA_ES_GERMEN,
  PA_ES_LCR_FQ,
  PA_EXPANDIR,
  PA_FARMACOS,
  PA_MUESTRAS,
  PA_PILA,
  PA_SEXO,
  conNegritas,
  esPila,
  paCamaOrden,
  paCultivos,
  paFormatoAsterisco,
  paLimpiar,
  paNombre,
  paOrdenNombre,
  paPartirAccesos,
  paPartirTto,
  paQueEs,
  paReordenarClinicos,
  paTitulo,
  paTrozos,
};
