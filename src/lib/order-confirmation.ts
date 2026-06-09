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

// Palabras "positivas" sueltas que cuentan como confirmación dentro de
// mensajes cortos (≤ 8 palabras). Ej: "si claro gracias", "ok mami",
// "listo dale", "perfecto entonces", "esta bien si".
// Solo aplica cuando NO hay patrones negativos (cambiar, cancelar, mal, etc.)
const POSITIVE_KEYWORDS = [
  "confirmado", "confirmo", "confirmar",
  "perfecto", "perfecta", "excelente", "genial", "buenisimo", "buenisima",
  "listo", "lista", "correcto", "correcta", "exacto", "exacta",
  "vale", "dale", "claro", "bueno", "buena",
  "ok", "okay", "okey", "okas", "oka",
  "si",                // Cuidado: solo dispara en mensajes <= 8 palabras
  "yes", "sip", "sipo",
  "envien", "envialo", "manden", "mandalo", "despachen", "despachalo"
];

const POSITIVE_RE = new RegExp(`\\b(${POSITIVE_KEYWORDS.join("|")})\\b`);

// ─── Tolerancia a errores de tipeo en "confirmado" ───────────────────────────
// La gente escribe rápido y manda "corfimado", "comfirmado", "confirmd", etc.
// Sin esto, esos typos NO se detectaban como confirmación y se "moría" el flujo.

// Distancia de edición (Levenshtein), acotada para ser barata.
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

const CONFIRM_ROOTS = ["confirmado", "confirmo", "confirmar", "confirma", "confirmacion", "confirmando"];

// True si una palabra es "confirmado" mal escrito. Exige empezar con 'c' y
// largo ≥6 para no confundir con palabras parecidas (ej: "informado").
function looksLikeConfirmWord(word: string): boolean {
  if (word.length < 6 || word[0] !== "c") return false;
  for (const root of CONFIRM_ROOTS) {
    const tol = root.length >= 9 ? 3 : 2;
    if (editDistance(word, root) <= tol) return true;
  }
  return false;
}

/**
 * Devuelve true si el texto se interpreta como confirmación final de pedido.
 *
 * Capas (cortocircuito en orden):
 *   1. NEGATIVE_PATTERNS → false (cancelar, cambiar, mal, no esta correcto, etc.)
 *   2. CONFIRMATION_EXACT → true (frase entera matchea)
 *   3. CONFIRMATION_PATTERNS → true (regex compuesto dentro del texto)
 *   4. Heurística suelta: mensaje corto (≤ 8 palabras) que contiene ALGUNA
 *      palabra positiva (si, ok, vale, perfecto, listo, claro, etc.) → true
 *
 * La capa 4 es la más permisiva pero requiere que el mensaje sea CORTO
 * (≤ 8 palabras) para no tomar como confirmación frases largas tipo
 * "perfecto, pero antes quiero cambiar el color".
 */
export function isConfirmationMessage(text: string): boolean {
  const norm = normalize(text);
  if (!norm) return false;

  // 1) Bloqueo por intención negativa explícita (siempre)
  for (const neg of NEGATIVE_PATTERNS) {
    if (neg.test(norm)) return false;
  }

  // 2) Match exacto
  if (CONFIRMATION_EXACT.has(norm)) return true;

  // 3) Match por patrón dentro de mensaje más largo
  for (const re of CONFIRMATION_PATTERNS) {
    if (re.test(norm)) return true;
  }

  // 4) Heurística suelta para mensajes cortos con keyword positivo
  const words = norm.split(/\s+/);
  if (words.length <= 8 && POSITIVE_RE.test(norm)) {
    return true;
  }

  // 5) Tolerancia a errores de tipeo de "confirmado" en mensajes cortos
  //    (ej: "corfimado", "comfirmado", "confirmd"). Evita que un typo mate el flujo.
  if (words.length <= 4 && words.some(looksLikeConfirmWord)) {
    return true;
  }

  return false;
}

/**
 * Clasifica qué tan clara es la confirmación:
 *   - "strong": intención explícita de confirmar/despachar ("confirmado",
 *     "envíalo", "todo correcto"...). Se dispara directo.
 *   - "weak": aceptación ambigua ("ok", "vale", "bueno", "sí", "dale"...). Debe
 *     verificarse con IA + contexto antes de disparar (puede no ser confirmación).
 *   - "none": no es confirmación.
 */
export function confirmationStrength(text: string): "strong" | "weak" | "none" {
  const norm = normalize(text);
  if (!norm) return "none";

  // Intención negativa explícita → nunca confirma
  for (const neg of NEGATIVE_PATTERNS) {
    if (neg.test(norm)) return "none";
  }

  const words = norm.split(/\s+/);

  // ── STRONG: confirmación explícita ──────────────────────────────────────────
  if (/\bconfirm/.test(norm)) return "strong";                       // confirmado/confirmo/...
  if (words.length <= 4 && words.some(looksLikeConfirmWord)) return "strong"; // typos
  if (/\b(envialo|despachalo|mandalo|envienlo|despachenlo|envienmelo|mandenmelo|despachenmelo|mandenlo|despachen|envien|manden)\b/.test(norm)) return "strong";
  for (const re of CONFIRMATION_PATTERNS) {
    if (re.test(norm)) return "strong";                              // "todo correcto", "datos bien"
  }
  if (CONFIRMATION_EXACT.has(norm) &&
      /(correcto|correcta|bien|perfect|exact|asi|datos|informacion|orden)/.test(norm)) {
    return "strong";                                                 // frases de validación de datos
  }

  // ── WEAK: aceptación ambigua (necesita verificación con IA) ──────────────────
  if (CONFIRMATION_EXACT.has(norm)) return "weak";                   // "ok", "vale", "dale", "bueno"...
  if (words.length <= 8 && POSITIVE_RE.test(norm)) return "weak";

  return "none";
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

  // Los emojis varían entre la plantilla de la IA (system-prompt) y la de
  // Shopify (shopify.ts): teléfono 📞/📱, total 💰/💵, talla "Talla"/"Talla body/top".
  // Aceptamos ambas variantes para que el respaldo funcione con cualquiera.
  const nombre    = extractField(t, /👤 Nombre:\s*(.+)/);
  const apellido  = extractField(t, /👤 Apellido:\s*(.+)/);
  const telefono  = extractField(t, /(?:📞|📱) Teléfono:\s*(.+)/);
  const producto  = extractField(t, /🛍️ Producto[^:]*:\s*(.+)/);
  const color     = extractField(t, /🎨 Color:\s*(.+)/);
  const talla     = extractField(t, /📏 Talla[^:]*:\s*(.+)/);
  const cantidad  = extractField(t, /🔢 Cantidad:\s*(.+)/);
  const total     = extractField(t, /(?:💰|💵) Total a pagar:\s*(.+)/);
  const envio     = extractField(t, /🚚 Envío:\s*(.+)/);
  const pago      = extractField(t, /💳 Pago[^:]*:\s*(.+)/);
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
