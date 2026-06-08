"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  conversationId: number;
  onClose: () => void;
}

interface WaLabel {
  id: string;
  name: string;
  color: string;
}

export default function LabelsPopover({ conversationId, onClose }: Props) {
  const [allLabels, setAllLabels]     = useState<WaLabel[]>([]);
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading]         = useState(true);
  const [busyId, setBusyId]           = useState<string | null>(null);
  const [error, setError]             = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/wa-labels", { cache: "no-store" }).then((r) => r.json() as Promise<{ labels: WaLabel[] }>),
      fetch(`/api/conversations/${conversationId}/wa-labels`, { cache: "no-store" }).then((r) => r.json() as Promise<{ labelIds: string[] }>)
    ]).then(([all, assigned]) => {
      setAllLabels(all.labels ?? []);
      setAssignedIds(new Set(assigned.labelIds ?? []));
    }).catch(() => setError("No se pudieron cargar las etiquetas"))
      .finally(() => setLoading(false));
  }, [conversationId]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  async function toggleAssign(labelId: string, isAssigned: boolean) {
    setBusyId(labelId);
    setError(null);
    try {
      const res = isAssigned
        ? await fetch(`/api/conversations/${conversationId}/wa-labels?labelId=${encodeURIComponent(labelId)}`, { method: "DELETE" })
        : await fetch(`/api/conversations/${conversationId}/wa-labels`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ labelId })
          });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(res.status === 409 ? "WhatsApp no está conectado" : (data.error ?? "Error al sincronizar"));
        return;
      }
      const next = new Set(assignedIds);
      if (isAssigned) next.delete(labelId); else next.add(labelId);
      setAssignedIds(next);
    } catch {
      setError("Error de conexión");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      ref={ref}
      className="fade-in"
      style={{
        position: "absolute",
        right: 0,
        top: 36,
        zIndex: 30,
        width: 280,
        background: "var(--bg-elev)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-lg)",
        padding: 12,
        boxShadow: "0 8px 32px rgba(0,0,0,0.25)"
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-dim)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          marginBottom: 8,
          padding: "0 4px"
        }}
      >
        Etiquetas de WhatsApp
      </div>

      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {loading && (
          <p style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 4px", margin: 0 }}>
            Cargando…
          </p>
        )}

        {!loading && allLabels.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 4px", margin: 0, lineHeight: 1.5 }}>
            No hay etiquetas todavía. Créalas en la app de <b>WhatsApp Business</b> (Menú → Etiquetas) y aparecerán aquí automáticamente.
          </p>
        )}

        {!loading && allLabels.map((label) => {
          const assigned = assignedIds.has(label.id);
          const busy = busyId === label.id;
          return (
            <button
              key={label.id}
              disabled={busy}
              onClick={() => toggleAssign(label.id, assigned)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                textAlign: "left",
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                transition: "background 0.1s",
                fontSize: 13.5,
                color: "var(--text)",
                opacity: busy ? 0.5 : 1,
                cursor: busy ? "default" : "pointer"
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <span
                style={{
                  width: 14, height: 14, borderRadius: 4,
                  background: assigned ? label.color : "transparent",
                  border: `2px solid ${label.color}`,
                  flexShrink: 0,
                  display: "grid",
                  placeItems: "center",
                  color: "#fff",
                  fontSize: 9,
                  fontWeight: 700
                }}
              >
                {assigned && "✓"}
              </span>
              <span style={{ flex: 1 }}>{label.name}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div style={{ fontSize: 11.5, color: "var(--danger)", padding: "6px 4px 0", lineHeight: 1.4 }}>
          {error}
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8 }}>
        <p style={{ fontSize: 10.5, color: "var(--text-dim)", margin: 0, padding: "0 4px", lineHeight: 1.4 }}>
          Las etiquetas se sincronizan con tu WhatsApp Business en ambos sentidos.
        </p>
      </div>
    </div>
  );
}
