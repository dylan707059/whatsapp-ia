"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ConversationWithPreview, ConversationMode } from "@/lib/types";
import QRScreen from "./QRScreen";
import SettingsScreen from "./SettingsScreen";
import AccountsScreen from "./AccountsScreen";
import PedidosScreen from "./PedidosScreen";
import Sidebar, { type View } from "./Sidebar";
import ConversationList from "./ConversationList";
import ConversationPanel from "./ConversationPanel";
import { useEventStream } from "./useEventStream";

type AppStatus = "loading" | "qr" | "connected";

export default function ConnectionGate() {
  const [appStatus, setAppStatus]         = useState<AppStatus>("loading");
  const [connectedPhone, setConnected]    = useState<string>("");
  const [conversations, setConversations] = useState<ConversationWithPreview[]>([]);
  const [convsLoaded, setConvsLoaded]     = useState<boolean>(false);
  const [archivedCount, setArchivedCount] = useState<number>(0);
  const [view, setView]                   = useState<View>("active");
  const [selectedId, setSelectedId]       = useState<number | null>(null);
  const [search, setSearch]               = useState<string>("");
  const [labelFilter, setLabelFilter]     = useState<number | null>(null);
  // Pantalla de configuración: se abre con el botón ⚙️ del menú lateral.
  const [showSettings, setShowSettings]   = useState<boolean>(false);
  const [showAccounts, setShowAccounts]   = useState<boolean>(false);
  const [showPedidos, setShowPedidos]     = useState<boolean>(false);

  const router = useRouter();

  async function handleLogout() {
    if (!confirm("¿Cerrar sesión?")) return;
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
    router.push("/login");
    router.refresh();
  }

  // Estado de conexión: polling mientras NO conectados (necesitamos el QR);
  // cuando conectados, dependemos del evento SSE "conn" que llega abajo.
  useEffect(() => {
    checkStatus();
    if (appStatus === "connected") return;
    const timer = setInterval(checkStatus, 2000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appStatus]);

  // Fetch inicial de conversaciones al conectar y al cambiar view
  useEffect(() => {
    if (appStatus !== "connected") return;
    fetchConversations();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appStatus, view]);

  // SSE: push instantáneo de cambios desde el backend
  const onConvEvent = useCallback(() => { fetchConversations(); }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const onConnEvent = useCallback(() => { checkStatus(); }, []);
  useEventStream(
    "/api/events",
    { conv: onConvEvent, conn: onConnEvent },
    appStatus === "connected"
  );

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
    finally { setConvsLoaded(true); }
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

  // Cambiar estado del pedido activo de una conversación (desde el clic derecho).
  async function handleOrderAction(conversationId: number, action: "dispatch" | "cancel") {
    try {
      const res = await fetch(`/api/orders/${conversationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({})) as { error?: string };
        alert(error || "No se pudo cambiar el estado (¿tiene pedido activo?)");
      }
    } catch (err) {
      console.error("Error cambiando estado:", err);
    }
  }

  // Filtros aplicados sobre las convs cargadas
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, ""); // dígitos para buscar por número
    return conversations.filter((c) => {
      if (labelFilter && !(c.labels ?? []).some((l) => l.id === labelFilter)) return false;
      if (q) {
        const inName = (c.name || "").toLowerCase().includes(q);
        const inPhone = c.phone.toLowerCase().includes(q) ||
          (qDigits.length > 0 && c.phone.replace(/\D/g, "").includes(qDigits));
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

  // Pantalla de configuración (se abre desde el botón ⚙️; "Volver" la cierra).
  if (showSettings) {
    return <SettingsScreen allowSkip onSaved={() => setShowSettings(false)} />;
  }

  // Pantalla de cuentas (solo admin; se abre desde el botón 👥).
  if (showAccounts) {
    return <AccountsScreen onClose={() => setShowAccounts(false)} />;
  }

  // Panel de pedidos (se abre desde el botón 📋 Pedidos).
  if (showPedidos) {
    return (
      <PedidosScreen
        onClose={() => setShowPedidos(false)}
        onOpenConversation={(convId) => {
          setShowPedidos(false);
          setView("active");
          setSelectedId(convId);
        }}
      />
    );
  }

  // Antes de conectar WhatsApp: panel de configuración a la izquierda + QR a la
  // derecha. Al conectar, este layout desaparece y se muestra el dashboard.
  if (appStatus === "qr") {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", height: "100vh", background: "var(--bg)" }}>
        <aside style={{ borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <SettingsScreen embedded onSaved={() => {}} />
          </div>
          <button
            onClick={handleLogout}
            style={{
              borderTop: "1px solid var(--border)",
              padding: "12px 16px",
              color: "var(--text-muted)",
              fontSize: 13,
              textAlign: "left",
              display: "flex", alignItems: "center", gap: 10,
              flexShrink: 0
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <span style={{ width: 16, opacity: 0.7 }}>🚪</span>
            Cerrar sesión
          </button>
        </aside>
        <div style={{ minHeight: 0, overflowY: "auto" }}>
          <QRScreen onConnected={handleConnected} />
        </div>
      </div>
    );
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
        onOpenSettings={() => setShowSettings(true)}
        onOpenAccounts={() => setShowAccounts(true)}
        onOpenPedidos={() => setShowPedidos(true)}
        onLogout={handleLogout}
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
        loading={!convsLoaded}
        onPinToggle={handlePinToggle}
        onArchiveToggle={handleArchiveToggle}
        onOrderAction={handleOrderAction}
      />

      <main style={{ background: "var(--bg)", overflow: "hidden" }}>
        {selectedConversation ? (
          <ConversationPanel
            conversation={selectedConversation}
            onModeChange={handleModeChange}
            onDelete={handleDelete}
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
