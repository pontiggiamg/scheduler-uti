/* ══════════════════════════════════════════════════════════════════════════
   LA PASE APP — la copia privada de cada residente durante la guardia

   Esta es la pantalla más grande de la app y la única que se carga aparte:
   App.jsx la pide con un import dinámico, así que su código no entra en la
   descarga inicial. Quien abre "¿Quién está hoy?" o el cronograma no baja
   nada de esto.

   Lo que interpreta el texto del pase no está acá sino en pase/motor.jsx,
   que sí comparten las otras pestañas.
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useRef } from "react";
import { db } from "../firebase";
import { doc, setDoc, getDoc, deleteDoc } from "firebase/firestore";
import { escribir } from "../nube";
import { isoDate, shift, useChico, Skeleton } from "../comunes";
import {
  PASE_FIELDS,
  usePaseDelDrive,
  PA_COMUNES,
  PA_FARMACOS,
  conNegritas,
  paCamaOrden,
  paCultivos,
  paFormatoAsterisco,
  paLimpiar,
  paNombre,
  paPartirAccesos,
  paPartirTto,
  paReordenarClinicos,
  paTitulo,
} from "./motor";

const PA_ANOT_TTL_HORAS = 26;

// Saca de todos los pacientes las anotaciones que ya pasaron su tiempo. Pura:
// no muta nada, devuelve un array nuevo (o el mismo, si no había nada que
// sacar). Las anotaciones sin `ts` —de antes de este cambio— se dejan, porque
// no hay con qué medir su antigüedad.

function purgarAnotacionesViejas(pacientes) {
  const limite = Date.now() - PA_ANOT_TTL_HORAS * 3600 * 1000;
  let tocado = false;
  const resultado = (pacientes || []).map((p) => {
    if (!Array.isArray(p.anotaciones) || !p.anotaciones.length) return p;
    const vivas = p.anotaciones.filter((a) => !a.ts || new Date(a.ts).getTime() > limite);
    if (vivas.length === p.anotaciones.length) return p;
    tocado = true;
    return { ...p, anotaciones: vivas };
  });
  return tocado ? resultado : pacientes;
}

// Colección propia. Un documento por residente y por pase: id = uid + fecha de
// la foto, así cambiar de pase no pisa lo de la guardia anterior.

const PASEAPP_COL = "pase_guardia";

const PA_ROT = {
  ap: "Antecedentes", ea: "Enfermedad actual", req: "Requerimientos e intercurrencias",
  tto: "Tratamiento", labo: "Laboratorio", eab: "Estado ácido-base", cultivos: "Cultivos",
  estudios: "Estudios", accesos: "Accesos", imagenes: "Imágenes",
};
// El orden en que se muestran los campos. Si el Drive trae un campo que no está
// acá, no se ve: por eso EAB está en la lista aunque solo lo use parte del
// plantel. Cualquier campo nuevo del Drive hay que agregarlo en los dos lados.
//
// Accesos e Imágenes son dos cosas distintas: una vía central no es una TAC.
// En el Drive vienen juntas en el mismo renglón, así que se separan al leer
// (ver paPartirAccesos).

const PA_ORDEN = ["ap", "ea", "req", "tto", "labo", "eab", "cultivos", "estudios", "accesos", "imagenes"];

const PA_TIPOS = ["Medicación", "Intercurrencia", "Estudio", "Procedimiento", "Otro"];

const PA_PESO_SUPUESTO = 70;

// La unidad de cada infusión no está escrita en el pase: depende de la droga.
// Los vasoactivos se titulan en mcg/kg/min, no en mcg/kg/h: para esos se
// muestran las dos. Para sedoanalgesia la de por hora alcanza.

const PA_POR_MINUTO = new Set(["Noradrenalina", "Adrenalina", "Dobutamina", "Dopamina"]);

const PA_UNIDAD = {
  Fentanilo: "mcg", Remifentanilo: "mcg", Dexmedetomidina: "mcg",
  Ketamina: "mg", Morfina: "mg", Noradrenalina: "mg", Midazolam: "mg", Propofol: "mg",
};
// Rango habitual, solo como control de sanidad del DATO: si cae afuera casi
// siempre es un ritmo viejo o una dilución mal escrita, no una mala dosis. No
// es una recomendación de dosificación y no pretende serlo.
//
// Contrastados con fuentes abiertas (StatPearls / NCBI Bookshelf, agosto 2026):
// dexmedetomidina, mantenimiento 0.2–0.7 mcg/kg/h y hasta 1.5 para alcanzar
// sedación, por eso el techo en 1.5. Noradrenalina: las fuentes para adultos
// la dan en mcg/min absolutos y no por kilo, así que el rango de acá es una
// conversión de uso, amplia a propósito (equivale a 0.01–3 mcg/kg/min) para
// que marque sólo lo groseramente improbable.

const PA_RANGO = {
  Fentanilo: [0.5, 10], Remifentanilo: [1, 12], Dexmedetomidina: [0.2, 1.5],
  Morfina: [0.005, 0.2], Ketamina: [0.05, 1.5], Noradrenalina: [0.0006, 0.18],
  Midazolam: [0.02, 0.2], Propofol: [0.5, 4],
};

const PA_INFUS = {
  FENTANILO: "Fentanilo", FNT: "Fentanilo", KETAMINA: "Ketamina", KETA: "Ketamina",
  MORFINA: "Morfina", NORADRENALINA: "Noradrenalina", NORA: "Noradrenalina",
  MIDAZOLAM: "Midazolam", MIDA: "Midazolam", PROPOFOL: "Propofol", PROPO: "Propofol",
  // "DEXMEDETO 400/100/3" aparece así en la 1.4: el nombre entero casi nunca
  // se escribe completo, conviene tener las formas cortas.
  DEXMEDETOMIDINA: "Dexmedetomidina", DEXMEDETO: "Dexmedetomidina", DEXME: "Dexmedetomidina",
  PRECEDEX: "Dexmedetomidina", REMIFENTANILO: "Remifentanilo", REMI: "Remifentanilo",
};

const PA_IGNORAR = new Set([
  // Laboratorios y gases: se leen bien abreviados y son los que más aparecen.
  "HB", "HTO", "HT", "GB", "PLAQ", "GLU", "UREA", "CREA", "CR", "NA", "K", "CL",
  "CA", "MG", "P", "ALB", "PROT", "BILI", "BT", "FAL", "TGO", "TGP", "LDH", "TP",
  "APTT", "RIN", "PMN", "LEUCOS", "TAG", "TG", "AMILASA", "PH", "PO2", "PCO2",
  "HCO3", "EB", "SAT", "FIO2", "PAFI", "LAC",
  // Cultivos y microbiología.
  "HC", "HCX", "UC", "RC", "HMC", "MATQX", "ATB", "BAL", "MPX",
  // Unidades y medidas.
  "ML", "MG", "GR", "GRS", "MCG", "KG", "CM", "MM", "LTS", "L", "HS", "H", "UI", "UGR",
  // Siglas de uso corriente que ya todos leen.
  "UTI", "UCO", "RECU", "CM", "QX", "DX", "TC", "TAC", "RM", "RX", "ECO", "EEG",
  "LCR", "GCS", "RASS", "SOFA", "APACHE", "PIC", "PAM", "TAM", "FC", "FR", "TA",
  "OK", "SOS", "NEG", "POS", "OFF", "ON", "II", "III", "IV", "VI",
  // Vía aérea, accesos y soportes: vocabulario diario del servicio.
  "IOT", "ARM", "VNI", "CPAP", "VE", "EOT", "TQT", "TET", "SNG", "SV", "TAP",
  "CVC", "VVC", "VVP", "PICC", "DVE", "DJE", "DJP", "COOK", "VAC", "HD", "HDF",
  "PC", "PS", "VC", "VCV", "PCV", "VT", "PEEP", "PAFI", "FD", "YD", "FI", "YI",
  // Patologías y antecedentes que se escriben siempre abreviados.
  "HTA", "DBT", "EPOC", "ERC", "IC", "IAM", "ACV", "HSA", "TEP", "TVP", "FA",
  "IRA", "IRC", "HIP", "TBQ", "OH", "SAHOS", "MOD", "SME", "CF", "FEY", "BGN",
  "BGP", "SAMS", "SAMR", "KPC", "BLEE", "PBE", "HDA", "HDB",
  // Soluciones, sueros y nutrición.
  "SF", "RL", "DX", "NE", "NET", "NPT", "PHP", "AM", "PM",
  // Servicios, procedimientos y varios de uso corriente.
  "TTO", "REQ", "EAB", "PL", "TX", "EX", "PQ", "LIQ", "AMC", "MI", "AP", "EA",
  "GOT", "BASE", "PR", "DOB", "HMD", "CTI", "CM", "GC", "TR",
]);

function paDesconocidas(txt) {
  if (!txt) return [];
  const out = new Set();
  // Sólo sobre el texto YA limpiado: lo que queda en mayúscula ahí es lo que
  // ningún diccionario supo tocar.
  const limpio = paLimpiar(txt);
  const re = /(?<![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])[A-ZÁÉÍÓÚÜÑ]{2,10}(?![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/g;
  let m;
  while ((m = re.exec(limpio))) {
    const w = m[0];
    if (PA_IGNORAR.has(w) || PA_COMUNES.has(w)) continue;
    if (/\d/.test(w)) continue;
    out.add(w);
  }
  return [...out];
}

// ── Cultivos: un renglón por muestra ───────────────────────────────────────
//
// El campo viene como un párrafo corrido donde conviven fechas, muestras y
// gérmenes, separados con lo que el residente tuvo a mano: "//", "/", ",", o
// nada. Cuesta leerlo en el celular justo cuando importa, que es cuando hay
// fiebre y hay que saber qué creció y de dónde.
//
// Se parte en un renglón por muestra, con la fecha adelante. Si dos muestras
// vienen sin fecha entre medio, la segunda hereda la de la anterior: es la
// convención del servicio (se sacaron el mismo día).
//
// Importante: la barra NO sirve como separador de muestras, porque también se
// usa DENTRO de una ("MAT/QX", "HMC/RC/UC", "COPRO/TCD"). Se corta por fecha y
// por "//", que son los cortes que no tienen ese doble uso.

function paAhora() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0"), mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── Mecánica ventilatoria ──────────────────────────────────────────────────
//
// Cada modo se programa con parámetros distintos, así que mostrar una lista
// única de casillas obliga a adivinar cuáles corresponden. Se elige el modo y
// se piden sólo los settings de ese modo. La presión meseta y la PEEP total
// son medidas, no programadas: van aparte porque son las que hacen falta para
// driving pressure y auto-PEEP, y sólo se obtienen haciendo una pausa.

const PA_MODOS = {
  pc: { rot: "Presión control", campos: [["pc", "PC sobre PEEP"], ["fr", "FR"], ["peep", "PEEP"], ["fio2", "FiO₂ %"], ["ti", "Ti (seg)"]] },
  vc: { rot: "Volumen control", campos: [["vt", "Vt programado"], ["fr", "FR"], ["peep", "PEEP"], ["fio2", "FiO₂ %"], ["flujo", "Flujo"]] },
  ps: { rot: "Presión soporte", campos: [["ps", "PS sobre PEEP"], ["peep", "PEEP"], ["fio2", "FiO₂ %"]] },
};

// Lee lo que el pase ya trae escrito: "PC 12/18/8/21 VT 350", "VENTILADOR:
// PC 13/12/8/30 VT 335". El orden es presión sobre PEEP / FR / PEEP / FiO2,
// y el VT que sigue es el volumen que sale, no uno programado. Es una
// precarga para no tipear de nuevo, no una fuente de verdad: queda editable.

function paLeerArm(txt) {
  if (!txt) return null;
  const t = txt.toUpperCase();
  const m = t.match(/\b(PC|PCV|VC|VCV|PS|PSV)\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)(?:\s*\/\s*(\d+))?/);
  if (!m) return null;
  const modo = /^P?S/.test(m[1]) ? "ps" : /^V/.test(m[1]) ? "vc" : "pc";
  const vt = t.match(/\bVT\s*(\d{3,4})/);
  const v = { modo };
  if (modo === "vc") { v.vt = m[2]; v.fr = m[3]; v.peep = m[4]; if (m[5]) v.fio2 = m[5]; }
  else if (modo === "ps") { v.ps = m[2]; v.peep = m[3]; v.fio2 = m[4]; }
  else { v.pc = m[2]; v.fr = m[3]; v.peep = m[4]; if (m[5]) v.fio2 = m[5]; }
  if (vt) v.vtMedido = vt[1];
  return v;
}

// ── Separar accesos de imágenes y de ARM ───────────────────────────────────
//
// En el Drive las tres cosas caen en el mismo renglón de "ACCESOS", separadas
// con "//" o con una etiqueta suelta. Pero un catéter, una tomografía y los
// parámetros del respirador son datos distintos y se consultan en momentos
// distintos, así que se parten acá. Lo que no se puede clasificar queda en
// accesos, que es lo que más aparece: es mejor dejarlo donde estaba que
// inventarle una categoría.
/* El primer renglón de TRATAMIENTO en el Drive no es tratamiento: es el peso
   y la dieta ("PESO 60 KG DIETA BLANDA", o directamente "70 KG"). Estaban
   ocupando el lugar de la primera indicación y encima el peso ya se muestra
   arriba, en la ficha, donde uno lo busca.

   Se saca de ahí y se devuelve aparte: la dieta pasa a Requerimientos, que es
   donde va, y el peso se descarta porque ya está parseado en su propio campo.

   Sólo se toca el ARRANQUE del campo. Un "70 kg" en medio de la medicación
   puede ser parte de una indicación y no se toca. */

