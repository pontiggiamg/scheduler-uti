import { initializeApp, getApps } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";

var firebaseConfig = {
  apiKey: "AIzaSyAHjLDpf9MZr8I6KA1sg3Ofr0GzN0IYENw",
  authDomain: "residencia-uti-hb.firebaseapp.com",
  projectId: "residencia-uti-hb",
  storageBucket: "residencia-uti-hb.firebasestorage.app",
  messagingSenderId: "404025159387",
  appId: "1:404025159387:web:eab539798b975a00dca6fe",
};

var app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
var db = getFirestore(app);

// Límite práctico: Vercel corta el body de una función serverless en ~4.5MB.
// Un PDF en base64 pesa ~33% más que el original, así que ponemos el techo
// bastante antes de eso para poder devolver un error claro en vez de un 413 crudo.
var MAX_BASE64_CHARS = 5_500_000; // ~4MB de PDF original aprox.

var MODEL = "claude-sonnet-5";

var TOOL = {
  name: "entregar_resumen",
  description: "Entrega el resumen del artículo y las preguntas para la residencia.",
  input_schema: {
    type: "object",
    properties: {
      resumen: {
        type: "string",
        description: "Resumen del artículo en español rioplatense, claro y directo, de 3 a 5 párrafos. Sin bullets.",
      },
      preguntas_r2: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
        description: "Tres preguntas para pensar, nivel R2 (residentes de segundo año). Son para reflexionar, no llevan respuesta.",
      },
      preguntas_r3_r4: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
        description: "Tres preguntas más avanzadas, para R3 y R4. Son para reflexionar, no llevan respuesta.",
      },
    },
    required: ["resumen", "preguntas_r2", "preguntas_r3_r4"],
  },
};

var SYSTEM = "Sos un asistente que ayuda a armar el material semanal de una residencia de terapia intensiva " +
  "en un hospital de Buenos Aires. Vas a leer un artículo (paper o capítulo de libro) que subió el jefe de " +
  "residentes y tenés que devolver, usando la herramienta entregar_resumen: un resumen fiel del artículo en " +
  "español rioplatense, y dos tandas de tres preguntas cada una para disparar discusión en el pase o el ateneo. " +
  "Las preguntas de R2 apuntan a conceptos de base; las de R3/R4 apuntan a manejo clínico, controversias o " +
  "matices más finos. Ninguna pregunta lleva la respuesta incluida, son solo para pensar.";

function pickApiKey() {
  return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método no permitido, usá POST." });
  }

  try {
    var apiKey = pickApiKey();
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "Falta configurar ANTHROPIC_API_KEY en Vercel (Project Settings → Environment Variables)." });
    }

    var body = req.body || {};
    var pdfBase64 = body.pdfBase64;
    var filename = typeof body.filename === "string" && body.filename ? body.filename : "articulo.pdf";

    if (!pdfBase64 || typeof pdfBase64 !== "string") {
      return res.status(400).json({ ok: false, error: "Falta el PDF (pdfBase64)." });
    }
    if (pdfBase64.length > MAX_BASE64_CHARS) {
      return res.status(413).json({ ok: false, error: "El PDF es demasiado grande. Probá con un extracto más corto (menos de ~4MB)." });
    }

    var anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "entregar_resumen" },
        messages: [
          {
            role: "user",
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
              { type: "text", text: "Este es el artículo de la semana. Generá el resumen y las preguntas con la herramienta entregar_resumen." },
            ],
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      var errText = await anthropicRes.text();
      return res.status(502).json({ ok: false, error: "Error de la API de Claude: " + errText.slice(0, 500) });
    }

    var data = await anthropicRes.json();
    var toolBlock = (data.content || []).find(function (b) { return b.type === "tool_use" && b.name === "entregar_resumen"; });
    if (!toolBlock) {
      return res.status(502).json({ ok: false, error: "Claude no devolvió el resumen en el formato esperado." });
    }

    var out = toolBlock.input || {};
    var payload = {
      filename: filename,
      resumen: typeof out.resumen === "string" ? out.resumen : "",
      preguntasR2: Array.isArray(out.preguntas_r2) ? out.preguntas_r2.slice(0, 3) : [],
      preguntasR3R4: Array.isArray(out.preguntas_r3_r4) ? out.preguntas_r3_r4.slice(0, 3) : [],
      generatedAt: new Date().toISOString(),
      generatedBy: "Claude (" + MODEL + ")",
    };

    await setDoc(doc(db, "scheduler", "articulo-semana"), payload);

    return res.status(200).json({ ok: true, articulo: payload });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
