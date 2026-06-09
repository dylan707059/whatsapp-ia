import type { WASocket } from "@whiskeysockets/baileys";
import type { OrderData } from "./types";
import { setOwnerNotifiedAt, getOrCreateConversation, insertMessage, getAccountByOwnerPhone, getAccountSettings, getConfirmGroupJid } from "./db";
import { getActiveOrder, setOrderOwnerNotifiedAt } from "./orders";
import { registerBotMessage } from "./bot-messages";
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
  const nombre = data.fullName || "el cliente";
  const phoneDigits = (data.phone || "").replace(/\D/g, "");
  const phoneDisplay = phoneDigits.startsWith("57") && phoneDigits.length === 12
    ? `+57 ${phoneDigits.slice(2, 5)} ${phoneDigits.slice(5, 8)} ${phoneDigits.slice(8)}`
    : data.phone;
  return [
    `✅ *La señora ${nombre} confirmó su pedido* ✅`,
    `📱 ${phoneDisplay}`,
    "",
    `🧾 Pedido *#${id}*`,
    "",
    `📦 ${data.product}`,
    `🎨 ${data.color}  •  📏 ${data.size}  •  🔢 x${data.quantity}`,
    "",
    `💵 *${data.total}*  —  ${data.payment}`,
    `🚚 ${data.shipping}`,
    "",
    `📍 *${data.address}*`,
    `🏙️ ${data.city}, ${data.department}`
  ].join("\n");
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

  // El número conectado de la cuenta dueña (para resolver SUS destinos de aviso).
  const botOwnerPhone = (sock.user?.id ?? "").split(":")[0] ?? "";

  // Destino: si hay grupo de confirmaciones (Dropi) configurado, va al grupo;
  // si no, a los teléfonos personales de aviso (comportamiento anterior).
  const confirmGroup = getConfirmGroupJid(botOwnerPhone);
  const targets: { jid: string; label: string }[] = confirmGroup
    ? [{ jid: confirmGroup, label: "Grupo confirmaciones" }]
    : getOwnerNotifyPhones(botOwnerPhone).map((p) => ({ jid: `${p}@s.whatsapp.net`, label: `Owner +${p}` }));

  if (targets.length === 0) {
    console.warn("[bot] Sin grupo ni teléfonos de aviso configurados — no se envía notificación interna");
    return;
  }

  const orderId = activeOrder?.id;
  console.log(`[bot] Enviando notificación interna del pedido ${orderId ?? data.conversationId}`);

  insertOrderEvent({
    orderId,
    conversationId: data.conversationId,
    eventType: "OWNER_NOTIFICATION_STARTED",
    message: "Iniciando notificación a owners",
    metadata: { targets: targets.map((t) => t.jid), phone: data.phone }
  });

  const summary = buildSummaryMessage(data, orderId);

  for (const { jid, label } of targets) {
    try {
      const r1 = await sock.sendMessage(jid, { text: summary });
      if (r1?.key?.id) registerBotMessage(r1.key.id);
      await sleep(800);

      // Guardar la notificación en la conversación del destino en el dashboard.
      try {
        const ownerConv = getOrCreateConversation(jid, label, botOwnerPhone);
        insertMessage(ownerConv.id, "assistant", summary);
      } catch (err) {
        console.warn(`[bot] No se pudo guardar notif en conv de ${label}:`, err);
      }

      console.log(`[bot] Notificación del pedido ${orderId ?? data.conversationId} enviada a ${label} (${jid})`);
    } catch (err) {
      console.error(`[bot] Error enviando pedido ${orderId ?? data.conversationId} a ${label}:`, err);
      insertOrderEvent({
        orderId,
        conversationId: data.conversationId,
        eventType: "OWNER_NOTIFICATION_ERROR",
        message: `Error notificando a ${label}`,
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
    metadata: { targets: targets.map((t) => t.jid), phone: data.phone }
  });
  console.log(`[bot] Pedido ${orderId ?? data.conversationId} notificado correctamente`);
}