function paProcesar(raw, unidad) {
  const campos = { ...(raw.fields || {}) };

  // Red de seguridad del lado del cliente para el recuadro de TRATAMIENTO que
  // el Drive pega adentro de ENFERMEDAD ACTUAL. El arreglo de fondo está en
  // api/parse-pase.js, pero Firestore puede tener todavía un pase sincronizado
  // con el parser viejo, y no quiero que la medicación quede escondida hasta
  // el próximo sync. Si el pase ya viene bien partido, esto no hace nada.
  if (!campos.tto && campos.ea) {
    const lsEa = campos.ea.split("\n");
    const corte = lsEa.findIndex((l) => /^(PESO|PR)\b|^(NE|NPT|NTE|RL|SF|NXB)\s*\d/i.test(l.trim()));
    if (corte > 0) {
      campos.tto = lsEa.slice(corte).join("\n");
      campos.ea = lsEa.slice(0, corte).join("\n");
    }
  }

  // Accesos, imágenes y ARM vienen amontonados en el mismo campo.
  const part = paPartirAccesos(campos.accesos);
  if (campos.accesos) {
    campos.accesos = part.accesos;
    if (part.imagenes) campos.imagenes = [campos.imagenes, part.imagenes].filter(Boolean).join("\n");
    if (!campos.accesos) delete campos.accesos;
  }

  // Repartir laboratorio, EAB, cultivos y estudios según lo que dice cada
  // renglón, no según en qué campo lo escribieron.
  // El peso y la dieta salen del arranque de TRATAMIENTO: el peso se guarda
  // aparte —lo usa el cálculo de dosis— y la dieta pasa a Requerimientos.
  let pesoDelTto = null;
  if (campos.tto) {
    const pt = paPartirTto(campos.tto);
    if (pt.tto !== campos.tto) {
      pesoDelTto = pt.peso;
      campos.tto = pt.tto;
      if (pt.dieta) campos.req = [pt.dieta, campos.req].filter(Boolean).join("\n");
      if (!campos.tto) delete campos.tto;
    }
  }
  // Ojo con Object.assign acá: paReordenarClinicos puede BORRAR un campo
  // —cuando todos sus renglones se mudaron a otra sección— y assign sólo
  // copia las claves que existen, así que la vieja sobrevivía. El resultado
  // era el mismo cultivo apareciendo en Cultivos y en Estudios a la vez.
  // Hay que sacar explícitamente las que el reordenado eliminó.
  {
    const ordenado = paReordenarClinicos(campos);
    for (const k of ["labo", "eab", "cultivos", "estudios"]) {
      if (ordenado[k] === undefined) delete campos[k];
      else campos[k] = ordenado[k];
    }
  }

  const todo = Object.values(campos).join(" ");
  const inf = [], vistos = new Set();
  // Las infusiones no siempre están en TTO: la 1.1 las tiene en enfermedad
  // actual. Se busca en todos los campos. NA solo cuenta en tratamiento, porque
  // en laboratorio es el sodio.
  for (const [campo, txt] of Object.entries(campos)) {
    const re = /\b([A-ZÁÉÍÓÚÑ]{2,15})\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*(?:→\s*([0-9.,]+))?/g;
    let m;
    while ((m = re.exec(txt || ""))) {
      const droga = PA_INFUS[m[1]] || (m[1] === "NA" && campo === "tto" ? "Noradrenalina" : null);
      if (!droga) continue;
      const k = `${droga}|${m[2]}|${m[3]}|${m[4]}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      inf.push({ droga, mg: +m[2], ml: +m[3], ritmo: +m[4],
        declarada: m[5] ? parseFloat(m[5].replace(",", ".")) : null,
        // "campo" es sólo para el cartel de "escrita en tal lado"; para poder
        // reescribir el renglón cuando se cambia el goteo hace falta saber en
        // qué campo está de verdad y con qué números venía escrito.
        campo: campo === "tto" ? null : campo,
        campoReal: campo, original: `${m[2]}/${m[3]}/${m[4]}` });
    }
  }
  // Propofol al 2%: se escribe distinto que el resto de las infusiones. No es
  // "droga mg/ml/ritmo" sino "PROPO 2% 8" = propofol al 2% pasando a 8 ml/h.
  // El 2% quiere decir 2 g en 100 ml, o sea 20 mg/ml, y con eso la dosis por
  // kilo sale igual que en las demás. También se acepta al 1% (10 mg/ml).
  for (const [campo, txt] of Object.entries(campos)) {
    const reP = /\bPROPO(?:FOL)?\s*(1|2)\s*%\s*(?:A\s*)?([\d.,]+)\s*(?:ML\/?H)?/gi;
    let mp2;
    while ((mp2 = reP.exec(txt || ""))) {
      const mgMl = +mp2[1] * 10;              // 1% = 10 mg/ml, 2% = 20 mg/ml
      const ritmo = parseFloat(mp2[2].replace(",", "."));
      if (!isFinite(ritmo)) continue;
      const k = `Propofol|${mgMl}|1|${ritmo}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      // Se guarda como "mgMl mg en 1 ml" para que la fórmula de siempre
      // (concentración ÷ dilución × ritmo ÷ peso) dé el resultado correcto.
      inf.push({ droga: "Propofol", mg: mgMl, ml: 1, ritmo, declarada: null,
        campo: campo === "tto" ? null : campo, campoReal: campo,
        original: `${mp2[1]}% ${mp2[2]}`, porcentaje: +mp2[1] });
    }
  }

  const interm = [];
  const reI = /\b([A-ZÁÉÍÓÚÑ]{3,15})\s+(\d+)\s*\/\s*(\d+)\b(?!\s*\/)/g;
  let mi;
  while ((mi = reI.exec(campos.tto || ""))) {
    if (PA_FARMACOS.has(mi[1]) && [4, 6, 8, 12, 24].includes(+mi[3]))
      interm.push({ droga: paTitulo(mi[1]), mg: +mi[2], cada: +mi[3] });
  }
  // Peso real estimado: es el que se usa para calcular las dosis. Cualquier
  // peso escrito sin aclaración ("PESO 70 KG", o incluso "70 KG" suelto) se
  // interpreta como real estimado — así lo definió Gonzalo el 2/9/2026.
  /* El "KG" es opcional: el pase escribe tanto "PESO 80 KG" como "Peso 80" a
     secas, y hasta el 2/9/2026 la segunda forma no se reconocía. Eso no era
     cosmético: sin peso, TODAS las dosis del paciente se calculaban sobre los
     70 kg supuestos. Un paciente de 80 kg con noradrenalina mostraba una
     dosis 14% más alta que la real.

     Alcanza con que esté la palabra PESO o PR adelante para que el número no
     sea ambiguo. Se exige además un rango plausible (30 a 250 kg) para que un
     dedazo no cargue un peso imposible sin que nadie lo note. */
  const pesoDe = (re) => {
    const m = todo.match(re);
    if (!m) return null;
    const n = +m[1];
    return n >= 30 && n <= 250 ? n : null;
  };
  const mp = pesoDe(/PESO\s*(?:REAL\s*)?(?:ESTIMADO\s*)?(?:DE\s*)?:?\s*(\d{2,3})\s*(?:KG\b)?/i)
          ?? pesoDe(/(?<![A-ZÁÉÍÓÚÑ])PR\s*:?\s*(\d{2,3})\s*(?:KG\b)?/i)
          ?? pesoDelTto;   // el que venía en el encabezado del tratamiento
  // Peso teórico (PT), también llamado predicho. NO se usa para las dosis:
  // sirve sólo para la mecánica ventilatoria, donde el volumen corriente se
  // calcula por kilo de peso predicho y no por el peso real del paciente.
  const mpt = pesoDe(/(?<![A-ZÁÉÍÓÚÑ])PT\s*:?\s*(\d{2,3})\s*(?:KG\b)?/i);
  // Balance del día escrito al final del renglón de estado: "…, 890-590" son
  // 890 ml de ingresos y 590 ml de diuresis. Se acota fuerte a propósito —par
  // al final del renglón, precedido por coma y sin "%"— porque el mismo patrón
  // aparece como rango en "FEY 45-50%" o "TROPO 72 - 85", y leer una fracción
  // de eyección como si fuera un balance sería un error feo.
  let balDia = null;
  for (const linea of (campos.req || "").split("\n")) {
    const mb = linea.match(/,\s*(\d{2,4})\s*-\s*(\d{2,4})\s*$/);
    if (mb) balDia = { ingresos: +mb[1], egresos: +mb[2] };
  }

  /* ── Los pendientes ──────────────────────────────────────────────────────
     Salen del campo PENDIENTES del Drive, pero también aparecen escritos
     dentro de otras secciones, sobre todo en Estudios: "Pendiente: LAB, RX".
     Esos renglones son tareas de verdad —lo que hay que ir a buscar— y
     quedaban como texto suelto mientras la lista de pendientes se veía vacía.

     Hay que distinguirlos de otra cosa que también dice "pendiente" y NO es
     una tarea: el RESULTADO de un cultivo que todavía no salió ("HMC x2:
     pendiente", "retrocultivos PICC: pendiente"). Eso es información del
     estudio, no algo para tildar, y moverlo sería vaciar la sección de
     cultivos. La diferencia es dónde está la palabra: una tarea ARRANCA con
     "Pendiente:" y después dice qué falta; un resultado la tiene al final,
     después de los dos puntos.

     Se corta por coma para poder tildar el laboratorio cuando sale y dejar la
     radiografía todavía pendiente. */
  const TAREA_PEND = /^\*?\s*(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s+)?PENDIENTES?\s*[:\-]\s*(.+)$/i;
  const partir = (txt) => String(txt || "")
    .split(/\n|\/\/|(?<=[a-zA-ZáéíóúÁÉÍÓÚ0-9])\s+\/\s+(?=[A-ZÁÉÍÓÚ])/)
    .map((x) => x.replace(/^[\s/]+|[\s/]+$/g, "")).filter(Boolean);

  const pend = partir(campos.pendiente).map((x) => ({ texto: paLimpiar(x), listo: false }));

  // Las tareas escritas dentro de otras secciones se mudan acá, y el renglón
  // se saca de donde estaba para no leerlo dos veces.
  for (const k of ["estudios", "labo", "req", "eab", "accesos", "imagenes"]) {
    if (!campos[k]) continue;
    const quedan = [];
    for (const linea of String(campos[k]).split("\n")) {
      const m = linea.match(TAREA_PEND);
      if (!m) { quedan.push(linea); continue; }
      for (const tarea of m[1].split(/\s*[,;]\s*/)) {
        const t = paLimpiar(tarea.trim());
        if (t) pend.push({ texto: t, listo: false, de: k });
      }
    }
    const v = quedan.join("\n").trim();
    if (v) campos[k] = v; else delete campos[k];
  }
  const req = (campos.req || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const ult = req.length ? req[req.length - 1] : "";
  const limpios = {};
  // Cultivos tienen su propio tratamiento: se reordenan en un renglón por
  // muestra, con la fecha adelante.
  const CON_ASTERISCO = new Set(["labo", "eab", "cultivos", "estudios"]);
  for (const [k, v] of Object.entries(campos)) if (k !== "pendiente") {
    // Cultivos pasa por paLimpiar ANTES de agruparse: si no, las siglas de
    // esa sección se quedaban crudas —"HMC X2" seguía siendo "HMC X2" en vez
    // de "HCx2"— porque paCultivos sólo reordena y nunca normaliza.
    const limpio = k === "cultivos" ? paCultivos(paLimpiar(v)) : paLimpiar(v);
    // *fecha estudio resultado, en las tres secciones fechadas.
    limpios[k] = CON_ASTERISCO.has(k) ? paFormatoAsterisco(limpio) : limpio;
  }
  /* La edad puede venir de dos lados. El parser del servidor (api/_parser.js)
     ya la separa del nombre en el momento de leer el Drive —"Huarachi 37
     años" pasa a nombre "Huarachi" y edad 37 en `raw.age`— así que acá casi
     siempre `raw.name` YA NO TIENE la edad adentro para que paNombre() la
     vuelva a encontrar. Antes esta línea sólo miraba `paNombre(raw.name)` y
     tiraba `raw.age` sin usarlo: por eso la edad no aparecía en Pase App
     aunque el pase la tuviera. Se usa `raw.age` cuando está, y `paNombre`
     como respaldo para cuando no —una cama agregada a mano, por ejemplo, no
     tiene `raw.age` y sólo tiene lo que se haya escrito en el nombre—. */
  const nom = paNombre(raw.name);
  const edad = (typeof raw.age === "number" && raw.age > 0) ? raw.age : nom.edad;
  return {
    unidad, cama: raw.bed, ...nom, edad,
    // El sync marca con vacia:true las camas que rellenó porque el Drive las
    // salteaba (la 2.4 entre la 2.3 y la 2.5). Acá se traducen a la marca que
    // la app ya usa para una cama sin paciente, así caen solas en la vista de
    // "Cama libre" con sus opciones de ingresar o traer a alguien.
    egresado: !!raw.vacia,
    mi: paLimpiar(raw.mi || ""), campos: limpios,
    peso: mp, pesoTeorico: mpt,
    infusiones: inf, intermitentes: interm,
    pendientes: pend, anotaciones: [],
    // Si el pase ya traía el balance del día, entra precargado en vez de
    // obligar a copiarlo a mano.
    balance: balDia
      ? { ingresos: [{ que: "Aportes del día (del pase)", ml: balDia.ingresos, cuando: "" }],
          egresos: [{ que: "Diuresis del día (del pase)", ml: balDia.egresos, cuando: "" }] }
      : { ingresos: [], egresos: [] },
    sinCompletar: !req.length || /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(ult),
    // Texto crudo del respirador tal como venía en el pase, para precargar el
    // pop-up de mecánica ventilatoria.
    armTexto: part.arm || "",
  };
}

// ── Diff por palabras ──────────────────────────────────────────────────────
// Palabra y no carácter: agregar "PL s/p" tiene que leerse como dos palabras
// nuevas, no como siete letras sueltas intercaladas en el texto.

function paDiff(a, b) {
  if (a === b) return [{ t: "=", v: a }];
  const A = (a || "").split(/(\s+)/), B = (b || "").split(/(\s+)/);
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: "=", v: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ t: "-", v: A[i] }); i++; }
    else { out.push({ t: "+", v: B[j] }); j++; }
  }
  while (i < n) out.push({ t: "-", v: A[i++] });
  while (j < m) out.push({ t: "+", v: B[j++] });
  return out;
}

// Pone en negrita lo que va entre «» —el encabezado de cada cultivo, "fecha
// muestra:"— y el "+" que separa dos gérmenes. El texto guardado sigue siendo
// plano: los marcadores viven en el string y sólo se interpretan al mostrarlo,
// así la edición libre y el diff de cambios siguen funcionando igual. Cuando
// el campo está en foco se ve el texto crudo, como con el resaltado.

const PA_MARCA = { "\u0011": "#FEF08A", "\u0012": "#BBF7D0" };   // amarillo, verde

const PA_MARCA_ROT = { "\u0011": "Amarillo", "\u0012": "Verde" };

const PA_MARCAS = Object.keys(PA_MARCA);

const PA_FIN = "\u0013";                                        // cierra un resaltado

/* Los resaltados viven DENTRO del texto: un caracter invisible abre el color y
   otro lo cierra. Así viajan con el campo —se guardan, se sincronizan y
   sobreviven a mover renglones— sin una estructura aparte que haya que
   mantener en sincronía con el texto.

   Se trabaja con un "mapa de colores": una lista con un color (o nada) por
   cada caracter del texto limpio. Es más código que meter y sacar marcas a
   mano, pero es la única forma en que resaltar sobre algo ya resaltado, o
   pisar dos colores, no termine en marcas cruzadas o sin cerrar.

   Compatible con el formato viejo, que pintaba el renglón entero poniendo la
   marca al principio y sin cerrarla: una marca sin cierre pinta hasta el fin
   del renglón, que es exactamente lo que hacía antes. */

function paColores(txt) {
  const t = String(txt || "");
  let limpio = "", colores = [], actual = null;
  for (const ch of t) {
    if (PA_MARCA[ch]) { actual = ch; continue; }
    if (ch === PA_FIN) { actual = null; continue; }
    if (ch === "\n") actual = null;      // el color no cruza de renglón
    limpio += ch;
    colores.push(ch === "\n" ? null : actual);
  }
  return { limpio, colores };
}

function paDeColores(limpio, colores) {
  let out = "", actual = null;
  for (let i = 0; i < limpio.length; i++) {
    const c = colores[i] || null;
    if (c !== actual) {
      if (actual) out += PA_FIN;
      if (c) out += c;
      actual = c;
    }
    out += limpio[i];
    if (limpio[i] === "\n") actual = null;   // se cierra solo al saltar
  }
  if (actual) out += PA_FIN;
  return out;
}

/* Pinta (o despinta, con color null) el tramo [desde, hasta) del texto. Las
   posiciones son sobre el texto LIMPIO, que es lo que ve y selecciona el que
   está leyendo; adentro se traduce al texto con marcas. */

function paPintarRango(txt, desde, hasta, color) {
  const { limpio, colores } = paColores(txt);
  const a = Math.max(0, Math.min(desde, limpio.length));
  const b = Math.max(a, Math.min(hasta, limpio.length));
  for (let i = a; i < b; i++) if (limpio[i] !== "\n") colores[i] = color;
  return paDeColores(limpio, colores);
}

/* Los tramos de un texto, cada uno con su color y su posición de arranque
   dentro del texto limpio. Esa posición es la que permite volver de una
   selección del navegador a un índice de caracter. */

function paSegmentos(txt) {
  const { limpio, colores } = paColores(txt);
  const segs = [];
  let i = 0;
  while (i < limpio.length) {
    if (limpio[i] === "\n") { segs.push({ texto: "\n", color: null, inicio: i }); i++; continue; }
    let j = i;
    while (j < limpio.length && colores[j] === colores[i] && limpio[j] !== "\n") j++;
    segs.push({ texto: limpio.slice(i, j), color: colores[i], inicio: i });
    i = j;
  }
  return segs;
}

const paSinMarcas = (t) => (t || "").replace(/[\u0011\u0012\u0013]/g, "");

// El modo de reordenar renglónes sigue preguntando por el color de una línea
// entera: devuelve el primero que encuentre, o nada.

function paMarcaDe(linea) {
  const { limpio, colores } = paColores(linea);
  return { color: colores.find(Boolean) || null, texto: limpio };
}

/* Lo que escribiste va en naranja; lo que borraste, no se muestra.
   Antes se mostraba tachado al lado, y en un renglón muy editado quedaban dos
   versiones mezcladas del mismo texto: justo lo que uno no quiere leer a las
   tres de la mañana. Para ver lo que decía el Drive está el botón de arriba,
   que muestra el pase entero sin ninguna edición. */

function TextoMarcado({ actual, original }) {
  // El resaltado se pinta por renglón, así que se procesa línea por línea y
  // el diff se hace sobre el texto sin marcas: si no, el caracter invisible
  // contaría como una edición y todo el renglón saldría en naranja.
  const lineas = (actual || "").split("\n");
  const orig = (original || "").split("\n");
  return (
    <>
      {lineas.map((linea, li) => {
        const { color, texto } = paMarcaDe(linea);
        const previa = paSinMarcas(orig[li] ?? "");
        const cuerpo = texto === previa
          ? conNegritas(texto, `n${li}`)
          : paDiff(previa, texto)
              .filter((d) => d.t !== "-")
              .map((d, i) =>
                d.t === "=" ? <span key={i}>{conNegritas(d.v, `d${li}_${i}`)}</span>
                : <ins key={i} style={{ background: "#FFF6E5", color: "#8A4B00", fontWeight: 600, textDecoration: "none", borderRadius: 2, boxShadow: "inset 0 -2px 0 #E9C48A" }}>{d.v}</ins>);
        return (
          <div key={li} style={color ? {
            background: PA_MARCA[color], borderRadius: 3,
            padding: "1px 4px", margin: "1px -4px",
          } : undefined}>
            {cuerpo}
          </div>
        );
      })}
    </>
  );
}

function paDosis(inf, pesoReal) {
  const peso = pesoReal || PA_PESO_SUPUESTO;
  const u = PA_UNIDAD[inf.droga];
  if (!u) return { sinUnidad: true, peso };
  const kgh = (inf.mg / inf.ml) * inf.ritmo / peso;
  return { u, kgh, kgmin: kgh / 60, peso, supuesto: !pesoReal };
}

/* ── La vista ───────────────────────────────────────────────────────────── */

