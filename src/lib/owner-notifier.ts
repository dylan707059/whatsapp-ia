import type { WASocket } from "@whiskeysockets/baileys";
import type { OrderData } from "./types";
import { setOwnerNotifiedAt, getOrCreateConversation, insertMessage, getAccountByOwnerPhone, getAccountSettings } from "./db";
import { getActiveOrder, setOrderOwnerNotifiedAt } from "./orders";
import { registerBotMessage } from "./bot-messages";
import { enqueueOrderTask } from "./queue";
import { insertOrderEvent } from "./order-events";

// ─── Utilidades ───────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Teléfonos a notificar para la cuenta cuyo WhatsApp conectado es `ownerPhone`.
 * Usa la config guardada de esa cuenta; cae a la variable de entorno global.
 */
export function getOwnerNotifyPhones(ownerPhone: string): string[] {
  let raw = "";
  if (ownerPhone) {
    const acc = getAccountByOwnerPhone(ownerPhone);
    if (acc) {
      const s = getAccountSettings(acc.id);
      if (s?.owner_notify_phones?.trim()) raw = s.owner_notify_phones.trim();
    }
  }
  if (!raw) raw = process.env.OWNER_NOTIFY_PHONES ?? "";
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((p) => p.trim().replace(/[\s\-+]/g, ""))
    .filter(Boolean);
}

// ─── Formato de mensajes ──────────────────────────────────────────────────────

function buildSummaryMessage(data: OrderData, orderId?: number): string {
  const id = orderId ?? data.conversationId;
  return [
    "*NUEVO PEDIDO CONFIRMADO*",
    "",
    `*ID:* #${id}`,
    `*Cliente:* ${data.fullName}`,
    `*Teléfono:* ${data.phone}`,
    "",
    `*Producto:* ${data.product}`,
    `*Color:* ${data.color}`,
    `*Talla:* ${data.size}`,
    `*Cantidad:* ${data.quantity}`,
    "",
    `*Total:* ${data.total}`,
    `*Pago:* ${data.payment}`,
    `*Envío:* ${data.shipping}`,
    "",
    `*Dirección:* ${data.address}`,
    `*Ciudad:* ${data.city}`,
    `*Departamento:* ${data.department}`,
    "",
    "*Estado:* Listo para despachar"
  ].join("\n");
}

function buildCopyMessage(data: OrderData, orderId?: number): string {
  const id = orderId ?? data.conversationId;
  return [
    "*DATOS LISTOS PARA COPIAR*",
    `*ID:* #${id}`,
    "",
    "```",
    data.fullName,
    data.phone,
    data.product,
    data.color,
    data.size,
    data.quantity,
    data.total,
    data.payment,
    data.shipping,
    data.address,
    data.city,
    data.department,
    "```"
  ].join("\n");
}

// ─── Cola unificada ───────────────────────────────────────────────────────────
// Redirige a la cola global FIFO para no mezclar con las confirmaciones.

export function enqueueOwnerNotification(
  sock: WASocket,
  data: OrderData
): void {
  const snapshot = { ...data };
  enqueueOrderTask(
    `notificacion:${data.conversationId}`,
    async () => {
      await sendOwnerNotificationSequentially(sock, snapshot);
    }
  );
}

// ─── Envío secuencial ─────────────────────────────────────────────────────────
// Llamar directamente cuando ya se está dentro de la cola global
// para no crear un nivel de anidamiento que bloquee la cola.

export async function sendOwnerNotificationSequentially(
  sock: WASocket,
  data: OrderData
): Promise<void> {
  // Double-check anti-duplicado — protege contra race conditions
  const activeOrder = getActiveOrder(data.conversationId);

  if (activeOrder?.owner_notified_at) {
    console.log(`[bot] Pedido ${data.conversationId} ya había sido notificado, no se duplica`);
    return;
  }

  // El número conectado de la cuenta dueña (para resolver SUS teléfonos de aviso).
  const botOwnerPhone = (sock.user?.id ?? "").split(":")[0] ?? "";
  const phones = getOwnerNotifyPhones(botOwnerPhone);

  if (phones.length === 0) {
    console.warn("[bot] Sin teléfonos de aviso configurados — no se envía notificación interna");
    return;
  }

  const orderId = activeOrder?.id;
  console.log(`[bot] Enviando notificación interna del pedido ${orderId ?? data.conversationId}`);

  insertOrderEvent({
    orderId,
    conversationId: data.conversationId,
    eventType: "OWNER_NOTIFICATION_STARTED",
    message: "Iniciando notificación a owners",
    metadata: { phones, phone: data.phone }
  });

  const summary = buildSummaryMessage(data, orderId);
  const copy    = buildCopyMessage(data, orderId);

  for (const phone of phones) {
    const jid = `${phone}@s.whatsapp.net`;

    try {
      const r1 = await sock.sendMessage(jid, { text: summary });
      if (r1?.key?.id) registerBotMessage(r1.key.id);
      await sleep(1200);

      const r2 = await sock.sendMessage(jid, { text: copy });
      if (r2?.key?.id) registerBotMessage(r2.key.id);
      await sleep(1200);

      // Guardar también las notificaciones en la conversación del owner
      // dentro del dashboard, para que el usuario pueda ver lo que se envió.
      try {
        const ownerConv = getOrCreateConversation(jid, `Owner +${phone}`, botOwnerPhone);
        insertMessage(ownerConv.id, "assistant", summary);
        insertMessage(ownerConv.id, "assistant", copy);
      } catch (err) {
        console.warn(`[bot] No se pudo guardar notif en conv del owner ${phone}:`, err);
      }

      console.log(`[bot] Notificación del pedido ${orderId ?? data.conversationId} enviada a ${phone}`);
    } catch (err) {
      console.error(`[bot] Error enviando pedido ${orderId ?? data.conversationId} a ${phone}:`, err);
      insertOrderEvent({
        orderId,
        conversationId: data.conversationId,
        eventType: "OWNER_NOTIFICATION_ERROR",
        message: `Error notificando a ${phone}`,
        metadata: { error: String(err) }
      });
    }
  }

  setOwnerNotifiedAt(data.conversationId);
  if (activeOrder) setOrderOwnerNotifiedAt(activeOrder.id);

  insertOrderEvent({
    orderId,
    conversationId: data.conversationId,
    eventType: "OWNER_NOTIFIED",
    message: "Owners notificados correctamente",
    metadata: { phones, phone: data.phone }
  });
  console.log(`[bot] Pedido ${orderId ?? data.conversationId} notificado correctamente`);
}
