import { NextRequest, NextResponse } from "next/server";
import {
  getConnectionState,
  getOrCreateConversation,
  enqueueOutbox,
  insertMessage,
  setConversationMode
} from "@/lib/db";
import { upsertOrder, computeOrderHash, findOrderByHash } from "@/lib/orders";
import { normalizePhone, phoneToJid } from "@/lib/phone-utils";
import {
  verifyShopifyHmac,
  parseShopifyOrder,
  toOrderData,
  buildConfirmationMessage,
  type ShopifyOrderPayload
} from "@/lib/shopify";
import {
  isBlockedZone,
  buildRejectionMessage,
  isOfficeAddress,
  buildOfficeRejectionMessage
} from "@/lib/colombia-zones";
import { insertOrderEvent } from "@/lib/order-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ─── 1. Leer body crudo (necesario para validar HMAC) ──────────────────────
  const rawBody = Buffer.from(await req.arrayBuffer());
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  // ─── 2. Validar firma HMAC ────────────────────────────────────────────────
  if (!verifyShopifyHmac(rawBody, hmac, secret)) {
    console.warn("[shopify] HMAC inválido — webhook rechazado");
    return NextResponse.json({ error: "invalid hmac" }, { status: 401 });
  }

  // ─── 3. Parsear el payload ─────────────────────────────────────────────────
  let payload: ShopifyOrderPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as ShopifyOrderPayload;
  } catch (err) {
    console.error("[shopify] JSON inválido en webhook", err);
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = parseShopifyOrder(payload);

  if (!parsed.rawPhone) {
    console.warn(`[shopify] Pedido ${parsed.orderNumber} sin teléfono — se ignora`);
    return NextResponse.json({ ok: true, skipped: "no_phone" });
  }

  // ─── 4. Verificar que haya un bot conectado ────────────────────────────────
  const conn = getConnectionState();
  const ownerPhone = conn.phone ?? "";
  if (conn.status !== "connected" || !ownerPhone) {
    console.warn(
      `[shopify] Pedido ${parsed.orderNumber} recibido pero el bot no está conectado. ` +
      "El mensaje quedará encolado en outbox y se enviará al reconectar."
    );
    // No retornamos error: igual encolamos para que se envíe al reconectar.
  }

  // ─── 5. Crear/obtener conversación del cliente ────────────────────────────
  const customerJid = phoneToJid(parsed.rawPhone);
  const conv = getOrCreateConversation(customerJid, parsed.fullName, ownerPhone);

  // Pasar a modo HUMAN para que la IA no responda automáticamente al cliente.
  // El owner puede toggle a AI manualmente desde el dashboard si quiere.
  setConversationMode(conv.id, "HUMAN");

  const orderData = toOrderData(parsed, conv.id);

  // ─── 6. Rechazo de zonas no cubiertas ─────────────────────────────────────
  // Si el departamento o ciudad están en la blacklist (San Andrés, Amazonas,
  // Vaupés, Guainía, Vichada por default), creamos el pedido directamente
  // como CANCELLED y enviamos un mensaje amable con alternativa al cliente.
  const zoneCheck = isBlockedZone(orderData.city, orderData.department);
  if (zoneCheck.blocked) {
    const orderId = upsertOrder(conv.id, orderData, "CANCELLED", "SHOPIFY");
    const zoneLabel = zoneCheck.matchedDepartment ?? zoneCheck.matchedCity ?? "tu zona";
    const rejectionText = buildRejectionMessage(parsed.firstName, parsed.orderNumber, zoneLabel);

    insertOrderEvent({
      orderId,
      conversationId: conv.id,
      eventType: "SHOPIFY_ORDER_REJECTED_BLOCKED_ZONE",
      message: `Pedido ${parsed.orderNumber} rechazado: ${zoneCheck.reason}`,
      metadata: {
        shopifyOrderId: parsed.orderId,
        shopifyOrderNumber: parsed.orderNumber,
        matchedDepartment: zoneCheck.matchedDepartment,
        matchedCity: zoneCheck.matchedCity,
        city: orderData.city,
        department: orderData.department
      }
    });

    // Respetar mismo delay anti-bloqueo que las confirmaciones normales
    const delaySec = Number(process.env.SHOPIFY_CONFIRMATION_DELAY_SECONDS ?? 180);
    const scheduledAt = Math.floor(Date.now() / 1000) + (Number.isFinite(delaySec) ? delaySec : 180);

    insertMessage(conv.id, "assistant", rejectionText);
    enqueueOutbox(conv.id, conv.phone, rejectionText, scheduledAt);

    console.log(
      `[shopify] Pedido ${parsed.orderNumber} RECHAZADO por zona no cubierta (${zoneLabel}) — ` +
      `conv #${conv.id} (${normalizePhone(parsed.rawPhone)}) — order #${orderId} CANCELLED`
    );

    return NextResponse.json({
      ok: true,
      skipped: "blocked_zone",
      reason: zoneCheck.reason,
      orderId,
      conversationId: conv.id
    });
  }

  // ─── 6b. Rechazo de envíos a oficinas ─────────────────────────────────────
  // No despachamos a oficinas de transportadoras ni puntos de retiro.
  // Mismo flujo que zonas bloqueadas: order CANCELLED + mensaje pidiendo
  // dirección residencial alternativa.
  if (isOfficeAddress(orderData.address)) {
    const orderId = upsertOrder(conv.id, orderData, "CANCELLED", "SHOPIFY");
    const rejectionText = buildOfficeRejectionMessage(
      parsed.firstName, parsed.orderNumber, orderData.address
    );

    insertOrderEvent({
      orderId,
      conversationId: conv.id,
      eventType: "SHOPIFY_ORDER_REJECTED_BLOCKED_ZONE",
      message: `Pedido ${parsed.orderNumber} rechazado: dirección es oficina`,
      metadata: {
        shopifyOrderId: parsed.orderId,
        shopifyOrderNumber: parsed.orderNumber,
        reason: "office_address",
        address: orderData.address
      }
    });

    const delaySec = Number(process.env.SHOPIFY_CONFIRMATION_DELAY_SECONDS ?? 180);
    const scheduledAt = Math.floor(Date.now() / 1000) + (Number.isFinite(delaySec) ? delaySec : 180);

    insertMessage(conv.id, "assistant", rejectionText);
    enqueueOutbox(conv.id, conv.phone, rejectionText, scheduledAt);

    console.log(
      `[shopify] Pedido ${parsed.orderNumber} RECHAZADO por dirección de oficina ` +
      `("${orderData.address}") — conv #${conv.id} — order #${orderId} CANCELLED`
    );

    return NextResponse.json({
      ok: true,
      skipped: "office_address",
      address: orderData.address,
      orderId,
      conversationId: conv.id
    });
  }

  // ─── 7. Anti-duplicado por hash del pedido ────────────────────────────────
  const hash = computeOrderHash({
    phone:      orderData.phone,
    product:    orderData.product,
    color:      orderData.color,
    size:       orderData.size,
    quantity:   orderData.quantity,
    total:      orderData.total,
    address:    orderData.address,
    city:       orderData.city,
    department: orderData.department
  });

  const duplicate = findOrderByHash(hash);
  if (duplicate) {
    insertOrderEvent({
      orderId: duplicate.id,
      conversationId: conv.id,
      eventType: "SHOPIFY_ORDER_DUPLICATE",
      message: `Webhook duplicado para pedido ${parsed.orderNumber} (hash ${hash})`,
      metadata: { shopifyOrderId: parsed.orderId, shopifyOrderNumber: parsed.orderNumber }
    });
    console.log(
      `[shopify] Pedido ${parsed.orderNumber} duplicado (hash ${hash}) — ` +
      `ya existe order #${duplicate.id}, se ignora reenvío`
    );
    return NextResponse.json({ ok: true, skipped: "duplicate", orderId: duplicate.id });
  }

  // ─── 7. Crear el pedido en SQLite ──────────────────────────────────────────
  const orderId = upsertOrder(conv.id, orderData, "PENDING_CONFIRMATION", "SHOPIFY");

  insertOrderEvent({
    orderId,
    conversationId: conv.id,
    eventType: "SHOPIFY_ORDER_RECEIVED",
    message: `Pedido ${parsed.orderNumber} recibido desde Shopify`,
    metadata: {
      shopifyOrderId: parsed.orderId,
      shopifyOrderNumber: parsed.orderNumber,
      total: parsed.totalPrice,
      currency: parsed.currency,
      itemsCount: parsed.items.length
    }
  });

  // ─── 8. Encolar el mensaje de confirmación con delay anti-bloqueo ──────────
  // Releasit pide al cliente que escriba primero a WhatsApp. Si no escribe en
  // SHOPIFY_CONFIRMATION_DELAY_SECONDS (default 180s = 3 min), enviamos igual.
  // El handler de mensajes entrantes adelanta este envío si el cliente escribe
  // antes (vía advancePendingOutbox).
  const delaySec = Number(process.env.SHOPIFY_CONFIRMATION_DELAY_SECONDS ?? 180);
  const scheduledAt = Math.floor(Date.now() / 1000) + (Number.isFinite(delaySec) ? delaySec : 180);

  const message = buildConfirmationMessage(parsed);
  // Mismo patrón que el POST de mensajes humanos: insertamos en messages al
  // encolar (para que aparezca en el dashboard) y dejamos outbox como cola de
  // envío real. El outbox respeta scheduled_at — solo dispara cuando llega
  // el momento, o cuando el handler entrante lo adelanta.
  insertMessage(conv.id, "assistant", message);
  enqueueOutbox(conv.id, conv.phone, message, scheduledAt);

  console.log(
    `[shopify] Pedido ${parsed.orderNumber} → conv #${conv.id} (${normalizePhone(parsed.rawPhone)}) — ` +
    `mensaje programado para ${new Date(scheduledAt * 1000).toISOString()} ` +
    `(delay ${delaySec}s; se adelanta si cliente escribe primero)`
  );

  return NextResponse.json({
    ok: true,
    conversationId: conv.id,
    orderId,
    customerPhone: normalizePhone(parsed.rawPhone),
    scheduledAt
  });
}