function PaseAppView({ user }) {
  // El pase del Drive, pasado por el motor completo (paProcesar). Nunca se
  // toca: lo editable es `mio`.
  const { foto, cargando } = usePaseDelDrive(paProcesar);
  const [mio, setMio] = useState(null);          // mi copia editable
  const [uSel, setUSel] = useState(null);
  const [iSel, setISel] = useState(0);
  const [verOriginal, setVerOriginal] = useState(false);
  const [enFoco, setEnFoco] = useState(null);
  // Todas las secciones arrancan colapsadas: en el celular, durante el pase,
  // lo primero que uno quiere ver es el paciente, no cuatro cajas abiertas.
  const [plegado, setPlegado] = useState({ anot: true, pend: true, bal: true, raras: true });
  const [tipoSel, setTipoSel] = useState("Intercurrencia");
  const [estado, setEstado] = useState("");
  // ARM por paciente (no uno solo para toda la unidad, que era el bug latente
  // del prototipo): clave = índice del paciente.
  const [arm, setArm] = useState({});
  const [armAbierto, setArmAbierto] = useState(false);
  const [ordenando, setOrdenando] = useState(null);
  const [resaltando, setResaltando] = useState(null);  // campo en modo resaltar
  const [colorSel, setColorSel] = useState(PA_MARCAS[0]);  // con qué color pinta
  const chico = useChico();
  const [editando, setEditando] = useState(false);
  const [confirmandoEgreso, setConfirmandoEgreso] = useState(false);
  const undo = useRef([]);
  const guardarTimer = useRef(null);

  const docId = user && foto ? `${user.uid}__${(foto.tomado || "").slice(0, 10)}` : null;

  // 1) La foto del Drive, pasada por el motor completo de Pase App.
  useEffect(() => {
    if (foto && foto.unidades.length) setUSel((cur) => cur || foto.unidades[0]);
  }, [foto]);

  /* 2) Mi copia. Si no existe todavía, arranca siendo la foto del Drive.

     El manejo del error de acá es la parte importante. Antes, si la lectura
     fallaba —se cortó la red, la respuesta tardó, un permiso— la app se caía
     en silencio a la foto del Drive y mostraba el pase limpio, como si uno
     nunca hubiera editado nada. Las ediciones seguían guardadas en Firestore,
     pero desde la pantalla eso es indistinguible de haberlas perdido, y lo
     peor: la primera edición que hicieras encima sobreescribía la copia buena
     con la que estabas viendo.

     Ahora un error NO descarta nada. Se avisa, se ofrece reintentar, y hasta
     que la lectura no responda no se deja escribir: es preferible una
     pantalla que dice "no pude leer tu copia" a una que miente diciendo que
     no había nada. */
  const [fallo, setFallo] = useState(null);
  // La foto congelada contra la que se compara `mio` (naranja / "ver
  // original"). Se fija una sola vez al cargar la copia y no se vuelve a
  // tocar por un resync — ver el comentario en el efecto de más abajo.
  const [fotoBase, setFotoBase] = useState(null);
  const [noGuarda, setNoGuarda] = useState(null);
  const [viendoCopias, setViendoCopias] = useState(false);
  const [copias, setCopias] = useState(null);
  const [reintento, setReintento] = useState(0);

  /* `foto` sólo se usa acá abajo para el caso "todavía no hay copia mía": la
     primera vez que alguien abre el pase de hoy, se arranca con lo que trajo
     el Drive. Se guarda en un ref, no en el efecto de abajo, a propósito. */
  const fotoRef = useRef(foto);
  fotoRef.current = foto;

  /* Esto se dispara al entrar y cada vez que cambia docId (uid + fecha del
     pase), NUNCA por un resync.

     Antes dependía también de `foto`, y `foto` cambia cada vez que alguien
     resincroniza la pestaña Pases — algo que puede pasar en cualquier momento
     de la guardia, sin que quien está en Pase App haga nada. Cada resync
     volvía a leer la copia guardada en la nube y LA PISABA ENCIMA de `mio`,
     el estado que se está editando en pantalla. Si eso pasaba dentro de los
     700 ms que tarda en guardarse un cambio (ver `guardar`), lo último
     tipiado se perdía sin aviso: no había error, la pantalla seguía mostrando
     el pase, y la próxima vez que se guardara se guardaba la versión vieja.
     Así se explica que camas y pacientes de Pase App "cambiaran solos" a
     mitad de guardia.

     `docId` no cambia con un resync común: sólo cambia si cambia la fecha del
     pase (un día nuevo). Por eso alcanza con sacar `foto` de las dependencias
     — la fecha del pase actual (para armar docId) igual se sigue leyendo de
     `foto` más arriba, eso no se toca. */
  useEffect(() => {
    if (!docId || !fotoRef.current) return;
    let vivo = true;
    setFallo(null);
    getDoc(doc(db, PASEAPP_COL, docId)).then((snap) => {
      if (!vivo) return;
      // ¿Hay algo en este navegador más nuevo que lo que trajo la nube? Pasa
      // cuando la escritura falló: el trabajo quedó acá y allá no llegó.
      let local = null;
      try {
        const crudo = claveLocal ? localStorage.getItem(claveLocal) : null;
        if (crudo) local = JSON.parse(crudo);
      } catch (e) { /* ignorar */ }

      const nube = snap.exists() && Array.isArray(snap.data().pacientes) ? snap.data() : null;
      const localEsMasNuevo = local && Array.isArray(local.pacientes) &&
        (!nube || (local.guardadoEn || "") > (nube.guardadoEn || ""));

      /* La foto contra la que se va a comparar (naranja / "ver original")
         se recupera de donde se recupera `mio`: si ya había una copia
         guardada (en este navegador o en la nube) y trae su propia
         `fotoOriginal`, se usa ESA, no la foto viva actual. Si se usara la
         viva, cada vez que se vuelve a esta pestaña —lo que la desmonta y
         remonta entera— quedaría fijada de nuevo contra lo más reciente que
         haya sincronizado la pestaña Pases mientras tanto, que es
         exactamente lo que se quería evitar: el cartelito saltando adelante
         solo, y campos marcados naranja que nadie tocó en esta sesión.

         Sólo cuando no hay ninguna copia guardada (fuente `fotoOriginal`
         inexistente, sea porque es la primera vez o porque es una copia
         vieja de antes de que este campo existiera) se usa la foto viva:
         no hay otra con la que trabajar. */
      const fuente = localEsMasNuevo ? local : nube;
      const fotoGuardada = fuente && Array.isArray(fuente.fotoOriginal)
        ? { tomado: fuente.tomado, pacientes: fuente.fotoOriginal }
        : fotoRef.current;
      setFotoBase(fotoGuardada);

      // Se cargue de donde se cargue, antes de mostrarla se le sacan las
      // anotaciones que ya cumplieron sus 26 h (ver PA_ANOT_TTL_HORAS más
      // arriba). Si de verdad sacó algo, se guarda esa versión más corta:
      // si no, la próxima vez que alguien abra este pase van a seguir ahí,
      // ahora con más horas encima todavía.
      if (localEsMasNuevo) {
        const p = purgarAnotacionesViejas(local.pacientes);
        setMio(p);
        if (p !== local.pacientes) guardar(p);
        setEstado("Recuperado de este navegador — no había llegado a guardarse en la nube");
      } else if (nube) {
        const p = purgarAnotacionesViejas(nube.pacientes);
        setMio(p);
        if (p !== nube.pacientes) guardar(p);
        setEstado("Recuperado de tu última sesión");
      } else {
        // No hay copia guardada todavía: es la primera vez con este pase.
        // No hace falta purgar acá: recién nace, no puede tener nada viejo.
        setMio(JSON.parse(JSON.stringify(fotoRef.current.pacientes)));
      }
    }).catch((e) => {
      if (!vivo) return;
      console.error("leer mi copia", e);
      // Si la nube no responde pero este navegador tiene una copia, se usa
      // esa: es mejor seguir trabajando sobre lo propio que quedar frenado.
      let local = null;
      try {
        const crudo = claveLocal ? localStorage.getItem(claveLocal) : null;
        if (crudo) local = JSON.parse(crudo);
      } catch (e2) { /* ignorar */ }
      if (local && Array.isArray(local.pacientes)) {
        setFotoBase(Array.isArray(local.fotoOriginal)
          ? { tomado: local.tomado, pacientes: local.fotoOriginal }
          : fotoRef.current);
        // Acá sólo se purga para lo que se ve en pantalla, sin forzar un
        // guardado: la nube ya está fallando, insistir ahora sólo suma un
        // segundo error. La próxima lectura que funcione lo guarda bien.
        setMio(purgarAnotacionesViejas(local.pacientes));
        setEstado("Trabajando con la copia de este navegador");
        setNoGuarda(e && e.message ? e.message : "no se pudo leer");
      } else {
        setFotoBase(fotoRef.current);
        setFallo(e && e.message ? e.message : "no se pudo leer");
      }
    });
    return () => { vivo = false; };
  }, [docId, reintento]);

  /* Todas las copias privadas que tiene guardadas este usuario.

     Existe porque la copia se guarda con la FECHA DEL PASE del Drive adentro
     de la clave: si el pase se resincroniza y cambia de fecha, la app pasa a
     usar otra clave y lo anotado antes queda en un documento que ya nadie
     abre. No se borró, pero deja de estar a la vista, que en la práctica es
     lo mismo si uno no sabe dónde buscar.

     Acá se listan todas y se puede traer cualquiera a la copia actual. */
  useEffect(() => {
    if (!viendoCopias || !user) return;
    let vivo = true;
    /* Se piden los documentos UNO POR UNO, por fecha, en vez de barrer la
       colección entera.

       Barrerla no funciona: las reglas exigen que el id del documento empiece
       con el uid de quien pide, y una consulta que abarca toda la colección
       no puede garantizar eso, así que Firestore la rechaza completa. El
       resultado era un listado vacío que decía "no hay copias" cuando en
       realidad quería decir "no pude preguntar" — que es peor que no tener la
       función, porque hace concluir que el trabajo se perdió.

       Pidiendo cada documento por su id la regla se cumple y la respuesta es
       de verdad. Se miran los últimos 30 días, que es de sobra: las
       anotaciones son del día y no se guardan más allá. */
    const dias = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dias.push(isoDate(d));
    }
    Promise.all(dias.map((f) =>
      getDoc(doc(db, PASEAPP_COL, `${user.uid}__${f}`))
        .then((snap) => {
          if (!snap.exists()) return null;
          const v = snap.data() || {};
          return {
            id: snap.id, fecha: f,
            guardadoEn: v.guardadoEn || "",
            pacientes: Array.isArray(v.pacientes) ? v.pacientes : [],
          };
        })
        .catch(() => null)     // una fecha que falle no tira abajo la lista
    )).then((todas) => {
      if (!vivo) return;
      const mias = todas.filter(Boolean);
      mias.sort((a, b) => (b.guardadoEn || b.fecha).localeCompare(a.guardadoEn || a.fecha));
      setCopias(mias);
    });
    return () => { vivo = false; };
  }, [viendoCopias, user]);

  // Traer una copia guardada a la de hoy. No pisa nada sin avisar: se
  // pregunta, porque lo que hay ahora también puede ser trabajo de alguien.
  const restaurarCopia = (c) => {
    if (!confirm(`Traer las anotaciones del pase del ${c.fecha}?\n\n` +
      `Son ${c.pacientes.length} camas. Lo que tengas cargado ahora se reemplaza.`)) return;
    mutar((d) => { d.length = 0; for (const x of c.pacientes) d.push(x); });
    setViendoCopias(false);
    setEstado(`Restaurada tu copia del ${c.fecha}`);
  };

  // Lo último que hay para guardar, por si la ventana se cierra antes de que
  // venza la espera de abajo.
  const pendienteRef = useRef(null);

  /* Respaldo en el propio navegador.

     El 2/9/2026 se perdió una guardia entera de anotaciones: las reglas de
     Firestore rechazaban la escritura y no había ninguna otra copia. El
     trabajo existía sólo en la pantalla, y al recargar desapareció.

     Ahora antes de cada intento de escribir en la nube se deja una copia acá,
     en el navegador. No reemplaza a Firestore —no se comparte entre
     dispositivos ni sobrevive a limpiar el navegador— pero convierte "se
     perdió todo" en "está en la máquina donde lo escribiste". */
  const claveLocal = docId ? "uti-pase-" + docId : null;

  /* La foto congelada (`fotoBase`) vive en memoria, y la memoria no sobrevive
     a cambiar de pestaña: esta vista se desmonta y se vuelve a montar entera,
     así que "congelar al cargar" terminaba congelando de nuevo cada vez que
     alguien volvía a Pase App, contra lo que fuera la foto MÁS RECIENTE en
     ese momento — que es justo lo que se quería evitar.

     La solución es guardar la foto congelada JUNTO con la copia, no sólo en
     memoria: así al volver a entrar se recupera la misma de siempre, en vez
     de fijar una nueva. `fotoOriginal` es esa foto (los pacientes tal como
     los trajo el Drive quel día que se armó esta copia); `tomado` es su hora. */
  const guardarLocal = (datos) => {
    if (!claveLocal) return;
    try {
      localStorage.setItem(claveLocal, JSON.stringify({
        guardadoEn: new Date().toISOString(), pacientes: datos,
        tomado: fotoBase ? fotoBase.tomado : foto.tomado,
        fotoOriginal: fotoBase ? fotoBase.pacientes : foto.pacientes,
      }));
    } catch (e) { /* sin espacio o modo privado: no es motivo para frenar nada */ }
  };

  const escribir = async (datos) => {
    if (!docId) return;
    guardarLocal(datos);          // primero lo seguro, después la nube
    await setDoc(doc(db, PASEAPP_COL, docId), {
      uid: user.uid, email: user.email || "", nombre: user.displayName || "",
      // `fotoBase`, no `foto`: es el pase que tu copia realmente tiene
      // adentro, no el último que llegó del Drive. Se guarda completa
      // (no sólo la hora) para poder recuperarla igual la próxima vez que
      // se abra esta copia, aunque para entonces el Drive ya haya cambiado.
      tomado: fotoBase ? fotoBase.tomado : foto.tomado,
      fotoOriginal: fotoBase ? fotoBase.pacientes : foto.pacientes,
      guardadoEn: new Date().toISOString(), pacientes: datos,
    });
  };

  const guardar = (datos) => {
    if (!docId) return;
    pendienteRef.current = datos;
    clearTimeout(guardarTimer.current);
    // Se espera 700 ms antes de escribir para no mandar una escritura por cada
    // tecla mientras alguien redacta un renglón.
    guardarTimer.current = setTimeout(async () => {
      try {
        await escribir(datos);
        pendienteRef.current = null;
        setNoGuarda(null);        // volvió a andar
        setEstado("Guardado " + new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }));
      } catch (e) {
        console.error("guardar pase", e);
        setEstado("No se pudo guardar");
        // Un cartel chico abajo a la derecha no alcanza para esto: si el
        // guardado falla y uno sigue anotando, al final de la guardia el
        // trabajo no está en ningún lado. Se levanta una bandera que corta la
        // pantalla hasta que se resuelva.
        setNoGuarda(e && e.message ? e.message : "no se pudo guardar");
      }
    }, 700);
  };

  /* `guardar` se vuelve a crear en cada render (usa `fotoBase`, `docId`, etc.
     por closure), pero el intervalo de purga de acá abajo se monta UNA sola
     vez. Sin esta ref, el intervalo se queda para siempre con el `guardar`
     del primerísimo render —cuando `fotoBase` todavía era `null`— y cuando
     por fin purga algo (media hora después, o más) guarda con datos viejos
     en vez de los actuales. Actualizarla en cada render asegura que el
     intervalo siempre llame a la versión de ahora. */
  const guardarRef = useRef(guardar);
  guardarRef.current = guardar;

  /* La purga de anotaciones viejas (ver PA_ANOT_TTL_HORAS) corre al abrir el
     pase, pero una guardia puede quedar con la pestaña abierta muchas horas
     sin recargar. Este intervalo repite la purga cada media hora mientras la
     pestaña sigue abierta, para que una anotación no se quede esperando a
     que alguien recargue la página para desaparecer. */
  useEffect(() => {
    const t = setInterval(() => {
      setMio((cur) => {
        if (!cur) return cur;
        const p = purgarAnotacionesViejas(cur);
        if (p !== cur) guardarRef.current(p);
        return p;
      });
    }, 30 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  /* Si la pestaña se cierra dentro de esos 700 ms, el último cambio se perdía.
     Pasa poco, pero pasa justo en el peor momento: uno anota algo y cierra.
     Al ocultarse la pestaña se fuerza la escritura de lo que quedó pendiente.

     Va con "visibilitychange" y no con "beforeunload" porque en el celular
     cambiar de app no dispara beforeunload, y ese es exactamente el caso que
     se quiere cubrir. */
  useEffect(() => {
    const alOcultar = () => {
      if (document.visibilityState !== "hidden") return;
      const p = pendienteRef.current;
      if (!p) return;
      clearTimeout(guardarTimer.current);
      pendienteRef.current = null;
      escribir(p).catch((e) => console.error("guardar al salir", e));
    };
    document.addEventListener("visibilitychange", alOcultar);
    window.addEventListener("pagehide", alOcultar);
    return () => {
      document.removeEventListener("visibilitychange", alOcultar);
      window.removeEventListener("pagehide", alOcultar);
    };
  });

  // Toda mutación pasa por acá: apila para deshacer y guarda.
  const mutar = (fn) => {
    setMio((cur) => {
      undo.current.push(JSON.stringify(cur));
      if (undo.current.length > 40) undo.current.shift();
      const next = JSON.parse(JSON.stringify(cur));
      fn(next);
      guardar(next);
      return next;
    });
  };
  // ── Agregar una cama ────────────────────────────────────────────────────
  //
  // El pase del Drive es una foto de un momento: si entra alguien después,
  // no hay dónde escribirlo. Esto agrega una cama a la copia privada, en la
  // unidad que se está mirando.
  //
  // Se permite a propósito repetir el número de cama. Pasa de verdad: un
  // paciente que se va y otro que entra a la misma cama en la misma guardia,
  // o una cama que se desdobla. Bloquearlo sería resolver un problema que el
  // servicio no tiene, y crear uno que sí.
  //
  // Dos formas de crearla, según lo que se necesite: vacía, para un ingreso
  // nuevo; o copia del paciente que se está viendo, para cuando lo que se
  // quiere es una segunda versión de la misma ficha (por ejemplo, dejar el
  // pase de la mañana y arrancar el de la tarde sin volver a tipear todo).
  const agregarCama = () => {
    const base = {
      nombre: "", edad: null, sexo: null, mi: "", peso: null, pesoTeorico: null,
      campos: {}, anotaciones: [], infusiones: [], arm: {}, ordenCampos: [],
    };
    base.cama = String((mio[idx] || {}).cama || "");
    base.unidad = uSel;
    base.egresado = false;
    base.sinCompletar = false;
    base.agregada = true;               // marca: no vino del Drive
    mutar((d) => { d.splice(idx + 1, 0, base); });
    setISel(idx + 1);
    setEditando(true);                  // se abre la ficha para completarla
    setEstado("Cama agregada");
  };

  /* ── Enviar un paciente a otra cama ─────────────────────────────────────
     Los movimientos de cama son de las cosas que más pasan en una guardia y
     hasta ahora había que editar la ficha a mano de los dos lados, con el
     riesgo de dejar dos pacientes declarando la misma cama sin darse cuenta.

     La cama viaja con el paciente: lo que se mueve es la ficha entera, y el
     número de cama y la unidad pasan a ser los del destino. Se puede cruzar
     de unidad —de UTI 1 a RECU, por ejemplo—, que es lo que pasa de verdad.

     Si el destino está libre, se muda y listo, sin preguntar. Si está
     ocupado hay que decidir qué pasa con el que estaba, y ahí sí pregunta:
     intercambiarlos, mandarlo a una tercera cama, o marcarlo como egresado.
     Nunca se resuelve solo, porque las tres respuestas son plausibles y
     elegir mal significa perder una ficha entera. */
  const [enviando, setEnviando] = useState(null);   // { destino, choque } | null
  const [trayendo, setTrayendo] = useState(false);  // eligiendo a quién traer a una cama libre

  // La ficha vacía que queda cuando alguien egresa. Es la misma forma que usa
  // marcarEgreso, sacada acá para no repetirla en los dos lugares.
  const fichaVacia = (cama, unidad) => ({
    cama, unidad, egresado: true, agregada: false, sinCompletar: false,
    nombre: "", edad: null, sexo: null, mi: "", peso: null, pesoTeorico: null,
    campos: {}, anotaciones: [], infusiones: [], intermitentes: [],
    pendientes: [], arm: {}, ordenCampos: [], armTexto: "",
    balance: { ingresos: [], egresos: [] },
  });

  // Una cama está ocupada si tiene a alguien que no egresó. Una cama vacía
  // por egreso se puede reusar sin preguntar nada.
  const ocupada = (x) => x && !x.egresado && (x.nombre || "").trim();

  // Paso 1: elegiste el destino. Si está libre se muda directo; si no, se
  // guarda el choque para que la pantalla pregunte qué hacer con el que está.
  const elegirDestino = (j) => {
    if (ocupada(mio[j])) { setEnviando({ destino: j, choque: true }); return; }
    moverA(j, "libre", null);
  };

  // Paso 2: el movimiento en sí. `que` dice qué pasa con el desplazado:
  //   libre        → no había nadie
  //   intercambiar → se va a la cama que dejo yo
  //   tercera      → se va a la cama `otro` que elegiste
  //   egreso       → su ficha se vacía y queda como cama libre
  const moverA = (j, que, otro) => {
    const miCama = mio[idx].cama, miUnidad = mio[idx].unidad;
    const suCama = mio[j].cama, suUnidad = mio[j].unidad;
    mutar((d) => {
      // Los índices se corren en cuanto se borra un elemento, así que primero
      // se agarran las fichas por referencia y recién después se toca el
      // array. Trabajar con índices y splice a la vez es la forma clásica de
      // mover mal a un paciente.
      const yo = d[idx], el = d[j], tercero = otro != null ? d[otro] : null;

      if (que === "intercambiar") {
        el.cama = miCama; el.unidad = miUnidad;
      } else if (que === "tercera" && tercero) {
        el.cama = tercero.cama; el.unidad = tercero.unidad;
        // La tercera cama estaba libre (el selector sólo ofrece libres), así
        // que lo que había ahí era una ficha vacía y sobra.
        d.splice(d.indexOf(tercero), 1);
      } else if (que === "egreso") {
        // El que estaba se fue: su ficha desaparece y la cama la ocupa el que
        // llega. Dejar la ficha vacía además haría que dos renglones declaren
        // la misma cama.
        d.splice(d.indexOf(el), 1);
      } else if (que === "libre") {
        // El destino era una cama vacía. Esa ficha vacía se consume: si no,
        // quedan dos renglones diciendo ser la misma cama, uno con el
        // paciente y otro vacío, y en la barra aparece dos veces.
        d.splice(d.indexOf(el), 1);
      }
      yo.cama = suCama;
      yo.unidad = suUnidad;
    });
    // La vista sigue al paciente movido: si no, desaparece de la pestaña en
    // la que estabas y parece que se perdió. No se puede guardar la ficha por
    // referencia porque mutar clona todo; se lo busca por nombre y cama, que
    // después del movimiento ya lo identifican.
    const miNombre = mio[idx].nombre;
    setUSel(suUnidad);
    setMio((cur) => {
      const k = cur.findIndex((x) => x.cama === suCama && x.unidad === suUnidad && x.nombre === miNombre);
      if (k >= 0) setISel(k);
      return cur;
    });
    setEnviando(null);
    setEstado(
      que === "intercambiar" ? `Intercambiados: ${miCama} ↔ ${suCama}`
      : que === "egreso" ? `Movido a ${suCama}. El paciente de ${suCama} egresó.`
      : `Movido a ${suCama}`
    );
  };

  /* ── Qué se puede hacer con una cama libre ──────────────────────────────
     Una cama vacía no es un error ni un hueco: durante la guardia es un
     lugar donde puede entrar alguien. Las tres salidas son las que pasan de
     verdad — entra un paciente nuevo, se muda uno que ya está, o la cama no
     va más en el pase. */

  // Entra alguien nuevo: la ficha se vacía del todo y se abre para escribir.
  const ingresarPaciente = () => {
    mutar((d) => {
      const c = d[idx].cama, u = d[idx].unidad;
      d[idx] = {
        ...fichaVacia(c, u),
        egresado: false,        // deja de ser cama libre
        agregada: true,         // no vino del Drive
        ingreso: paAhora(),     // queda la marca de cuándo entró
      };
    });
    setEditando(true);
    setEstado("Cama ocupada. Completá la ficha.");
  };

  // Se muda alguien que ya está en otra cama. Su cama anterior queda libre,
  // que es lo que pasa de verdad: el lugar del que se fue no desaparece.
  const traerDe = (j) => {
    const suCama = mio[j].cama, suUnidad = mio[j].unidad;
    const acaCama = mio[idx].cama, acaUnidad = mio[idx].unidad;
    const quien = mio[j].nombre;
    mutar((d) => {
      const el = d[j];
      // La ficha entera se muda: se conserva todo y sólo cambian cama y unidad.
      d[idx] = { ...JSON.parse(JSON.stringify(el)), cama: acaCama, unidad: acaUnidad };
      // Donde estaba, queda una cama libre.
      d[j] = fichaVacia(suCama, suUnidad);
    });
    setTrayendo(false);
    setEstado(`${(quien || "").split(" ").pop()} pasó de ${suCama} a ${acaCama}. La ${suCama} quedó libre.`);
  };

  // La cama no va más. Se saca del pase: si la agregaste vos desaparece y
  // listo; si venía del Drive, vuelve cuando sincronices, y el cartel lo dice.
  const eliminarCama = () => {
    const c = mio[idx].cama;
    mutar((d) => { d.splice(idx, 1); });
    setISel(0);
    setEstado(`Cama ${c} sacada del pase`);
  };

  const deshacer = () => {
    if (!undo.current.length) { setEstado("Nada para deshacer"); return; }
    const prev = JSON.parse(undo.current.pop());
    setMio(prev); guardar(prev);
    setEstado("Deshecho · quedan " + undo.current.length);
  };
  const reiniciar = async () => {
    if (!confirm("Esto borra tus anotaciones y ediciones, y vuelve a traer el pase del Drive.\n\n¿Seguro?")) return;

    /* Antes esto sólo borraba el documento de la nube, y por eso "Borrar mis
       anotaciones y sincronizar pase" podía no servir de nada: la pantalla
       se veía limpia un instante, pero apenas se recargaba la página (o se
       cambiaba de pestaña y se volvía) el efecto de carga encontraba que la
       nube ya no tenía nada, y entonces usaba lo que hubiera en
       localStorage —que seguía teniendo la copia VIEJA, porque acá nunca se
       tocaba— y la traía de vuelta entera: anotaciones incluidas, y con ella
       el naranja de campos que en esta sesión nadie tocó. Cuantas más veces
       se apretaba el botón, más confuso: cada vez se veía limpio un
       segundo y volvía a aparecer lo viejo.

       También podía quedar una escritura pendiente de antes de apretar el
       botón (la que se demora 700 ms para no guardar por cada tecla, ver
       `guardar`): si ese timer llegaba a disparar DESPUÉS del borrado, volvía
       a escribir la copia vieja tanto en la nube como en localStorage, y el
       borrado quedaba deshecho solo, sin que nadie tocara nada.

       Ahora se cancela cualquier guardado pendiente, se borra la nube Y el
       localStorage de esta copia, en ese orden, antes de mostrar nada como
       terminado. */
    clearTimeout(guardarTimer.current);
    pendienteRef.current = null;

    const limpio = JSON.parse(JSON.stringify(foto.pacientes));
    undo.current = [];
    setMio(limpio);
    // Esto sí es un resync a propósito: acá la foto congelada se vuelve a
    // fijar en la más nueva, porque el pedido explícito es "traeme lo que
    // diga el Drive ahora".
    setFotoBase(foto);

    try { await deleteDoc(doc(db, PASEAPP_COL, docId)); } catch (e) { /* si no existía, da igual */ }
    try { if (claveLocal) localStorage.removeItem(claveLocal); } catch (e) { /* sin espacio o modo privado: da igual */ }

    setEstado("Pase sincronizado y anotaciones borradas");
  };

  /* No se pudo leer la copia propia. Se corta acá a propósito: mostrar el
     pase del Drive sería hacerle creer a alguien que perdió lo que anotó, y
     la primera tecla que tocara encima pisaría la copia buena. */
  if (fallo) return (
    <div style={{ maxWidth: 620, margin: "24px auto", background: "#FEF2F2", border: "1.5px solid #FCA5A5", borderRadius: 10, padding: "18px 20px" }}>
      <div style={{ fontSize: 16, fontWeight: 800, color: "#7F1D1D" }}>No pude leer tus anotaciones</div>
      <div style={{ fontSize: 13.5, color: "#7F1D1D", lineHeight: 1.6, marginTop: 8 }}>
        Tus ediciones <b>no se perdieron</b>: están guardadas en tu cuenta. Lo que falló fue traerlas
        recién ahora. No te muestro el pase sin editar para que no parezca que se borró todo, y para
        que nada de lo que escribas encima las pise.
      </div>
      <div style={{ fontSize: 11.5, color: "#991B1B", marginTop: 8, fontFamily: "ui-monospace,monospace" }}>{fallo}</div>
      {/* El error de permisos tiene una causa concreta y una solución concreta;
          decirla acá evita que alguien crea que perdió el trabajo de la guardia. */}
      {/permission|insufficient/i.test(fallo || "") && (
        <div style={{ fontSize: 12.5, color: "#7F1D1D", lineHeight: 1.55, marginTop: 8, background: "#fff", border: "1px solid #FCA5A5", borderRadius: 6, padding: "9px 11px" }}>
          Esto no es la conexión: la base está rechazando la lectura. Hay que revisar las reglas de
          Firestore en la consola de Firebase. Avisale a Gonzalo.
        </div>
      )}
      <button onClick={() => setReintento((n) => n + 1)}
        style={{ marginTop: 14, fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, padding: "9px 16px", borderRadius: 6, border: "none", background: "#B91C1C", color: "#fff", cursor: "pointer" }}>
        Reintentar
      </button>
    </div>
  );

  if (cargando || !mio || !foto || !fotoBase) return <Skeleton />;

  // La tira de camas va ordenada por número de cama, no por la posición que
  // la ficha tiene en el array. Antes seguía el orden del array y al mover a
  // alguien de unidad aparecía último de la fila aunque su cama fuera la 1.1:
  // uno recorre la sala por número, así que la barra tiene que leerse igual.
  //
  // El orden es natural: "1.2" va antes que "1.10", y "R3" antes que "R12".
  // Comparar como texto pondría "1.10" antes que "1.2", que es como ordena
  // una computadora y no como cuenta una persona.
  const idxUnidad = mio
    .map((p, i) => [p, i])
    .filter(([p]) => p.unidad === uSel)
    .sort(([a], [b]) => paCamaOrden(a.cama).localeCompare(paCamaOrden(b.cama)))
    .map(([, i]) => i);
  const idx = idxUnidad.includes(iSel) ? iSel : (idxUnidad[0] ?? 0);
  /* El paciente tal como vino del Drive, para poder marcar en naranja lo que
     uno cambió.

     Se busca POR CAMA Y UNIDAD, no por posición en la lista. Antes era
     foto.pacientes[idx], que asume que tu copia y la foto del Drive tienen
     exactamente el mismo orden y la misma cantidad de camas. Deja de ser
     cierto apenas alguien agrega una cama, manda un paciente a otra unidad o
     —como pasó el 2/9/2026— el pase del Drive cambia y una UTI pasa de ocho
     camas a seis: los índices se corren y la app termina comparando la ficha
     de un paciente contra la de otro. Como todo difiere, TODO sale marcado
     como editado, y el naranja deja de querer decir algo.

     Buscar por cama es estable frente a todo eso. Si la cama no está en la
     foto —una que agregaste vos, o una que el Drive ya no trae— no hay contra
     qué comparar y no se marca nada, que es lo correcto.

     Y se busca en `fotoBase` —la foto CONGELADA al momento de cargar tu
     copia— y no en `foto`, que sigue viva con cada resync. Si se buscara en
     `foto`, un resync a mitad de guardia que cambie un dato en el Drive haría
     aparecer naranja en un campo que vos nunca tocaste, porque de golpe tu
     copia (vieja, intacta) pasaría a diferir de un original que cambió
     debajo. Con `fotoBase` fija, naranja quiere decir siempre "esto lo
     edité yo", sin excepción. */
  const yo_ = mio[idx] || {};
  const o = fotoBase.pacientes.find((x) => x.cama === yo_.cama && x.unidad === yo_.unidad) || {};
  const p = verOriginal ? o : (mio[idx] || {});
  const editable = !verOriginal;

  // Todas las camas del pase, para el selector de destino de "Enviar a otra
  // cama". Se ofrecen las de todas las unidades porque los traslados entre
  // sectores son moneda corriente; la propia queda afuera, que mandarse a uno
  // mismo no es nada.
  //
  // Va DESPUÉS del return de arriba a propósito: depende de `mio`, que arranca
  // en null mientras carga, y de `idx`, que se calcula acá. Tenerlo antes hacía
  // que la pestaña entera se cayera al abrirla —React desmonta el árbol y
  // queda la pantalla de un solo color— antes siquiera de tocar nada.
  const destinos = mio
    .map((x, i) => ({ i, cama: x.cama, unidad: x.unidad, quien: ocupada(x) ? x.nombre : null }))
    .filter((c) => c.i !== idx);
  // Orden de las secciones. Por defecto el clínico (antecedentes, enfermedad
  // actual, requerimientos, tratamiento...), pero cada uno puede subir o bajar
  // las que mira primero. Queda guardado en la copia privada, así que el orden
  // de uno no le cambia la pantalla a nadie.
  const presentes = PA_ORDEN.filter((k) => p.campos && p.campos[k] !== undefined);
  const guardado = (p.ordenCampos || []).filter((k) => presentes.includes(k));
  const campos = [...guardado, ...presentes.filter((k) => !guardado.includes(k))];

  /* Subir o bajar una sección. El orden se aplica a TODOS los pacientes, no
     sólo al que estabas mirando: es una preferencia de cómo querés leer el
     pase, no un dato de ese paciente. Acomodarlo cama por cama sería una
     tarea de veinticinco pasos para conseguir una sola cosa.

     Sigue siendo privado: vive en la copia de cada uno, así que el orden de
     uno no le cambia la pantalla a nadie. */
  const moverCampo = (k, paso) => mutar((d) => {
    const act = [...campos];
    const i = act.indexOf(k), j = i + paso;
    if (i < 0 || j < 0 || j >= act.length) return;
    [act[i], act[j]] = [act[j], act[i]];
    for (const x of d) {
      // Cada paciente tiene sus propias secciones —no todos traen EAB, por
      // ejemplo—, así que se guarda el orden elegido y después las que ese
      // paciente sí tiene se ordenan según él.
      x.ordenCampos = act;
    }
  });

  // Cambiar dilución o ritmo de una infusión. Se guarda en la copia propia y
  // la dosis se recalcula sola: si en la guardia se sube el goteo, el número
  // que se ve tiene que ser el de ahora, no el que quedó escrito en el Drive.
  const cambiarInfusion = (k, campo, valor) => mutar((d) => {
    const inf = d[idx].infusiones?.[k];
    if (!inf) return;
    inf[campo] = valor === "" ? "" : Number(valor);
    // La dosis que venía anotada en el pase deja de aplicar apenas se toca el
    // goteo: si no, el cartel de "no coincide" compara contra un valor viejo.
    inf.declarada = null;
    inf.tocada = true;

    // Y se reescribe el renglón del pase, para que el texto y la dosis no digan
    // cosas distintas.
    //
    // Se hace por líneas y reconstruyendo la línea entera, no con un replace
    // sobre todo el texto: React puede correr este updater dos veces y un
    // replace que se aplique dos veces deja el número viejo pegado al nuevo
    // ("200/250/16200/250/32"). Reconstruir la línea es idempotente.
    const c = inf.campoReal;
    const texto = d[idx].campos?.[c];
    if (c && texto && inf.mg !== "" && inf.ml !== "" && inf.ritmo !== "") {
      const nuevo = `${inf.mg}/${inf.ml}/${inf.ritmo}`;
      const tri = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/;
      d[idx].campos[c] = texto.split("\n").map((linea) => {
        if (!tri.test(linea)) return linea;
        // ¿esta línea es la de esta droga? El nombre puede estar prolijado
        // ("Ketamina") o crudo ("KETA"), así que se aceptan las dos formas.
        const prim = (linea.trim().split(/\s+/)[0] || "").toUpperCase();
        const esta = PA_INFUS[prim] === inf.droga ||
          prim === inf.droga.toUpperCase() ||
          (prim === "NA" && inf.droga === "Noradrenalina");
        return esta ? linea.replace(tri, nuevo) : linea;
      }).join("\n");
    }
  });

  // Mover un renglón dentro de una sección. El texto de cada campo es un bloque
  // de líneas; reordenar es mover la línea y volver a pegar.
  // Egreso: el paciente se fue y el pase del Drive todavía lo muestra. No se
  // borra el renglón —la cama sigue existiendo y saber que quedó libre es
  // justamente el dato útil a las tres de la mañana— sino que se le vacía
  // todo: campos, dosis, pendientes, balance y anotaciones. Queda la cama con
  // el cartel de vacía.
  //
  // Esto vive solo en tu copia. Cuando entre un pase nuevo del Drive con el
  // paciente ya dado de alta, "borrar mis anotaciones y sincronizar" limpia
  // todo y vuelve a arrancar de la foto.
  const marcarEgreso = () => {
    mutar((d) => {
      const x = d[idx];
      x.egresado = true;
      x.nombre = "";
      x.edad = null;
      x.sexo = null;
      x.mi = "";
      x.peso = null;
      x.pesoTeorico = null;
      x.campos = {};
      x.infusiones = [];
      x.intermitentes = [];
      x.pendientes = [];
      x.anotaciones = [];
      x.balance = { ingresos: [], egresos: [] };
      x.armTexto = "";
      x.sinCompletar = false;
    });
    setConfirmandoEgreso(false);
    setEditando(false);
  };

  // Pintar o despintar un renglón. El color se guarda dentro del texto, así
  // que viaja con el campo y no hay una estructura aparte que mantener.
  /* Pinta lo que el usuario acaba de seleccionar.

     El navegador informa la selección como "nodo + desplazamiento dentro de
     ese nodo", que no sirve para tocar el texto: hay que saber en qué caracter
     del campo cae. Por eso cada tramo se dibuja con su posición de arranque en
     data-i; se sube desde el nodo seleccionado hasta el tramo que lo contiene,
     se le suma el desplazamiento, y eso sí es un índice de caracter.

     Con colorSel en null la selección se despinta, que es como se saca un
     resaltado sin tener que acordarse de qué color era. */
  const pintarSeleccion = (k) => {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const posicion = (nodo, off) => {
      let el = nodo && nodo.nodeType === 3 ? nodo.parentElement : nodo;
      while (el && (!el.dataset || el.dataset.i === undefined)) el = el.parentElement;
      if (!el) return null;
      return +el.dataset.i + off;
    };
    const a = posicion(sel.anchorNode, sel.anchorOffset);
    const b = posicion(sel.focusNode, sel.focusOffset);
    if (a == null || b == null) return;
    const desde = Math.min(a, b), hasta = Math.max(a, b);
    if (hasta <= desde) return;
    mutar((d) => {
      d[idx].campos[k] = paPintarRango(d[idx].campos[k] || "", desde, hasta, colorSel);
    });
    sel.removeAllRanges();   // si no, queda la selección azul encima del color
  };

  const moverLinea = (k, i, paso) => mutar((d) => {
    const ls = (d[idx].campos[k] || "").split("\n");
    const j = i + paso;
    if (j < 0 || j >= ls.length) return;
    [ls[i], ls[j]] = [ls[j], ls[i]];
    d[idx].campos[k] = ls.join("\n");
  });

  // Dónde van las dosis calculadas. Lo natural es debajo de Tratamiento, pero
  // hay pacientes que no tienen campo TTO en el Drive y llevan las infusiones
  // escritas en enfermedad actual (1.1, 1.4, 2.5, 3.2, 3.7 al momento de
  // escribir esto). Si se anclaran a "tto" a secas, esos cinco se quedarían sin
  // ninguna dosis a la vista, que es justo el dato que hay que mirar. Cuando no
  // hay tto se muestran en un bloque aparte al final, no colgadas del último
  // campo que haya quedado, porque leer las dosis abajo de "Accesos" confunde.
  const hayTto = campos.includes("tto");

  const editarCampo = (k, txt) => mutar((d) => {
    // Reponer los marcadores de negrita en cultivos: se le sacan al usuario
    // mientras edita y se vuelven a poner al guardar, mirando renglón por
    // renglón si empieza con "fecha muestra:".
    if (k === "cultivos" && !txt.includes("«")) {
      txt = txt.split("\n").map((l) => {
        const m = l.match(/^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+[A-Za-zÁÉÍÓÚÑ][\w.]*)?)\s*:\s*/);
        return m ? `«${m[1]}:» ` + l.slice(m[0].length) : l;
      }).join("\n");
    }
    // Lo que se escribe a mano también se acomoda al formato *fecha ... :
    // así el renglón agregado durante la guardia queda igual que los que
    // vinieron del Drive, sin tener que acordarse de poner el asterisco.
    if (k === "labo" || k === "eab" || k === "estudios") txt = paFormatoAsterisco(txt);
    // Reponer los resaltados. Mientras se edita el campo se muestra sin
    // marcas, así que lo que vuelve del contentEditable no las trae; se
    // vuelven a poner por posición de renglón. Si agregaste o borraste
    // renglones el resaltado puede correrse: es el precio de que el color
    // viva dentro del texto, y se arregla volviendo a marcar.
    const previas = (d[idx].campos[k] || "").split("\n").map((l) => paMarcaDe(l).color);
    if (previas.some(Boolean)) {
      txt = txt.split("\n").map((l, i) => (previas[i] ? paMarcar(l, previas[i]) : l)).join("\n");
    }
    d[idx].campos[k] = txt;
  });

  // Settings de ARM del paciente que se está mirando. Si todavía no se tocó
  // nada, se precargan los que el propio pase trae escritos.
  const armDe = (i) => {
    if (arm[i]) return arm[i];
    const leido = paLeerArm((mio[i] || {}).armTexto);
    return leido || {};
  };
  const setArmDe = (i, campo, valor) =>
    setArm((s) => ({ ...s, [i]: { ...armDe(i), [campo]: valor } }));
  // En el celular los botones chicos se erran con el pulgar. 32 px de lado es
  // el mínimo que se acierta parado en un pasillo; en pantalla grande el
  // mouse no lo necesita y quedarían desproporcionados.
  const FLECHA = { fontFamily: "inherit", fontSize: chico ? 14 : 11, lineHeight: 1,
    padding: chico ? "0" : "3px 6px", width: chico ? 32 : undefined, height: chico ? 32 : undefined,
    flex: chico ? "0 0 auto" : undefined,
    borderRadius: 4, border: "1.5px solid #E2E8F0", background: "#fff", color: "#64748B", cursor: "pointer" };
  const B = { fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 5, border: "1.5px solid #E2E8F0", background: "#fff", color: "#0F172A", cursor: "pointer" };
  const BP = { ...B, background: "#0F5F66", borderColor: "#0F5F66", color: "#fff" };
  const ROT = { fontFamily: "ui-monospace,monospace", fontSize: 10.5, fontWeight: 600, letterSpacing: ".09em", textTransform: "uppercase" };
  const caja = { background: "#fff", border: "1px solid #E2E8F0", borderRadius: 8, marginBottom: 12, overflow: "hidden" };

  const Plegable = ({ k, titulo, color, n, children }) => (
    <div style={{ ...caja, borderLeft: color ? `4px solid ${color}` : caja.border }}>
      <div onClick={() => setPlegado((s) => ({ ...s, [k]: !s[k] }))}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", cursor: "pointer", userSelect: "none" }}>
        <span style={{ fontSize: 10, color: "#64748B", transform: plegado[k] ? "rotate(-90deg)" : "none", transition: "transform .15s" }}>▼</span>
        <span style={{ ...ROT, fontWeight: 800, fontSize: 11.5, color: color || "#334155" }}>{titulo}</span>
        {n > 0 && <span style={{ background: color || "#64748B", color: "#fff", borderRadius: 9, padding: "0 6px", fontSize: 10, fontFamily: "ui-monospace,monospace" }}>{n}</span>}
      </div>
      {!plegado[k] && <div style={{ padding: "0 14px 13px" }}>{children}</div>}
    </div>
  );

  const totalBal = (lista) => (lista || []).reduce((s, x) => s + (Number(x.ml) || 0), 0);
  const ing = totalBal(p.balance?.ingresos), egr = totalBal(p.balance?.egresos);

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <span style={{ fontSize: 22 }}>🩺</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3, display: "flex", alignItems: "center", gap: 7 }}>
            Pase App
            <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: ".08em", background: "#B45309", padding: "2px 6px", borderRadius: 3 }}>ALPHA</span>
          </div>
          <div style={{ fontSize: 10.5, opacity: 0.6 }}>
            {/* Se muestra `fotoBase` —la foto CONGELADA, la misma contra la
                que se compara el naranja— y no `foto`, que sigue viva con
                cada resync de la pestaña Pases. Mostrar la última resincronizada
                acá confundía: decía una hora posterior a tus propias ediciones,
                como si el pase se hubiera actualizado encima tuyo, cuando en
                realidad tu copia seguía intacta. Esta hora es la del pase que
                tu copia realmente tiene adentro. */}
            Foto del Drive {fotoBase.tomado ? new Date(fotoBase.tomado).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"} · {mio.length} camas · tu copia privada
          </div>
        </div>
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7 }}>{estado}</span>
      </div>

      {/* Lo que se está escribiendo NO se está guardando. Va arriba de todo,
          en rojo y ocupando el ancho: es la única forma de que alguien en el
          medio de un pase lo registre antes de seguir anotando media hora al
          vacío. */}
      {noGuarda && (
        <div className="no-print" style={{ background: "#B91C1C", color: "#fff", borderRadius: 8, padding: "12px 15px", marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>⚠ No se está guardando lo que escribís</div>
          <div style={{ fontSize: 13, lineHeight: 1.55, marginTop: 5, opacity: 0.95 }}>
            Lo que anotes ahora se pierde al cerrar la pestaña. Sacale una foto a lo importante
            y avisale a Gonzalo antes de seguir.
          </div>
          <div style={{ fontSize: 11.5, fontFamily: "ui-monospace,monospace", marginTop: 6, opacity: 0.85 }}>{noGuarda}</div>
        </div>
      )}

      <div className="no-print" style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
        <button onClick={deshacer} style={B}>↶ Deshacer</button>
        <button onClick={reiniciar} style={B}>Borrar mis anotaciones y sincronizar pase</button>
        <button onClick={() => setViendoCopias((v) => !v)} style={B}>
          Mis copias guardadas
        </button>
        {/* Imprime la unidad que se está mirando con el mismo formato y las
            mismas palabras que la pestaña Pases, más los pendientes y las
            dosis calculadas. Se abre en una ventana aparte donde se puede
            editar antes de mandar a la impresora. */}
        <button onClick={() => imprimirPase(mio.filter((x) => x.unidad === uSel), uSel, fotoBase.tomado)}
          style={B}>Imprimir pase de {uSel}</button>
        <label style={{ ...B, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={verOriginal} onChange={(e) => setVerOriginal(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: "#0F5F66", margin: 0 }} />
          Ver original sin modificaciones
        </label>
      </div>

      <div className="no-print" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 9 }}>
        {foto.unidades.map((u) => {
          const g = mio.filter((x) => x.unidad === u);
          return (
            <button key={u} onClick={() => { setUSel(u); setISel(mio.findIndex((x) => x.unidad === u)); }}
              style={{ ...B, fontSize: 13, fontWeight: 700, ...(u === uSel ? { background: "#0F172A", borderColor: "#0F172A", color: "#fff" } : {}) }}>
              {/* Solo la cantidad de camas. El contador de pendientes por unidad
                  no servía para decidir nada: los pendientes son de cada
                  paciente y se ven en su ficha. */}
              {u} <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 10, opacity: 0.7 }}>{g.length}</span>
            </button>
          );
        })}
      </div>

      <div className="no-print" style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8, marginBottom: 10 }}>
        {idxUnidad.map((i) => {
          const x = mio[i];
          const pend = (x.pendientes || []).filter((y) => !y.listo).length;
          // Una cama de la que se fue el paciente sigue en la barra, pero
          // antes quedaba como un botón con el número y nada debajo: se leía
          // como un hueco y parecía que la cama había desaparecido. Ahora lo
          // dice, y con borde punteado, que es como se ve un lugar libre.
          const libre = !!x.egresado;
          return (
            <button key={i} onClick={() => setISel(i)}
              title={libre ? "Cama libre" : undefined}
              style={{ flex: "0 0 auto", fontFamily: "ui-monospace,monospace", fontSize: 16, fontWeight: 700,
                padding: "7px 13px", borderRadius: 5, cursor: "pointer",
                border: libre ? "1.5px dashed #CBD5E1" : "1.5px solid #E2E8F0",
                background: i === idx ? "#0F5F66" : (libre ? "#F8FAFC" : "#fff"),
                color: i === idx ? "#fff" : (libre ? "#94A3B8" : "#334155") }}>
              {x.cama}{pend ? " •" : ""}
              {/* El apellido entero: cortarlo a ocho letras hacía que dos
                  pacientes distintos se vieran igual en la barra. */}
              <span style={{ display: "block", fontSize: 11.5, fontWeight: 600, opacity: 0.85, fontFamily: "inherit",
                fontStyle: libre ? "italic" : "normal" }}>
                {libre ? "libre" : (x.nombre || "").split(" ").pop()}
              </span>
            </button>
          );
        })}
      </div>

      {viendoCopias && (
        <div className="no-print" style={{ background: "#fff", border: "1.5px solid #CBD5E1", borderRadius: 8, padding: "14px 16px", marginBottom: 12 }}>
          <div style={{ fontSize: 14.5, fontWeight: 800, marginBottom: 4 }}>Mis copias guardadas</div>
          <div style={{ fontSize: 12.5, color: "#475569", lineHeight: 1.55, marginBottom: 10 }}>
            Cada vez que el pase del Drive cambia de día, tus anotaciones quedan guardadas aparte.
            Si algo que escribiste no aparece, buscalo acá y traelo.
          </div>
          {copias === null ? (
            <div style={{ fontSize: 13, color: "#64748B" }}>Buscando…</div>
          ) : copias.length === 0 ? (
            <div style={{ fontSize: 13, color: "#64748B" }}>No encontré ninguna copia guardada en tu cuenta.</div>
          ) : copias.map((c) => {
            const conTexto = c.pacientes.filter((x) => (x.anotaciones || []).length ||
              Object.values(x.campos || {}).some(Boolean)).length;
            const esLaDeAhora = c.id === docId;
            return (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "9px 0", borderTop: "1px solid #F1F5F9" }}>
                <div style={{ flex: 1, minWidth: 190 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                    Pase del {c.fecha.split("-").reverse().join("/")}
                    {esLaDeAhora && <span style={{ fontSize: 11, fontWeight: 700, color: "#166534", background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 999, padding: "1px 8px", marginLeft: 7 }}>la que estás viendo</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: "#64748B" }}>
                    {c.pacientes.length} camas · {conTexto} con contenido
                    {c.guardadoEn && " · guardada " + new Date(c.guardadoEn).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
                {!esLaDeAhora && (
                  <button onClick={() => restaurarCopia(c)} style={B}>Traer estas anotaciones</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {verOriginal && (
        <div style={{ padding: "9px 13px", borderRadius: 6, background: "#FFF6E5", border: "1px solid #E9C48A", color: "#8A4B00", fontSize: 12.5, fontWeight: 600, marginBottom: 12 }}>
          Viendo la foto original del Drive, sin tus cambios. Destildá arriba para volver a tu versión.
        </div>
      )}

      <Plegable k="anot" titulo="Anotaciones de este paciente durante la guardia" color="#8A4B00" n={(p.anotaciones || []).length}>
        {editable && (
          <>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
              {PA_TIPOS.map((t) => (
                <button key={t} onClick={() => setTipoSel(t)}
                  style={{ fontFamily: "ui-monospace,monospace", fontSize: 10.5, fontWeight: 600, padding: "5px 9px", borderRadius: 4, border: "1.5px solid #E9C48A", cursor: "pointer", background: t === tipoSel ? "#8A4B00" : "transparent", color: t === tipoSel ? "#fff" : "#8A4B00" }}>{t}</button>
              ))}
            </div>
            <NuevaAnotacion onAdd={(txt) => mutar((d) => {
              d[idx].anotaciones = d[idx].anotaciones || [];
              // `ts` es la hora completa (fecha + hora), para poder calcular
              // cuándo cumple las 26 h y se borra sola. `hora` sigue siendo
              // sólo para mostrar, como antes.
              d[idx].anotaciones.push({
                hora: new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }),
                ts: new Date().toISOString(),
                tipo: tipoSel, texto: txt,
              });
            })} />
          </>
        )}
        {(p.anotaciones || []).length === 0
          ? <div style={{ fontSize: 13, color: "#64748B", fontStyle: "italic" }}>Todavía no anotaste nada de este paciente.</div>
          : (p.anotaciones || []).map((x, k) => (
            <div key={k} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "8px 0", borderTop: k ? "1px solid #F1F5F9" : "none" }}>
              <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 11, color: "#8A4B00", paddingTop: 2 }}>{x.hora}</span>
              <span style={{ flex: 1, fontSize: 14 }}>
                <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 9, border: "1px solid #E9C48A", color: "#8A4B00", borderRadius: 3, padding: "1px 5px", marginRight: 6 }}>{x.tipo}</span>
                {x.texto}
              </span>
              {editable && <span onClick={() => mutar((d) => { d[idx].anotaciones.splice(k, 1); })} style={{ cursor: "pointer", color: "#94A3B8" }}>×</span>}
            </div>
          ))}
      </Plegable>

      {/* Cama libre: el paciente egresó y todavía no llegó el pase nuevo del
          Drive. Se muestra la cama vacía en vez de sacarla de la lista, porque
          saber que hay lugar es información útil durante la guardia. */}
      {p.egresado ? (
        <div style={{ ...caja, borderStyle: "dashed", background: "#F8FAFC", padding: "26px 18px", textAlign: "center" }}>
          {/* El número de cama se edita acá mismo: una cama que agregaste nace
              con el número de la que estabas mirando y casi siempre hay que
              corregirlo, y no tenía sentido obligar a abrir la ficha para eso. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
            {editable ? (
              <input value={p.cama || ""} onChange={(e) => mutar((d) => { d[idx].cama = e.target.value; })}
                title="Número de cama"
                style={{ width: 92, textAlign: "center", fontFamily: "ui-monospace,monospace", fontSize: 20, fontWeight: 800, color: "#475569", padding: "3px 6px", border: "1.5px solid #CBD5E1", borderRadius: 5, background: "#fff" }} />
            ) : (
              <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 20, fontWeight: 800, color: "#94A3B8" }}>{p.cama}</div>
            )}
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: "#475569", marginTop: 7 }}>Cama libre</div>
          <div style={{ fontSize: 12.5, color: "#64748B", marginTop: 5, lineHeight: 1.5, maxWidth: 440, margin: "5px auto 0" }}>
            {p.agregada
              ? <>La agregaste vos durante la guardia. No existe en el pase del Drive.</>
              : <>La sacaste vos durante la guardia. El pase del Drive todavía la muestra ocupada;
                 cuando entre un pase nuevo, con <b>“Borrar mis anotaciones y sincronizar pase”</b> vuelve
                 lo que diga el Drive.</>}
          </div>

          {editable && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 14 }}>
              <button onClick={ingresarPaciente} style={{ ...B, fontWeight: 700 }}>
                Ingresar nuevo paciente
              </button>
              <button onClick={() => setTrayendo(true)} style={B}>
                Traer paciente de otra cama
              </button>
              <button onClick={() => eliminarCama()} style={{ ...B, color: "#B91C1C", border: "1.5px solid #FCA5A5" }}>
                Eliminar cama del pase
              </button>
              {/* Sólo tiene sentido si la cama venía del Drive: una cama que
                  agregaste vos no tiene datos a los que volver. Se usa `o`
                  —la misma búsqueda por cama y unidad de más arriba, sobre
                  la foto CONGELADA— en vez de foto.pacientes[idx]: buscar por
                  posición asume que tu copia y la foto del Drive tienen el
                  mismo orden, y ya causó que esto trajera los datos de otro
                  paciente. */}
              {!p.agregada && o.cama && (
                <button onClick={() => mutar((d) => { d[idx] = JSON.parse(JSON.stringify(o)); })}
                  style={B}>Traer de nuevo los datos del pase</button>
              )}
            </div>
          )}

          {/* Traer a alguien de otra cama: la lista de los que hay, y al
              elegir uno se muda acá y su cama anterior queda libre. */}
          {editable && trayendo && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #CBD5E1", textAlign: "left" }}>
              <div style={{ fontSize: 12.5, color: "#475569", marginBottom: 8 }}>
                ¿A quién traés a la cama <b>{p.cama}</b>?
              </div>
              {(() => {
                const gente = mio
                  .map((x, i) => ({ i, x }))
                  .filter(({ i, x }) => i !== idx && ocupada(x))
                  .sort((a, b) => paCamaOrden(a.x.cama).localeCompare(paCamaOrden(b.x.cama)));
                if (!gente.length) return (
                  <div style={{ fontSize: 12.5, color: "#64748B" }}>No hay ningún paciente cargado en otra cama.</div>
                );
                return (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 190, overflowY: "auto" }}>
                    {gente.map(({ i, x }) => (
                      <button key={i} onClick={() => traerDe(i)}
                        style={{ fontFamily: "ui-monospace,monospace", fontSize: 13, fontWeight: 700, padding: "6px 10px", borderRadius: 5, cursor: "pointer", border: "1.5px solid #CBD5E1", background: "#fff", color: "#334155", textAlign: "left" }}>
                        {x.cama}
                        <span style={{ display: "block", fontSize: 10.5, fontWeight: 600, opacity: 0.8, fontFamily: "inherit" }}>
                          {x.unidad} · {(x.nombre || "").split(" ").pop()}
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })()}
              <button onClick={() => setTrayendo(false)} style={{ ...B, marginTop: 10 }}>Cancelar</button>
            </div>
          )}
        </div>
      ) : (
      <>
      <div style={caja}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid #E2E8F0" }}>
          {/* Identificación editable. El pase del Drive escribe mal los nombres
              a menudo ("MEONIZ GRACIELA, F, 73 AÑOS") y los pacientes cambian de
              cama y de unidad durante la guardia, que es justo cuando esta
              pantalla se usa. Editar acá no toca el Drive: queda en la copia
              propia, como todo lo demás. */}
          {editando ? (
            <div style={{ display: "grid", gap: 7, marginBottom: 4 }}>
              <input value={p.nombre || ""} placeholder="Nombre y apellido"
                onChange={(e) => mutar((d) => { d[idx].nombre = e.target.value; })}
                style={{ fontSize: 16, fontWeight: 700, padding: "6px 8px", border: "1.5px solid #CBD5E1", borderRadius: 5, fontFamily: "inherit" }} />
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                <label style={{ fontSize: 11.5, color: "#64748B", display: "flex", alignItems: "center", gap: 5 }}>
                  Edad
                  <input type="number" value={p.edad || ""} onChange={(e) => mutar((d) => { d[idx].edad = e.target.value ? +e.target.value : null; })}
                    style={{ width: 62, fontFamily: "ui-monospace,monospace", fontSize: 13, padding: "4px 6px", border: "1.5px solid #CBD5E1", borderRadius: 4 }} />
                </label>
                <label style={{ fontSize: 11.5, color: "#64748B", display: "flex", alignItems: "center", gap: 5 }}>
                  Sexo
                  <select value={p.sexo || ""} onChange={(e) => mutar((d) => { d[idx].sexo = e.target.value || null; })}
                    style={{ fontFamily: "inherit", fontSize: 13, padding: "4px 6px", border: "1.5px solid #CBD5E1", borderRadius: 4 }}>
                    <option value="">—</option><option value="femenino">femenino</option><option value="masculino">masculino</option>
                  </select>
                </label>
                <label style={{ fontSize: 11.5, color: "#64748B", display: "flex", alignItems: "center", gap: 5 }}>
                  Cama
                  <input value={p.cama || ""} onChange={(e) => mutar((d) => { d[idx].cama = e.target.value; })}
                    style={{ width: 68, fontFamily: "ui-monospace,monospace", fontSize: 13, padding: "4px 6px", border: "1.5px solid #CBD5E1", borderRadius: 4 }} />
                </label>
                <label style={{ fontSize: 11.5, color: "#64748B", display: "flex", alignItems: "center", gap: 5 }}>
                  Unidad
                  {/* Al mover a otro sector, la vista lo sigue: si no, el
                      paciente desaparece de la pestaña en la que estabas y
                      parece que se perdió. */}
                  <select value={p.unidad || ""} onChange={(e) => { const u = e.target.value; mutar((d) => { d[idx].unidad = u; }); setUSel(u); setISel(idx); }}
                    style={{ fontFamily: "inherit", fontSize: 13, padding: "4px 6px", border: "1.5px solid #CBD5E1", borderRadius: 4 }}>
                    {foto.unidades.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </label>
              </div>
              <div>
                <button onClick={() => setEditando(false)} style={{ ...B, background: "#0F172A", color: "#fff", borderColor: "#0F172A" }}>Listo</button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: -0.2 }}>{p.nombre}</div>
                {editable && (
                  <button onClick={() => setEditando(true)} title="Corregir nombre, edad, cama o unidad"
                    style={{ background: "none", border: "none", color: "#64748B", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>editar ficha</button>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: "#64748B", marginTop: 3 }}>
                {p.edad ? `${p.edad} años` : ""}{p.sexo ? ` · ${p.sexo}` : ""}
              </div>
            </>
          )}
          {/* Motivo de ingreso: es lo primero que uno lee para ubicarse en el
              paciente, así que va destacado y con la fecha separada del texto
              en vez de perdida adelante en gris chico. */}
          {p.mi && (() => {
            const m = (p.mi || "").match(/^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*[:\-]?\s*/);
            const fecha = m ? m[1] : "";
            const texto = m ? p.mi.slice(m[0].length) : p.mi;
            return (
              <div style={{ display: "flex", gap: 11, alignItems: "baseline", marginTop: 9, padding: "11px 13px", background: "#F8FAFC", borderLeft: "4px solid #94A3B8", borderRadius: 5 }}>
                {fecha && (
                  <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 16, fontWeight: 800, color: "#334155", whiteSpace: "nowrap" }}>{fecha}</span>
                )}
                <span style={{ fontSize: 17.5, fontWeight: 800, color: "#0F172A", lineHeight: 1.4, letterSpacing: -0.2 }}>{texto}</span>
              </div>
            );
          })()}
          {/* Sacar al paciente: arriba, junto a los datos de la cama, que es
              donde uno mira cuando alguien se va. Con confirmación, porque es
              la única acción de esta pantalla que borra datos de golpe. */}
          {editable && (
            confirmandoEgreso ? (
              <div style={{ marginTop: 10, padding: "11px 13px", borderRadius: 6, border: "1px solid #FCA5A5", background: "#FEF2F2" }}>
                <div style={{ fontSize: 13.5, color: "#7F1D1D", lineHeight: 1.55 }}>
                  ¿Sacar a <b>{p.nombre || "este paciente"}</b> de la cama <b>{p.cama}</b>?
                  Se borran de tu copia los antecedentes, el tratamiento, las dosis, los pendientes,
                  el balance y tus anotaciones. La cama queda como libre.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <button onClick={marcarEgreso} style={{ ...B, background: "#B91C1C", borderColor: "#B91C1C", color: "#fff" }}>Sí, se fue</button>
                  <button onClick={() => setConfirmandoEgreso(false)} style={B}>Cancelar</button>
                </div>
              </div>
            ) : null
          )}

          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 9, alignItems: "center" }}>
            <span style={{ fontSize: 11.5, border: "1px solid #E2E8F0", borderRadius: 4, padding: "3px 8px" }}>
              Cama <b style={{ fontFamily: "ui-monospace,monospace" }}>{p.cama}</b>
              {/* Se busca esta cama por su NÚMERO en toda la foto congelada
                  (no por posición ni por la unidad actual, que ya puede
                  haber cambiado) para saber en qué unidad la tenía el Drive
                  originalmente. */}
              {(() => {
                const oCama = fotoBase.pacientes.find((x) => x.cama === p.cama);
                return oCama && p.unidad !== oCama.unidad && (
                  <b style={{ color: "#8A4B00", marginLeft: 5 }}>· movido a {p.unidad}</b>
                );
              })()}
            </span>
            {/* Los dos pesos, uno al lado del otro. El real estimado manda en
                las dosis; el teórico (predicho) sólo se usa para el Vt/kg en
                mecánica ventilatoria. Antes el teórico se cargaba únicamente
                desde adentro del pop-up de ARM, que es un lugar donde nadie
                lo busca si no está intubando en ese momento. */}
            <span style={{ fontSize: 11.5, border: `1px ${p.peso ? "solid" : "dashed"} #E2E8F0`, borderRadius: 4, padding: "3px 8px", display: "flex", alignItems: "center", gap: 5 }}>
              Peso real
              <input type="number" value={p.peso || ""} placeholder="—" disabled={!editable}
                title="Peso real estimado. Es el que se usa para calcular las dosis."
                onChange={(e) => mutar((d) => { d[idx].peso = e.target.value ? +e.target.value : null; })}
                style={{ width: 56, fontFamily: "ui-monospace,monospace", fontSize: 13, padding: "3px 5px", border: `1px solid ${p.peso ? "#E2E8F0" : "#FCA5A5"}`, borderRadius: 4 }} /> kg
            </span>
            <span style={{ fontSize: 11.5, border: `1px ${p.pesoTeorico ? "solid" : "dashed"} #E2E8F0`, borderRadius: 4, padding: "3px 8px", display: "flex", alignItems: "center", gap: 5 }}>
              PT
              <input type="number" value={p.pesoTeorico || ""} placeholder="—" disabled={!editable}
                title="Peso teórico o predicho. Sólo se usa para el Vt/kg en mecánica ventilatoria, nunca para dosis."
                onChange={(e) => mutar((d) => { d[idx].pesoTeorico = e.target.value ? +e.target.value : null; })}
                style={{ width: 56, fontFamily: "ui-monospace,monospace", fontSize: 13, padding: "3px 5px", border: "1px solid #E2E8F0", borderRadius: 4 }} /> kg
            </span>
            {/* Sin peso, todas las dosis se calculan sobre 70 kg supuestos. El
                aviso va acá arriba, pegado al campo que lo resuelve, y no sólo
                abajo con las dosis. */}
            {!p.peso && (
              <span style={{ fontSize: 11.5, fontWeight: 700, color: "#B91C1C", border: "1px dashed #FCA5A5", borderRadius: 4, padding: "3px 8px", display: "flex", alignItems: "center" }}>
                ↖ Escribí el peso real o estimado
              </span>
            )}
            {p.sinCompletar && <span style={{ fontSize: 11.5, border: "1px dashed #FCA5A5", color: "#B91C1C", borderRadius: 4, padding: "3px 8px" }}>Último día sin completar</span>}
            {editable && !confirmandoEgreso && (
              <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button onClick={agregarCama}
                  title="Sumar una cama a esta unidad, vacía. Se puede repetir el número de cama."
                  style={{ fontFamily: "inherit", fontSize: 11.5, fontWeight: 600, color: "#334155", background: "#fff", border: "1px solid #CBD5E1", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}>
                  + Agregar cama
                </button>
                <button onClick={() => setEnviando({ destino: null, choque: false })}
                  title="Mover este paciente a otra cama, de esta o de otra unidad"
                  style={{ fontFamily: "inherit", fontSize: 11.5, fontWeight: 600, color: "#334155", background: "#fff", border: "1px solid #CBD5E1", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}>
                  → Enviar a otra cama
                </button>
                <button onClick={() => setConfirmandoEgreso(true)}
                  title="El paciente egresó y el pase del Drive todavía lo muestra"
                  style={{ fontFamily: "inherit", fontSize: 11.5, fontWeight: 600, color: "#B91C1C", background: "#fff", border: "1px solid #FCA5A5", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}>
                  El paciente se fue
                </button>
              </span>
            )}
          </div>

          {/* Enviar a otra cama. Dos pasos: elegir destino y, si está ocupado,
              decidir qué pasa con el que estaba. */}
          {editable && enviando && (
            <div style={{ marginTop: 10, padding: "12px 14px", borderRadius: 6, border: "1.5px solid #CBD5E1", background: "#F8FAFC" }}>
              {!enviando.choque ? (
                <>
                  <div style={{ fontSize: 13.5, color: "#0F172A", marginBottom: 9 }}>
                    Enviar a <b>{p.nombre || "este paciente"}</b> (cama {p.cama}) a:
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 200, overflowY: "auto" }}>
                    {destinos.map((c) => (
                      <button key={c.i} onClick={() => elegirDestino(c.i)}
                        title={c.quien ? `Ocupada por ${c.quien}` : "Cama libre"}
                        style={{ fontFamily: "ui-monospace,monospace", fontSize: 13, fontWeight: 700, padding: "6px 10px", borderRadius: 5, cursor: "pointer",
                          border: `1.5px solid ${c.quien ? "#E9C48A" : "#86EFAC"}`,
                          background: c.quien ? "#FFFBF3" : "#F0FDF4", color: "#334155" }}>
                        {c.cama}
                        <span style={{ display: "block", fontSize: 10, fontWeight: 600, opacity: 0.75, fontFamily: "inherit" }}>
                          {c.unidad}{c.quien ? " · ocupada" : " · libre"}
                        </span>
                      </button>
                    ))}
                  </div>
                  <button onClick={() => setEnviando(null)} style={{ ...B, marginTop: 10 }}>Cancelar</button>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 13.5, color: "#0F172A", lineHeight: 1.55, marginBottom: 10 }}>
                    En la cama <b>{mio[enviando.destino].cama}</b> está <b>{mio[enviando.destino].nombre}</b>.
                    ¿Qué hacemos con {mio[enviando.destino].nombre ? "él" : "esa ficha"}?
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button onClick={() => moverA(enviando.destino, "intercambiar", null)} style={{ ...B, fontWeight: 700 }}>
                      Se cambian de lugar (pasa a {p.cama})
                    </button>
                    <button onClick={() => setEnviando({ ...enviando, tercera: true })} style={B}>
                      Mandarlo a otra cama
                    </button>
                    <button onClick={() => moverA(enviando.destino, "egreso", null)}
                      style={{ ...B, color: "#B91C1C", border: "1.5px solid #FCA5A5" }}>
                      Ese paciente se fue
                    </button>
                    <button onClick={() => setEnviando(null)} style={B}>Cancelar</button>
                  </div>

                  {/* Tercera cama: sólo las libres, porque encadenar dos
                      desplazados abre una cadena sin fin. */}
                  {enviando.tercera && (
                    <div style={{ marginTop: 11, paddingTop: 10, borderTop: "1px dashed #CBD5E1" }}>
                      <div style={{ fontSize: 12.5, color: "#475569", marginBottom: 7 }}>
                        ¿A qué cama libre va <b>{mio[enviando.destino].nombre}</b>?
                      </div>
                      {(() => {
                        const libres = destinos.filter((c) => c.i !== enviando.destino && !c.quien);
                        if (!libres.length) return (
                          <div style={{ fontSize: 12.5, color: "#B91C1C" }}>
                            No hay ninguna cama libre. Agregá una con “+ Agregar cama” y volvé a intentar.
                          </div>
                        );
                        return (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {libres.map((c) => (
                              <button key={c.i} onClick={() => moverA(enviando.destino, "tercera", c.i)}
                                style={{ fontFamily: "ui-monospace,monospace", fontSize: 13, fontWeight: 700, padding: "6px 10px", borderRadius: 5, cursor: "pointer", border: "1.5px solid #86EFAC", background: "#F0FDF4", color: "#334155" }}>
                                {c.cama}
                                <span style={{ display: "block", fontSize: 10, fontWeight: 600, opacity: 0.75, fontFamily: "inherit" }}>{c.unidad}</span>
                              </button>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {campos.map((k) => {
          const txt = p.campos[k] || "", orig = o.campos?.[k] || "";
          const cambiado = txt !== orig;
          return (
            <div key={k} style={{ borderBottom: "1px solid #E2E8F0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px" }}>
                <span style={{ ...ROT, fontWeight: 800, fontSize: 11.5, color: "#334155" }}>{PA_ROT[k]}</span>
                {editable && (
                  <span style={{ display: "flex", gap: 2 }}>
                    <button onClick={() => moverCampo(k, -1)} title="Subir esta sección" style={FLECHA}>↑</button>
                    <button onClick={() => moverCampo(k, 1)} title="Bajar esta sección" style={FLECHA}>↓</button>
                    {(txt || "").includes("\n") && (
                      <button onClick={() => { setOrdenando(ordenando === k ? null : k); setResaltando(null); }}
                        title="Reordenar los renglones de esta sección"
                        style={{ ...FLECHA, background: ordenando === k ? "#0F172A" : "#fff", color: ordenando === k ? "#fff" : "#64748B" }}>⇅</button>
                    )}
                    {/* Resaltar: se marca por renglón, con el dedo, sin tener
                        que seleccionar texto —que en un celular es la peor
                        interacción posible—. */}
                    <button onClick={() => { setResaltando(resaltando === k ? null : k); setOrdenando(null); }}
                      title="Resaltar renglones de esta sección"
                      style={{ ...FLECHA, background: resaltando === k ? "#0F172A" : "#fff", color: resaltando === k ? "#fff" : "#64748B" }}>🖍</button>
                  </span>
                )}
                <span style={{ marginLeft: "auto", fontSize: 11, color: cambiado ? "#8A4B00" : "#94A3B8" }}>
                  {ordenando === k ? "moviendo renglones"
                    : resaltando === k ? "tocá un renglón para resaltarlo"
                    : cambiado ? "editado" : "tocá para editar"}
                </span>
              </div>
              <div style={{ padding: "0 14px 12px", fontSize: 14 }}>
                {ordenando === k ? (
                  /* Modo reordenar: cada renglón por separado, con sus flechas.
                     Se separa de la edición porque un contenteditable con
                     botones adentro se pelea con el cursor. */
                  <div style={{ display: "grid", gap: 4 }}>
                    {(txt || "").split("\n").map((l, li, arr) => {
                      const { color, texto } = paMarcaDe(l);
                      return (
                        <div key={li} style={{ display: "flex", alignItems: "flex-start", gap: 6, background: color ? PA_MARCA[color] : "#F8FAFC", borderRadius: 4, padding: "5px 7px" }}>
                          <span style={{ flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{texto}</span>
                          <button onClick={() => moverLinea(k, li, -1)} disabled={li === 0} style={{ ...FLECHA, opacity: li === 0 ? 0.3 : 1 }}>↑</button>
                          <button onClick={() => moverLinea(k, li, 1)} disabled={li === arr.length - 1} style={{ ...FLECHA, opacity: li === arr.length - 1 ? 0.3 : 1 }}>↓</button>
                        </div>
                      );
                    })}
                  </div>
                ) : resaltando === k ? (
                  /* Modo resaltar: se elige el color arriba y después se
                     selecciona con el dedo o el mouse la palabra a pintar.
                     Antes se pintaba el renglón entero, que para marcar dos
                     palabras obligaba a teñir tres líneas de texto alrededor.

                     El texto se dibuja en tramos, cada uno con su posición de
                     arranque en el atributo data-i. Con eso, cuando el
                     navegador avisa qué seleccionó el usuario, se puede
                     traducir esa selección a un índice de caracter: sin las
                     posiciones habría que adivinar dónde cae la selección
                     dentro del texto, que es donde estas cosas fallan. */
                  <div style={{ display: "grid", gap: 7 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11.5, color: "#64748B" }}>Color</span>
                      {PA_MARCAS.map((c) => (
                        <button key={c} onClick={() => setColorSel(c)}
                          title={PA_MARCA_ROT[c]}
                          style={{ width: 34, height: 34, flex: "0 0 auto", borderRadius: 6, cursor: "pointer",
                            background: PA_MARCA[c],
                            border: colorSel === c ? "3px solid #0F172A" : "1.5px solid #CBD5E1" }} />
                      ))}
                      <button onClick={() => setColorSel(null)}
                        title="Seleccionar texto ya pintado para despintarlo"
                        style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, height: 34, padding: "0 11px",
                          borderRadius: 6, cursor: "pointer", background: "#fff", color: "#475569",
                          border: colorSel === null ? "3px solid #0F172A" : "1.5px solid #CBD5E1" }}>
                        Borrar
                      </button>
                      <span style={{ fontSize: 11.5, color: "#64748B", marginLeft: "auto" }}>
                        Seleccioná la palabra
                      </span>
                    </div>
                    <div
                      onMouseUp={() => pintarSeleccion(k)}
                      onTouchEnd={() => setTimeout(() => pintarSeleccion(k), 10)}
                      style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "#F8FAFC",
                        borderRadius: 5, padding: "8px 10px", cursor: "text", lineHeight: 1.6 }}>
                      {paSegmentos(txt).map((seg, si) => seg.texto === "\n"
                        ? <br key={si} />
                        : <span key={si} data-i={seg.inicio}
                            style={seg.color ? { background: PA_MARCA[seg.color], borderRadius: 2, padding: "1px 0" } : undefined}>
                            {/* Los «» se muestran crudos a propósito: sacarlos
                                acortaría el texto y las posiciones dejarían de
                                coincidir con lo que se ve, que es lo que hace
                                que la selección pinte el tramo equivocado. */}
                            {seg.texto}
                          </span>)}
                    </div>
                  </div>
                ) : (
                  <div contentEditable={editable} suppressContentEditableWarning
                    onFocus={() => setEnFoco(k)}
                    onBlur={(e) => { editarCampo(k, e.currentTarget.innerText); setEnFoco(null); }}
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", outline: "none", background: enFoco === k ? "rgba(15,95,102,.06)" : "transparent", borderRadius: 3, minHeight: 20 }}>
                    {/* Mientras el campo tiene el foco se muestra texto plano: si le
                        metemos marcas mientras se escribe, el cursor salta al inicio. */}
                    {/* Al editar se ven los «» crudos, que confunden; se sacan.
                        Al guardar se reponen si el renglón sigue teniendo la
                        forma "fecha muestra: germen", así el formato sobrevive
                        a una edición sin obligar a nadie a tipear símbolos. */}
                    {verOriginal || enFoco === k
                      ? paSinMarcas(txt).replace(/[«»]/g, "")
                      : <TextoMarcado actual={txt} original={orig} />}
                  </div>
                )}
              </div>
              {k === "tto" && <DosisDe p={p} onCambio={editable ? cambiarInfusion : null} />}
            </div>
          );
        })}

        {/* Sin campo Tratamiento, las dosis van igual: bloque propio al final. */}
        {!hayTto && (
          <div style={{ borderBottom: "1px solid #E2E8F0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px" }}>
              <span style={{ ...ROT, fontWeight: 800, fontSize: 11.5, color: "#334155" }}>Tratamiento</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "#94A3B8" }}>según lo escrito arriba</span>
            </div>
            <DosisDe p={p} onCambio={editable ? cambiarInfusion : null} />
          </div>
        )}
      </div>

      {/* ARM: casi nunca se usa, así que no ocupa lugar en la ficha. Botón que
          abre un pop-up, con los settings del modo que corresponda. */}
      <button onClick={() => setArmAbierto(true)} style={{ ...B, width: "100%", textAlign: "left", marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "#64748B" }}>🫁</span> Ver ARM de este paciente
        {(armDe(idx).modo || p.armTexto) && <span style={{ marginLeft: "auto", fontSize: 11, color: "#64748B" }}>
          {PA_MODOS[armDe(idx).modo]?.rot || "según el pase"}
        </span>}
      </button>

      <Plegable k="bal" titulo="Balance" color="#1D4ED8" n={(p.balance?.ingresos?.length || 0) + (p.balance?.egresos?.length || 0)}>
        <div style={{ display: "grid", gap: 12 }}>
          {[["ingresos", "Ingresos", ing], ["egresos", "Egresos", egr]].map(([campo, rot, tot]) => (
            <div key={campo}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                <span style={{ ...ROT, fontSize: 9.5, color: "#64748B" }}>{rot}</span>
                <span style={{ marginLeft: "auto", fontFamily: "ui-monospace,monospace", fontWeight: 700, fontSize: 14 }}>{tot} ml</span>
              </div>
              {(p.balance?.[campo] || []).map((x, k) => (
                <div key={k} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderTop: k ? "1px solid #F1F5F9" : "none" }}>
                  <span style={{ flex: 1, fontSize: 13.5 }}>
                    {x.que}
                    {/* Cuándo se relevó: un ingreso de las 18 y uno de las 3 de
                        la mañana no se leen igual al hacer el balance. */}
                    {x.cuando && <span style={{ color: "#94A3B8", fontFamily: "ui-monospace,monospace", fontSize: 11.5, marginLeft: 6 }}>{x.cuando}</span>}
                  </span>
                  <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 13.5, fontWeight: 600 }}>{x.ml} ml</span>
                  {editable && <span onClick={() => mutar((d) => { d[idx].balance[campo].splice(k, 1); })} style={{ cursor: "pointer", color: "#94A3B8" }}>×</span>}
                </div>
              ))}
              {editable && <FilaBalance onAdd={(que, ml) => mutar((d) => {
                if (!d[idx].balance) d[idx].balance = { ingresos: [], egresos: [] };
                d[idx].balance[campo].push({ que, ml, cuando: paAhora() });
              })} />}
            </div>
          ))}
          <div style={{ borderTop: "1px solid #E2E8F0", paddingTop: 9, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...ROT, fontSize: 9.5, color: "#64748B" }}>Balance</span>
            <span style={{ marginLeft: "auto", fontFamily: "ui-monospace,monospace", fontWeight: 700, fontSize: 17, color: ing - egr >= 0 ? "#1D4ED8" : "#B91C1C" }}>
              {ing - egr >= 0 ? "+" : ""}{ing - egr} ml
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.45 }}>
            {(p.balance?.ingresos || []).some((x) => /del pase/.test(x.que || ""))
              ? "Los renglones marcados \u0022del pase\u0022 salen del balance escrito al final del estado de hoy. El resto lo cargás vos en la cama."
              : "El balance lo cargás vos en la cama: no viene en el pase del Drive."}
          </div>
        </div>
      </Plegable>





      <Plegable k="pend" titulo="Pendientes" color="#0F5F66" n={(p.pendientes || []).filter((x) => !x.listo).length}>
        {(p.pendientes || []).length === 0
          ? <div style={{ fontSize: 13, color: "#64748B", fontStyle: "italic" }}>Sin pendientes cargados para este paciente.</div>
          : (p.pendientes || []).map((x, k) => (
            <div key={k} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "6px 0", borderTop: k ? "1px solid #F1F5F9" : "none" }}>
              <input type="checkbox" checked={x.listo} disabled={!editable}
                onChange={() => mutar((d) => { d[idx].pendientes[k].listo = !d[idx].pendientes[k].listo; })}
                style={{ width: 19, height: 19, accentColor: "#0F5F66", marginTop: 1 }} />
              <span style={{ flex: 1, fontSize: 14.5, textDecoration: x.listo ? "line-through" : "none", color: x.listo ? "#94A3B8" : "inherit" }}>{x.texto}</span>
              {editable && <span onClick={() => mutar((d) => { d[idx].pendientes.splice(k, 1); })} style={{ cursor: "pointer", color: "#94A3B8" }}>×</span>}
            </div>
          ))}
        {editable && <NuevoPendiente onAdd={(txt) => mutar((d) => {
          d[idx].pendientes = d[idx].pendientes || [];
          d[idx].pendientes.push({ texto: txt, listo: false });
        })} />}
      </Plegable>

      {/* Abreviaturas que la app no supo interpretar en ESTE paciente. No
          adivina el significado: sólo las señala, porque inventar una
          expansión plausible en un pase de terapia es peor que dejar la sigla
          cruda. Sirve para que la jerga nueva aparezca sola en vez de tener
          que ir a cazarla leyendo pases. */}
      {(() => {
        const raras = [...new Set(PA_ORDEN.flatMap((k) => paDesconocidas(p.campos?.[k])))];
        if (!raras.length) return null;
        return (
          <Plegable k="raras" titulo="Abreviaturas sin interpretar" color="#94A3B8" n={raras.length}>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
              {raras.map((w) => (
                <span key={w} style={{ fontFamily: "ui-monospace,monospace", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 4, padding: "3px 7px", color: "#475569" }}>{w}</span>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.45 }}>
              Estas siglas quedaron sin expandir: la app las deja tal cual en vez de suponer qué significan.
              Si alguna es de uso corriente, decímela y la agrego al diccionario.
            </div>
          </Plegable>
        );
      })()}

      </>
      )}

      <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.5, padding: "4px 2px" }}>
        <b>Versión alpha.</b> Tu copia se guarda en tu cuenta y nadie más la ve. Las anotaciones son temporales: cuando entra un pase nuevo, usá "Borrar mis anotaciones y sincronizar pase". Si algo no funciona o te falta algo, decímelo.
      </div>

      {armAbierto && (
        <ArmPopup p={p} v={armDe(idx)} set={(c, val) => setArmDe(idx, c, val)}
          setPT={(val) => mutar((d) => { d[idx].pesoTeorico = val; })}
          cerrar={() => setArmAbierto(false)} />
      )}
    </div>
  );
}

