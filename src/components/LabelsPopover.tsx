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
  "#5e6ad2", // violet (default)
  "#46d39a", // green
  "#ffb547", // amber
  "#f472b6", // pink
  "#60a5fa", // blue
  "#f87171", // red
  "#a78bfa", // purple
  "#34d399", // emerald
  "#fb923c", // orange
  "#94a3b8"  // slate
];

export default function LabelsPopover({ conversationId, onClose }: Props) {
  const [allLabels, setAllLabels]       = useState<Label[]>([]);
  const [assignedIds, setAssignedIds]   = useState<Set<number>>(new Set());
  const [creating, setCreating]         = useState(false);
  const [newName, setNewName]           = useState("");
  const [newColor, setNewColor]         = useState(PALETTE[0]);
  const ref = useRef<HTMLDivElement>(null);

  // Cargar labels disponibles y asignadas
  useEffect(() => {
    Promise.all([
      fetch("/api/labels").then((r) => r.json() as Promise<{ labels: Label[] }>),
      fetch(`/api/conversations/${conversationId}/labels`).then((r) => r.json() as Promise<{ labels: Label[] }>)
    ]).then(([all, assigned]) => {
      setAllLabels(all.labels ?? []);
      setAssignedIds(new Set((assigned.labels ?? []).map((l) => l.id)));
    });
  }, [conversationId]);

  // Cerrar al click fuera
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
    // Auto-asignar a la conv actual
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
      className="absolute right-0 top-7 z-20 w-72 bg-white border border-gray-200 rounded-lg shadow-lg p-3"
    >
      <div className="text-xs font-semibold text-gray-500 uppercase mb-2 tracking-wide">
        Etiquetas
      </div>

      <div className="max-h-56 overflow-y-auto space-y-1">
        {allLabels.length === 0 && !creating && (
          <p className="text-xs text-gray-400 py-2">
            Sin etiquetas. Creá la primera abajo.
          </p>
        )}
        {allLabels.map((label) => {
          const assigned = assignedIds.has(label.id);
          return (
            <div key={label.id} className="flex items-center gap-2 group">
              <button
                onClick={() => toggleAssign(label.id, assigned)}
                className="flex-1 flex items-center gap-2 text-left py-1 px-2 rounded hover:bg-gray-50"
              >
                <span
                  className="w-4 h-4 rounded border-2"
                  style={{
                    backgroundColor: assigned ? label.color : "transparent",
                    borderColor: label.color
                  }}
                />
                <span className="text-sm flex-1">{label.name}</span>
                {assigned && <span className="text-xs text-gray-400">✓</span>}
              </button>
              <button
                onClick={() => handleDeleteLabel(label.id)}
                className="opacity-0 group-hover:opacity-100 text-xs text-red-400 hover:text-red-600 px-1"
                title="Borrar etiqueta"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <div className="border-t border-gray-100 mt-2 pt-2">
        {!creating ? (
          <button
            onClick={() => setCreating(true)}
            className="text-xs text-violet-600 hover:text-violet-800 font-medium"
          >
            + Crear etiqueta
          </button>
        ) : (
          <div className="space-y-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="Nombre de la etiqueta"
              maxLength={40}
              autoFocus
              className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none focus:border-violet-400"
            />
            <div className="flex gap-1 flex-wrap">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  onClick={() => setNewColor(c)}
                  className={`w-5 h-5 rounded-full ${newColor === c ? "ring-2 ring-offset-1 ring-gray-400" : ""}`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                className="bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium px-3 py-1 rounded disabled:opacity-50"
              >
                Crear
              </button>
              <button
                onClick={() => { setCreating(false); setNewName(""); }}
                className="text-xs text-gray-500 hover:text-gray-700 px-2"
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
