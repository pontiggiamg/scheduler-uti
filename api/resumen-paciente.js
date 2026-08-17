// Usamos la misma API gratuita de Google Gemini que en resumen-articulo.js
// (Google AI Studio, "Interactions API", nivel gratuito, sin tarjeta).
var MODEL = "gemini-3.5-flash";
var GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

// Mismas etiquetas que PASE_FIELDS en el frontend (src/App.jsx), para armar
// un texto legible a partir de los campos del pase de cada paciente.
var FIELD_LABELS = {
  req: "Requerimientos / Intercurrencias",
  ea: "Enfermedad actual",
  ap: "Antecedentes",
  tto: "Tratamiento",
  accesos: "Accesos",
  cultivos: "Cultivos",
  estudios: "Complementarios",
  labo: "Laboratorio",
  eab: "EAB",
  pendiente: "Pendientes",
};

var RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    resumen: {
      type: "string",
      description:
        "Resumen clínico formal del paciente, en español rioplatense técnico, adaptado para ser leído por un médico de " +
        "terapia intensiva (vocabulario técnico, sin simplificar). Texto corrido de 3 a 6 párrafos que integra toda la " +
        "información provista del pase (enfermedad actual, antecedentes, tratamiento, accesos, cultivos, estudios, " +
        "laboratorio, EAB, requerimientos/intercurrencias y pendientes). No debe inventar datos que no figuren en la " +
        "información provista.",
    },
    perlas: {
      type: "array",
      items: { type: "string" },
      minItems: 5,
      maxItems: 5,
      description:
        "Exactamente cinco perlas clínicas o consideraciones específicas para este caso particular, basadas en " +
        "medicina basada en la evidencia (MBE) revisada por pares (guías internacionales, ensayos clínicos o " +
        "revisiones sistemáticas reconocidas). Cada perla es una oración o párrafo corto, serio y formal. Si una " +
        "perla se apoya en una fuente concreta, mencionarla dentro del texto de forma breve (autor/es o guía, año).",
    },
    fuentes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          referencia: { type: "string", description: "Cita académica breve: autor(es) o guía/sociedad, revista, año." },
          url: { type: "string", description: "URL o DOI si se conoce con certeza. Dejar vacío si no se está seguro." },
        },
        required: ["referencia"],
      },
      description:
        "Lista de fuentes citadas en las perlas, solo si corresponde. No inventar citas: si no hay una fuente " +
        "concreta y verificable en mente, dejar este arreglo vacío en vez de fabricar una referencia falsa.",
    },
  },
  required: ["resumen", "perlas"],
};

var SYSTEM =
  "Sos un médico intensivista consultor que redacta, a pedido de un colega de terapia intensiva, un resumen " +
  "clínico formal de un paciente internado en UTI a partir de los datos del pase. Tu resumen debe integrar toda " +
  "la información provista en un texto corrido, claro, técnico y formal, adaptado para ser leído por un médico " +
  "de terapia intensiva (no simplifiques el vocabulario médico). No inventes datos que no figuren en la " +
  "información provista. Además, generá exactamente cinco perlas clínicas o consideraciones específicas para " +
  "este caso particular, basadas en medicina basada en la evidencia (MBE) revisada por pares (guías " +
  "internacionales, ensayos clínicos o revisiones sistemáticas reconocidas). Cuando una perla se apoye en una " +
  "fuente concreta, citala de forma breve (autor/es o guía/sociedad, año) y agregala también en el arreglo de " +
  "fuentes con URL o DOI si lo sabés con certeza. Es fundamental que nunca inventes ni fabriques una cita, DOI o " +
  "URL que no conozcas con certeza: ante la duda, referite a la guía o al consenso de forma general en el texto " +
  "de la perla, sin inventar una referencia falsa, y dejá el arreglo de fuentes vacío o incompleto si hace " +
  "falta. El tono tiene que ser serio, formal y profesional en todo momento, en español rioplatense técnico. " +
  "Nota de interpretación de unidades (aplicá esto solo si en los datos provistos aparece un valor de lactato " +
  "o ácido láctico): ese número está expresado en mg/dL, no en mmol/L, salvo que el pase indique explícitamente " +
  "lo contrario. Esto es únicamente una aclaración para interpretar correctamente el valor si aparece — no es una " +
  "instrucción para buscar, mencionar o priorizar el lactato en el resumen o en las perlas si no es relevante " +
  "para el cuadro clínico del paciente. " +
  "Respondé únicamente con el JSON pedido, sin texto adicional.";

function pickApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

function buildPatientText(p) {
  var lines = [];
  lines.push("Cama: " + (p.bed || "—"));
  lines.push("Nombre: " + (p.name || "—"));
  if (p.age) lines.push("Edad: " + p.age + " años");
  if (p.mi) lines.push("Motivo de internación: " + p.mi);
  if (Array.isArray(p.flags) && p.flags.length) lines.push("Alertas: " + p.flags.join(", "));
  var fields = p.fields || {};
  Object.keys(FIELD_LABELS).forEach(function (k) {
    var v = fields[k];
    if (v && String(v).trim()) lines.push(FIELD_LABELS[k].toUpperCase() + ":\n" + String(v).trim());
  });
  return lines.join("\n\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método no permitido, usá POST." });
  }

  try {
    var apiKey = pickApiKey();
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "Falta configurar GEMINI_API_KEY en Vercel (Project Settings → Environment Variables)." });
    }

    var body = req.body || {};
    var p = body.paciente;
    if (!p || typeof p !== "object") {
      return res.status(400).json({ ok: false, error: "Falta la información del paciente (paciente)." });
    }

    var patientText = buildPatientText(p);
    if (!patientText.trim()) {
      return res.status(400).json({ ok: false, error: "El paciente no tiene información cargada en el pase." });
    }

    var geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        system_instruction: SYSTEM,
        input: [
          { type: "text", text: "Datos del pase de este paciente:\n\n" + patientText + "\n\nGenerá el resumen clínico formal y las cinco perlas en el formato JSON pedido." },
        ],
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: RESPONSE_SCHEMA,
        },
        generation_config: {
          temperature: 0.3,
          max_output_tokens: 8000,
        },
      }),
    });

    if (!geminiRes.ok) {
      var errText = await geminiRes.text();
      return res.status(502).json({ ok: false, error: "Error de la API de Gemini: " + errText.slice(0, 500) });
    }

    var data = await geminiRes.json();
    var textOut = data.output_text;
    if (!textOut && Array.isArray(data.steps)) {
      for (var s = data.steps.length - 1; s >= 0; s--) {
        var step = data.steps[s];
        if (step.type === "model_output" && Array.isArray(step.content)) {
          var textBlock = step.content.find(function (c) { return c.type === "text" && c.text; });
          if (textBlock) { textOut = textBlock.text; break; }
        }
      }
    }

    if (!textOut) {
      return res.status(502).json({ ok: false, error: "Gemini no devolvió el resumen en el formato esperado." });
    }

    var out;
    try {
      out = JSON.parse(textOut);
    } catch (e1) {
      var cleaned = textOut.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      var match = cleaned.match(/\{[\s\S]*\}/);
      try {
        out = JSON.parse(match ? match[0] : cleaned);
      } catch (e2) {
        var statusInfo = "status=" + data.status;
        if (Array.isArray(data.steps)) {
          statusInfo += " steps=" + data.steps.map(function (s) { return s.type + ":" + s.status; }).join(",");
        }
        return res.status(502).json({
          ok: false,
          error: "No se pudo interpretar la respuesta de Gemini como JSON. Detalle: " + e2.message +
            " | " + statusInfo +
            " | Longitud: " + textOut.length +
            " | Final: " + textOut.slice(-250),
        });
      }
    }

    var payload = {
      resumen: typeof out.resumen === "string" ? out.resumen : "",
      perlas: Array.isArray(out.perlas) ? out.perlas.slice(0, 5) : [],
      fuentes: Array.isArray(out.fuentes) ? out.fuentes.filter(function (f) { return f && typeof f.referencia === "string" && f.referencia.trim(); }) : [],
      generatedAt: new Date().toISOString(),
      generatedBy: "Gemini (" + MODEL + ")",
    };

    return res.status(200).json({ ok: true, resumen: payload });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
