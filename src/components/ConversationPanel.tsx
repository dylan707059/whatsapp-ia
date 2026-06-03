"use client";

import { useEffect, useRef, useState } from "react";
import type { Conversation, Message } from "@/lib/types";
import { jidToDisplay } from "@/lib/types";
import MessageBubble from "./MessageBubble";
import ModeToggle from "./ModeToggle";
import OrderSummary from "./OrderSummary";

interface Props {
  conversation: Conversation;
  onModeChange: (id: number, mode: "AI" | "HUMAN") => void;
  onDelete: (id: number) => void;
  onArchiveToggle?: (id: number, archived: boolean) => void;
}

export default function ConversationPanel({ conversation, onModeChange, onDelete, onArchiveToggle }: Props) {
  const isArchived = conversation.archived_at != null;
  const [messages, setMessages]   = useState<Message[]>([]);
  const [mode, setMode]           = useState(conversation.mode);
  const [input, setInput]         = useState("");
  const [sending, setSending]     = useState(false);
  const bottomRef                 = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMode(conversation.mode);
    fetchMessages();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  useEffect(() => {
    const timer = setInterval(fetchMessages, 2000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function fetchMessages() {
    try {
      const res = await fetch(`/api/messages/${conversation.id}`);
      if (res.ok) setMessages(await res.json());
    } catch {}
  }

  function handleModeToggle(newMode: "AI" | "HUMAN") {
    setMode(newMode);
    onModeChange(conversation.id, newMode);
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setInput("");

    try {
      await fetch(`/api/messages/${conversation.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text })
      });
      await fetchMessages();
    } catch (err) {
      console.error(err);
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

  const displayName = conversation.name || jidToDisplay(conversation.phone);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white shrink-0">
        <div>
          <p className="font-semibold text-gray-900">{displayName}</p>
          <p className="text-xs text-gray-400">{jidToDisplay(conversation.phone)}</p>
        </div>

        <div className="flex items-center gap-3">
          <ModeToggle
            conversationId={conversation.id}
            mode={mode}
            onToggle={handleModeToggle}
          />
          {onArchiveToggle && (
            <button
              onClick={() => onArchiveToggle(conversation.id, isArchived)}
              className="text-xs text-gray-500 hover:text-amber-600 transition-colors"
              title={isArchived ? "Desarchivar" : "Archivar"}
            >
              {isArchived ? "Desarchivar" : "Archivar"}
            </button>
          )}
          <button
            onClick={handleDelete}
            className="text-xs text-red-400 hover:text-red-600 transition-colors"
          >
            Borrar
          </button>
        </div>
      </div>

      <OrderSummary conversationId={conversation.id} />

      <div className="flex-1 overflow-y-auto px-4 py-4 bg-gray-50">
        {messages.length === 0 && (
          <p className="text-center text-sm text-gray-400 mt-8">Sin mensajes aún.</p>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            role={msg.role}
            content={msg.content}
            createdAt={msg.created_at}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-gray-200 bg-white px-4 py-3">
        {mode === "AI" ? (
          <p className="text-xs text-center text-gray-400">
            El bot responde automáticamente en modo IA.
          </p>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder="Escribir mensaje..."
              disabled={sending}
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-400 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="bg-amber-400 hover:bg-amber-500 text-white text-sm font-medium px-4 py-2 rounded-lg disabled:opacity-50 transition-colors"
            >
              Enviar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
