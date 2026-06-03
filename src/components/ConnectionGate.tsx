"use client";

import { useEffect, useState } from "react";
import type { ConversationWithPreview, ConversationMode } from "@/lib/types";
import QRScreen from "./QRScreen";
import DashboardHeader from "./DashboardHeader";
import ConversationList from "./ConversationList";
import ConversationPanel from "./ConversationPanel";

type AppStatus = "loading" | "qr" | "connected";

export default function ConnectionGate() {
  const [appStatus, setAppStatus]         = useState<AppStatus>("loading");
  const [connectedPhone, setConnected]    = useState<string>("");
  const [conversations, setConversations] = useState<ConversationWithPreview[]>([]);
  const [archivedCount, setArchivedCount] = useState<number>(0);
  const [showArchived, setShowArchived]   = useState<boolean>(false);
  const [selectedId, setSelectedId]       = useState<number | null>(null);

  // Polling de estado: mientras no esté conectado verifica cada 2s
  useEffect(() => {
    checkStatus();
    const timer = setInterval(() => {
      if (appStatus !== "connected") checkStatus();
    }, 2000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appStatus]);

  // Polling de conversaciones cuando está conectado
  useEffect(() => {
    if (appStatus !== "connected") return;
    fetchConversations();
    const timer = setInterval(fetchConversations, 2000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appStatus, showArchived]);

  async function checkStatus() {
    try {
      const res  = await fetch("/api/connection/status");
      const data = await res.json() as { status: string; phone?: string };
      if (data.status === "connected" && data.phone) {
        setConnected(data.phone);
        setAppStatus("connected");
      } else {
        setAppStatus("qr");
      }
    } catch {
      setAppStatus("qr");
    }
  }

  async function fetchConversations() {
    try {
      const url = showArchived
        ? "/api/conversations?archived=true"
        : "/api/conversations";
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json() as {
        conversations: ConversationWithPreview[];
        archivedCount: number;
        showingArchived: boolean;
      };
      setConversations(data.conversations);
      setArchivedCount(data.archivedCount);
    } catch {}
  }

  function handleConnected(phone: string) {
    setConnected(phone);
    setAppStatus("connected");
  }

  function handleDisconnect() {
    setConnected("");
    setSelectedId(null);
    setConversations([]);
    setAppStatus("qr");
  }

  function handleModeChange(id: number, mode: ConversationMode) {
    setConversations((prev) => prev.map((c) => c.id === id ? { ...c, mode } : c));
  }

  function handleDelete(id: number) {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  async function handleArchiveToggle(id: number, archived: boolean) {
    try {
      const action = archived ? "unarchive" : "archive";
      await fetch(`/api/conversations/${id}/${action}`, { method: "POST" });
      // Quitar de la lista actual (cambia de pestaña)
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (selectedId === id) setSelectedId(null);
      // Refrescar contador
      fetchConversations();
    } catch (err) {
      console.error("Error toggling archive:", err);
    }
  }

  async function handlePinToggle(id: number, pinned: boolean) {
    try {
      const action = pinned ? "unpin" : "pin";
      const res = await fetch(`/api/conversations/${id}/${action}`, { method: "POST" });
      if (!res.ok) {
        const { error } = await res.json() as { error?: string };
        if (error) alert(error);
        return;
      }
      // Refrescar lista (cambia de orden)
      fetchConversations();
    } catch (err) {
      console.error("Error toggling pin:", err);
    }
  }

  if (appStatus === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (appStatus === "qr") {
    return <QRScreen onConnected={handleConnected} />;
  }

  const selectedConversation = conversations.find((c) => c.id === selectedId);

  return (
    <div className="flex flex-col h-screen">
      <DashboardHeader phone={connectedPhone} onDisconnect={handleDisconnect} />

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-72 flex flex-col border-r border-gray-200 bg-white">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {showArchived ? "Archivados" : "Conversaciones"}
            </h2>
            <button
              type="button"
              onClick={() => { setSelectedId(null); setShowArchived((v) => !v); }}
              className={`text-xs font-medium px-2 py-1 rounded transition-colors ${
                showArchived
                  ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
              title={showArchived ? "Volver a activos" : "Ver archivados"}
            >
              {showArchived ? "← Activos" : `Archivados${archivedCount > 0 ? ` (${archivedCount})` : ""}`}
            </button>
          </div>
          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </aside>

        <main className="flex-1 overflow-hidden">
          {selectedConversation ? (
            <ConversationPanel
              conversation={selectedConversation}
              onModeChange={handleModeChange}
              onDelete={handleDelete}
              onArchiveToggle={handleArchiveToggle}
              onPinToggle={handlePinToggle}
            />
          ) : (
            <div className="h-full flex items-center justify-center">
              <p className="text-sm text-gray-400">
                Selecciona una conversación para comenzar.
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
