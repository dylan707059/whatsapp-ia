"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation, Message } from "@/lib/types";
import { jidToDisplay } from "@/lib/types";
import MessageBubble from "./MessageBubble";
import OrderSummary from "./OrderSummary";
import LabelsPopover from "./LabelsPopover";
import ConversationInfo from "./ConversationInfo";
import { useEventStream } from "./useEventStream";

interface Props {
  conversation: Conversation;
  onModeChange: (id: number, mode: "AI" | "HUMAN") => void;
  onDelete: (id: number) => void;
  onArchiveToggle?: (id: number, archived: boolean) => void;
  onPinToggle?: (id: number, pinned: boolean) => void;
}

const AVATAR_GRADIENTS = [
  ["#5e6ad2", "#4751b8"], ["#46d39a", "#2da776"], ["#f472b6", "#c83a8e"],
  ["#ffb547", "#c98326"], ["#60a5fa", "#3b82f6"], ["#a78bfa", "#8b5cf6"],
  ["#fb923c", "#ea580c"], ["#34d399", "#10b981"]
];
function avatarColors(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length] as [string, string];
}
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function ConversationPanel({
  conversation, onModeChange, onDelete, onArchiveToggle, onPinToggle
}: Props) {
  const isArchived = conversation.archived_at != null;
  const isPinned   = conversation.pinned_at != null;

  const [messages, setMessages]   = useState<Message[]>([]);
  const [mode, setMode]           = useState<"AI" | "HUMAN">(conversation.mode);
  const [input, setInput]         = useState("");
  const [sending, setSending]     = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [infoOpen, setInfoOpen]     = useState(false);
  const bottomRef                 = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMode(conversation.mode);
    fetchMessages();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  // SSE: cualquier mensaje nuevo dispara refetch de este chat.
  // (Optimización futura: filtrar por conversationId en el evento.)
  const onMsgEvent = useCallback(() => { fetchMessages(); }, [conversation.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEventStream("/api/events", { msg: onMsgEvent });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function fetchMessages() {
    try {
      const res = await fetch(`/api/messages/${conversation.id}`);
      if (res.ok) setMessages(await res.json());
    } catch {}
  }

  async function toggleMode() {
    const next: "AI" | "HUMAN" = mode === "AI" ? "HUMAN" : "AI";
    setMode(next);
    onModeChange(conversation.id, next);
    try {
      await fetch(`/api/mode/${conversation.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next })
      });
    } catch (err) { console.error(err); }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");

    // OPTIMISTIC: agregamos el mensaje al estado local YA, con id temporal
    // negativo. Cuando el server confirma, el fetchMessages lo reemplaza
    // por el real. Si falla, queda marcado como "fallido" (id < 0).
    const tempId = -Date.now();
    const optimistic: Message = {
      id: tempId,
      conversation_id: conversation.id,
      role: "human",
      content: text,
      created_at: Math.floor(Date.now() / 1000)
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const res = await fetch(`/api/messages/${conversation.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refetch para reemplazar el optimistic por el mensaje real con id correcto
      await fetchMessages();
    } catch (err) {
      console.error("[ui] Error enviando mensaje:", err);
      // Marcar el optimistic como fallido: mantener pero cambiar el contenido
      // para indicar el problema; el user puede reintentar copiando+pegando.
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId
          ? { ...m, content: `❌ FALLÓ ENVIAR: ${text}` }
          : m
        ))
      );
    } finally {
      setSending(false);
    }
  }

  async function handleDelete() {
    const display = conversation.name || jidToDisplay(conversation.phone);
    if (!confirm(`¿Borrar la conversación con ${display}? Esta acción no se puede deshacer.`)) return;
    await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
    onDelete(conversation.id);
  }

  const name = conversation.name?.trim() || jidToDisplay(conversation.phone);
  const [g1, g2] = avatarColors(name);
  const initials = initialsOf(name);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)" }}>
      {/* Header */}
      <div
        style={{
          padding: "12px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          background: "var(--bg-elev)"
        }}
      >
        <div
          style={{
            width: 36, height: 36, borderRadius: 6,
            background: `linear-gradient(135deg, ${g1}, ${g2})`,
            display: "grid", placeItems: "center",
            color: "#fff", fontWeight: 600, fontSize: 13,
            flexShrink: 0
          }}
        >
          {initials}
        </div>
        <button
          onClick={() => setInfoOpen((v) => !v)}
          title="Ver información del cliente"
          style={{ flex: 1, minWidth: 0, textAlign: "left", background: "transparent" }}
        >
          <div
            style={{
              fontWeight: 600,
              fontSize: 14,
              color: "var(--text)",
              display: "flex",
              alignItems: "center",
              gap: 8
            }}
          >
            {isPinned && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>📌</span>}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {name}
            </span>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{infoOpen ? "▲" : "▾"}</span>
          </div>
          <div
            className="font-mono"
            style={{ fontSize: 11, color: "var(--text-muted)" }}
          >
            {jidToDisplay(conversation.phone)}
          </div>
        </button>

        {/* Action buttons */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <ModeChip mode={mode} onClick={toggleMode} />
          {onPinToggle && (
            <IconBtn
              active={isPinned}
              onClick={() => onPinToggle(conversation.id, isPinned)}
              title={isPinned ? "Desfijar" : "Fijar arriba"}
            >
              📌
            </IconBtn>
          )}
          <div style={{ position: "relative" }}>
            <IconBtn
              active={labelsOpen}
              onClick={() => setLabelsOpen((v) => !v)}
              title="Etiquetas"
            >
              🏷️
            </IconBtn>
            {labelsOpen && (
              <LabelsPopover
                conversationId={conversation.id}
                onClose={() => setLabelsOpen(false)}
              />
            )}
          </div>
          {onArchiveToggle && (
            <IconBtn
              onClick={() => onArchiveToggle(conversation.id, isArchived)}
              title={isArchived ? "Desarchivar" : "Archivar"}
            >
              {isArchived ? "↩️" : "📁"}
            </IconBtn>
          )}
          <IconBtn onClick={handleDelete} title="Borrar" danger>
            🗑️
          </IconBtn>
        </div>
      </div>

      {/* Panel de información del cliente (clic en el nombre) */}
      {infoOpen && (
        <ConversationInfo
          conversation={conversation}
          isPinned={isPinned}
          isArchived={isArchived}
          onPinToggle={onPinToggle ? () => onPinToggle(conversation.id, isPinned) : undefined}
          onArchiveToggle={onArchiveToggle ? () => onArchiveToggle(conversation.id, isArchived) : undefined}
          onClose={() => setInfoOpen(false)}
        />
      )}

      {/* Order summary */}
      <OrderSummary conversationId={conversation.id} />

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "14px 20px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 8
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              textAlign: "center",
              color: "var(--text-dim)",
              fontSize: 12,
              marginTop: 32
            }}
          >
            Sin mensajes todavía.
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            messageId={msg.id}
            role={msg.role}
            content={msg.content}
            createdAt={msg.created_at}
            canDeleteForEveryone={msg.wa_from_me === 1 && !!msg.wa_msg_id}
            onDelete={async (mode) => {
              if (msg.id < 0) return; // optimistic, ignorar
              try {
                await fetch(`/api/messages/item/${msg.id}?for=${mode}`, { method: "DELETE" });
                setMessages((prev) => prev.filter((m) => m.id !== msg.id));
              } catch (err) { console.error(err); }
            }}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div
        style={{
          padding: "10px 14px",
          borderTop: "1px solid var(--border)",
          background: "var(--bg-elev)",
          display: "flex",
          alignItems: "center",
          gap: 8
        }}
      >
        {mode === "AI" ? (
          <div
            style={{
              flex: 1,
              textAlign: "center",
              fontSize: 12,
              color: "var(--text-muted)",
              padding: "8px 12px"
            }}
          >
            🤖 El bot responde automáticamente en modo IA — cambia a HUMAN para escribir manualmente
          </div>
        ) : (
          <>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={`Mensaje a ${name.split(" ")[0]}...`}
              disabled={sending}
              style={{
                flex: 1,
                background: "var(--bg-elev-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "8px 12px",
                color: "var(--text)",
                fontSize: 13.5,
                fontFamily: "inherit",
                outline: 0,
                opacity: sending ? 0.5 : 1
              }}
            />
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              style={{
                padding: "7px 14px",
                background: input.trim() ? "var(--accent)" : "var(--bg-elev-2)",
                color: input.trim() ? "#fff" : "var(--text-dim)",
                borderRadius: "var(--radius)",
                fontSize: 12.5,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 6,
                transition: "all 0.1s"
              }}
            >
              Enviar
              <span
                style={{
                  fontSize: 10,
                  opacity: 0.8,
                  padding: "0 4px",
                  background: input.trim() ? "rgba(255,255,255,0.18)" : "transparent",
                  borderRadius: 3
                }}
              >
                ↵
              </span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function IconBtn({
  children, onClick, title, active, danger
}: {
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
  active?: boolean;
  danger?: boolean;
}) {
  const color = danger ? "var(--danger)" : (active ? "var(--accent)" : "var(--text-muted)");
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 30, height: 30,
        borderRadius: "var(--radius-sm)",
        display: "grid", placeItems: "center",
        color,
        background: active ? "var(--accent-soft)" : "transparent",
        fontSize: 13,
        transition: "all 0.1s"
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

function ModeChip({
  mode, onClick
}: {
  mode: "AI" | "HUMAN";
  onClick: () => void;
}) {
  const isAi = mode === "AI";
  return (
    <button
      onClick={onClick}
      title={`Modo actual: ${mode}. Click para cambiar.`}
      style={{
        padding: "4px 10px",
        borderRadius: 4,
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.04em",
        background: isAi ? "var(--success-soft)" : "var(--warning-soft)",
        color: isAi ? "var(--success)" : "var(--warning)",
        marginRight: 4,
        transition: "opacity 0.1s"
      }}
      onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
      onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
    >
      {mode}
    </button>
  );
}
