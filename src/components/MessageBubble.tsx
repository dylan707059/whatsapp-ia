"use client";

import { memo, useEffect, useRef, useState } from "react";

interface Props {
  messageId: number;
  role: "user" | "assistant" | "human";
  content: string;
  createdAt: number;
  canDeleteForEveryone?: boolean;   // true si fue mandado por el bot (wa_from_me=1 y tiene wa_msg_id)
  onDelete?: (mode: "me" | "everyone") => void;
}

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString("es", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function MessageBubbleInner(props: Props) {
  const { role, content, createdAt, canDeleteForEveryone, onDelete } = props;
  const isIncoming = role === "user";
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setMenuOpen(true);
  }

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
        onContextMenu={handleContextMenu}
        style={{
          maxWidth: "58%",
          padding: "8px 12px",
          borderRadius: "var(--radius)",
          fontSize: 13.5,
          lineHeight: 1.5,
          wordWrap: "break-word",
          border: "1px solid var(--border)",
          background: isIncoming ? "var(--bubble-in)" : "var(--bubble-out)",
          color: "var(--text)",
          position: "relative",
          cursor: "context-menu"
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
        <div style={{ whiteSpace: "pre-wrap" }}>{content}</div>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--text-dim)",
            marginTop: 4,
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
            <MenuItem
              icon="📋"
              label="Copiar texto"
              onClick={() => {
                navigator.clipboard.writeText(content).catch(() => {});
                setMenuOpen(false);
              }}
            />
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
