/* ══════════════════════════════════════════════════════════════════════════
   La pestaña de articulo
   ══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useRef } from "react";
import { db } from "../firebase";
import { doc, setDoc, deleteDoc, collection, query, orderBy } from "firebase/firestore";
import { escuchar, escribir } from "../nube";
import { Skeleton } from "../comunes";
import { formatFechaHora } from "../fechas";
import { Banner, INPUT, NAV } from "../ui";

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || "";
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(file);
  });
}

function ArticuloSemanaView({ isAdmin }) {
  const [articulos, setArticulos] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [driveUrl, setDriveUrl] = useState("");
  const fileRef = useRef(null);

  useEffect(() => {
    setLoading(true);
    const q = query(collection(db, "articulos_semana"), orderBy("generatedAt", "desc"));
    const unsub = escuchar(q, (snap) => {
      setArticulos(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, "los artículos de la semana", () => setLoading(false));
    return () => unsub();
  }, []);

  // El más reciente arranca desplegado; si llega uno nuevo, pasa a ser ese.
  useEffect(() => {
    if (articulos && articulos.length > 0) setOpenId((cur) => cur ?? articulos[0].id);
  }, [articulos]);

  const eliminarArticulo = async (id) => {
    if (!confirm("¿Eliminar este artículo? Se borra el resumen, las preguntas y el link — no se puede deshacer.")) return;
    await escribir(deleteDoc(doc(db, "articulos_semana", id)), "borrar el artículo");
  };

  const guardarPdfUrl = async (id, url) => {
    await escribir(setDoc(doc(db, "articulos_semana", id), { pdfUrl: url.trim() || null }, { merge: true }), "el PDF del artículo");
  };

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    if (file.type !== "application/pdf") { setError("El archivo tiene que ser un PDF."); return; }
    if (file.size > 4.3 * 1024 * 1024) { setError("El PDF es demasiado grande (máx. ~4MB). Probá con un extracto más corto."); return; }
    setError(""); setUploading(true);
    try {
      const pdfBase64 = await fileToBase64(file);
      const res = await fetch("/api/resumen-articulo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pdfBase64, filename: file.name, pdfUrl: driveUrl.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "No se pudo generar el resumen.");
      setDriveUrl("");
      setOpenId(null); // se va a abrir el nuevo (el más reciente) apenas llegue por onSnapshot
    } catch (err) {
      setError(err.message || "Error inesperado al generar el resumen.");
    } finally {
      setUploading(false);
    }
  };

  if (loading) return <Skeleton />;

  return (
    <div>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 14, background: "linear-gradient(135deg,#0F172A,#1E293B 60%,#334155)", color: "#fff" }}>
        <span style={{ fontSize: 22 }}>📄</span>
        <div><div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: -0.3 }}>Artículo de la semana</div><div style={{ fontSize: 10.5, opacity: 0.55 }}>Hospital Británico</div></div>
      </div>

      {isAdmin && (
        <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 12, padding: "12px 14px", marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
            <div style={{ fontSize: 12, color: "#475569" }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: "#0F172A", marginBottom: 2 }}>Subir un artículo nuevo</div>
              Subí el PDF del artículo de la semana y la IA genera un resumen y preguntas para discutir en el pase. Los anteriores quedan guardados abajo como historial.
            </div>
            <label style={{ ...NAV, background: uploading ? "#94A3B8" : "#0F172A", color: "#fff", width: "auto", padding: "8px 16px", fontSize: 12, opacity: uploading ? 0.7 : 1, cursor: uploading ? "default" : "pointer" }}>
              {uploading ? "Generando resumen…" : "📤 Subir PDF"}
              <input ref={fileRef} type="file" accept="application/pdf" onChange={handleFile} disabled={uploading} style={{ display: "none" }} />
            </label>
          </div>
          <div>
            <input
              value={driveUrl}
              onChange={(e) => setDriveUrl(e.target.value)}
              placeholder="Opcional: pegá acá el link para compartir del PDF en tu Google Drive (para que los residentes lo puedan descargar)"
              disabled={uploading}
              style={{ ...INPUT, width: "100%", boxSizing: "border-box" }}
            />
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="warn">{error}</Banner>
        </div>
      )}

      {!articulos || articulos.length === 0 ? (
        <div style={{ textAlign: "center", padding: 30, color: "#64748B", fontSize: 12.5, background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0" }}>
          Todavía no se cargó ningún artículo{isAdmin ? " — tocá \"Subir PDF\" para generar el primero." : "."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {articulos.map((a, i) => (
            <ArticuloCard key={a.id} articulo={a} isOpen={openId === a.id} isLatest={i === 0} isAdmin={isAdmin} onToggle={() => setOpenId((cur) => (cur === a.id ? null : a.id))} onDelete={() => eliminarArticulo(a.id)} onSavePdfUrl={(url) => guardarPdfUrl(a.id, url)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArticuloCard({ articulo, isOpen, isLatest, isAdmin, onToggle, onDelete, onSavePdfUrl }) {
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlValue, setUrlValue] = useState(articulo.pdfUrl || "");

  const startEditUrl = (e) => { e.stopPropagation(); setUrlValue(articulo.pdfUrl || ""); setEditingUrl(true); };
  const saveUrl = (e) => { e.stopPropagation(); onSavePdfUrl(urlValue); setEditingUrl(false); };
  const cancelUrl = (e) => { e.stopPropagation(); setEditingUrl(false); };

  return (
    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(15,23,42,.04)", overflow: "hidden" }}>
      <div onClick={onToggle} style={{ cursor: "pointer", padding: "14px 18px", borderBottom: isOpen ? "1px solid #F1F5F9" : "none", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span className="no-print" style={{ display: "inline-block", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s", color: "#64748B", fontSize: 12 }}>▶</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 14.5, color: "#0F172A", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>📄 {articulo.filename || "Artículo"}</div>
            <div style={{ fontSize: 10.5, color: "#64748B", marginTop: 2 }}>{formatFechaHora(articulo.generatedAt)}{isLatest && <span style={{ marginLeft: 6, fontWeight: 700, color: "#16A34A" }}>· más reciente</span>}</div>
          </div>
        </div>
        <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {articulo.pdfUrl && (
            <a href={articulo.pdfUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: "#0F172A", color: "#fff", textDecoration: "none" }}>📄 Ver PDF</a>
          )}
          {isAdmin && (
            <button onClick={startEditUrl} title={articulo.pdfUrl ? "Editar link del PDF" : "Agregar link del PDF"} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: "#F1F5F9", color: "#475569", border: "1px solid #E2E8F0", cursor: "pointer", fontFamily: "inherit" }}>
              🔗 {articulo.pdfUrl ? "Editar link" : "Agregar link"}
            </button>
          )}
          <div style={{ fontSize: 10.5, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: "#EEF2FF", color: "#4338CA", border: "1px solid #C7D2FE" }}>🤖 Generado por IA</div>
          {isAdmin && (
            <button onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Eliminar artículo" style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 14, fontFamily: "inherit", padding: "2px 2px" }}>🗑️</button>
          )}
        </div>
      </div>

      {isAdmin && editingUrl && (
        <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6, alignItems: "center", padding: "10px 18px", background: "#F8FAFC", borderBottom: "1px solid #F1F5F9", flexWrap: "wrap" }}>
          <input
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            placeholder="Link para compartir del PDF en Google Drive…"
            onKeyDown={(e) => e.key === "Enter" && saveUrl(e)}
            style={{ ...INPUT, flex: 1, minWidth: 200, boxSizing: "border-box" }}
          />
          <button onClick={saveUrl} style={{ background: "#16A34A", color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓ Guardar</button>
          <button onClick={cancelUrl} style={{ background: "#E2E8F0", color: "#64748B", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
        </div>
      )}

      {isOpen && (
        <>
          <div style={{ padding: "16px 18px" }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: "#334155", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>Resumen</div>
            <div style={{ fontSize: 13, color: "#1E293B", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{articulo.resumen || "—"}</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, borderTop: "1px solid #F1F5F9" }}>
            <div style={{ padding: "14px 18px", borderRight: "1px solid #F1F5F9" }}>
              <div style={{ fontWeight: 700, fontSize: 11.5, color: "#1D4ED8", marginBottom: 8 }}>❓ Preguntas para R2</div>
              <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}>
                {(articulo.preguntasR2 || []).map((q, i) => (
                  <li key={i} style={{ fontSize: 12.5, color: "#334155", lineHeight: 1.5 }}>{q}</li>
                ))}
              </ol>
            </div>
            <div style={{ padding: "14px 18px" }}>
              <div style={{ fontWeight: 700, fontSize: 11.5, color: "#B45309", marginBottom: 8 }}>❓ Preguntas para R3 y R4</div>
              <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}>
                {(articulo.preguntasR3R4 || []).map((q, i) => (
                  <li key={i} style={{ fontSize: 12.5, color: "#334155", lineHeight: 1.5 }}>{q}</li>
                ))}
              </ol>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ══════════════════ REGISTRO (llegadas tarde / faltas / guardias / procedimientos) ══════════════════ */

export { ArticuloCard, ArticuloSemanaView, fileToBase64 };
