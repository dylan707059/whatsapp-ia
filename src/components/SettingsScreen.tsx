"use client";

import { useEffect, useState, type FormEvent, type CSSProperties, type ReactNode } from "react";

interface Props {
  // Se llama tras guardar correctamente. También se usa para "Volver" cuando
  // la config ya existía (allowSkip).
  onSaved: () => void;
  // Si true, muestra un botón para continuar sin cambios (cuando ya hay config).
  allowSkip?: boolean;
}

interface SettingsForm {
  shopifyDomain: string;
  shopifyWebhookSecret: string;
  confirmationDelayMinutes: string;
  blockedDepartments: string;
  blockedCities: string;
  blockedDepartmentCodes: string;
  ownerNotifyPhones: string;
}

const EMPTY: SettingsForm = {
  shopifyDomain: "",
  shopifyWebhookSecret: "",
  confirmationDelayMinutes: "3",
  blockedDepartments: "",
  blockedCities: "",
  blockedDepartmentCodes: "",
  ownerNotifyPhones: ""
};

export default function SettingsScreen({ onSaved, allowSkip = false }: Props) {
  const [form, setForm] = useState<SettingsForm>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          const s = data.settings ?? {};
          setForm({
            shopifyDomain: s.shopifyDomain ?? "",
            shopifyWebhookSecret: s.shopifyWebhookSecret ?? "",
            confirmationDelayMinutes: String(Math.round((s.confirmationDelaySeconds ?? 180) / 60)),
            blockedDepartments: s.blockedDepartments ?? "",
            blockedCities: s.blockedCities ?? "",
            blockedDepartmentCodes: s.blockedDepartmentCodes ?? "",
            ownerNotifyPhones: s.ownerNotifyPhones ?? ""
          });
        }
      } catch {
        // si falla, queda el formulario vacío
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function update<K extends keyof SettingsForm>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      if (res.ok) {
        onSaved();
        return;
      }
      const d = await res.json().catch(() => ({}));
      setError(d.error || "No se pudo guardar la configuración");
    } catch {
      setError("Error de conexión. Intenta de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div style={{ height: "100vh", display: "grid", placeItems: "center", background: "var(--bg)" }}>
        <div
          style={{
            width: 24, height: 24,
            border: "2px solid var(--border-strong)",
            borderTopColor: "var(--accent)",
            borderRadius: "50%",
            animation: "spin 0.8s linear infinite"
          }}
        />
        <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "40px 16px", overflowY: "auto" }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 600, margin: 0 }}>
            Configuración de tu tienda
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 8, lineHeight: 1.5 }}>
            Configura tu Shopify y tus preferencias antes de conectar WhatsApp.
            Los campos que dejes vacíos usarán los valores por defecto del sistema.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 20
          }}
        >
          <Section title="🛍️ Shopify">
            <Field label="Dominio de tu tienda" hint="Ej: eclipse.myshopify.com">
              <input
                style={inputStyle}
                value={form.shopifyDomain}
                onChange={(e) => update("shopifyDomain", e.target.value)}
                placeholder="tu-tienda.myshopify.com"
              />
            </Field>
            <Field label="Secret del webhook" hint="Shopify → Configuración → Notificaciones → Webhooks">
              <input
                style={inputStyle}
                value={form.shopifyWebhookSecret}
                onChange={(e) => update("shopifyWebhookSecret", e.target.value)}
                placeholder="shpss_..."
              />
            </Field>
            <Field label="Delay de confirmación (minutos)" hint="Tiempo de espera antes de enviar la confirmación al cliente">
              <input
                style={inputStyle}
                type="number"
                min={0}
                value={form.confirmationDelayMinutes}
                onChange={(e) => update("confirmationDelayMinutes", e.target.value)}
              />
            </Field>
          </Section>

          <Section title="🚫 Zonas que no cubres">
            <Field label="Departamentos bloqueados" hint="Separados por coma. Ej: Amazonas,Vaupes,Guainia">
              <input
                style={inputStyle}
                value={form.blockedDepartments}
                onChange={(e) => update("blockedDepartments", e.target.value)}
                placeholder="Amazonas,Vaupes,Guainia,Vichada"
              />
            </Field>
            <Field label="Ciudades bloqueadas" hint="Separadas por coma">
              <input
                style={inputStyle}
                value={form.blockedCities}
                onChange={(e) => update("blockedCities", e.target.value)}
                placeholder="Leticia,Mitu,Inirida"
              />
            </Field>
            <Field label="Códigos de provincia bloqueados" hint="Códigos de Shopify. Ej: VAU,SAP,AMA">
              <input
                style={inputStyle}
                value={form.blockedDepartmentCodes}
                onChange={(e) => update("blockedDepartmentCodes", e.target.value)}
                placeholder="SAP,AMA,VAU,GUA,VID"
              />
            </Field>
          </Section>

          <Section title="📞 Notificaciones">
            <Field label="Mis números para avisos" hint="Separados por coma, formato 57XXXXXXXXXX">
              <input
                style={inputStyle}
                value={form.ownerNotifyPhones}
                onChange={(e) => update("ownerNotifyPhones", e.target.value)}
                placeholder="573001234567,573009876543"
              />
            </Field>
          </Section>

          {error && (
            <p style={{ color: "#f87171", fontSize: 13, background: "rgba(248,113,113,0.1)", borderRadius: 8, padding: "8px 12px", margin: 0 }}>
              {error}
            </p>
          )}

          <div style={{ display: "flex", gap: 12 }}>
            <button type="submit" disabled={saving} style={primaryBtn}>
              {saving ? "Guardando…" : "Guardar y continuar"}
            </button>
            {allowSkip && (
              <button type="button" onClick={onSaved} style={secondaryBtn}>
                Volver
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 style={{ color: "var(--text)", fontSize: 14, fontWeight: 600, margin: 0 }}>{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>{label}</span>
      {hint && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{hint}</span>}
      {children}
    </label>
  );
}

const inputStyle: CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 12px",
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
  width: "100%"
};

const primaryBtn: CSSProperties = {
  flex: 1,
  background: "var(--accent)",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "10px 16px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer"
};

const secondaryBtn: CSSProperties = {
  background: "transparent",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "10px 16px",
  fontSize: 14,
  cursor: "pointer"
};
