import "./env-loader";

import fs from "node:fs";
import path from "node:path";
import { start, getHandle } from "../src/lib/baileys/client";
import {
  getPendingOutbox, claimOutboxItem, unclaimOutboxItem, getConnectionState, enqueueOutbox, insertMessage,
  setMessageWaId,
  getPendingRevokes, markRevokeDone
} from "../src/lib/db";
import {
  getOrdersNeedingReminder,
  getOrdersToAutoCancel,
  incrementReminderCount,
  setOrderStatus
} from "../src/lib/orders";
import { insertOrderEvent } from "../src/lib/order-events";
import { AUTH_DIR, DATA_DIR, RESTART_FLAG } from "../src/lib/paths";

// Escribir PID para que Next.js (instrumentation.ts) detecte que ya estamos corriendo
fs.writeFileSync(path.join(DATA_DIR, "bot.pid"), String(process.pid));
process.on("exit", () => {
  try { fs.unlinkSync(path.join(DATA_DIR, "bot.pid")); } catch {}
});

// ─── Outbox poller ────────────────────────────────────────────────────────────

setInterval(async () => {
  const handle = getHandle();
  if (!handle) return;
  if (getConnectionState().status !== "connected") return;

  const ownerPhone = getConnectionState().phone ?? "";
  for (const item of getPendingOutbox(ownerPhone, 20)) {
    if (!claimOutboxItem(item.id)) continue;
    try {
      const result = await handle.sock.sendMessage(item.phone, { text: item.content });
      console.log(`[bot] → Outbox enviado a ${item.phone}`);

      // Guardar el wa_msg_id en la fila de messages asociada para poder
      // revocar el mensaje más tarde si el owner lo borra "para todos".
      const waMsgId = result?.key?.id;
      if (waMsgId && item.message_id) {
        try { setMessageWaId(item.message_id, waMsgId, true); } catch {}
      }
    } catch (err) {
      console.error(`[bot] Error enviando outbox #${item.id}, revirtiendo para reintentar:`, err);
      try { unclaimOutboxItem(item.id); } catch {}
    }
  }

  // Procesar revokes pendientes (delete para todos)
  for (const r of getPendingRevokes(10)) {
    try {
      await handle.sock.sendMessage(r.remote_jid, {
        delete: {
          remoteJid: r.remote_jid,
          fromMe:    r.wa_from_me === 1,
          id:        r.wa_msg_id
        }
      });
      markRevokeDone(r.id);
      console.log(`[bot] 🗑 Mensaje ${r.wa_msg_id} revocado en ${r.remote_jid}`);
    } catch (err) {
      console.error(`[bot] Error revocando ${r.wa_msg_id}:`, err);
      // Marca igual para no quedar atascado — WhatsApp tiene ventana ~1h
      markRevokeDone(r.id);
    }
  }
}, 2000);

// ─── Recordatorios de pedidos Shopify ─────────────────────────────────────────
// Cada 5 min:
//   - Si un pedido SHOPIFY lleva > 2h sin confirmar, le mandamos recordatorio.
//   - Máximo 2 recordatorios por pedido (configurable via env).
//   - Si después del último recordatorio pasan otras 2h sin confirmar →
//     cancelamos el pedido automáticamente.

const REMINDER_MAX      = Number(process.env.SHOPIFY_REMINDER_MAX ?? 2);
const REMINDER_INTERVAL = Number(process.env.SHOPIFY_REMINDER_INTERVAL_SEC ?? 7200); // 2h
const REMINDER_CHECK_MS = Number(process.env.SHOPIFY_REMINDER_CHECK_MS ?? 5 * 60 * 1000); // 5 min

function buildReminderText(attemptNumber: number, customerFirstName: string | null, orderNumber: string): string {
  const greeting = customerFirstName ? `Hola ${customerFirstName} 😊` : "Hola 😊";
  const urgency = attemptNumber === 1
    ? "Te recordamos que tu pedido aún está pendiente de confirmar."
    : "Es nuestro último recordatorio antes de cancelar tu pedido por falta de respuesta.";
  return [
    greeting,
    "",
    urgency,
    "",
    `🧾 Pedido: ${orderNumber}`,
    "",
    "Si todo está correcto responde *CONFIRMADO* para despachar tu pedido. Si deseas cambiar algo, escríbenos y te ayudamos de inmediato 💛"
  ].join("\n");
}

