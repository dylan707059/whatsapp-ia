import crypto from "node:crypto";
import type { OrderData } from "./types";

// ─── Validación HMAC del webhook de Shopify ────────────────────────────────────
// Shopify firma cada webhook con HMAC-SHA256 usando el "Webhook signing secret"
// que se muestra en Settings → Notifications → Webhooks.

export function verifyShopifyHmac(
  rawBody: Buffer,
  hmacHeader: string | null,
  secret: string | undefined
): boolean {
  if (!hmacHeader || !secret) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

// ─── Tipos mínimos del payload de Shopify que usamos ──────────────────────────
// (Shopify manda muchísimo más en el payload; aquí solo tipamos lo necesario.)

interface ShopifyAddress {
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  province_code?: string | null;
  country?: string | null;
  zip?: string | null;
}

interface ShopifyCustomer {
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email?: string | null;
}

interface ShopifyLineItem {
  title: string;
  quantity: number;
  variant_title?: string | null;
  price?: string | null;
}

export interface ShopifyOrderPayload {
  id: number;
  order_number?: number;
  name?: string;                       // ej: "#1331"
  currency?: string;
  total_price?: string;
  financial_status?: string | null;    // "paid" | "pending" | etc
  gateway?: string | null;
  customer?: ShopifyCustomer | null;
  shipping_address?: ShopifyAddress | null;
  billing_address?: ShopifyAddress | null;
  line_items?: ShopifyLineItem[];
  shipping_lines?: Array<{ title?: string | null; price?: string | null }>;
}

// ─── Datos parseados listos para usar ─────────────────────────────────────────

export interface ParsedShopifyOrder {
  orderNumber: string;             // "#1331"
  orderId: number;
  firstName: string;
  lastName: string;
  fullName: string;
  rawPhone: string;                // teléfono tal como vino de Shopify
  address: string;
  city: string;
  department: string;              // province
  departmentCode: string;          // province_code (ej: "VAU", "SAP") — Shopify a veces solo manda esto
  currency: string;
  totalPrice: string;              // ej: "169900.00"
  isCOD: boolean;
  shippingLabel: string;           // "Gratis" / "$15.000" / etc
  items: Array<{
    title: string;
    variantTitle: string;
    quantity: number;
  }>;
}

export function parseShopifyOrder(payload: ShopifyOrderPayload): ParsedShopifyOrder {
  const customer = payload.customer ?? {};
  const ship     = payload.shipping_address ?? {};
  const bill     = payload.billing_address ?? {};

  const firstName = customer.first_name || ship.first_name || bill.first_name || "";
  const lastName  = customer.last_name  || ship.last_name  || bill.last_name  || "";
  const fullName  = [firstName, lastName].filter(Boolean).join(" ").trim() || "cliente";

  const rawPhone = (customer.phone || ship.phone || bill.phone || "").trim();

  const address  = [ship.address1, ship.address2].filter(Boolean).join(", ").trim()
                 || [bill.address1, bill.address2].filter(Boolean).join(", ").trim();
  const city     = (ship.city || bill.city || "").trim();
  const department = (ship.province || bill.province || "").trim();
  const departmentCode = (ship.province_code || bill.province_code || "").trim();

  const orderNumber = payload.name || (payload.order_number ? `#${payload.order_number}` : `#${payload.id}`);
  const currency = payload.currency || "COP";
  const totalPrice = payload.total_price || "0";

  const gateway = (payload.gateway || "").toLowerCase();
  const isCOD =
    payload.financial_status === "pending" ||
    gateway.includes("cash on delivery") ||
    gateway.includes("contra entrega") ||
    gateway.includes("contraentrega") ||
    gateway.includes("cod");

  // Algunos merchants agregan el envío como line_item en vez de shipping_line.
  // Los separamos para no mostrarlos como producto en el mensaje al cliente.
  const SHIPPING_KEYWORDS = /envio|envío|shipping|flete|domicilio|courier|despacho/i;
  const productItems = (payload.line_items ?? []).filter(
    (li) => !SHIPPING_KEYWORDS.test(li.title)
  );
  const shippingLineItem = (payload.line_items ?? []).find(
    (li) => SHIPPING_KEYWORDS.test(li.title)
  );

  const shippingLineTitle = payload.shipping_lines?.[0]?.title ?? "";
  const shippingPrice = Number(payload.shipping_lines?.[0]?.price ?? "0");
  // Si el envío viene como line_item, usarlo como label de envío
  const shippingLabel =
    shippingPrice > 0
      ? shippingLineTitle || formatCurrencySimple(shippingPrice)
      : shippingLineItem
        ? `${shippingLineItem.title} · ${formatCurrencySimple(Number(shippingLineItem.price ?? "0"))}`
        : "Gratis";

  const items = productItems.map((li) => ({
    title: li.title,
    variantTitle: li.variant_title ?? "",
    quantity: li.quantity ?? 1
  }));

  return {
    orderNumber,
    orderId: payload.id,
    firstName,
    lastName,
    fullName,
    rawPhone,
    address,
    city,
    department,
    departmentCode,
    currency,
    totalPrice,
    isCOD,
    shippingLabel,
    items
  };
}

// ─── Parsing de variantes de Shopify ──────────────────────────────────────────
// Reglas según convención de Eclipse:
//   - 2 partes "Color / Talla"        → ropa común (S, M, L, XL)
//   - 3 partes "Color / Top / Pant"   → SET de 3 piezas:
//       - Top   = letra (S, M, L, XL) — talla del body/top
//       - Pant  = número (4, 6, 8, 10, 12, 14) — talla del pantalón
//   - Si la 3era parte NO es numérica, se concatena con la 2da por seguridad

export interface ParsedVariant {
  color: string;
  topSize: string;    // talla superior (M, L, etc.) o única si no es set
  pantSize: string;   // talla pantalón si es set, "" sino
  isSet: boolean;     // true si tiene 3 partes y la 3era es numérica
  rawDisplay: string; // representación legible para el campo `size` de OrderData
}

const NUMERIC_PANT_SIZE = /^\d{1,2}$/;

export function parseVariantTitle(variantTitle: string | null | undefined): ParsedVariant {
  const parts = (variantTitle || "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length >= 3) {
    const color    = parts[0];
    const topSize  = parts[1];
    const pantSize = parts[2];
    const isSet = NUMERIC_PANT_SIZE.test(pantSize);
    if (isSet) {
      return {
        color,
        topSize,
        pantSize,
        isSet: true,
        rawDisplay: `Top ${topSize} · Pant ${pantSize}`
      };
    }
    // 3+ partes pero la última no es número: la unimos por seguridad
    return {
      color,
      topSize: parts.slice(1).join(" / "),
      pantSize: "",
      isSet: false,
      rawDisplay: parts.slice(1).join(" / ")
    };
  }
  if (parts.length === 2) {
    return {
      color: parts[0],
      topSize: parts[1],
      pantSize: "",
      isSet: false,
      rawDisplay: parts[1]
    };
  }
  if (parts.length === 1) {
    // Una sola parte: capaz es talla o capaz color, asumimos talla
    return {
      color: "",
      topSize: parts[0],
      pantSize: "",
      isSet: false,
      rawDisplay: parts[0]
    };
  }
  return { color: "", topSize: "", pantSize: "", isSet: false, rawDisplay: "" };
}

// ─── Adapter a OrderData (formato interno del proyecto) ───────────────────────

export function toOrderData(parsed: ParsedShopifyOrder, conversationId: number): OrderData {
  // Usamos el primer line item como producto principal.
  // Si hay varios, lo registramos así igual; el mensaje al cliente sí los lista todos.
  const first = parsed.items[0];
  const variant = parseVariantTitle(first?.variantTitle);

  // validateOrderData requiere color y size no vacíos para notificar al owner.
  // Si el producto no tiene variantes, usamos "—" como placeholder en vez de
  // dejar vacío (lo cual bloquearía la notificación).
  const color = variant.color || "—";
  const size  = variant.rawDisplay || "—";

  return {
    conversationId,
    fullName:   parsed.fullName,
    firstName:  parsed.firstName,
    lastName:   parsed.lastName,
    phone:      parsed.rawPhone,
    product:    first?.title ?? "",
    color,
    size,
    quantity:   String(first?.quantity ?? 1),
    total:      formatCurrency(parsed.totalPrice, parsed.currency),
    payment:    parsed.isCOD ? "Sí, pagas al recibir" : "Pagado online",
    shipping:   parsed.shippingLabel,
    address:    parsed.address,
    city:       parsed.city,
    department: parsed.department
  };
}

// ─── Validación de dirección colombiana ──────────────────────────────────────
// Una dirección válida debe tener:
//   (a) una nomenclatura conocida (calle, carrera, avenida, diagonal,
//       transversal, kilómetro, autopista, vereda, manzana, etc.) o su
//       abreviatura (cl, cll, cr, cra, krr, av, dg, tv, mz)
//   (b) al menos un número de cuadra/casa
// Si solo viene un nombre tipo "Las Palmas" o "Casa azul cerca al parque",
// devolvemos false para que el bot pida la dirección completa.

const ADDRESS_KEYWORDS = [
  // Vías principales
  "calle", "cll", "cl",
  "carrera", "cra", "cr", "krr", "kr", "k",
  "avenida", "av", "avda",
  "diagonal", "dg", "diag",
  "transversal", "tv", "trans",
  "circular", "circ",
  "autopista", "auto",
  "via", "vía",
  "anillo",
  // Vías rurales / especiales
  "kilometro", "kilómetro", "kilometro", "km",
  "vereda",
  "corregimiento",
  "finca",
  "lote",
  // Unidades / sectores
  "manzana", "mz", "mza",
  "torre", "tr", "trre",
  "bloque", "bl", "blq",
  "casa",
  "apartamento", "apto", "apt",
  "interior", "int",
  "edificio", "ed", "edif",
  "conjunto", "cj",
  "unidad", "und",
  "etapa"
];

export function isValidColombianAddress(rawAddress: string): boolean {
  const addr = (rawAddress || "").toLowerCase().trim();
  if (addr.length < 6) return false;

  // (a) Debe contener al menos una palabra clave de nomenclatura
  const hasKeyword = ADDRESS_KEYWORDS.some((kw) => {
    const pattern = new RegExp(`(^|[\\s.,#-])${kw}([\\s.,#-]|$)`, "i");
    return pattern.test(addr);
  });
  if (!hasKeyword) return false;

  // (b) Debe contener al menos un número
  const hasNumber = /\d/.test(addr);
  if (!hasNumber) return false;

  return true;
}

// ─── Mensaje de confirmación al cliente (formato exacto solicitado) ───────────

export function buildConfirmationMessage(parsed: ParsedShopifyOrder): string {
  const total = formatCurrency(parsed.totalPrice, parsed.currency);
  const phoneDisplay = formatPhoneForDisplay(parsed.rawPhone);
  const addressIsValid = isValidColombianAddress(parsed.address);

  const itemsBlock = parsed.items
    .map((it, idx) => {
      const variant = parseVariantTitle(it.variantTitle);

      const lines: (string | null)[] = [
        `🛍️ Producto ${idx + 1}: ${it.title}`,
        variant.color ? `🎨 Color: ${variant.color}` : null
      ];

      if (variant.isSet) {
        // Set de 3 piezas → mostrar AMBAS tallas separadas
        lines.push(`📏 Talla body/top: ${variant.topSize}`);
        lines.push(`📐 Talla pantalón: ${variant.pantSize}`);
      } else if (variant.topSize) {
        lines.push(`📏 Talla: ${variant.topSize}`);
      }

      lines.push(`🔢 Cantidad: ${it.quantity} unidad${it.quantity === 1 ? "" : "es"}`);

      return lines.filter(Boolean).join("\n");
    })
    .join("\n\n");

  const paymentLine = parsed.isCOD
    ? "💳 Pago contraentrega: Sí, pagas al recibir"
    : "💳 Pago: Pagado online";

  return [
    `Hola ${parsed.firstName || "amig@"}, buen día 😊`,
    "",
    "Te escribimos para confirmar los datos de tu pedido antes de enviarlo. Por favor revisa que todo esté correcto:",
    "",
    `🧾 Pedido: ${parsed.orderNumber}`,
    "",
    itemsBlock,
    "",
    `🚚 Envío: ${parsed.shippingLabel}`,
    `💵 Total a pagar: ${total}`,
    paymentLine,
    "",
    `👤 Nombre: ${parsed.firstName || ""}`,
    `👤 Apellido: ${parsed.lastName || ""}`,
    `📱 Teléfono: ${phoneDisplay}`,
    `📍 Dirección: ${parsed.address || "(sin dirección)"}`,
    `🏙️ Ciudad: ${parsed.city || ""}`,
    `📌 Departamento: ${parsed.department || ""}`,
    "",
    `Por favor revisa muy bien que el teléfono ${phoneDisplay} y la dirección completa estén correctamente escritos para evitar novedades con la transportadora.`,
    ...(addressIsValid ? [] : [
      "",
      "⚠️ *Importante:* Tu dirección no parece estar completa. Por favor envíanos la dirección con nomenclatura completa (Calle, Carrera, Avenida, Diagonal, Transversal, Kilómetro, etc.) seguida del número de la cuadra y casa. Ejemplo: *Calle 23 # 10-69* o *Carrera 45 # 12-34 Apto 301*."
    ]),
    "",
    "Si todo está correcto responde *CONFIRMADO* para despachar tu pedido. Si deseas cambiar algo, escríbenos y te ayudamos de inmediato 😊"
  ].join("\n");
}

// ─── Helpers de formato ───────────────────────────────────────────────────────

function formatCurrencySimple(amount: number): string {
  return `$${amount.toLocaleString("es-CO", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatCurrency(amount: string, currency: string): string {
  const num = Number(amount);
  if (!Number.isFinite(num)) return `${currency} ${amount}`;

  // Formato colombiano: $169.900  (sin decimales si son enteros)
  const hasDecimals = num % 1 !== 0;
  const formatted = num
    .toLocaleString("es-CO", {
      minimumFractionDigits: hasDecimals ? 2 : 0,
      maximumFractionDigits: 2
    });

  return currency === "COP" ? `$${formatted}` : `${currency} ${formatted}`;
}

function formatPhoneForDisplay(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  // Si viene con prefijo 57, lo quitamos y formateamos como "314 329 2204"
  const local = digits.startsWith("57") && digits.length === 12
    ? digits.slice(2)
    : digits;
  if (local.length === 10) {
    return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
  }
  return raw || "";
}
