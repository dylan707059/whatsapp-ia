// Mapa LID → teléfono persistido en SQLite.
// Se llena al sincronizar contactos (contacts.upsert / contacts.update).
// Permite identificar al owner cuando WhatsApp envía JIDs @lid.

import { db } from "../db";

const stmtUpsert = db.prepare(
  `INSERT INTO contact_lids (lid, phone, updated_at)
   VALUES (?, ?, unixepoch())
   ON CONFLICT(lid) DO UPDATE SET phone = excluded.phone, updated_at = unixepoch()`
);

const stmtAll = db.prepare<[], { lid: string; phone: string }>(
  "SELECT lid, phone FROM contact_lids"
);

// Cache en memoria
const lidToPhone = new Map<string, string>();

// Cargar mapa desde SQLite al arrancar
(function loadFromDb() {
  for (const row of stmtAll.all()) {
    lidToPhone.set(row.lid, row.phone);
  }
  if (lidToPhone.size > 0) {
    console.log(`[contact-store] Cargados ${lidToPhone.size} LIDs desde SQLite`);
  }
})();

export function registerContact(
  id: string | null | undefined,
  lid: string | null | undefined
): void {
  if (!id || !lid) return;
  const phone  = id.split("@")[0];
  const lidKey = lid.split("@")[0];
  if (!phone || !lidKey) return;

  if (lidToPhone.get(lidKey) === phone) return; // sin cambio

  lidToPhone.set(lidKey, phone);
  try {
    stmtUpsert.run(lidKey, phone);
  } catch (err) {
    console.error("[contact-store] Error guardando LID:", err);
  }
}

// Dado un JID (@s.whatsapp.net o @lid), devuelve el número de teléfono sin @.
export function resolvePhone(jid: string): string {
  if (jid.endsWith("@lid")) {
    const lidKey  = jid.split("@")[0];
    const resolved = lidToPhone.get(lidKey);
    if (resolved) return resolved;
    // Sin mapping: devolver el LID en bruto (no hay owner match → se trata como cliente)
    return lidKey;
  }
  return jid.split("@")[0];
}
