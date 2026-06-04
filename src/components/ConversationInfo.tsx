"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { Conversation } from "@/lib/types";
import { jidToDisplay, formatPhoneNumber } from "@/lib/types";

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
  onClose: () => void;
}

export default function ConversationInfo({ conversation, onClose }: Props) {
  const [order, setOrder] = useState<OrderInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [blocked, setBlocked] = useState<boolean>(conversation.blocked_at != null);

  useEffect(() => {
    setBlocked(conversation.blocked_at != null);
    (async () => {
      try {
        const r = await fetch(`/api/orders/${conversation.id}`);
        if (r.ok) {
          const d = await r.json();
          setOrder(d.order ?? null);
        }
      } catch {
        // ignore
      }
    })();
  }, [conversation.id, conversation.blocked_at]);

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

  async function toggleBlock() {
    const next = !blocked;
    if (next && !confirm("¿Bloquear a este cliente? El bot dejará de responderle.")) return;
    setBlocked(next);
    try {
      await fetch(`/api/conversations/${conversation.id}/block`, { method: "POST" });
    } catch {
      setBlocked(!next); // revertir si falla
    }
  }

  const st = order ? (STATUS_LABEL[order.status] ?? { label: order.status, color: "var(--text-muted)" }) : null;

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-elev-2)", padding: "14px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ color: "var(--text)", fontWeight: 600, fontSize: 13 }}>Información del cliente</span>
        <button onClick={onClose} style={{ color: "var(--text-dim)", fontSize: 13 }} title="Cerrar">✕</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--text-muted)" }}>
        <Row k="Nombre" v={order?.full_name || conversation.name || "—"} />
        <Row k="Teléfono" v={formatPhoneNumber(order?.phone || jidToDisplay(conversation.phone))} />
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

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        {order && (
          <button onClick={copyData} style={actionBtn}>{copied ? "✓ Copiado" : "📋 Copiar para Dropi"}</button>
        )}
        <button
          onClick={toggleBlock}
          style={{ ...actionBtn, color: blocked ? "#34d399" : "#ef4444", borderColor: blocked ? "#34d399" : "#ef4444" }}
        >
          {blocked ? "✓ Desbloquear" : "🚫 Bloquear cliente"}
        </button>
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
