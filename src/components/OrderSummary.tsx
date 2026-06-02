"use client";

import { useEffect, useState } from "react";
import type { Order, OrderStatus } from "@/lib/types";

interface Props {
  conversationId: number;
}

const STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT:                "Borrador",
  PENDING_CONFIRMATION: "Esperando confirmación",
  CONFIRMED:            "Confirmado",
  OWNER_NOTIFIED:       "Notificado",
  DISPATCHED:           "Despachado",
  CANCELLED:            "Cancelado"
};

const STATUS_COLOR: Record<OrderStatus, string> = {
  DRAFT:                "bg-gray-100 text-gray-600",
  PENDING_CONFIRMATION: "bg-amber-100 text-amber-700",
  CONFIRMED:            "bg-emerald-100 text-emerald-700",
  OWNER_NOTIFIED:       "bg-blue-100 text-blue-700",
  DISPATCHED:           "bg-purple-100 text-purple-700",
  CANCELLED:            "bg-red-100 text-red-600"
};

function missingFields(order: Order): string[] {
  const missing: string[] = [];
  if (!order.full_name) missing.push("nombre");
  if (!order.phone)     missing.push("teléfono");
  if (!order.product)   missing.push("producto");
  if (!order.color)     missing.push("color");
  if (!order.size)      missing.push("talla");
  if (!order.quantity)  missing.push("cantidad");
  if (!order.total)     missing.push("total");
  if (!order.address)   missing.push("dirección");
  if (!order.city)      missing.push("ciudad");
  if (!order.department) missing.push("departamento");
  return missing;
}

function relativeTime(unix: number): string {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60)    return "hace un momento";
  if (diff < 3600)  return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return new Date(unix * 1000).toLocaleDateString("es");
}

export default function OrderSummary({ conversationId }: Props) {
  const [order, setOrder] = useState<Order | null>(null);
  const [aiPausedUntil, setAiPausedUntil] = useState<number | null>(null);

  useEffect(() => {
    fetchOrder();
    const t = setInterval(fetchOrder, 4000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

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
    <div className="border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs space-y-1">
      {isPaused && (
        <p className="text-amber-600 font-medium">
          ⏸ IA pausada por intervención humana
        </p>
      )}

      {order && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-gray-600">
          <span
            className={`px-2 py-0.5 rounded-full font-semibold ${STATUS_COLOR[order.status]}`}
          >
            {STATUS_LABEL[order.status]}
          </span>

          {order.product && (
            <span>🛍️ {order.product}{order.color ? ` · ${order.color}` : ""}{order.size ? ` · ${order.size}` : ""}</span>
          )}

          {order.total && <span>💰 {order.total}</span>}

          {order.full_name && <span>👤 {order.full_name}</span>}

          {missing.length > 0 && (
            <span className="text-red-500">
              ⚠ Falta: {missing.join(", ")}
            </span>
          )}

          <span className="text-gray-400 ml-auto">#{order.id} · {relativeTime(order.updated_at)}</span>
        </div>
      )}
    </div>
  );
}
