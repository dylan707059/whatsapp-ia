"use client";

import { useEffect, useMemo, useState } from "react";
import type { ConversationWithPreview, ConversationMode } from "@/lib/types";
import QRScreen from "./QRScreen";
import Sidebar, { type View } from "./Sidebar";
import ConversationList from "./ConversationList";
import ConversationPanel from "./ConversationPanel";

type AppStatus = "loading" | "qr" | "connected";

export default function ConnectionGate() {
  const [appStatus, setAppStatus]         = useState<AppStatus>("loading");
  const [connectedPhone, setConnected]    = useState<string>("");
  const [conversations, setConversations] = useState<ConversationWithPreview[]>([]);
  const [archivedCount, setArchivedCount] = useState<number>(0);
  const [view, setView]                   = useState<View>("active");
  const [selectedId, setSelectedId]       = useState<number | null>(null);
  const [search, setSearch]               = useState<string>("");
  const [labelFilter, setLabelFilter]     = useState<number | null>(null);

  // Polling estado de conexión
  useEffect(() => {
    checkStatus();
    const timer = setInterval(() => {
      if (appStatus !== "connected") checkStatus();
    }, 2000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appStatus]);

  // Polling conversaciones
  useEffect(() => {
    if (appStatus !== "connected") return;
    fetchConversations();
    const timer = setInterval(fetchConversations, 2500);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appStatus, view]);

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
      const url = view === "archived"
        ? "/api/conversations?archived=true"
        : "/api/conversations";
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json() as {
        conversations: ConversationWithPreview[];
        archivedCount: number;
      };
      setConversations(data.conversations);
      setArchivedCount(data.archivedCount);
    } catch {}
  }

  function handleConnected(phone: string) {
    setConnected(phone);
    setAppStatus("connected");
  }

  async function handleDisconnect() {
    if (!confirm("¿Desconectar WhatsApp? Vas a tener que escanear el QR de nuevo.")) return;
    try {
      await fetch("/api/connection/disconnect", { method: "POST" });
    } catch {}
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
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (selectedId === id) setSelectedId(null);
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
      fetchConversations();
    } catch (err) {
      console.error("Error toggling pin:", err);
    }
  }

  // Filtros aplicados sobre las convs cargadas
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((c) => {
      if (labelFilter && !(c.labels ?? []).some((l) => l.id === labelFilter)) return false;
      if (q) {
        const inName = (c.name || "").toLowerCase().includes(q);
        const inPhone = c.phone.toLowerCase().includes(q);
        const inPreview = (c.last_message_preview || "").toLowerCase().includes(q);
        if (!inName && !inPhone && !inPreview) return false;
      }
      return true;
    });
  }, [conversations, search, labelFilter]);

  if (appStatus === "loading") {
    return (
      <div style={{ height: "100vh", display: "grid", placeItems: "center", background: "var(--bg)" }}>
        <div
          style={{
            width: 24, height: 24,
            border: "2px solid var(--border-strong)",
            borderTopColor: "var(--accent)",
            borderRadius: "50%",
            animation: "spin 0.8s linear infinite"
          }}
        />
        <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (appStatus === "qr") {
    return <QRScreen onConnected={handleConnected} />;
  }

  const selectedConversation = conversations.find((c) => c.id === selectedId);
  const pinnedCount = conversations.filter((c) => c.pinned_at).length;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "240px 320px 1fr",
        height: "100vh",
        background: "var(--bg)"
      }}
    >
      <Sidebar
        view={view}
        onViewChange={(v) => { setView(v); setSelectedId(null); }}
        activeCount={view === "active" ? conversations.length : 0}
        archivedCount={archivedCount}
        pinnedCount={pinnedCount}
        ownerPhone={connectedPhone}
        onDisconnect={handleDisconnect}
        onLabelFilter={setLabelFilter}
        activeLabelFilter={labelFilter}
      />

      <ConversationList
        conversations={filtered}
        selectedId={selectedId}
        onSelect={setSelectedId}
        search={search}
        onSearch={setSearch}
        viewLabel={view === "archived" ? "Archivados" : "Mensajes"}
        totalCount={conversations.length}
      />

      <main style={{ background: "var(--bg)", overflow: "hidden" }}>
        {selectedConversation ? (
          <ConversationPanel
            conversation={selectedConversation}
            onModeChange={handleModeChange}
            onDelete={handleDelete}
            onArchiveToggle={handleArchiveToggle}
            onPinToggle={handlePinToggle}
          />
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ textAlign: "center", maxWidth: 320 }}>
        <div
          style={{
            width: 56, height: 56, borderRadius: 14,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            display: "grid", placeItems: "center",
            fontSize: 24, margin: "0 auto 16px"
          }}
        >
          💬
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0, lineHeight: 1.6 }}>
          Seleccioná una conversación de la lista para ver los mensajes.
        </p>
        <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 8 }}>
          Las nuevas conversaciones aparecen automáticamente.
        </p>
      </div>
    </div>
  );
}
