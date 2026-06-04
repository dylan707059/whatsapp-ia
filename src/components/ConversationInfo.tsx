"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { Conversation } from "@/lib/types";
import { jidToDisplay } from "@/lib/types";

interface OrderInfo {
  id: number;
  full_name: string | null;
  phone: string | null;
  product: string | null;
  color: string | null;
  size: string | null;
  quantity: string | null;
  total: string | null;
  payment: string | null;
  shipping: string | null;
  address: string | null;
  city: string | null;
  department: string | null;
  status: string;
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  PENDING_CONFIRMATION: { label: "Pendiente", color: "#f59e0b" },
  CONFIRMED:            { label: "Confirmado", color: "#34d399" },
  OWNER_NOTIFIED:       { label: "Confirmado", color: "#34d399" },
  DISPATCHED:           { label: "Despachado", color: "#60a5fa" },
  CANCELLED:            { label: "Cancelado", color: "#9ca3af" }
};

interface Props {
  conversation: Conversation;
  isPinned: boolean;
  isArchived: boolean;
  onPinToggle?: () => void;
  onArchiveToggle?: () => void;
  onClose: () => void;
}

export default function ConversationInfo({
  conversation, isPinned, isArchived, onPinToggle, onArchiveToggle, onClose
}: Props) {
  const [order, setOrder] = useState<OrderInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const r = await fetch(`/api/orders/${conversation.id}`);
      if (r.ok) {
        const d = await r.json();
        setOrder(d.order ?? null);
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [conversation.id]);

  async function changeStatus(action: "dispatch" | "cancel") {
    if (!order) return;
    setBusy(true);
    try {
      await fetch("/api/orders-board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id, action })
      });
      await load();
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  async function copyData() {
    if (!order) return;
    const variant = [order.color, order.size].filter(Boolean).join(" / ");
    const text = [
      order.full_name || conversation.name || "",
      order.phone || jidToDisplay(conversation.phone),
      `${order.product ?? ""}${variant ? " - " + variant : ""}${order.quantity ? " x" + order.quantity : ""}`,
      order.total ? `Total: ${order.total}` : "",
      order.address ?? "",
      [order.city, order.department].filter(Boolean).join(", ")
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  const st = order ? (STATUS_LABEL[order.status] ?? { label: order.status, color: "var(--text-muted)" }) : null;
  const isConfirmed = order && (order.status === "CONFIRMED" || order.status === "OWNER_NOTIFIED");
  const isCancellable = order && order.status !== "CANCELLED" && order.status !== "DISPATCHED";

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-elev-2)", padding: "14px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ color: "var(--text)", fontWeight: 600, fontSize: 13 }}>Información del cliente</span>
        <button onClick={onClose} style={{ color: "var(--text-dim)", fontSize: 13 }} title="Cerrar">✕</button>
      </div>

      {/* Datos */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--text-muted)" }}>
        <Row k="Nombre" v={order?.full_name || conversation.name || "—"} />
        <Row k="Teléfono" v={order?.phone || jidToDisplay(conversation.phone)} />
        {order && (
          <>
            <Row k="Producto" v={[order.product, order.color, order.size].filter(Boolean).join(" · ") || "—"} />
            <Row k="Cantidad" v={order.quantity || "—"} />
            <Row k="Total" v={order.total || "—"} />
            <Row k="Pago" v={order.payment || "—"} />
            <Row k="Envío" v={order.shipping || "—"} />
            <Row k="Dirección" v={order.address || "—"} />
            <Row k="Ciudad" v={[order.city, order.department].filter(Boolean).join(", ") || "—"} />
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <span style={{ color: "var(--text-dim)", minWidth: 84, fontSize: 12 }}>Estado</span>
              {st && <span style={{ ...badge, background: st.color + "22", color: st.color }}>{st.label}</span>}
            </div>
          </>
        )}
        {!order && (
          <span style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 4 }}>
            Esta conversación no tiene un pedido asociado.
          </span>
        )}
      </div>

      {/* Acciones */}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        {onPinToggle && (
          <button onClick={onPinToggle} style={actionBtn}>{isPinned ? "📌 Desanclar" : "📌 Anclar"}</button>
        )}
        {onArchiveToggle && (
          <button onClick={onArchiveToggle} style={actionBtn}>{isArchived ? "↩️ Desarchivar" : "📁 Archivar"}</button>
        )}
        {order && (
          <button onClick={copyData} style={actionBtn}>{copied ? "✓ Copiado" : "📋 Copiar para Dropi"}</button>
        )}
        {isConfirmed && (
          <button onClick={() => changeStatus("dispatch")} disabled={busy} style={{ ...actionBtn, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }}>
            {busy ? "…" : "🚚 Marcar despachado"}
          </button>
        )}
        {isCancellable && (
          <button onClick={() => changeStatus("cancel")} disabled={busy} style={{ ...actionBtn, color: "#ef4444", borderColor: "#ef4444" }}>
            Cancelar pedido
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <span style={{ color: "var(--text-dim)", minWidth: 84, fontSize: 12 }}>{k}</span>
      <span style={{ color: "var(--text)", flex: 1, wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}

const badge: CSSProperties = { fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 6 };
const actionBtn: CSSProperties = {
  fontSize: 12.5, fontWeight: 500, padding: "7px 12px", borderRadius: 8,
  background: "var(--bg)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer"
};
