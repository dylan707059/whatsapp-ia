"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationWithPreview, Message } from "@/lib/types";
import { jidToDisplay, chatDisplayTitle, formatPhoneNumber } from "@/lib/types";
import MessageBubble from "./MessageBubble";
import OrderSummary from "./OrderSummary";
import LabelsPopover from "./LabelsPopover";
import ConversationInfo from "./ConversationInfo";
import { useEventStream } from "./useEventStream";

interface Props {
  conversation: ConversationWithPreview;
  onModeChange: (id: number, mode: "AI" | "HUMAN") => void;
  onDelete: (id: number) => void;
}

type AttachKind = "image" | "video" | "document";
interface Attached {
  file: File;
  url: string;       // object URL para la previa
  kind: AttachKind;
}
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function attachKind(file: File): AttachKind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type === "application/pdf") return "document";
  return null;
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
  conversation, onModeChange, onDelete
}: Props) {
  const isPinned = conversation.pinned_at != null;

  const [messages, setMessages]   = useState<Message[]>([]);
  const [mode, setMode]           = useState<"AI" | "HUMAN">(conversation.mode);
  const [input, setInput]         = useState("");
  const [sending, setSending]     = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [infoOpen, setInfoOpen]     = useState(false);
  const [attached, setAttached]   = useState<Attached | null>(null);
  const [dragOver, setDragOver]   = useState(false);
  const fileInputRef              = useRef<HTMLInputElement>(null);
  const bottomRef                 = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMode(conversation.mode);
    setInput("");
    setAttached((prev) => {
      if (prev) { try { URL.revokeObjectURL(prev.url); } catch {} }
      return null;
    });
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

  function onFilePicked(file: File | null | undefined) {
    if (!file) return;
    const kind = attachKind(file);
    if (!kind) { alert("Solo se permiten fotos, videos o PDF."); return; }
    if (file.size > MAX_UPLOAD_BYTES) { alert("El archivo supera el límite de 20 MB."); return; }
    if (attached) { try { URL.revokeObjectURL(attached.url); } catch {} }
    setAttached({ file, url: URL.createObjectURL(file), kind });
  }

  function clearAttached() {
    if (attached) { try { URL.revokeObjectURL(attached.url); } catch {} }
    setAttached(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function onPaste(e: React.ClipboardEvent) {
    const f = e.clipboardData?.files?.[0];
    if (f && attachKind(f)) { e.preventDefault(); onFilePicked(f); }
  }

  async function handleSendMedia() {
    if (!attached || sending) return;
    const caption = input.trim();
    const { file, kind, url: previewUrl } = attached;
    setSending(true);
    setInput("");
    setAttached(null);
    if (fileInputRef.current) fileInputRef.current.value = "";

    const tempId = -Date.now();
    const optimistic = {
      id: tempId,
      conversation_id: conversation.id,
      role: "human",
      content: caption,
      created_at: Math.floor(Date.now() / 1000),
      media_type: kind,
      localPreviewUrl: previewUrl
    } as Message & { localPreviewUrl?: string };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const fd = new FormData();
      fd.append("file", file);
      if (caption) fd.append("caption", caption);
      const res = await fetch(`/api/messages/${conversation.id}`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchMessages();
    } catch (err) {
      console.error("[ui] Error enviando archivo:", err);
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId
          ? ({ ...m, content: "❌ FALLÓ ENVIAR ARCHIVO", media_type: null } as Message)
          : m
        ))
      );
    } finally {
      setSending(false);
      setTimeout(() => { try { URL.revokeObjectURL(previewUrl); } catch {} }, 15000);
    }
  }

  async function handleDelete() {
    const display = conversation.name || jidToDisplay(conversation.phone);
    if (!confirm(`¿Borrar la conversación con ${display}? Esta acción no se puede deshacer.`)) return;
    await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
    onDelete(conversation.id);
  }

  const name = conversation.name?.trim() || chatDisplayTitle(conversation.phone, conversation.name, conversation.order_phone);
  const isRealPhone = conversation.phone.endsWith("@s.whatsapp.net");
  const phoneLine = isRealPhone
    ? formatPhoneNumber(jidToDisplay(conversation.phone))
    : conversation.order_phone
      ? formatPhoneNumber(conversation.order_phone)
      : `ID privacidad …${jidToDisplay(conversation.phone).slice(-4)}`;
  const [g1, g2] = avatarColors(name);
  const initials = initialsOf(name);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)", position: "relative" }}
      onDragOver={(e) => { if (mode === "HUMAN") { e.preventDefault(); if (!dragOver) setDragOver(true); } }}
      onDragLeave={(e) => {
        // solo ocultar si el cursor salió del panel (no al pasar sobre hijos)
        if (e.relatedTarget && (e.currentTarget as Node).contains(e.relatedTarget as Node)) return;
        setDragOver(false);
      }}
      onDrop={(e) => {
        if (mode !== "HUMAN") return;
        e.preventDefault();
        setDragOver(false);
        onFilePicked(e.dataTransfer?.files?.[0]);
      }}
    >
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
            width: 38, height: 38, borderRadius: "50%",
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
            {phoneLine}
          </div>
        </button>

        {/* Action buttons (anclar/archivar van en el clic derecho de la lista) */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <ModeChip mode={mode} onClick={toggleMode} />
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
          <IconBtn onClick={handleDelete} title="Borrar" danger>
            🗑️
          </IconBtn>
        </div>
      </div>

      {/* Panel de información del cliente (clic en el nombre) */}
      {infoOpen && (
        <ConversationInfo
          conversation={conversation}
          onClose={() => setInfoOpen(false)}
        />
      )}

      {/* Order summary */}
      <OrderSummary conversationId={conversation.id} />

      {/* Messages */}
      <div
        className="chat-wallpaper"
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
            mediaType={msg.media_type}
            mediaMime={msg.media_mime}
            mediaFilename={msg.media_filename}
            localPreviewUrl={(msg as Message & { localPreviewUrl?: string }).localPreviewUrl}
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
      <div style={{ borderTop: "1px solid var(--border)", background: "var(--bg-elev)" }}>
        {mode === "AI" ? (
          <div
            style={{
              textAlign: "center",
              fontSize: 12,
              color: "var(--text-muted)",
              padding: "14px 12px"
            }}
          >
            🤖 El bot responde automáticamente en modo IA — cambia a HUMAN para escribir manualmente
          </div>
        ) : (
          <>
            {/* Bandeja de previa del adjunto */}
            {attached && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--border)"
                }}
              >
                {attached.kind === "image" && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={attached.url} alt="previa" style={{ width: 54, height: 54, objectFit: "cover", borderRadius: 6 }} />
                )}
                {attached.kind === "video" && (
                  <video src={attached.url} style={{ width: 54, height: 54, objectFit: "cover", borderRadius: 6, background: "#000" }} />
                )}
                {attached.kind === "document" && <span style={{ fontSize: 30 }}>📄</span>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {attached.file.name}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    {(attached.file.size / 1024 / 1024).toFixed(1)} MB · listo para enviar
                  </div>
                </div>
                <button onClick={clearAttached} title="Quitar" style={{ color: "var(--text-dim)", fontSize: 16, padding: 6 }}>✕</button>
              </div>
            )}

            {/* Fila de escritura */}
            <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*,application/pdf"
                style={{ display: "none" }}
                onChange={(e) => onFilePicked(e.target.files?.[0])}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                title="Adjuntar foto, video o PDF"
                disabled={sending}
                style={{ width: 34, height: 34, borderRadius: "var(--radius)", display: "grid", placeItems: "center", color: "var(--text-muted)", fontSize: 17, flexShrink: 0 }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                📎
              </button>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (attached) handleSendMedia(); else handleSend();
                  }
                }}
                placeholder={attached ? "Agrega un comentario..." : `Mensaje a ${name.split(" ")[0]}...`}
                disabled={sending}
                style={{
                  flex: 1,
                  background: "var(--bg-elev-2)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "9px 13px",
                  color: "var(--text)",
                  fontSize: 13.5,
                  fontFamily: "inherit",
                  outline: 0,
                  opacity: sending ? 0.5 : 1
                }}
              />
              <button
                onClick={() => { if (attached) handleSendMedia(); else handleSend(); }}
                disabled={sending || (!attached && !input.trim())}
                title="Enviar"
                style={{
                  width: 38, height: 38,
                  borderRadius: "50%",
                  background: (attached || input.trim()) ? "var(--accent)" : "var(--bg-elev-2)",
                  color: (attached || input.trim()) ? "#fff" : "var(--text-dim)",
                  display: "grid", placeItems: "center",
                  fontSize: 16, flexShrink: 0,
                  transition: "all 0.1s"
                }}
              >
                ➤
              </button>
            </div>
          </>
        )}
      </div>

      {/* Overlay de arrastrar y soltar */}
      {dragOver && mode === "HUMAN" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "var(--accent-soft)",
            border: "2px dashed var(--accent)",
            display: "grid",
            placeItems: "center",
            zIndex: 50,
            pointerEvents: "none"
          }}
        >
          <span style={{ color: "var(--accent)", fontSize: 15, fontWeight: 600 }}>
            📎 Suelta para adjuntar
          </span>
        </div>
      )}
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
