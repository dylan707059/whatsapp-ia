import fs from "node:fs";
import path from "node:path";
import { start, listHandles, isManaged, stopAccount, stopAndWipe } from "./baileys/client";
import {
  getPendingOutbox, claimOutboxItem, unclaimOutboxItem, enqueueOutbox, insertMessage,
  setMessageWaId, getPendingRevokes, markRevokeDone,
  listAllAccounts, getAccountConnection, getConversationById,
  isAccountAutomationPaused
} from "./db";
import {
  getOrdersNeedingReminder,
  getOrdersToAutoCancel,
  incrementReminderCount,
  setOrderStatus
} from "./orders";
import { insertOrderEvent } from "./order-events";
import { AUTH_DIR, DATA_DIR } from "./paths";

// ─── Constantes ───────────────────────────────────────────────────────────────
const WANTED_WINDOW_SEC  = 120;
const MAX_OUTBOX_AGE_SEC  = Number(process.env.MAX_OUTBOX_AGE_SEC ?? 6 * 3600); // 6h
const REMINDER_MAX        = Number(process.env.SHOPIFY_REMINDER_MAX ?? 2);
const REMINDER_INTERVAL   = Number(process.env.SHOPIFY_REMINDER_INTERVAL_SEC ?? 7200); // 2h
const REMINDER_CHECK_MS   = Number(process.env.SHOPIFY_REMINDER_CHECK_MS ?? 5 * 60 * 1000); // 5 min
const REMINDER_MAX_AGE    = Number(process.env.SHOPIFY_REMINDER_MAX_AGE_SEC ?? 24 * 3600); // 24h

// ─── Helpers ──────────────────────────────────────────────────────────────────

function handleForPhone(phone: string) {
  for (const h of listHandles()) {
    if (getAccountConnection(h.accountId).phone === phone) return h;
  }
  return undefined;
}

function credsExist(accountId: number): boolean {
  try {
    return fs.existsSync(path.join(AUTH_DIR, String(accountId), "creds.json"));
  } catch {
    return false;
  }
}

// Conexión lazy: solo mantenemos socket para cuentas conectadas, con
// credenciales guardadas, o "deseadas" hace poco. De a una por tick.
function ensureAccountsConnected() {
  const now = Math.floor(Date.now() / 1000);
  let startedOne = false;

  for (const acc of listAllAccounts()) {
    const conn = getAccountConnection(acc.id);
    const wanted = conn.wanted_at != null && now - conn.wanted_at < WANTED_WINDOW_SEC;
    const shouldRun = conn.status === "connected" || credsExist(acc.id) || wanted;

    if (shouldRun) {
      if (!isManaged(acc.id) && !startedOne) {
        console.log(`[bot] Iniciando socket para cuenta ${acc.id} (${acc.email})`);
        start(acc.id).catch((e) => console.error(`[bot] Error iniciando cuenta ${acc.id}:`, e));
        startedOne = true;
      }
    } else if (isManaged(acc.id)) {
      stopAccount(acc.id).catch((e) => console.error(`[bot] Error deteniendo cuenta ${acc.id}:`, e));
    }
  }
}

function buildReminderText(attemptNumber: number, customerFirstName: string | null, orderNumber: string): string {
  const greeting = customerFirstName ? `Hola ${customerFirstName} 😊` : "Hola 😊";
  const urgency = attemptNumber === 1
    ? "Te recordamos que tu pedido aún está pendiente de confirmar."
    : "Es nuestro último recordatorio antes de cancelar tu pedido por falta de respuesta.";
  return [
    greeting, "", urgency, "",
    `🧾 Pedido: ${orderNumber}`, "",
    "Si todo está correcto responde *CONFIRMADO* para despachar tu pedido. Si deseas cambiar algo, escríbenos y te ayudamos de inmediato 💛"
  ].join("\n");
}

function buildAutoCancelText(customerFirstName: string | null, orderNumber: string): string {
  const greeting = customerFirstName ? `Hola ${customerFirstName} 😊` : "Hola 😊";
  return [
    greeting, "",
    `Cancelamos automáticamente tu pedido ${orderNumber} porque no recibimos confirmación.`, "",
    "Si todavía deseas recibirlo, escríbenos y lo reactivamos con gusto 💛"
  ].join("\n");
}