/* ── Pop-up de mecánica ventilatoria ──────────────────────────────────────
   Se elige el modo y se piden sólo los settings de ese modo. Meseta y PEEP
   total van siempre, porque son medidas con pausa y son las que dan driving
   pressure y auto-PEEP, que es para lo que uno abre esto. */

function ArmPopup({ p, v, set, setPT, cerrar }) {
  const modo = v.modo || "";
  // Peso para el Vt: el teórico manda. Regla de Gonzalo del 2/9/2026: el PT
  // se usa acá y en ningún otro lado — las dosis de drogas siguen yendo por
  // peso real.
  const pesoVt = p.pesoTeorico || p.peso || null;
  const conPT = !!p.pesoTeorico;
  const campos = PA_MODOS[modo]?.campos || [];
  const n = (x) => (x === "" || x == null || isNaN(+x) ? null : +x);
  const pl = n(v.pmeseta), pt = n(v.peeptotal), pe = n(v.peep);
  const vt = n(v.vtMedido) ?? n(v.vt);
  const peep = pt ?? pe;
  const dp = pl != null && peep != null ? pl - peep : null;
  const inp = { width: "100%", fontFamily: "ui-monospace,monospace", fontSize: 15, padding: "7px 9px", border: "1.5px solid #E2E8F0", borderRadius: 5, boxSizing: "border-box" };
  return (
    <div onClick={cerrar} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, border: "1.5px solid #CBD5E1", maxWidth: 480, width: "100%", maxHeight: "88vh", overflowY: "auto", padding: 18 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
          <b style={{ fontSize: 16 }}>Mecánica ventilatoria</b>
          <button onClick={cerrar} style={{ marginLeft: "auto", border: "none", background: "none", fontSize: 20, cursor: "pointer", color: "#64748B", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 12.5, color: "#64748B", marginBottom: 12 }}>{p.nombre} · cama {p.cama}</div>

        {/* El peso predicho vive acá y no en la ficha, porque acá es el único
            lugar donde se usa. Si el pase lo trae escrito como "PT 60 KG"
            viene cargado solo; si no, se escribe una vez y queda. */}
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "9px 11px", marginBottom: 14 }}>
          <span style={{ fontSize: 11.5, color: "#64748B" }}>Peso teórico (PT)</span>
          <input type="number" value={p.pesoTeorico || ""} placeholder="—"
            onChange={(e) => setPT && setPT(e.target.value ? +e.target.value : null)}
            style={{ width: 62, fontFamily: "ui-monospace,monospace", fontSize: 14, padding: "4px 6px", border: `1px solid ${conPT ? "#E2E8F0" : "#FCA5A5"}`, borderRadius: 4 }} />
          <span style={{ fontSize: 11.5, color: "#64748B" }}>kg</span>
          <span style={{ fontSize: 11.5, color: conPT ? "#64748B" : "#B91C1C", marginLeft: "auto" }}>
            {conPT ? "El Vt/kg se calcula con este peso." :
             p.peso ? `Sin PT cargado: el Vt/kg usa el peso real (${p.peso} kg) y queda subestimado.` :
             "Sin PT ni peso: no se puede calcular el Vt/kg."}
          </span>
        </div>

        <label style={{ fontSize: 11.5, color: "#64748B", display: "block", marginBottom: 4 }}>Modo ventilatorio</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          {Object.entries(PA_MODOS).map(([k, m]) => (
            <button key={k} onClick={() => set("modo", k)}
              style={{ fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 6, cursor: "pointer",
                border: modo === k ? "1.5px solid #0F172A" : "1.5px solid #E2E8F0",
                background: modo === k ? "#0F172A" : "#fff", color: modo === k ? "#fff" : "#475569" }}>
              {m.rot}
            </button>
          ))}
        </div>

        {!modo && <div style={{ fontSize: 13, color: "#64748B", padding: "10px 0" }}>Elegí el modo para cargar los parámetros.</div>}

        {modo && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(108px,1fr))", gap: 9, marginBottom: 14 }}>
            {campos.map(([k, rot]) => (
              <div key={k}>
                <label style={{ fontSize: 11, color: "#64748B", display: "block", marginBottom: 3 }}>{rot}</label>
                <input type="number" value={v[k] ?? ""} onChange={(e) => set(k, e.target.value)} style={inp} />
              </div>
            ))}
          </div>
        )}

        <div style={{ borderTop: "1px solid #E2E8F0", paddingTop: 12 }}>
          <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 7 }}>Medidas con pausa</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(108px,1fr))", gap: 9 }}>
            {[["pmeseta", "Presión meseta"], ["peeptotal", "PEEP total"], ["vtMedido", "Vt exhalado"]].map(([k, rot]) => (
              <div key={k}>
                <label style={{ fontSize: 11, color: "#64748B", display: "block", marginBottom: 3 }}>{rot}</label>
                <input type="number" value={v[k] ?? ""} onChange={(e) => set(k, e.target.value)} style={inp} />
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", borderTop: "1px solid #E2E8F0", marginTop: 12, paddingTop: 12 }}>
          {[["Driving pressure", dp != null ? dp.toFixed(1) : "—"],
            ["Auto-PEEP", pt != null && pe != null ? (pt - pe).toFixed(1) : "—"],
            ["Compliance", dp && vt ? (vt / dp).toFixed(1) : "—"],
            // El Vt se programa por kilo de peso PREDICHO, no del real: los
            // pulmones no engordan. Si el pase trae PT se usa ese; si no, se
            // cae al peso real y se avisa abajo, porque en un obeso la
            // diferencia entre los dos puede ser de varios ml/kg.
            ["Vt / kg", vt && pesoVt ? (vt / pesoVt).toFixed(1) : "—"]].map(([l, val]) => (
            <div key={l} style={{ fontSize: 12, color: "#64748B" }}>{l}
              <b style={{ display: "block", fontFamily: "ui-monospace,monospace", fontSize: 19, color: "#0F172A" }}>{val}</b>
            </div>
          ))}
        </div>

        {p.armTexto && (
          <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 12, paddingTop: 10, borderTop: "1px dashed #E2E8F0" }}>
            En el pase dice: <span style={{ fontFamily: "ui-monospace,monospace", color: "#0F172A" }}>{p.armTexto}</span>
          </div>
        )}
        <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 10, lineHeight: 1.45 }}>
          Driving = meseta − PEEP total. Auto-PEEP = PEEP total − PEEP programada. Compliance = Vt / driving.
          {" El Vt/kg va por peso teórico (predicho), no por el real."}
        </div>
      </div>
    </div>
  );
}

