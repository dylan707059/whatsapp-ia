// Normalización de teléfonos colombianos.
// Acepta: 3147823790 / +57 314 782 3790 / 573147823790 / 314-782-3790

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  // Ya tiene prefijo 57 y longitud correcta
  if (digits.startsWith("57") && digits.length === 12) return digits;

  // Número local de 10 dígitos
  if (digits.startsWith("3") && digits.length === 10) return "57" + digits;

  // Intento genérico
  if (digits.length === 10) return "57" + digits;

  return digits;
}

// 573147823790 → 3147823790  (para mostrar al cliente)
export function phoneForDisplay(normalized: string): string {
  if (normalized.startsWith("57") && normalized.length === 12) {
    return normalized.slice(2);
  }
  return normalized;
}

// JID completo para enviar por Baileys
export function phoneToJid(phone: string): string {
  return `${normalizePhone(phone)}@s.whatsapp.net`;
}