// ─── Arranque (idempotente) ───────────────────────────────────────────────────
let started = false;

export function startBotRuntime(): void {
  if (started) return;
  started = true;
  console.log("[bot] Iniciando agente WhatsApp (multi-cuenta, in-process)...");

  // Asegurar conexiones
  setInterval(ensureAccountsConnected, 5000);

  // Outbox poller + revokes
  setInterval(async () => {
    const nowSec = Math.floor(Date.now() / 1000);

    for (const h of listHandles()) {
      const conn = getAccountConnection(h.accountId);
      if (conn.status !== "connected" || !conn.phone) continue;

      for (const item of getPendingOutbox(conn.phone, 20)) {
        if (nowSec - item.created_at > MAX_OUTBOX_AGE_SEC) {
          claimOutboxItem(item.id);
          console.log(`[bot] Outbox #${item.id} descartado por antiguo (${Math.round((nowSec - item.created_at) / 3600)}h)`);
          continue;
        }
        if (!claimOutboxItem(item.id)) continue;
        try {
          const result = await h.sock.sendMessage(item.phone, { text: item.content });
          const waMsgId = result?.key?.id;
          if (waMsgId && item.message_id) {
            try { setMessageWaId(item.message_id, waMsgId, true); } catch {}
          }
        } catch (err) {
          console.error(`[bot] (acc ${h.accountId}) Error enviando outbox #${item.id}, revirtiendo:`, err);
          try { unclaimOutboxItem(item.id); } catch {}
        }
      }
    }

    for (const r of getPendingRevokes(10)) {
      const conv = getConversationById(r.conversation_id);
      const h = conv ? handleForPhone(conv.owner_phone) : undefined;
      if (!h) continue;
      try {
        await h.sock.sendMessage(r.remote_jid, {
          delete: { remoteJid: r.remote_jid, fromMe: r.wa_from_me === 1, id: r.wa_msg_id }
        });
        markRevokeDone(r.id);
      } catch (err) {
        console.error(`[bot] Error revocando ${r.wa_msg_id}:`, err);
        markRevokeDone(r.id);
      }
    }
  }, 2000);

  // Recordatorios Shopify (por cuenta)
  setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);

    for (const h of listHandles()) {
      const conn = getAccountConnection(h.accountId);
      if (conn.status !== "connected" || !conn.phone) continue;
      if (isAccountAutomationPaused(h.accountId)) continue;
      const currentOwner = conn.phone;

      for (const order of getOrdersNeedingReminder(currentOwner, REMINDER_MAX, REMINDER_INTERVAL)) {
        if (nowSec - order.created_at > REMINDER_MAX_AGE) continue;
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
        } catch (err) {
          console.error(`[bot] Error enviando recordatorio order #${order.id}:`, err);
        }
      }

      for (const order of getOrdersToAutoCancel(currentOwner, REMINDER_MAX, REMINDER_INTERVAL)) {
        if (nowSec - order.created_at > REMINDER_MAX_AGE) continue;
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
        } catch (err) {
          console.error(`[bot] Error cancelando order #${order.id}:`, err);
        }
      }
    }
  }, REMINDER_CHECK_MS);

  // Watcher de reinicio por cuenta (.restart-<id> escrito por /api/connection/disconnect)
  setInterval(async () => {
    let entries: string[] = [];
    try { entries = fs.readdirSync(DATA_DIR); } catch { return; }

    for (const name of entries) {
      if (!name.startsWith(".restart-")) continue;
      const accountId = parseInt(name.slice(".restart-".length), 10);
      try { fs.unlinkSync(path.join(DATA_DIR, name)); } catch {}
      if (isNaN(accountId)) continue;

      console.log(`[bot] Flag de reinicio para cuenta ${accountId}. Reiniciando su conexión...`);
      try { await stopAndWipe(accountId); } catch (err) { console.error(err); }
      start(accountId).catch((e) => console.error(`[bot] Error reiniciando cuenta ${accountId}:`, e));
    }
  }, 1000);

  // Arranque inmediato
  ensureAccountsConnected();
}
