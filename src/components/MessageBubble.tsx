"use client";

import { memo, useEffect, useRef, useState } from "react";

interface Props {
  messageId: number;
  role: "user" | "assistant" | "human";
  content: string;
  createdAt: number;
  canDeleteForEveryone?: boolean;   // true si fue mandado por el bot (wa_from_me=1 y tiene wa_msg_id)
  onDelete?: (mode: "me" | "everyone") => void;
  // Multimedia (opcional)
  mediaType?: string | null;        // 'image' | 'video' | 'document'
  mediaMime?: string | null;
  mediaFilename?: string | null;
  // Para mensajes optimistas locales: previa antes de que el server confirme
  localPreviewUrl?: string | null;
}

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString("es", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function MessageBubbleInner(props: Props) {
  const { messageId, role, content, createdAt, canDeleteForEveryone, onDelete } = props;
  const { mediaType, mediaFilename, localPreviewUrl } = props;
  const isIncoming = role === "user";
  const hasRemote = messageId > 0;
  const isMedia = !!mediaType && (hasRemote || !!localPreviewUrl);
  const [menuOpen, setMenuOpen] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // URL del archivo: del server (mensaje real) o previa local (optimista).
  const mediaUrl = hasRemote ? `/api/media/${messageId}` : (localPreviewUrl ?? "");
  const hasCaption = content.trim().length > 0;

  useEffect(() => {
    if (!menuOpen) return;
    function handler(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  // Cerrar el visor en grande con Escape.
  useEffect(() => {
    if (!lightbox) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLightbox(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox]);

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setMenuOpen(true);
  }

  const padding = isMedia ? 4 : "7px 10px";

  return (
    <div
      ref={wrapRef}
      style={{
        display: "flex",
        justifyContent: isIncoming ? "flex-start" : "flex-end",
        marginBottom: 2,
        position: "relative"
      }}
    >
      <div
        className={isIncoming ? "bubble bubble-in" : "bubble bubble-out"}
        onContextMenu={handleContextMenu}
        style={{
          maxWidth: isMedia ? 320 : "62%",
          padding,
          borderRadius: isIncoming ? "0 8px 8px 8px" : "8px 0 8px 8px",
          fontSize: 13.5,
          lineHeight: 1.45,
          wordWrap: "break-word",
          background: isIncoming ? "var(--bubble-in)" : "var(--bubble-out)",
          color: "var(--text)",
          position: "relative",
          cursor: "context-menu",
          boxShadow: "0 1px 0.5px rgba(0,0,0,0.13)"
        }}
        onMouseEnter={(e) => {
          const btn = e.currentTarget.querySelector("[data-menu-btn]") as HTMLElement | null;
          if (btn) btn.style.opacity = "1";
        }}
        onMouseLeave={(e) => {
          if (menuOpen) return;
          const btn = e.currentTarget.querySelector("[data-menu-btn]") as HTMLElement | null;
          if (btn) btn.style.opacity = "0";
        }}
      >
        {/* ─── Multimedia ─── */}
        {isMedia && mediaType === "image" && mediaUrl && (
          <img
            src={mediaUrl}
            alt={hasCaption ? content : "Foto"}
            onClick={() => mediaUrl && setLightbox(true)}
            style={{
              display: "block",
              maxWidth: 312,
              maxHeight: 380,
              width: "auto",
              height: "auto",
              borderRadius: 6,
              cursor: mediaUrl ? "zoom-in" : "default"
            }}
          />
        )}
        {isMedia && mediaType === "video" && mediaUrl && (
          <video
            src={mediaUrl}
            controls
            preload="metadata"
            playsInline
            style={{
              display: "block",
              maxWidth: 312,
              maxHeight: 380,
              borderRadius: 6,
              background: "#000"
            }}
          />
        )}
        {isMedia && mediaType === "document" && (
          <a
            href={messageId > 0 ? `${mediaUrl}?download=1` : undefined}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              minWidth: 220,
              borderRadius: 6,
              background: "var(--bg-elev-2)",
              color: "var(--text)",
              textDecoration: "none"
            }}
          >
            <span style={{ fontSize: 26, lineHeight: 1 }}>📄</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }}
              >
                {mediaFilename || "Documento"}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Descargar</span>
            </span>
            <span style={{ fontSize: 16, opacity: 0.7 }}>⬇️</span>
          </a>
        )}

        {/* ─── Texto / caption ─── */}
        {hasCaption && (
          <div
            style={{
              whiteSpace: "pre-wrap",
              padding: isMedia ? "5px 6px 0" : 0
            }}
          >
            {content}
          </div>
        )}

        {/* ─── Meta (hora + etiqueta AUTO/MANUAL) ─── */}
        <div
          style={{
            fontSize: 10.5,
            color: "var(--text-dim)",
            marginTop: 3,
            padding: isMedia ? "0 6px 2px" : 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            justifyContent: isIncoming ? "flex-start" : "flex-end"
          }}
        >
          {role === "human" && (
            <span
              style={{ fontWeight: 600, color: "var(--warning)", fontSize: 9.5 }}
              title="Mensaje enviado manualmente"
            >
              MANUAL
            </span>
          )}
          {role === "assistant" && !isIncoming && (
            <span
              style={{ fontWeight: 600, color: "var(--success)", fontSize: 9.5 }}
              title="Mensaje automático del bot"
            >
              AUTO
            </span>
          )}
          <span>{formatTime(createdAt)}</span>
        </div>

        {/* Botón ⋯ que aparece on hover */}
        {onDelete && (
          <button
            data-menu-btn
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            style={{
              position: "absolute",
              top: 4,
              [isIncoming ? "right" : "left"]: -28,
              width: 24, height: 24,
              borderRadius: "50%",
              background: "var(--bg-elev-2)",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              opacity: menuOpen ? 1 : 0,
              transition: "opacity 0.12s",
              fontSize: 14,
              lineHeight: 1
            } as React.CSSProperties}
            title="Más opciones"
          >
            ⋯
          </button>
        )}

        {/* Menú contextual */}
        {menuOpen && onDelete && (
          <div
            className="fade-in"
            style={{
              position: "absolute",
              top: 28,
              [isIncoming ? "left" : "right"]: 0,
              zIndex: 40,
              minWidth: 200,
              background: "var(--bg-elev)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-lg)",
              padding: 4,
              boxShadow: "0 8px 32px rgba(0,0,0,0.25)"
            } as React.CSSProperties}
          >
            {isMedia ? (
              <MenuItem
                icon="⬇️"
                label="Descargar"
                onClick={() => {
                  if (messageId > 0) window.open(`${mediaUrl}?download=1`, "_blank");
                  setMenuOpen(false);
                }}
              />
            ) : (
              <MenuItem
                icon="📋"
                label="Copiar texto"
                onClick={() => {
                  navigator.clipboard.writeText(content).catch(() => {});
                  setMenuOpen(false);
                }}
              />
            )}
            <MenuItem
              icon="🗑"
              label="Eliminar para mí"
              onClick={() => { onDelete("me"); setMenuOpen(false); }}
            />
            {canDeleteForEveryone && (
              <MenuItem
                icon="🗑"
                label="Eliminar para todos"
                danger
                onClick={() => { onDelete("everyone"); setMenuOpen(false); }}
              />
            )}
          </div>
        )}
      </div>

      {/* ─── Visor en grande (lightbox) ─── */}
      {lightbox && (mediaType === "image" || mediaType === "video") && (
        <div
          onClick={() => setLightbox(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.92)",
            zIndex: 3000,
            display: "grid",
            placeItems: "center",
            padding: 28
          }}
        >
          {mediaType === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={mediaUrl}
              alt={content || "Foto"}
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: "92vw", maxHeight: "88vh", objectFit: "contain", borderRadius: 4 }}
            />
          ) : (
            <video
              src={mediaUrl}
              controls
              autoPlay
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: "92vw", maxHeight: "88vh", borderRadius: 4 }}
            />
          )}
          <button
            onClick={() => setLightbox(false)}
            style={{ position: "fixed", top: 16, right: 22, color: "#fff", fontSize: 28, lineHeight: 1 }}
            title="Cerrar (Esc)"
          >
            ✕
          </button>
          <a
            href={`${mediaUrl}?download=1`}
            onClick={(e) => e.stopPropagation()}
            style={{ position: "fixed", top: 20, right: 66, color: "#fff", fontSize: 20, textDecoration: "none" }}
            title="Descargar"
          >
            ⬇️
          </a>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon, label, onClick, danger
}: {
  icon: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        padding: "8px 10px",
        textAlign: "left",
        borderRadius: "var(--radius-sm)",
        fontSize: 13,
        color: danger ? "var(--danger)" : "var(--text)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        transition: "background 0.1s"
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ width: 16, opacity: 0.8 }}>{icon}</span>
      {label}
    </button>
  );
}

const MessageBubble = memo(MessageBubbleInner);
export default MessageBubble;