// Dosis calculadas. SOLO infusiones endovenosas continuas: son las únicas
// donde la dosis por kilo depende de la dilución y del ritmo, y por lo tanto
// las únicas donde este cálculo agrega algo. Un comprimido cada 12 horas ya
// dice todo lo que hay que saber en el renglón de tratamiento; ponerlo acá
// abajo repetido solo hace ruido en la sección que uno mira para chequear una
// bomba.
/* ══════════════════════════════════════════════════════════════════════════
   IMPRIMIR EL PASE

   Para llevar en el bolsillo del ambo y anotar encima.

   QUÉ SE IMPRIME
   --------------
   Exactamente lo mismo que muestra la pestaña Pases, con los mismos rótulos
   y las mismas palabras: "Complementarios", "Requerimientos / Intercurrencias",
   "EAB". No se reescribe ni se reordena nada. Lo que ya se lee bien en
   pantalla se lee bien en papel, y tener dos redacciones distintas del mismo
   pase es una fuente de confusión, no una mejora.

   Se agregan dos cosas que la pestaña Pases no muestra:
     · PENDIENTES, debajo de Accesos, con casillas para tildar. Es el dato que
       el médico que imprime necesita para trabajar.
     · Las DOSIS CALCULADAS, adentro de Tratamiento, para no rehacer de
       memoria una regla de tres a las cuatro de la mañana.

   EL ESTADO ACTUAL
   ----------------
   El último renglón de Requerimientos suele ser la descripción de cómo está
   hoy el paciente ("28/08 lúcida, sin foco neurológico. HDE. VE sin O₂...").
   Ese renglón se repite arriba, debajo del motivo de ingreso y con su fecha,
   que es donde uno lo busca al tomar la guardia.

   Pero NO siempre lo último escrito es un estado: los fines de semana el pase
   se llena a las apuradas y queda una cadena de eventos ("31/08 íleo funcional
   → SNG a descarga → TC abdomen"), una fecha pelada, o los parámetros del
   respirador. Mostrar eso como "estado actual" es peor que no mostrar nada,
   porque afirma algo que nadie escribió. Ver esEstadoActual(): ante la duda,
   no se muestra.

   EL ESPACIO
   ----------
   Máximo dos hojas (cuatro carillas) por unidad. Un paciente por fila, nunca
   partido entre carillas. Adentro de cada ficha, el relato clínico va en una
   columna con el tratamiento en paralelo; los datos fechados —laboratorio,
   cultivos, complementarios, accesos— cruzan la ficha entera, porque en media
   columna quedan en un chorizo de dos palabras por renglón.

   Blanco y negro: las jerarquías se hacen con peso y tamaño de letra. Un
   fondo gris sale negro en una impresora cansada y tapa el texto.
   ══════════════════════════════════════════════════════════════════════════ */

