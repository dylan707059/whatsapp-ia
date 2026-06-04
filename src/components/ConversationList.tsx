"use client";

import { memo } from "react";
import type { ConversationWithPreview } from "@/lib/types";
import { jidToDisplay } from "@/lib/types";
import { ChatRowSkeleton } from "./Skeleton";

interface Props {
  conversations: ConversationWithPreview[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  search: string;
  onSearch: (q: string) => void;
  viewLabel: string;
  totalCount: number;
  loading?: boolean;
}

function relativeTime(unixSeconds: number | null): string {
  if (!unixSeconds) return "";
  const now  = Math.floor(Date.now() / 1000);
  const diff = now - unixSeconds;
  if (diff < 60)    return "ahora";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d`;

  // Fecha corta tipo "12 mar"
  const date = new Date(unixSeconds * 1000);
  const months = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

// En la lista mostramos el NÚMERO (no el nombre). El nombre se ve en la
// cabecera del chat y en el panel de información.
function displayName(c: ConversationWithPreview): string {
  return jidToDisplay(c.phone);
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_GRADIENTS = [
  ["#5e6ad2", "#4751b8"], // accent
  ["#46d39a", "#2da776"], // green
  ["#f472b6", "#c83a8e"], // pink
  ["#ffb547", "#c98326"], // amber
  ["#60a5fa", "#3b82f6"], // blue
  ["#a78bfa", "#8b5cf6"], // purple
  ["#fb923c", "#ea580c"], // orange
  ["#34d399", "#10b981"]  // emerald
];

function avatarColors(seed: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length] as [string, string];
}

export default function ConversationList(props: Props) {
  const pinned = props.conversations.filter((c) => c.pinned_at);
  const recent = props.conversations.filter((c) => !c.pinned_at);

  return (
    <aside
      style={{
        background: "var(--bg-elev)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        minWidth: 0
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 8
        }}
      >
        <h1 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1, color: "var(--text)" }}>
          {props.viewLabel}
        </h1>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {props.totalCount}
        </span>
      </div>

      {/* Search */}
      <div style={{ padding: "8px 12px 0" }}>
        <div
          style={{
            background: "var(--bg-elev-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "6px 10px",
            display: "flex",
            alignItems: "center",
            gap: 8
          }}
        >
          <span style={{ color: "var(--text-dim)", fontSize: 13 }}>🔍</span>
          <input
            type="text"
            value={props.search}
            onChange={(e) => props.onSearch(e.target.value)}
            placeholder="Buscar número o nombre..."
            style={{
              flex: 1,
              background: "transparent",
              border: 0,
              outline: 0,
              color: "var(--text)",
              fontSize: 13,
              fontFamily: "inherit"
            }}
          />
          {props.search && (
            <button
              onClick={() => props.onSearch("")}
              style={{ color: "var(--text-dim)", fontSize: 12 }}
              title="Limpiar"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Lista */}
      <div style={{ flex: 1, overflowY: "auto", paddingTop: 6 }}>
        {props.loading && props.conversations.length === 0 && (
          <div style={{ paddingTop: 6 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <ChatRowSkeleton key={i} />
            ))}
          </div>
        )}
        {!props.loading && props.conversations.length === 0 && (
          <div
            style={{
              padding: "32px 20px",
              textAlign: "center",
              color: "var(--text-dim)",
              fontSize: 13
            }}
          >
            {props.search ? "Sin resultados" : "Sin conversaciones todavía"}
          </div>
        )}

        {pinned.length > 0 && (
          <>
            <SectionLabel>Fijados</SectionLabel>
            {pinned.map((c) => (
              <ChatRow
                key={c.id}
                conv={c}
                active={props.selectedId === c.id}
                onClick={() => props.onSelect(c.id)}
              />
            ))}
          </>
        )}

        {recent.length > 0 && (
          <>
            {pinned.length > 0 && <SectionLabel>Recientes</SectionLabel>}
            {recent.map((c) => (
              <ChatRow
                key={c.id}
                conv={c}
                active={props.selectedId === c.id}
                onClick={() => props.onSelect(c.id)}
              />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "12px 16px 4px",
        fontSize: 10.5,
        letterSpacing: "0.05em",
        color: "var(--text-dim)",
        textTransform: "uppercase",
        fontWeight: 600
      }}
    >
      {children}
    </div>
  );
}

interface ChatRowProps {
  conv: ConversationWithPreview;
  active: boolean;
  onClick: () => void;
}

const ChatRow = memo(ChatRowInner, (prev, next) => {
  // Re-render solo si cambia el contenido visible: selección, last_message_at,
  // preview, mode, pinned, name, labels.
  if (prev.active !== next.active) return false;
  if (prev.conv.id !== next.conv.id) return false;
  if (prev.conv.last_message_at !== next.conv.last_message_at) return false;
  if (prev.conv.last_message_preview !== next.conv.last_message_preview) return false;
  if (prev.conv.mode !== next.conv.mode) return false;
  if (prev.conv.pinned_at !== next.conv.pinned_at) return false;
  if (prev.conv.name !== next.conv.name) return false;
  // Comparación de labels por id y nombre (las labels son inmutables salvo update raro)
  const prevLabels = prev.conv.labels ?? [];
  const nextLabels = next.conv.labels ?? [];
  if (prevLabels.length !== nextLabels.length) return false;
  for (let i = 0; i < prevLabels.length; i++) {
    if (prevLabels[i].id !== nextLabels[i].id) return false;
    if (prevLabels[i].name !== nextLabels[i].name) return false;
    if (prevLabels[i].color !== nextLabels[i].color) return false;
  }
  return true;
});

function ChatRowInner({
  conv, active, onClick
}: ChatRowProps) {
  const name = displayName(conv);
  const [g1, g2] = avatarColors(name);
  const initials = initialsOf(name);

  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        padding: "9px 14px",
        display: "flex",
        gap: 11,
        alignItems: "center",
        background: active ? "var(--bg-active)" : "transparent",
        borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}`,
        textAlign: "left",
        transition: "background 0.1s"
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <div
        style={{
          width: 32, height: 32, borderRadius: 6,
          display: "grid", placeItems: "center",
          color: "#fff", fontWeight: 600, fontSize: 12,
          background: `linear-gradient(135deg, ${g1}, ${g2})`,
          flexShrink: 0
        }}
      >
        {initials}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 2
          }}
        >
          {conv.pinned_at && (
            <span style={{ color: "var(--text-dim)", fontSize: 10 }} title="Fijado">📌</span>
          )}
          <span
            style={{
              fontWeight: 600,
              fontSize: 13.5,
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--text)"
            }}
          >
            {name}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
            {relativeTime(conv.last_message_at)}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              flex: 1, minWidth: 0,
              color: "var(--text-muted)",
              fontSize: 12.5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}
          >
            {conv.last_message_preview ?? "Sin mensajes"}
          </span>
          <ModeBadge mode={conv.mode} />
        </div>

        {conv.labels && conv.labels.length > 0 && (
          <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
            {conv.labels.map((l) => (
              <span
                key={l.id}
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 3,
                  fontWeight: 500,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  background: `${l.color}22`,
                  color: l.color
                }}
              >
                <span
                  style={{
                    width: 6, height: 6, borderRadius: "50%",
                    backgroundColor: l.color
                  }}
                />
                {l.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

function ModeBadge({ mode }: { mode: "AI" | "HUMAN" }) {
  const isAi = mode === "AI";
  return (
    <span
      style={{
        fontSize: 9.5,
        padding: "1px 5px",
        borderRadius: 3,
        fontWeight: 700,
        letterSpacing: "0.04em",
        flexShrink: 0,
        background: isAi ? "var(--success-soft)" : "var(--warning-soft)",
        color: isAi ? "var(--success)" : "var(--warning)"
      }}
    >
      {mode}
    </span>
  );
}
