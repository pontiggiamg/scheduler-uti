// Avisa por Telegram cuando alguien pide acceso al scheduler privado.
//
// Se usa Telegram y no push web / mail porque es lo único que cumple las tres
// condiciones del proyecto: gratis de verdad (sin tarjeta), confiable en
// iPhone, y sin sumar dependencias nuevas al build (es un solo fetch a la API
// pública de Telegram).
//
// Config necesaria en Vercel (Project Settings → Environment Variables):
//   TELEGRAM_BOT_TOKEN → el token que devuelve @BotFather al crear el bot
//   TELEGRAM_CHAT_ID   → el id del chat personal donde tiene que llegar el aviso
//
// Este endpoint es "mejor esfuerzo": si falla o no está configurado, la
// solicitud de acceso igual ya quedó guardada en Firestore y el admin la ve
// con el badge rojo de la pestaña Accesos. Nunca debe romper el login.

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método no permitido, usá POST." });
  }

  try {
    var token = process.env.TELEGRAM_BOT_TOKEN;
    var chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      return res.status(500).json({ ok: false, error: "Faltan TELEGRAM_BOT_TOKEN y/o TELEGRAM_CHAT_ID en las variables de entorno de Vercel." });
    }

    var body = req.body || {};
    var email = typeof body.email === "string" ? body.email.trim() : "";
    var displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!email) {
      return res.status(400).json({ ok: false, error: "Falta el email de quien pide acceso." });
    }

    var texto =
      "🔐 <b>Nueva solicitud de acceso</b>\n" +
      "Scheduler UTI — Hospital Británico\n\n" +
      (displayName ? "👤 " + escapeHtml(displayName) + "\n" : "") +
      "✉️ " + escapeHtml(email) + "\n\n" +
      "Entrá a la app con tu cuenta de admin y abrí la pestaña 🔐 Accesos para autorizar o rechazar.";

    var tgRes = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: texto,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    if (!tgRes.ok) {
      var errText = await tgRes.text();
      return res.status(502).json({ ok: false, error: "Telegram rechazó el envío: " + errText.slice(0, 300) });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
