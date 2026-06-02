import type { Message, OrderData } from "./types";

// ─── Detección de confirmación ────────────────────────────────────────────────

// Frases exactas que significan "confirmo el pedido".
// Normalizadas sin tildes ni puntuación para comparar de forma robusta.
const CONFIRMATION_PHRASES = new Set([
  "confirmado",
  "confirmo",
  "si confirmo",
  "si dale",
  "dale",
  "correcto",
  "todo correcto",
  "listo",
  "asi esta bien",
  "asi lo quiero",
  "envialo",
  "despachalo",
  "dale todo esta bien",
  "si todo esta correcto"
]);

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")  // quitar tildes
    .replace(/[¿?¡!.,;:]/g, "")       // quitar puntuación
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Devuelve true solo si el texto es una confirmación final clara de pedido.
 * "sí" solo NO activa — requiere frases explícitas de confirmación.
 */
export function isConfirmationMessage(text: string): boolean {
  return CONFIRMATION_PHRASES.has(normalize(text));
}

// ─── Extracción de datos ──────────────────────────────────────────────────────

function extractField(text: string, pattern: RegExp): string {
  const m = text.match(pattern);
  return m ? m[1].trim() : "";
}

/**
 * Busca en el historial el último mensaje del bot que contiene la confirmación
 * de pedido formateada, y extrae todos los campos.
 * Devuelve null si no hay confirmación previa del bot.
 */
export function extractOrderData(
  history: Message[],
  conversationId: number
): OrderData | null {
  // El mensaje de confirmación del bot siempre contiene este emoji
  const botMsg = [...history]
    .reverse()
    .find((m) => m.role === "assistant" && m.content.includes("🛍️"));

  if (!botMsg) return null;

  const t = botMsg.content;

  const nombre    = extractField(t, /👤 Nombre:\s*(.+)/);
  const apellido  = extractField(t, /👤 Apellido:\s*(.+)/);
  const telefono  = extractField(t, /📞 Teléfono:\s*(.+)/);
  const producto  = extractField(t, /🛍️ Producto[^:]*:\s*(.+)/);
  const color     = extractField(t, /🎨 Color:\s*(.+)/);
  const talla     = extractField(t, /📏 Talla:\s*(.+)/);
  const cantidad  = extractField(t, /🔢 Cantidad:\s*(.+)/);
  const total     = extractField(t, /💰 Total a pagar:\s*(.+)/);
  const envio     = extractField(t, /🚚 Envío:\s*(.+)/);
  const pago      = extractField(t, /💳 Pago:\s*(.+)/);
  const direccion = extractField(t, /📍 Dirección:\s*(.+)/);
  const ciudad    = extractField(t, /🏙️ Ciudad:\s*(.+)/);
  const depto     = extractField(t, /📌 Departamento:\s*(.+)/);

  return {
    conversationId,
    fullName:   [nombre, apellido].filter(Boolean).join(" "),
    firstName:  nombre,
    lastName:   apellido,
    phone:      telefono,
    product:    producto,
    color,
    size:       talla,
    quantity:   cantidad,
    total,
    payment:    pago || "Contraentrega",
    shipping:   envio || "Gratis",
    address:    direccion,
    city:       ciudad,
    department: depto
  };
}

// ─── Validación ───────────────────────────────────────────────────────────────

/**
 * Devuelve la lista de campos faltantes en el pedido.
 * Array vacío = pedido completo.
 */
export function validateOrderData(data: OrderData): string[] {
  const missing: string[] = [];
  if (!data.fullName)   missing.push("nombre completo");
  if (!data.phone)      missing.push("teléfono");
  if (!data.product)    missing.push("producto");
  if (!data.color)      missing.push("color");
  if (!data.size)       missing.push("talla");
  if (!data.quantity)   missing.push("cantidad");
  if (!data.total)      missing.push("total a pagar");
  if (!data.address)    missing.push("dirección");
  if (!data.city)       missing.push("ciudad");
  if (!data.department) missing.push("departamento");
  return missing;
}
