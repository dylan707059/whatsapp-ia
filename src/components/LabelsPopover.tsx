"use client";

import { useEffect, useRef, useState } from "react";
import type { LabelLite } from "@/lib/types";

interface Props {
  conversationId: number;
  onClose: () => void;
}

interface Label extends LabelLite {
  owner_phone: string;
  created_at: number;
}

const PALETTE = [
  "#5e6ad2", "#46d39a", "#ffb547", "#f472b6", "#60a5fa",
  "#f87171", "#a78bfa", "#34d399", "#fb923c", "#94a3b8"
];

export default function LabelsPopover({ conversationId, onClose }: Props) {
  const [allLabels, setAllLabels]     = useState<Label[]>([]);
  const [assignedIds, setAssignedIds] = useState<Set<number>>(new Set());
  const [creating, setCreating]       = useState(false);
  const [newName, setNewName]         = useState("");
  const [newColor, setNewColor]       = useState(PALETTE[0]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/labels").then((r) => r.json() as Promise<{ labels: Label[] }>),
      fetch(`/api/conversations/${conversationId}/labels`).then((r) => r.json() as Promise<{ labels: Label[] }>)
    ]).then(([all, assigned]) => {
      setAllLabels(all.labels ?? []);
      setAssignedIds(new Set((assigned.labels ?? []).map((l) => l.id)));
    });
  }, [conversationId]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  async function toggleAssign(labelId: number, isAssigned: boolean) {
    const next = new Set(assignedIds);
    if (isAssigned) {
      await fetch(`/api/conversations/${conversationId}/labels?labelId=${labelId}`, { method: "DELETE" });
      next.delete(labelId);
    } else {
      await fetch(`/api/conversations/${conversationId}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelId })
      });
      next.add(labelId);
    }
    setAssignedIds(next);
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const res = await fetch("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color: newColor })
    });
    if (!res.ok) return;
    const data = await res.json() as { label: Label };
    setAllLabels((prev) => [...prev, data.label]);
    await fetch(`/api/conversations/${conversationId}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelId: data.label.id })
    });
    setAssignedIds((prev) => new Set(prev).add(data.label.id));
    setNewName("");
    setCreating(false);
  }

  async function handleDeleteLabel(labelId: number) {
    if (!confirm("¿Borrar esta etiqueta? Se quitará de TODAS las conversaciones.")) return;
    await fetch(`/api/labels/${labelId}`, { method: "DELETE" });
    setAllLabels((prev) => prev.filter((l) => l.id !== labelId));
    setAssignedIds((prev) => {
      const next = new Set(prev);
      next.delete(labelId);
      return next;
    });
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
        Etiquetas
      </div>

      <div style={{ maxHeight: 220, overflowY: "auto" }}>
        {allLabels.length === 0 && !creating && (
          <p style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 4px", margin: 0 }}>
            Sin etiquetas. Creá la primera abajo.
          </p>
        )}
        {allLabels.map((label) => {
          const assigned = assignedIds.has(label.id);
          return (
            <div
              key={label.id}
              style={{ display: "flex", alignItems: "center", gap: 4 }}
              onMouseEnter={(e) => {
                const del = e.currentTarget.querySelector("[data-del]") as HTMLElement;
                if (del) del.style.opacity = "1";
              }}
              onMouseLeave={(e) => {
                const del = e.currentTarget.querySelector("[data-del]") as HTMLElement;
                if (del) del.style.opacity = "0";
              }}
            >
              <button
                onClick={() => toggleAssign(label.id, assigned)}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  textAlign: "left",
                  padding: "6px 8px",
                  borderRadius: "var(--radius-sm)",
                  transition: "background 0.1s",
                  fontSize: 13.5,
                  color: "var(--text)"
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
              <button
                data-del
                onClick={() => handleDeleteLabel(label.id)}
                style={{
                  opacity: 0,
                  fontSize: 11,
                  color: "var(--danger)",
                  padding: "0 6px",
                  transition: "opacity 0.1s"
                }}
                title="Borrar etiqueta"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8 }}>
        {!creating ? (
          <button
            onClick={() => setCreating(true)}
            style={{
              fontSize: 12,
              color: "var(--accent)",
              fontWeight: 600,
              padding: "4px 4px"
            }}
          >
            + Crear etiqueta
          </button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="Nombre"
              maxLength={40}
              autoFocus
              style={{
                background: "var(--bg-elev-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                padding: "6px 10px",
                fontSize: 13,
                color: "var(--text)",
                outline: 0,
                fontFamily: "inherit"
              }}
            />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {PALETTE.map((c) => (
                <button
                  key={c}
                  onClick={() => setNewColor(c)}
                  style={{
                    width: 20, height: 20, borderRadius: "50%",
                    background: c,
                    border: newColor === c ? `2px solid var(--text)` : "2px solid transparent",
                    transition: "transform 0.1s"
                  }}
                  title={c}
                />
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                style={{
                  background: newName.trim() ? "var(--accent)" : "var(--bg-elev-2)",
                  color: newName.trim() ? "#fff" : "var(--text-dim)",
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "5px 12px",
                  borderRadius: "var(--radius-sm)"
                }}
              >
                Crear
              </button>
              <button
                onClick={() => { setCreating(false); setNewName(""); }}
                style={{ fontSize: 12, color: "var(--text-muted)", padding: "5px 8px" }}
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
