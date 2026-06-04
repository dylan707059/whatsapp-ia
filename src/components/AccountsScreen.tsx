"use client";

import { useEffect, useState, type FormEvent, type CSSProperties } from "react";

interface AccountRow {
  id: number;
  email: string;
  businessName: string | null;
  ownerPhone: string | null;
  automationPaused: boolean;
  isAdmin: boolean;
}

interface Props {
  onClose: () => void;
}

export default function AccountsScreen({ onClose }: Props) {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [business, setBusiness] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [okMsg, setOkMsg] = useState("");

  async function load() {
    try {
      const res = await fetch("/api/accounts");
      if (res.ok) {
        const d = await res.json();
        setAccounts(d.accounts ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setOkMsg("");
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, businessName: business })
      });
      if (res.ok) {
        setOkMsg(`Cuenta ${email} creada ✓`);
        setEmail(""); setPassword(""); setBusiness("");
        load();
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "No se pudo crear la cuenta");
      }
    } catch {
      setError("Error de conexión");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "40px 16px", overflowY: "auto" }}>
      <div style={{ maxWidth: 620, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 600, margin: 0 }}>Cuentas</h1>
          <button onClick={onClose} style={secondaryBtn}>Volver</button>
        </div>

        {/* Crear cuenta */}
        <form onSubmit={handleCreate} style={card}>
          <h2 style={{ color: "var(--text)", fontSize: 14, fontWeight: 600, margin: "0 0 4px" }}>Crear cuenta nueva</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={label}>Correo</span>
            <input style={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="correo@ejemplo.com" required />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={label}>Contraseña</span>
            <input style={input} type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="mínimo 6 caracteres" required />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={label}>Nombre del negocio (opcional)</span>
            <input style={input} value={business} onChange={(e) => setBusiness(e.target.value)} placeholder="Ej: Vittoria" />
          </div>
          {error && <p style={{ color: "#f87171", fontSize: 13, margin: 0 }}>{error}</p>}
          {okMsg && <p style={{ color: "#34d399", fontSize: 13, margin: 0 }}>{okMsg}</p>}
          <button type="submit" disabled={saving} style={primaryBtn}>
            {saving ? "Creando…" : "Crear cuenta"}
          </button>
        </form>

        {/* Lista de cuentas */}
        <div style={{ ...card, marginTop: 18 }}>
          <h2 style={{ color: "var(--text)", fontSize: 14, fontWeight: 600, margin: "0 0 4px" }}>
            Cuentas existentes
          </h2>
          {loading ? (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Cargando…</p>
          ) : accounts.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No hay cuentas.</p>
          ) : (
            accounts.map((a) => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>
                    {a.email} {a.isAdmin && <span style={{ color: "var(--accent)", fontSize: 11 }}>· admin</span>}
                  </div>
                  <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                    {a.businessName || "—"} · {a.ownerPhone ? `+${a.ownerPhone}` : "sin WhatsApp"}
                  </div>
                </div>
                <span style={{ fontSize: 11, color: a.automationPaused ? "#ef4444" : "#34d399" }}>
                  {a.automationPaused ? "pausado" : "activo"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const card: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 14
};
const label: CSSProperties = { color: "var(--text)", fontSize: 13, fontWeight: 500 };
const input: CSSProperties = {
  background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8,
  padding: "8px 12px", color: "var(--text)", fontSize: 13, outline: "none", width: "100%"
};
const primaryBtn: CSSProperties = {
  background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8,
  padding: "10px 16px", fontSize: 14, fontWeight: 500, cursor: "pointer"
};
const secondaryBtn: CSSProperties = {
  background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)",
  borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer"
};