/* ¿El último renglón de Requerimientos describe cómo está el paciente, o es
   otra cosa? Se pide fecha adelante, algo de cuerpo, ninguna flecha (una
   flecha encadena hechos: "fiebre → cultivos → TAC") y al menos dos señales
   de examen o estado. Probado contra los 25 pacientes de un pase real: deja
   pasar los 15 que describen al paciente y frena los 10 que no. */

const PA_SENAL_ESTADO = [
  /\bL[UÚ]CID[OA]\b/i, /\bVIGIL\b/i, /\bRASS\b/i, /\bSEDAD[OA]\b/i, /\bSOPOROS[OA]\b/i,
  /\bDESORIENTAD[OA]\b/i, /\bORIENTAD[OA]\b/i, /\bRESPONDE\b/i, /\bSIN FOCO\b/i,
  /\bHD[EI]\b/i, /\bHEMODIN[AÁ]MICAMENTE\b/i, /\bTA\s*\d/i,
  /\bVE\b/i, /\bARM\b/i, /\bVNI\b/i, /\bVENTILANDO\b/i, /\bHIPOVEN/i,
  /\bABD[I]?\b/i, /\bABDOMEN\b/i, /\bRHA\b/i, /\bPERITONEAL\b/i, /\bBLANDO\b/i,
  /\bAFEBRIL\b/i, /\bSUBFEBRIL\b/i, /\bEDEMAS\b/i, /\bPARESIA\b/i, /\bAFASIA\b/i,
  /\bMOVILIZA\b/i, /\bPUPILAS\b/i, /\bPIR\b/i, /\bENCEFALOPAT/i, /\bFUNCIONANTE\b/i,
  /\bESCARA\b/i, /\bOSCILA\b/i, /\bDOLOROS[OA]\b/i,
];

