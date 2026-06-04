"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";

interface Order {
  id: number;
  conversation_id: number;
  full_name: string | null;
  phone: string | null;
  product: string | null;
  color: string | null;
  size: string | null;
  quantity: string | null;
  total: string | null;
  address: string | null;
  city: string | null;
  department: string | null;
  status: string;
  created_at: number;
  conv_name: string | null;
  conv_phone: string;
}

interface Stats { pending: number; confirmed: number; dispatched: number; total: number; }

interface Props {
  onClose: () => void;
  onOpenConversation: (conversationId: number) => void;
}

type Filter = "pendientes" | "confirmados" | "despachados" | "todos";

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  PENDING_CONFIRMATION: { label: "Pendiente", color: "#f59e0b" },
  CONFIRMED:            { label: "Confirmado", color: "#34d399" },
  OWNER_NOTIFIED:       { label: "Confirmado", color: "#34d399" },
  DISPATCHED:           { label: "Despachado", color: "#60a5fa" },
  CANCELLED:            { label: "Cancelado", color: "#9ca3af" }
};

function inFilter(status: string, f: Filter): boolean {
  if (f === "todos") return true;
  if (f === "pendientes") return status === "PENDING_CONFIRMATION";
  if (f === "confirmados") return status === "CONFIRMED" || status === "OWNER_NOTIFIED";
  if (f === "despachados") return status === "DISPATCHED";
  return true;
}

function copyText(o: Order): string {
  const name = o.full_name || o.conv_name || "";
  const phone = o.phone || o.conv_phone || "";
  const variant = [o.color, o.size].filter(Boolean).join(" / ");
  return [
    name,
    phone,
    `${o.product ?? ""}${variant ? " - " + variant : ""}${o.quantity ? " x" + o.quantity : ""}`,
    o.total ? `Total: ${o.total}` : "",
    o.address ?? "",
    [o.city, o.department].filter(Boolean).join(", ")
  ].filter(Boolean).join("\n");
}

export default function PedidosScreen({ onClose, onOpenConversation }: Props) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [stats, setStats] = useState<Stats>({ pending: 0, confirmed: 0, dispatched: 0, total: 0 });
  const [filter, setFilter] = useState<Filter>("confirmados");
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/orders-board");
      if (res.ok) {
        const d = await res.json();
        setOrders(d.orders ?? []);
        setStats(d.stats ?? { pending: 0, confirmed: 0, dispatched: 0, total: 0 });
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  async function dispatch(orderId: number) {
    setBusyId(orderId);
    try {
      await fetch("/api/orders-board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, action: "dispatch" })
      });
      await load();
    } catch {
      // ignore
    } finally {
      setBusyId(null);
    }
  }

  async function copy(o: Order) {
    try {
      await navigator.clipboard.writeText(copyText(o));
      setCopiedId(o.id);
      setTimeout(() => setCopiedId((c) => (c === o.id ? null : c)), 1500);
    } catch {
      // ignore
    }
  }

  const filtered = orders.filter((o) => inFilter(o.status, filter));

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "28px 16px", overflowY: "auto" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 600, margin: 0 }}>Pedidos</h1>
          <button onClick={onClose} style={secondaryBtn}>Volver</button>
        </div>

        {/* Resumen de hoy */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 18 }}>
          <StatCard label="Hoy" value={stats.total} color="var(--text)" />
          <StatCard label="Pendientes" value={stats.pending} color="#f59e0b" />
          <StatCard label="Confirmados" value={stats.confirmed} color="#34d399" />
          <StatCard label="Despachados" value={stats.dispatched} color="#60a5fa" />
        </div>

        {/* Filtros */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {(["confirmados", "pendientes", "despachados", "todos"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                ...chip,
                background: filter === f ? "var(--accent)" : "var(--bg-elev)",
                color: filter === f ? "#fff" : "var(--text-muted)",
                borderColor: filter === f ? "var(--accent)" : "var(--border)"
              }}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {/* Lista */}
        {loading ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Cargando…</p>
        ) : filtered.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No hay pedidos en esta vista.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filtered.map((o) => {
              const st = STATUS_LABEL[o.status] ?? { label: o.status, color: "var(--text-muted)" };
              const variant = [o.color, o.size].filter(Boolean).join(" / ");
              const isConfirmed = o.status === "CONFIRMED" || o.status === "OWNER_NOTIFIED";
              return (
                <div key={o.id} style={card}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ ...badge, background: st.color + "22", color: st.color }}>{st.label}</span>
                    <span style={{ color: "var(--text)", fontWeight: 600, fontSize: 14 }}>
                      {o.full_name || o.conv_name || "Cliente"}
                    </span>
                    <span style={{ color: "var(--text-dim)", fontSize: 12, marginLeft: "auto" }}>#{o.id}</span>
                  </div>
                  <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>
                    🛍️ {o.product || "—"}{variant ? ` · ${variant}` : ""}{o.quantity ? ` · x${o.quantity}` : ""}<br />
                    💰 {o.total || "—"} &nbsp; 🏙️ {o.city || "—"}{o.department ? `, ${o.department}` : ""}<br />
                    📞 {o.phone || o.conv_phone}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                    <button onClick={() => copy(o)} style={actionBtn}>
                      {copiedId === o.id ? "✓ Copiado" : "📋 Copiar para Dropi"}
                    </button>
                    <button onClick={() => onOpenConversation(o.conversation_id)} style={actionBtn}>
                      💬 Abrir chat
                    </button>
                    {isConfirmed && (
                      <button
                        onClick={() => dispatch(o.id)}
                        disabled={busyId === o.id}
                        style={{ ...actionBtn, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }}
                      >
                        {busyId === o.id ? "…" : "🚚 Marcar despachado"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ color, fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{value}</div>
      <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 4 }}>{label}</div>
    </div>
  );
}

const card: CSSProperties = {
  background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 12, padding: 14
};
const badge: CSSProperties = {
  fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 6
};
const chip: CSSProperties = {
  fontSize: 12.5, fontWeight: 500, padding: "6px 12px", borderRadius: 8, border: "1px solid", cursor: "pointer"
};
const actionBtn: CSSProperties = {
  fontSize: 12.5, fontWeight: 500, padding: "7px 12px", borderRadius: 8,
  background: "var(--bg)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer"
};
const secondaryBtn: CSSProperties = {
  background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)",
  borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer"
};
