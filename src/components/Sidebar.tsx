"use client";

import { useEffect, useState } from "react";
import ThemeToggle from "./ThemeToggle";

interface Label {
  id: string;
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
  onOpenSettings?: () => void;
  onOpenAccounts?: () => void;
  onOpenPedidos?: () => void;
  onLogout?: () => void;
  onLabelFilter?: (labelId: string | null) => void;
  activeLabelFilter?: string | null;
}

export default function Sidebar(props: Props) {
  const [labels, setLabels] = useState<Label[]>([]);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json() as Promise<{ isAdmin?: boolean }>)
      .then((d) => setIsAdmin(Boolean(d.isAdmin)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`/api/wa-labels?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<{ labels: Label[] }>)
      .then((d) => setLabels(d.labels ?? []))
      .catch(() => {});
    const t = setInterval(() => {
      fetch(`/api/wa-labels?t=${Date.now()}`, { cache: "no-store" })
        .then((r) => r.json() as Promise<{ labels: Label[] }>)
        .then((d) => setLabels(d.labels ?? []))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const load = () =>
      fetch("/api/automation")
        .then((r) => r.json() as Promise<{ paused: boolean }>)
        .then((d) => setPaused(Boolean(d.paused)))
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  async function toggleAutomation() {
    const next = !(paused ?? false);
    if (next && !confirm(
      "¿Apagar TODA la automatización?\n\nEl bot dejará de responder, confirmar pedidos, mandar recordatorios y avisos. Solo podrás escribir manualmente.\n\nPuedes reactivarlo cuando quieras."
    )) return;
    setPaused(next);
    try {
      await fetch("/api/automation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: next })
      });
    } catch {
      setPaused(!next); // revertir si falla
    }
  }

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

      {/* Interruptor de automatización (botón de pánico) */}
      <button
        onClick={toggleAutomation}
        title={paused ? "Reanudar la automatización" : "Apagar toda la automatización"}
        style={{
          width: "100%",
          margin: "0 0 10px",
          padding: "10px 12px",
          borderRadius: "var(--radius)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 12.5,
          fontWeight: 600,
          textAlign: "left",
          transition: "all 0.12s",
          background: paused ? "rgba(239,68,68,0.14)" : "var(--bg-hover)",
          color: paused ? "#ef4444" : "var(--text-muted)",
          border: paused ? "1px solid #ef4444" : "1px solid var(--border)"
        }}
      >
        <span style={{ fontSize: 14 }}>{paused ? "⏸" : "🤖"}</span>
        <span style={{ flex: 1, lineHeight: 1.3 }}>
          {paused === null
            ? "Cargando…"
            : paused
              ? "Automatización APAGADA"
              : "Bot activo · tocá para apagar"}
        </span>
      </button>

      {/* Vistas principales */}
      <div style={{ marginTop: 6 }}>
        {props.onOpenPedidos && (
          <NavItem
            icon="📋"
            label="Pedidos"
            onClick={props.onOpenPedidos}
          />
        )}
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
          Se crean en WhatsApp Business
        </div>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Configuración */}
      {props.onOpenSettings && (
        <FooterButton icon="⚙️" label="Configuración" onClick={props.onOpenSettings} />
      )}

      {/* Cuentas (solo admin) */}
      {isAdmin && props.onOpenAccounts && (
        <FooterButton icon="👥" label="Cuentas" onClick={props.onOpenAccounts} />
      )}

      {/* Disconnect */}
      <FooterButton
        icon="⏻"
        label="Desconectar WhatsApp"
        onClick={props.onDisconnect}
        dangerHover
      />

      {/* Cerrar sesión */}
      {props.onLogout && (
        <FooterButton icon="🚪" label="Cerrar sesión" onClick={props.onLogout} />
      )}
    </nav>
  );
}

function FooterButton({
  icon, label, onClick, dangerHover
}: {
  icon: string;
  label: string;
  onClick?: () => void;
  dangerHover?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
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
        e.currentTarget.style.color = dangerHover ? "var(--danger)" : "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      <span style={{ width: 16, opacity: 0.7 }}>{icon}</span>
      {label}
    </button>
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
