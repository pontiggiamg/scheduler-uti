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

// Usamos la API gratuita de Google Gemini (Google AI Studio) en vez de la de
// Claude para no depender de crédito pago: gemini-2.5-flash tiene nivel
// gratuito sin tarjeta, entiende PDFs nativamente y devuelve JSON estructurado.
var MODEL = "gemini-2.5-flash";
var GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent";

var RESPONSE_SCHEMA = {
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
};

var SYSTEM = "Sos un asistente que ayuda a armar el material semanal de una residencia de terapia intensiva " +
  "en un hospital de Buenos Aires. Vas a leer un artículo (paper o capítulo de libro) que subió el jefe de " +
  "residentes y tenés que devolver un resumen fiel del artículo en español rioplatense, y dos tandas de tres " +
  "preguntas cada una para disparar discusión en el pase o el ateneo. Las preguntas de R2 apuntan a conceptos " +
  "de base; las de R3/R4 apuntan a manejo clínico, controversias o matices más finos. Ninguna pregunta lleva " +
  "la respuesta incluida, son solo para pensar. Respondé únicamente con el JSON pedido, sin texto adicional.";

function pickApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
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
    var pdfBase64 = body.pdfBase64;
    var filename = typeof body.filename === "string" && body.filename ? body.filename : "articulo.pdf";

    if (!pdfBase64 || typeof pdfBase64 !== "string") {
      return res.status(400).json({ ok: false, error: "Falta el PDF (pdfBase64)." });
    }
    if (pdfBase64.length > MAX_BASE64_CHARS) {
      return res.status(413).json({ ok: false, error: "El PDF es demasiado grande. Probá con un extracto más corto (menos de ~4MB)." });
    }

    var geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
              { text: "Este es el artículo de la semana. Generá el resumen y las preguntas en el formato JSON pedido." },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.4,
          maxOutputTokens: 2000,
        },
      }),
    });

    if (!geminiRes.ok) {
      var errText = await geminiRes.text();
      return res.status(502).json({ ok: false, error: "Error de la API de Gemini: " + errText.slice(0, 500) });
    }

    var data = await geminiRes.json();
    var textOut = data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    if (!textOut) {
      return res.status(502).json({ ok: false, error: "Gemini no devolvió el resumen en el formato esperado." });
    }

    var out;
    try { out = JSON.parse(textOut); } catch (e) {
      return res.status(502).json({ ok: false, error: "No se pudo interpretar la respuesta de Gemini como JSON." });
    }

    var payload = {
      filename: filename,
      resumen: typeof out.resumen === "string" ? out.resumen : "",
      preguntasR2: Array.isArray(out.preguntas_r2) ? out.preguntas_r2.slice(0, 3) : [],
      preguntasR3R4: Array.isArray(out.preguntas_r3_r4) ? out.preguntas_r3_r4.slice(0, 3) : [],
      generatedAt: new Date().toISOString(),
      generatedBy: "Gemini (" + MODEL + ")",
    };

    await setDoc(doc(db, "scheduler", "articulo-semana"), payload);

    return res.status(200).json({ ok: true, articulo: payload });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
