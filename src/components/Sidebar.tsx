"use client";

import { useEffect, useState } from "react";
import ThemeToggle from "./ThemeToggle";

interface Label {
  id: number;
  name: string;
  color: string;
}

export type View = "active" | "archived";

interface Props {
  view: View;
  onViewChange: (v: View) => void;
  activeCount: number;
  archivedCount: number;
  pinnedCount: number;
  unreadCount?: number;
  ownerPhone: string;
  onDisconnect: () => void;
  onLabelFilter?: (labelId: number | null) => void;
  activeLabelFilter?: number | null;
}

export default function Sidebar(props: Props) {
  const [labels, setLabels] = useState<Label[]>([]);

  useEffect(() => {
    fetch("/api/labels")
      .then((r) => r.json() as Promise<{ labels: Label[] }>)
      .then((d) => setLabels(d.labels ?? []))
      .catch(() => {});
    const t = setInterval(() => {
      fetch("/api/labels")
        .then((r) => r.json() as Promise<{ labels: Label[] }>)
        .then((d) => setLabels(d.labels ?? []))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <nav
      style={{
        width: 240,
        background: "var(--bg-elev)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        padding: "14px 10px",
        flexShrink: 0
      }}
    >
      {/* Workspace header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 10px",
          borderRadius: "var(--radius)",
          marginBottom: 12
        }}
      >
        <div
          style={{
            width: 22, height: 22, borderRadius: 5,
            background: "var(--accent)",
            color: "#fff",
            display: "grid", placeItems: "center",
            fontWeight: 600, fontSize: 12,
            flexShrink: 0
          }}
        >
          E
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Eclipse</div>
          <div
            className="font-mono"
            style={{ fontSize: 10.5, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            +{props.ownerPhone}
          </div>
        </div>
        <ThemeToggle />
      </div>

      {/* Vistas principales */}
      <div style={{ marginTop: 6 }}>
        <NavItem
          icon="💬"
          label="Activos"
          count={props.activeCount}
          active={props.view === "active" && !props.activeLabelFilter}
          onClick={() => { props.onViewChange("active"); props.onLabelFilter?.(null); }}
        />
        <NavItem
          icon="📁"
          label="Archivados"
          count={props.archivedCount}
          active={props.view === "archived"}
          onClick={() => { props.onViewChange("archived"); props.onLabelFilter?.(null); }}
        />
      </div>

      {/* Etiquetas */}
      <div style={{ marginTop: 18 }}>
        <SectionTitle>Etiquetas</SectionTitle>
        {labels.length === 0 && (
          <div style={{ padding: "4px 12px", fontSize: 12, color: "var(--text-dim)" }}>
            Sin etiquetas aún
          </div>
        )}
        {labels.map((l) => (
          <LabelRow
            key={l.id}
            label={l}
            active={props.activeLabelFilter === l.id}
            onClick={() => {
              props.onViewChange("active");
              props.onLabelFilter?.(props.activeLabelFilter === l.id ? null : l.id);
            }}
          />
        ))}
        <div style={{ padding: "4px 12px", fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
          Creá etiquetas desde cualquier chat
        </div>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Disconnect */}
      <button
        onClick={props.onDisconnect}
        style={{
          padding: "6px 12px",
          color: "var(--text-muted)",
          fontSize: 13,
          textAlign: "left",
          borderRadius: "var(--radius)",
          transition: "all 0.12s",
          display: "flex", alignItems: "center", gap: 10
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--danger)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        <span style={{ width: 16, opacity: 0.7 }}>⏻</span>
        Desconectar WhatsApp
      </button>
    </nav>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "4px 12px 6px",
        fontSize: 11,
        color: "var(--text-dim)",
        fontWeight: 500,
        textTransform: "uppercase",
        letterSpacing: "0.04em"
      }}
    >
      {children}
    </div>
  );
}

function NavItem({
  icon, label, count, active, onClick
}: {
  icon: string;
  label: string;
  count?: number;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        padding: "6px 12px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        color: active ? "var(--text)" : "var(--text-muted)",
        background: active ? "var(--bg-active)" : "transparent",
        borderRadius: "var(--radius)",
        fontSize: 13.5,
        fontWeight: 500,
        transition: "all 0.12s",
        textAlign: "left"
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--text)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--text-muted)";
        }
      }}
    >
      <span style={{ width: 16, opacity: 0.7 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {count != null && count > 0 && (
        <span
          style={{
            marginLeft: "auto",
            background: active ? "var(--accent-soft)" : "var(--bg-elev-2)",
            color: active ? "var(--accent)" : "var(--text-muted)",
            fontSize: 11,
            padding: "0 6px",
            borderRadius: 4,
            minWidth: 16,
            textAlign: "center"
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function LabelRow({
  label, active, onClick
}: {
  label: Label;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        padding: "6px 12px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        color: active ? "var(--text)" : "var(--text-muted)",
        background: active ? "var(--bg-active)" : "transparent",
        borderRadius: "var(--radius)",
        fontSize: 13.5,
        transition: "all 0.12s",
        textAlign: "left"
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <span
        style={{
          width: 8, height: 8, borderRadius: "50%",
          backgroundColor: label.color,
          flexShrink: 0
        }}
      />
      <span style={{
        flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
      }}>
        {label.name}
      </span>
    </button>
  );
}