function esEstadoActual(txt) {
  if (!txt) return false;
  const t = String(txt).replace(/\s+/g, " ").trim();
  const m = t.match(/^\*?\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.*)$/);
  if (!m) return false;                        // sin fecha adelante
  const cuerpo = m[2].trim();
  if (cuerpo.length < 15) return false;        // "29/08" y nada más
  if (/→|->/.test(cuerpo)) return false;       // cadena de hechos, no un estado
  return PA_SENAL_ESTADO.filter((re) => re.test(cuerpo)).length >= 2;
}
// Separa la fecha del cuerpo, para poder mostrarlas distinto.

function paPartirEstado(txt) {
  const m = String(txt).replace(/\s+/g, " ").trim()
    .match(/^\*?\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.*)$/);
  return m ? { fecha: m[1], cuerpo: m[2] } : { fecha: "", cuerpo: String(txt) };
}

function imprimirPase(pacientes, unidad, tomado) {
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Los marcadores internos no van al papel: «» era negrita en pantalla y los
  // caracteres de resaltado son invisibles pero ocupan lugar.
  const limpio = (s) => paSinMarcas(String(s || "")).replace(/[«»]/g, "");

  // Un renglón resaltado en pantalla se imprime con una barra al margen: el
  // color no sobrevive al blanco y negro, pero la marca sí tiene que llegar.
  const renglones = (txt) => String(txt || "").split("\n").map((cruda) => {
    const { color, texto } = paMarcaDe(cruda);
    const l = texto.replace(/[«»]/g, "").trim();
    if (!l) return "";
    return `<div class="l${color ? " mk" : ""}">${esc(l)}</div>`;
  }).join("");

  // Los mismos rótulos y el mismo orden que la pestaña Pases.
  const ROT = Object.fromEntries(PASE_FIELDS.map(([k, r]) => [k, r]));
  const ORDEN = PASE_FIELDS.map(([k]) => k);
  const IZQ = ["ap", "ea", "req"];     // el relato clínico
  const DER = ["tto"];                 // lo que recibe, en paralelo

  const ficha = (p) => {
    const campos = p.campos || {};
    const hay = (k) => campos[k] && String(campos[k]).trim();

    // Dosis calculadas, adentro de Tratamiento.
    const inf = (p.infusiones || []).map((i) => {
      const g = paDosis(i, p.peso);
      if (g.sinUnidad) return `${esc(i.droga)} ${i.mg}/${i.ml}/${i.ritmo}`;
      // EXACTAMENTE la misma cuenta y las mismas unidades que la pantalla:
      // la dosis por kilo y por hora, y para los vasoactivos además la de por
      // minuto en microgramos. La conversión ×1000/60 es la que pasa de
      // mg/kg/h a mcg/kg/min; sin ella una noradrenalina imprimía "0.000".
      const val = `${g.kgh.toFixed(3)} ${g.u}/kg/h`
        + (PA_POR_MINUTO.has(i.droga)
            ? ` · ${(g.kgh * 1000 / 60).toFixed(3)} mcg/kg/min` : "");
      return `${esc(i.droga)} ${i.mg}/${i.ml}/${i.ritmo} = <b>${val}</b>${g.supuesto ? " *" : ""}`;
    });
    const dosis = inf.length
      ? `<div class="dos"><span class="r2">Dosis calculadas</span>${inf.map((x) => `<div class="l">${x}</div>`).join("")}</div>`
      : "";

    const uno = (k) => !hay(k) ? "" :
      `<div class="s"><span class="r">${esc(ROT[k])}</span>${renglones(campos[k])}` +
      (k === "tto" ? dosis : "") + `</div>`;

    // Estado actual: el último renglón de Requerimientos, si de verdad lo es.
    const lineasReq = String(campos.req || "").split("\n")
      .map((x) => limpio(x).trim()).filter(Boolean);
    const ultima = lineasReq.length ? lineasReq[lineasReq.length - 1] : "";
    const est = esEstadoActual(ultima) ? paPartirEstado(ultima) : null;

    const izq = IZQ.map(uno).join("");
    const der = DER.map(uno).join("") + (!hay("tto") ? dosis : "");
    const anchas = ORDEN.filter((k) => !IZQ.includes(k) && !DER.includes(k)).map(uno).join("");

    // Pendientes, debajo de Accesos. Es lo único de la hoja que no describe al
    // paciente sino que le pide algo a quien la está leyendo.
    const ps = (p.pendientes || []).filter((x) => x && x.texto && !x.listo);
    const pend = ps.length
      ? `<div class="pend"><span class="r2">Pendientes</span>` +
        ps.map((x) => `<div class="l">&#9744; ${esc(limpio(x.texto))}</div>`).join("") + `</div>`
      : "";

    const pesos = [p.peso ? `${p.peso} kg` : null, p.pesoTeorico ? `PT ${p.pesoTeorico}` : null]
      .filter(Boolean).join(" · ");

    return `<article class="p">
      <header>
        <span class="cama">${esc(p.cama)}</span>
        <span class="nom">${esc(p.nombre) || "—"}</span>
        <span class="meta">${[p.edad ? p.edad + "a" : "", p.sexo ? p.sexo[0].toUpperCase() : "", pesos].filter(Boolean).join(" · ")}</span>
      </header>
      ${p.mi ? `<div class="mi">${esc(limpio(p.mi))}</div>` : ""}
      ${est ? `<div class="est"><span class="ef">${esc(est.fecha)}</span> ${esc(est.cuerpo)}</div>` : ""}
      <div class="par"><div>${izq}</div><div>${der}</div></div>
      ${anchas}
      ${pend}
      <div class="notas"></div>
    </article>`;
  };

  const vivos = pacientes.filter((p) => !p.egresado);
  const win = window.open("", "_blank");
  if (!win) { alert("El navegador bloqueó la ventana de impresión. Permitila y probá de nuevo."); return; }
  const titulo = `Pase ${unidad} — ${new Date().toLocaleDateString("es-AR")}`;
  const fecha = (d) => d ? new Date(d).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8" />
  <title>${esc(titulo)}</title>
  <style>
    * { box-sizing: border-box; }
    @page { size: A4; margin: 7mm 6mm; }
    body { font-family: 'Inter', system-ui, sans-serif; color: #000; margin: 0;
           font-size: 7pt; line-height: 1.2; padding-top: 13mm; }

    h1 { font-size: 11pt; margin: 0 0 1mm; }
    .sub { font-size: 7pt; color: #444; margin: 0 0 2.5mm;
           border-bottom: .5pt solid #000; padding-bottom: 1mm; }

    /* Un paciente por fila, nunca partido entre carillas: una ficha que sigue
       arriba en la otra columna se lee como si hubiera terminado. */
    .p { border: .5pt solid #000; border-radius: 1.2mm; padding: 1.2mm 1.6mm;
         margin: 0 0 1.4mm; break-inside: avoid; page-break-inside: avoid; }
    .p > header { display: flex; align-items: baseline; gap: 1.5mm;
                  border-bottom: .5pt solid #999; padding-bottom: .8mm; margin-bottom: 1mm; }
    .cama { font-family: ui-monospace, Menlo, monospace; font-size: 10pt; font-weight: 800; }
    .nom { font-size: 8.6pt; font-weight: 700; flex: 1; }
    .meta { font-size: 6.6pt; color: #333; white-space: nowrap; }

    .mi { font-size: 7.4pt; font-weight: 700; margin: 0 0 .7mm; }
    /* Cómo está hoy. Va pegado al motivo de ingreso: los dos juntos contestan
       "por qué entró" y "cómo está", que es con lo que uno arranca la guardia. */
    .est { font-size: 7pt; margin: 0 0 1mm; padding: .7mm 1.2mm;
           border-left: 1.5pt solid #000; background: #f4f4f4; }
    .ef { font-family: ui-monospace, Menlo, monospace; font-weight: 800; }

    /* El relato clínico y el tratamiento, en paralelo.
       La izquierda es más ancha a propósito: entre antecedentes, enfermedad
       actual y requerimientos junta el 86% del texto, y contra el 14% del
       tratamiento. Con columnas iguales la derecha quedaba casi vacía y la
       ficha entera se estiraba al alto de la izquierda — media carilla
       desperdiciada por hoja, y UTI 3 no entraba en dos hojas. */
    .par { display: grid; grid-template-columns: 1.7fr 1fr; gap: 0 4mm; }

    .s { margin-bottom: .6mm; break-inside: avoid; }
    .r { font-size: 6.2pt; font-weight: 800; text-transform: uppercase;
         letter-spacing: .02em; color: #000; display: block;
         border-bottom: .3pt dotted #bbb; margin-bottom: .3mm; }
    .l { margin: 0; padding-left: 1.6mm; text-indent: -1.6mm; }
    .l.mk { border-left: 1.2pt solid #000; padding-left: 1.4mm; margin-left: -2mm; text-indent: 0; }

    .dos { margin: .5mm 0 0 1.5mm; padding-left: 1.5mm; border-left: .8pt solid #666; }
    .r2 { font-size: 5.9pt; font-weight: 800; text-transform: uppercase;
          color: #333; display: block; }

    .pend { border: .7pt solid #000; border-radius: 1mm; padding: .8mm 1.4mm;
            margin-top: .8mm; break-inside: avoid; }
    .pend .l { padding-left: 0; text-indent: 0; }

    .notas { height: 5mm; border-top: .3pt dashed #999; margin-top: .8mm; }

    /* Barra de herramientas: no se imprime. */
    .bar { position: fixed; top: 0; left: 0; right: 0; z-index: 9;
           background: #0F172A; color: #fff; padding: 6px 10px;
           font-family: system-ui, sans-serif; font-size: 12px;
           display: flex; align-items: center; gap: 8px; }
    .bar button { font-family: inherit; font-size: 12px; font-weight: 700;
                  padding: 6px 12px; border-radius: 5px; border: 1px solid #fff;
                  background: #fff; color: #0F172A; cursor: pointer; }
    .bar button.off { background: transparent; color: #fff; }
    .bar .ay { opacity: .8; font-weight: 400; }
    body.edit .hoja { outline: 2px dashed #0F172A; outline-offset: 3px; }
    @media print { .bar { display: none; } body { padding-top: 0; }
                   body.edit .hoja { outline: none; } }
  </style></head><body>
  <div class="bar">
    <button id="ed" class="off" onclick="editar()">Editar antes de imprimir</button>
    <button onclick="window.print()">Imprimir</button>
    <span class="ay" id="ay">Los cambios valen sólo para esta impresión. No se guardan en la app.</span>
  </div>
  <div class="hoja">
    <h1>${esc(unidad)} · ${vivos.length} paciente${vivos.length === 1 ? "" : "s"}</h1>
    <div class="sub">Pase del Drive ${esc(fecha(tomado))}
      · impreso ${esc(fecha(new Date()))}
      · las dosis con * usan 70 kg supuestos</div>
    ${vivos.map(ficha).join("")}
  </div>
  <script>
    // Editar antes de imprimir. Es una ventana aparte con su propia copia del
    // HTML: lo que se toque acá no vuelve a la app ni al Drive, vive lo que
    // dura esta ventana. Sirve para tachar algo que ya no corre, agregar un
    // dato de último momento o corregir un dedazo antes de repartir la hoja.
    var editando = false;
    function editar() {
      editando = !editando;
      var h = document.querySelector('.hoja');
      h.contentEditable = editando ? 'true' : 'false';
      document.body.classList.toggle('edit', editando);
      var b = document.getElementById('ed');
      b.textContent = editando ? 'Listo, terminar de editar' : 'Editar antes de imprimir';
      b.className = editando ? '' : 'off';
      document.getElementById('ay').textContent = editando
        ? 'Escribí directo sobre la hoja. Los cambios valen sólo para esta impresión.'
        : 'Los cambios valen sólo para esta impresión. No se guardan en la app.';
      if (editando) h.focus();
    }
  <\/script>
  </body></html>`);
  win.document.close();
}

function DosisDe({ p, onCambio }) {
  const inf = p.infusiones || [];
  if (!inf.length) return null;
  const editable = typeof onCambio === "function";
  const cel = { width: 58, fontFamily: "ui-monospace,monospace", fontSize: 13, padding: "3px 5px", border: "1.5px solid #E2E8F0", borderRadius: 4, textAlign: "right" };
  return (
    <div style={{ margin: "0 14px 12px", paddingTop: 10, borderTop: "1px dashed #E2E8F0" }}>
      {!p.peso && inf.length > 0 && (
        <div style={{ fontSize: 13, fontWeight: 700, color: "#B91C1C", marginBottom: 8 }}>Dosis en paciente de {PA_PESO_SUPUESTO} kg</div>
      )}
      {inf.map((x, k) => {
        const g = paDosis(x, p.peso);
        const dec = x.declarada;
        const dif = !g.sinUnidad && dec != null && Math.abs(g.kgh - dec) / Math.max(dec, 1e-9) > 0.10;
        const r = PA_RANGO[x.droga];
        const fuera = !g.sinUnidad && r && (g.kgh < r[0] || g.kgh > r[1]);
        return (
          <div key={k} style={{ padding: "8px 0", borderTop: k ? "1px solid #F1F5F9" : "none" }}>
            {/* La dosis va pegada al nombre de la droga: es el dato que se
                busca, no tiene sentido mandarlo a una columna aparte. */}
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: 14.5 }}>{x.droga}</span>
              {g.sinUnidad
                ? <span style={{ color: "#B91C1C", fontSize: 12 }}>sin unidad definida</span>
                : <span style={{ fontFamily: "ui-monospace,monospace", fontWeight: 700, fontSize: 15, color: fuera ? "#B91C1C" : "#0F172A" }}>
                    {g.kgh.toFixed(3)} <em style={{ fontStyle: "normal", fontSize: 11, color: "#64748B" }}>{g.u}/kg/h</em>
                    {PA_POR_MINUTO.has(x.droga) && (
                      <span style={{ marginLeft: 9 }}>
                        {(g.kgh * 1000 / 60).toFixed(3)} <em style={{ fontStyle: "normal", fontSize: 11, color: "#64748B" }}>mcg/kg/min</em>
                      </span>
                    )}
                  </span>}
            </div>
            {/* Dilución y ritmo editables: si en la guardia se cambia el goteo,
                la dosis se recalcula sola en vez de quedar mintiendo. */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5, fontSize: 11.5, color: "#64748B", flexWrap: "wrap" }}>
              {editable ? <input type="number" value={x.mg} onChange={(e) => onCambio(k, "mg", e.target.value)} style={cel} />
                        : <b style={{ fontFamily: "ui-monospace,monospace" }}>{x.mg}</b>}
              <span>{g.u || "?"} en</span>
              {editable ? <input type="number" value={x.ml} onChange={(e) => onCambio(k, "ml", e.target.value)} style={cel} />
                        : <b style={{ fontFamily: "ui-monospace,monospace" }}>{x.ml}</b>}
              <span>ml a</span>
              {editable ? <input type="number" value={x.ritmo} onChange={(e) => onCambio(k, "ritmo", e.target.value)} style={cel} />
                        : <b style={{ fontFamily: "ui-monospace,monospace" }}>{x.ritmo}</b>}
              <span>ml/h · peso {g.peso} kg</span>
            </div>
            {dec != null && (
              <div style={{ fontSize: 11.5, marginTop: 4, color: dif ? "#B91C1C" : "#64748B", fontWeight: dif ? 600 : 400 }}>
                {dif ? "⚠ No coincide" : "✓ Coincide"} · el pase anota <b>{dec}</b>
              </div>
            )}
            {fuera && <div style={{ fontSize: 11.5, marginTop: 4, color: "#B91C1C" }}>⚠ Fuera del rango habitual ({r[0]}–{r[1]} {g.u}/kg/h). Revisá el ritmo o la dilución.</div>}
            {x.campo && <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>Escrita en {PA_ROT[x.campo] || x.campo}, no en tratamiento.</div>}
          </div>
        );
      })}
      <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 8, lineHeight: 1.45 }}>
        Dosis = concentración ÷ dilución × ritmo ÷ peso. <b>Verificá contra la bomba antes de usar.</b>
      </div>
    </div>
  );
}

function NuevaAnotacion({ onAdd }) {
  const [v, setV] = useState("");
  const enviar = () => { const t = v.trim(); if (!t) return; onAdd(t); setV(""); };
  return (
    <div style={{ display: "flex", gap: 7, marginBottom: 10 }}>
      <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && enviar()}
        placeholder="Qué pasó…" style={{ flex: 1, fontSize: 14, padding: "7px 9px", border: "1.5px solid #E2E8F0", borderRadius: 5, fontFamily: "inherit" }} />
      <button onClick={enviar} style={{ background: "#0F5F66", color: "#fff", border: "none", borderRadius: 5, padding: "7px 13px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Anotar</button>
    </div>
  );
}

function NuevoPendiente({ onAdd }) {
  const [v, setV] = useState("");
  const enviar = () => { const t = v.trim(); if (!t) return; onAdd(t); setV(""); };
  return (
    <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
      <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && enviar()}
        placeholder="Agregar pendiente…" style={{ flex: 1, fontSize: 14, padding: "7px 9px", border: "1.5px solid #E2E8F0", borderRadius: 5, fontFamily: "inherit" }} />
      <button onClick={enviar} style={{ background: "#0F5F66", color: "#fff", border: "none", borderRadius: 5, padding: "7px 13px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Agregar</button>
    </div>
  );
}

function FilaBalance({ onAdd }) {
  const [que, setQue] = useState("");
  const [ml, setMl] = useState("");
  const enviar = () => {
    const q = que.trim(), n = Number(ml);
    if (!q || !isFinite(n)) return;
    onAdd(q, n); setQue(""); setMl("");
  };
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
      <input value={que} onChange={(e) => setQue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && enviar()}
        placeholder="Qué" style={{ flex: 1, fontSize: 13.5, padding: "6px 8px", border: "1.5px solid #E2E8F0", borderRadius: 5, fontFamily: "inherit" }} />
      <input type="number" value={ml} onChange={(e) => setMl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && enviar()}
        placeholder="ml" style={{ width: 72, fontSize: 13.5, padding: "6px 8px", border: "1.5px solid #E2E8F0", borderRadius: 5, fontFamily: "ui-monospace,monospace" }} />
      <button onClick={enviar} style={{ background: "#fff", border: "1.5px solid #E2E8F0", borderRadius: 5, padding: "6px 11px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+</button>
    </div>
  );
}

export default PaseAppView;
