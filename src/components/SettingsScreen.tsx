"use client";

import { useEffect, useState, type FormEvent, type CSSProperties, type ReactNode } from "react";

interface Props {
  // Se llama tras guardar correctamente. También se usa para "Volver" cuando
  // la config ya existía (allowSkip).
  onSaved: () => void;
  // Si true, muestra un botón para continuar sin cambios (cuando ya hay config).
  allowSkip?: boolean;
  // Si true, se renderiza como panel (sin pantalla completa) para incrustarlo
  // en una columna (ej: junto al QR). Tras guardar muestra "✓ Guardado" en vez
  // de navegar.
  embedded?: boolean;
}

interface SettingsForm {
  shopifyDomain: string;
  shopifyWebhookSecret: string;
  confirmationDelayMinutes: string;
  blockedDepartments: string;
  blockedCities: string;
  blockedDepartmentCodes: string;
  ownerNotifyPhones: string;
  confirmGroupJid: string;
  manualGroupJid: string;
}

const EMPTY: SettingsForm = {
  shopifyDomain: "",
  shopifyWebhookSecret: "",
  confirmationDelayMinutes: "3",
  blockedDepartments: "",
  blockedCities: "",
  blockedDepartmentCodes: "",
  ownerNotifyPhones: "",
  confirmGroupJid: "",
  manualGroupJid: ""
};

interface WaGroup { id: string; name: string; }

export default function SettingsScreen({ onSaved, allowSkip = false, embedded = false }: Props) {
  const [form, setForm] = useState<SettingsForm>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedOk, setSavedOk] = useState(false);
  const [groups, setGroups] = useState<WaGroup[]>([]);
  const [groupsError, setGroupsError] = useState("");

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
            ownerNotifyPhones: s.ownerNotifyPhones ?? "",
            confirmGroupJid: s.confirmGroupJid ?? "",
            manualGroupJid: s.manualGroupJid ?? ""
          });
        }
      } catch {
        // si falla, queda el formulario vacío
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Cargar los grupos de WhatsApp donde está el bot (para los selectores).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/wa-groups", { cache: "no-store" });
        const data = await res.json() as { groups?: WaGroup[]; error?: string };
        setGroups(data.groups ?? []);
        if (data.error) setGroupsError(data.error);
      } catch {
        setGroupsError("No se pudieron cargar los grupos");
      }
    })();
  }, []);

  function update<K extends keyof SettingsForm>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSavedOk(false);
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
        setSavedOk(true);
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

  const outerStyle: CSSProperties = embedded
    ? { height: "100%", background: "var(--bg)", padding: "20px 16px", overflowY: "auto" }
    : { minHeight: "100vh", background: "var(--bg)", padding: "40px 16px", overflowY: "auto" };
  const innerStyle: CSSProperties = embedded
    ? { maxWidth: "100%", margin: 0 }
    : { maxWidth: 560, margin: "0 auto" };

  return (
    <div style={outerStyle}>
      <div style={innerStyle}>
        <div style={{ textAlign: embedded ? "left" : "center", marginBottom: embedded ? 18 : 28 }}>
          <h1 style={{ color: "var(--text)", fontSize: embedded ? 17 : 22, fontWeight: 600, margin: 0 }}>
            Configuración de tu tienda
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
            Configura tu Shopify y tus preferencias. Los campos que dejes vacíos
            usarán los valores por defecto del sistema.
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
            <Field label="Mis números para avisos" hint="Separados por coma, formato 57XXXXXXXXXX. Se usan si no eliges un grupo abajo.">
              <input
                style={inputStyle}
                value={form.ownerNotifyPhones}
                onChange={(e) => update("ownerNotifyPhones", e.target.value)}
                placeholder="573001234567,573009876543"
              />
            </Field>
          </Section>

          <Section title="👥 Grupos">
            <p style={{ color: "var(--text-dim)", fontSize: 11.5, margin: 0, lineHeight: 1.5 }}>
              Para usar grupos, agrega este WhatsApp a los grupos desde tu celular y
              elígelos aquí. Si dejas un grupo en “Ninguno”, ese aviso va a tus números.
            </p>
            <Field label="Grupo de confirmaciones (Dropi)" hint="Cuando un cliente confirma, el aviso llega aquí, listo para subir a Dropi.">
              <select
                style={inputStyle}
                value={form.confirmGroupJid}
                onChange={(e) => update("confirmGroupJid", e.target.value)}
              >
                <option value="">— Ninguno (avisar a mis números) —</option>
                {groupOptions(groups, form.confirmGroupJid).map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Grupo de envío manual al cliente" hint="Plantillas para reenviar al cliente y recordatorios llegan aquí.">
              <select
                style={inputStyle}
                value={form.manualGroupJid}
                onChange={(e) => update("manualGroupJid", e.target.value)}
              >
                <option value="">— Ninguno (avisar a mis números) —</option>
                {groupOptions(groups, form.manualGroupJid).map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </Field>
            {groupsError && (
              <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                ⚠️ {groupsError}. Conecta WhatsApp y recarga para ver tus grupos.
              </span>
            )}
            {!groupsError && groups.length === 0 && (
              <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                No se encontraron grupos. Agrega este WhatsApp a un grupo y recarga.
              </span>
            )}
          </Section>

          {error && (
            <p style={{ color: "#f87171", fontSize: 13, background: "rgba(248,113,113,0.1)", borderRadius: 8, padding: "8px 12px", margin: 0 }}>
              {error}
            </p>
          )}

          {savedOk && embedded && (
            <p style={{ color: "#34d399", fontSize: 13, background: "rgba(52,211,153,0.1)", borderRadius: 8, padding: "8px 12px", margin: 0 }}>
              ✓ Configuración guardada
            </p>
          )}

          <div style={{ display: "flex", gap: 12 }}>
            <button type="submit" disabled={saving} style={primaryBtn}>
              {saving ? "Guardando…" : embedded ? "Guardar" : "Guardar y continuar"}
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

// Asegura que el grupo ya guardado aparezca en el selector aunque la lista de
// grupos aún no haya cargado (ej: WhatsApp reconectando), para no perder la
// selección actual visualmente.
function groupOptions(groups: WaGroup[], current: string): WaGroup[] {
  if (current && !groups.some((g) => g.id === current)) {
    return [{ id: current, name: "Grupo seleccionado" }, ...groups];
  }
  return groups;
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
