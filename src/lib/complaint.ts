// Detección de mensajes de reclamo / devolución.
// Si el cliente envía cualquiera de estas palabras, el chat pasa a HUMAN
// y se envía alerta interna al dueño.

const COMPLAINT_KEYWORDS = [
  "reclamo",
  "reclamacion",
  "reclamación",
  "devolucion",
  "devolución",
  "me llego mal",
  "me llegó mal",
  "no era lo que pedi",
  "no era lo que pedí",
  "estafa",
  "denunciar",
  "quiero cancelar",
  "quiero hacer un reclamo",
  "producto malo",
  "vino malo",
  "vino roto",
  "llegó roto",
  "llego roto"
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!]/g, "")
    .trim();
}

export function isComplaintMessage(text: string): boolean {
  const normalized = normalize(text);
  return COMPLAINT_KEYWORDS.some((kw) => normalized.includes(normalize(kw)));
}

export function buildComplaintAlert(
  convId: number,
  clientPhone: string,
  message: string
): string {
  return [
    "*⚠️ ALERTA DE RECLAMO*",
    "",
    `*Conversación:* #${convId}`,
    `*Teléfono:* ${clientPhone}`,
    `*Mensaje:* ${message}`,
    "",
    "Chat pasado a *HUMANO*."
  ].join("\n");
}
