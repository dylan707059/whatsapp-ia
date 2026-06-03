"use client";

import { useCallback, useEffect, useState } from "react";
import type { Order, OrderStatus } from "@/lib/types";
import { useEventStream } from "./useEventStream";

interface Props {
  conversationId: number;
}

const STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT:                "Borrador",
  PENDING_CONFIRMATION: "Pendiente",
  CONFIRMED:            "Confirmado",
  OWNER_NOTIFIED:       "Notificado",
  DISPATCHED:           "Despachado",
  CANCELLED:            "Cancelado"
};

interface StatusStyle {
  bg: string;
  fg: string;
}

const STATUS_COLOR: Record<OrderStatus, StatusStyle> = {
  DRAFT:                { bg: "var(--bg-elev-2)", fg: "var(--text-muted)" },
  PENDING_CONFIRMATION: { bg: "var(--warning-soft)", fg: "var(--warning)" },
  CONFIRMED:            { bg: "var(--success-soft)", fg: "var(--success)" },
  OWNER_NOTIFIED:       { bg: "var(--accent-soft)", fg: "var(--accent)" },
  DISPATCHED:           { bg: "rgba(167, 139, 250, 0.18)", fg: "#a78bfa" },
  CANCELLED:            { bg: "var(--danger-soft)", fg: "var(--danger)" }
};

function missingFields(order: Order): string[] {
  const missing: string[] = [];
  if (!order.full_name) missing.push("nombre");
  if (!order.phone)     missing.push("teléfono");
  if (!order.product)   missing.push("producto");
  if (!order.address)   missing.push("dirección");
  if (!order.city)      missing.push("ciudad");
  return missing;
}

function relativeTime(unix: number): string {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60)    return "ahora";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(unix * 1000).toLocaleDateString("es");
}

export default function OrderSummary({ conversationId }: Props) {
  const [order, setOrder] = useState<Order | null>(null);
  const [aiPausedUntil, setAiPausedUntil] = useState<number | null>(null);

  useEffect(() => {
    fetchOrder();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // SSE: refetch cuando hay cambios (en cualquier conv); barato porque la
  // query es por conversationId y tiene LIMIT 1.
  const onConvOrMsg = useCallback(() => { fetchOrder(); }, [conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEventStream("/api/events", { conv: onConvOrMsg, msg: onConvOrMsg });

  async function fetchOrder() {
    try {
      const res = await fetch(`/api/orders/${conversationId}`);
      if (res.ok) {
        const data = await res.json() as { order: Order | null; aiPausedUntil: number | null };
        setOrder(data.order);
        setAiPausedUntil(data.aiPausedUntil);
      }
    } catch {}
  }

  const isPaused = aiPausedUntil && aiPausedUntil > Math.floor(Date.now() / 1000);
  const missing  = order ? missingFields(order) : [];

  if (!order && !isPaused) return null;

  return (
    <div
      style={{
        margin: "12px 20px 4px",
        padding: "10px 14px",
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        fontSize: 12.5
      }}
    >
      {isPaused && (
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 3,
            fontSize: 10.5,
            fontWeight: 600,
            background: "var(--warning-soft)",
            color: "var(--warning)"
          }}
        >
          ⏸ IA PAUSADA
        </span>
      )}

      {order && (
        <>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 3,
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.04em",
              background: STATUS_COLOR[order.status].bg,
              color: STATUS_COLOR[order.status].fg,
              textTransform: "uppercase"
            }}
          >
            {STATUS_LABEL[order.status]}
          </span>

          {order.product && (
            <span style={{ color: "var(--text-muted)" }}>
              📦 <span style={{ color: "var(--text)", fontWeight: 600 }}>{order.product}</span>
              {order.color && order.color !== "—" ? ` · ${order.color}` : ""}
              {order.size && order.size !== "—" ? ` · ${order.size}` : ""}
            </span>
          )}

          {order.total && (
            <span style={{ color: "var(--text-muted)" }}>
              💰 <span style={{ color: "var(--text)", fontWeight: 600 }}>{order.total}</span>
            </span>
          )}

          {missing.length > 0 && (
            <span style={{ color: "var(--danger)", fontSize: 11 }}>
              ⚠ Falta: {missing.join(", ")}
            </span>
          )}

          <span style={{ color: "var(--text-dim)", marginLeft: "auto", fontSize: 11 }}>
            #{order.id} · {relativeTime(order.updated_at)}
            {order.source && ` · ${order.source}`}
          </span>
        </>
      )}
    </div>
  );
}