function buildAutoCancelText(customerFirstName: string | null, orderNumber: string): string {
  const greeting = customerFirstName ? `Hola ${customerFirstName} 😊` : "Hola 😊";
  return [
    greeting,
    "",
    `Cancelamos automáticamente tu pedido ${orderNumber} porque no recibimos confirmación.`,
    "",
    "Si todavía deseas recibirlo, escríbenos y lo reactivamos con gusto 💛"
  ].join("\n");
}

setInterval(() => {
  const state = getConnectionState();
  if (state.status !== "connected") return;
  const currentOwner = state.phone ?? "";

  // 1) Enviar recordatorios
  for (const order of getOrdersNeedingReminder(currentOwner, REMINDER_MAX, REMINDER_INTERVAL)) {
    try {
      const attemptNumber = order.reminder_count + 1;
      const orderNumberText = order.id ? `#${order.id}` : "";
      const text = buildReminderText(attemptNumber, order.first_name, orderNumberText);

      const reminderMsgId = insertMessage(order.conversation_id, "assistant", text);
      enqueueOutbox(order.conversation_id, order.conv_phone, text, 0, reminderMsgId);
      incrementReminderCount(order.id);

      insertOrderEvent({
        orderId: order.id,
        conversationId: order.conversation_id,
        eventType: "CONFIRMATION_RESENT_TO_CLIENT",
        message: `Recordatorio ${attemptNumber}/${REMINDER_MAX} enviado`,
        metadata: { attemptNumber, maxAttempts: REMINDER_MAX }
      });
      console.log(`[bot] ⏰ Recordatorio ${attemptNumber}/${REMINDER_MAX} → order #${order.id} (${order.conv_phone})`);
    } catch (err) {
      console.error(`[bot] Error enviando recordatorio order #${order.id}:`, err);
    }
  }

  // 2) Cancelar pedidos que ya agotaron recordatorios
  for (const order of getOrdersToAutoCancel(currentOwner, REMINDER_MAX, REMINDER_INTERVAL)) {
    try {
      const orderNumberText = order.id ? `#${order.id}` : "";
      const text = buildAutoCancelText(order.first_name, orderNumberText);

      const cancelMsgId = insertMessage(order.conversation_id, "assistant", text);
      enqueueOutbox(order.conversation_id, order.conv_phone, text, 0, cancelMsgId);
      setOrderStatus(order.id, "CANCELLED");

      insertOrderEvent({
        orderId: order.id,
        conversationId: order.conversation_id,
        eventType: "ORDER_CANCELLED",
        message: "Auto-cancelado por falta de confirmación del cliente",
        metadata: { reason: "no_confirmation_after_reminders", maxAttempts: REMINDER_MAX }
      });
      console.log(`[bot] ❌ Pedido #${order.id} cancelado automáticamente (sin confirmación)`);
    } catch (err) {
      console.error(`[bot] Error cancelando order #${order.id}:`, err);
    }
  }
}, REMINDER_CHECK_MS);

// ─── Restart flag watcher ─────────────────────────────────────────────────────

setInterval(async () => {
  if (!fs.existsSync(RESTART_FLAG)) return;

  console.log("[bot] Flag de reinicio detectado. Reiniciando...");

  try { fs.unlinkSync(RESTART_FLAG); } catch {}

  const handle = getHandle();
  if (handle) {
    try { await handle.shutdown(); } catch {}
  }

  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}

  await start();
}, 1000);

// ─── Capturar errores internos de Baileys (e.g. "Connection Closed" en retry) ─

process.on("unhandledRejection", (reason) => {
  console.error("[bot] Error no manejado, reconectando en 5s...", reason);
  setTimeout(() => start().catch(console.error), 5000);
});

process.on("uncaughtException", (err) => {
  console.error("[bot] Excepción no capturada, reconectando en 5s...", err);
  setTimeout(() => start().catch(console.error), 5000);
});

// ─── Arranque principal ───────────────────────────────────────────────────────

console.log("[bot] Iniciando agente WhatsApp...");
start().catch((err) => {
  console.error("[bot] Error fatal al iniciar:", err);
  setTimeout(() => start().catch(console.error), 5000);
});
