import type { Message, OrderData } from "./types";

// ─── Detección de confirmación ────────────────────────────────────────────────

// Frases EXACTAS o cuasi-exactas (match completo del mensaje).
// La gente rara vez escribe solo "si" — eso se considera ambiguo y NO confirma.
const CONFIRMATION_EXACT = new Set([
  // Confirmaciones directas
  "confirmado", "confirmo", "confirmar", "confirma", "confirmemos",
  "si confirmo", "si confirmado", "confirmadisimo", "confirmando",
  // Coloquiales de aceptación
  "dale", "si dale", "vale", "ok", "okey", "okay", "okas", "oka",
  "listo", "lista", "perfecto", "perfecta", "excelente", "genial",
  "bueno", "buenas", "claro",
  // Validación de datos
  "correcto", "correcta", "todo correcto", "todo bien", "todo ok",
  "todo perfecto", "todo bueno",
  // Verificación
  "asi esta bien", "asi esta correcto", "asi lo quiero", "asi es",
  "esta bien asi", "esta correcto", "esta bien", "es correcto",
  "es correcta", "todo esta bien", "todo esta correcto",
  // Datos / información
  "los datos estan correctos", "los datos estan bien", "datos correctos",
  "la informacion esta correcta", "la informacion esta bien",
  "informacion correcta", "informacion ok",
  // Acción
  "envialo", "despachalo", "mandalo", "envienlo", "despachenlo",
  "envien", "despachen", "manden",
  // Mixtas
  "dale todo esta bien", "si todo esta correcto", "si todo bien",
  "todo esta perfecto", "esta todo bien", "esta todo correcto"
]);

// Patrones (regex) que detectan confirmación dentro de mensajes más largos.
// Aplican cuando el mensaje NO matchea exact pero tiene una frase clave.
// Ejemplos: "hola, todo está correcto gracias", "Sí los datos están bien"
const CONFIRMATION_PATTERNS: RegExp[] = [
  /\btodo\s+(esta|esta|es|sale)?\s*(perfecto|correcto|bien|ok|en orden|listo)\b/,
  /\b(los\s+)?datos\s+(estan|son|estan)?\s*(correctos|bien|ok|perfectos|exactos|completos)\b/,
  /\b(la\s+)?(informacion|info|direccion)\s+(esta|es)?\s*(correcta|bien|ok|perfecta|exacta|completa)\b/,
  /\b(envienmelo|mandenmelo|despachenmelo|envienlo|despachenlo|mandenlo)\b/,
  /\b(esta|es)\s+todo\s+(bien|correcto|ok|perfecto)\b/,
  /\bya\s+(puedes|pueden|podes|podeis)\s+(enviar|despachar|mandar)\b/,
  /\b(quedo|estoy)\s+esperando\s+(el\s+)?(envio|pedido|paquete)\b/,
  /\b(quedo|me\s+quedo)\s+atenta?\s+(a\s+)?la?\s+(guia|envio)\b/
];

// Frases que indican EXPLICITAMENTE que algo NO está bien.
// Si matchean, NO se trata como confirmación aunque también haya keyword positivo.
const NEGATIVE_PATTERNS: RegExp[] = [
  /\b(no|nope|nah)\s+(esta|es)\s+(correcto|bien|ok|cierto)\b/,
  /\bno\s+confirmo\b/,
  /\bcambiar?\b/,                       // "quiero cambiar"
  /\bmodific(ar|a|o)\b/,                // "modificar"
  /\bcorrij(an|e|o)\b/,                 // "corrijan"
  /\bequivoca(do|da|don)\b/,            // "está equivocado"
  /\b(mal|incorrect[oa])\b/,            // "está mal", "es incorrecto"
  /\b(actualizar?|actualizen)\b/,
  /\bcancelar?\b/                       // "quiero cancelar"
];

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
 * Devuelve true si el texto se interpreta como confirmación final de pedido.
 *
 * Tres pasos:
 *   1. Si matchea una expresión NEGATIVA (cancelar, cambiar, no es correcto)
 *      → false, sin importar si también hay keyword positivo.
 *   2. Si el mensaje normalizado matchea EXACT con una frase corta de la lista
 *      → true.
 *   3. Si el mensaje matchea cualquiera de los PATTERNS regex → true.
 *
 * "sí" solo, "perfecto" solo, etc. SÍ activan ahora porque la gente
 * confirma así. Si esto causa falsos positivos, ajustar removiendo keywords
 * del set EXACT.
 */
export function isConfirmationMessage(text: string): boolean {
  const norm = normalize(text);
  if (!norm) return false;

  // 1) Bloqueo por intención negativa explícita
  for (const neg of NEGATIVE_PATTERNS) {
    if (neg.test(norm)) return false;
  }

  // 2) Match exacto
  if (CONFIRMATION_EXACT.has(norm)) return true;

  // 3) Match por patrón dentro de mensaje más largo
  for (const re of CONFIRMATION_PATTERNS) {
    if (re.test(norm)) return true;
  }

  return false;
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
