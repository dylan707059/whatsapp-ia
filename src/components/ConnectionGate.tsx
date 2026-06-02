"use client";

import { useEffect, useState } from "react";
import type { ConversationWithPreview, ConversationMode } from "@/lib/types";
import QRScreen from "./QRScreen";
import DashboardHeader from "./DashboardHeader";
import ConversationList from "./ConversationList";
import ConversationPanel from "./ConversationPanel";

type AppStatus = "loading" | "qr" | "connected";

export default function ConnectionGate() {
  const [appStatus, setAppStatus]       = useState<AppStatus>("loading");
  const [connectedPhone, setConnected]  = useState<string>("");
  const [conversations, setConversations] = useState<ConversationWithPreview[]>([]);
  const [selectedId, setSelectedId]     = useState<number | null>(null);

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
  }, [appStatus]);

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
      const res = await fetch("/api/conversations");
      if (res.ok) setConversations(await res.json());
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
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Conversaciones
            </h2>
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
