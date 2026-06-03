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

  const shippingLineTitle = payload.shipping_lines?.[0]?.title ?? "";
  const shippingPrice = Number(payload.shipping_lines?.[0]?.price ?? "0");
  const shippingLabel = shippingPrice === 0 ? "Gratis" : shippingLineTitle || `$${shippingPrice}`;

  const items = (payload.line_items ?? []).map((li) => ({
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
    currency,
    totalPrice,
    isCOD,
    shippingLabel,
    items
  };
}

// ─── Adapter a OrderData (formato interno del proyecto) ───────────────────────

export function toOrderData(parsed: ParsedShopifyOrder, conversationId: number): OrderData {
  // Usamos el primer line item como producto principal.
  // Si hay varios, lo registramos así igual; el mensaje al cliente sí los lista todos.
  const first = parsed.items[0];
  const variantParts = (first?.variantTitle ?? "").split("/").map(s => s.trim()).filter(Boolean);
  const color = variantParts[0] ?? "";
  const size  = variantParts[1] ?? "";

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

// ─── Mensaje de confirmación al cliente (formato exacto solicitado) ───────────

export function buildConfirmationMessage(parsed: ParsedShopifyOrder): string {
  const total = formatCurrency(parsed.totalPrice, parsed.currency);
  const phoneDisplay = formatPhoneForDisplay(parsed.rawPhone);

  const itemsBlock = parsed.items
    .map((it, idx) => {
      const variantParts = (it.variantTitle ?? "")
        .split("/")
        .map(s => s.trim())
        .filter(Boolean);
      const color = variantParts[0] ?? "";
      const size  = variantParts[1] ?? "";

      const lines = [
        `🛍️ Producto ${idx + 1}: ${it.title}`,
        color ? `🎨 Color: ${color}` : null,
        size  ? `📏 Talla: ${size}` : null,
        `🔢 Cantidad: ${it.quantity} unidad${it.quantity === 1 ? "" : "es"}`
      ].filter(Boolean);

      return lines.join("\n");
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
    "",
    "Si todo está correcto responde *CONFIRMADO* para despachar tu pedido. Si deseas cambiar algo, escríbenos y te ayudamos de inmediato 😊"
  ].join("\n");
}

// ─── Helpers de formato ───────────────────────────────────────────────────────

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
