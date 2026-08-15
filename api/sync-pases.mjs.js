export default async function handler(req, res) {
  try {
    res.status(200).json({ ok: true, message: "Test OK" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}