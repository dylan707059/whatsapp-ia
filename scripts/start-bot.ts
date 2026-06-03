import "./env-loader";

import fs from "node:fs";
import path from "node:path";
import { start, listHandles, isManaged, stopAccount, stopAndWipe } from "../src/lib/baileys/client";
import {
  getPendingOutbox, claimOutboxItem, unclaimOutboxItem, enqueueOutbox, insertMessage,
  setMessageWaId, getPendingRevokes, markRevokeDone,
  listAllAccounts, getAccountConnection, getConversationById,
  isAccountAutomationPaused
} from "../src/lib/db";
import {
  getOrdersNeedingReminder,
  getOrdersToAutoCancel,
  incrementReminderCount,
  setOrderStatus
} from "../src/lib/orders";
import { insertOrderEvent } from "../src/lib/order-events";
import { AUTH_DIR, DATA_DIR } from "../src/lib/paths";

// Escribir PID para que Next.js (instrumentation.ts) detecte que ya estamos corriendo
fs.writeFileSync(path.join(DATA_DIR, "bot.pid"), String(process.pid));
process.on("exit", () => {
  try { fs.unlinkSync(path.join(DATA_DIR, "bot.pid")); } catch {}
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Devuelve el handle (socket) de la cuenta cuyo número conectado es `phone`.
function handleForPhone(phone: string) {
  for (const h of listHandles()) {
    if (getAccountConnection(h.accountId).phone === phone) return h;
  }
  return undefined;
}

// ─── Asegurar conexiones (lazy, para no agotar memoria) ───────────────────────
// Solo mantenemos conexión de WhatsApp para cuentas que:
//   - ya están conectadas (tienen credenciales y reciben mensajes), o
//   - tienen credenciales guardadas (se conectaron antes), o
//   - fueron "deseadas" hace poco (su dashboard/QR consultó estado < 2 min).
// Arrancamos de a UNA por tick (stagger) para no picar la RAM, y soltamos las
// conexiones de cuentas inactivas (ej: un QR que el usuario abandonó).

const WANTED_WINDOW_SEC = 120;

function credsExist(accountId: number): boolean {
  try {
    return fs.existsSync(path.join(AUTH_DIR, String(accountId), "creds.json"));
  } catch {
    return false;
  }
}

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
        startedOne = true; // de a una por tick
      }
    } else if (isManaged(acc.id)) {
      // Cuenta inactiva con socket vivo (típicamente un QR abandonado): soltar.
      stopAccount(acc.id).catch((e) => console.error(`[bot] Error deteniendo cuenta ${acc.id}:`, e));
    }
  }
}

setInterval(ensureAccountsConnected, 5000);

// ─── Outbox poller (por cuenta) ───────────────────────────────────────────────

// Edad máxima de un mensaje en cola: si quedó sin enviar más de esto (típicamente
// porque el bot estuvo desconectado mucho tiempo), se DESCARTA en vez de enviarse.
// Evita spamear a clientes viejos con confirmaciones/recordatorios al reconectar.
const MAX_OUTBOX_AGE_SEC = Number(process.env.MAX_OUTBOX_AGE_SEC ?? 6 * 3600); // 6h

setInterval(async () => {
  const nowSec = Math.floor(Date.now() / 1000);

  for (const h of listHandles()) {
    const conn = getAccountConnection(h.accountId);
    if (conn.status !== "connected" || !conn.phone) continue;

    for (const item of getPendingOutbox(conn.phone, 20)) {
      // Descartar mensajes demasiado viejos (no enviar tras larga desconexión).
      if (nowSec - item.created_at > MAX_OUTBOX_AGE_SEC) {
        claimOutboxItem(item.id); // marcar como procesado sin enviar
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

  // Revokes pendientes (delete para todos) — vía el socket de la cuenta dueña.
  for (const r of getPendingRevokes(10)) {
    const conv = getConversationById(r.conversation_id);
    const h = conv ? handleForPhone(conv.owner_phone) : undefined;
    if (!h) continue; // sin socket para esa cuenta ahora; se reintenta luego
    try {
      await h.sock.sendMessage(r.remote_jid, {
        delete: { remoteJid: r.remote_jid, fromMe: r.wa_from_me === 1, id: r.wa_msg_id }
      });
      markRevokeDone(r.id);
    } catch (err) {
      console.error(`[bot] Error revocando ${r.wa_msg_id}:`, err);
      markRevokeDone(r.id); // no quedar atascado — WhatsApp tiene ventana ~1h
    }
  }
}, 2000);

// ─── Recordatorios de pedidos Shopify (por cuenta) ────────────────────────────

const REMINDER_MAX      = Number(process.env.SHOPIFY_REMINDER_MAX ?? 2);
const REMINDER_INTERVAL = Number(process.env.SHOPIFY_REMINDER_INTERVAL_SEC ?? 7200); // 2h
const REMINDER_CHECK_MS = Number(process.env.SHOPIFY_REMINDER_CHECK_MS ?? 5 * 60 * 1000); // 5 min
// No recordar/cancelar pedidos más viejos que esto (evita spam al reconectar
// tras mucho tiempo). Default 24h.
const REMINDER_MAX_AGE  = Number(process.env.SHOPIFY_REMINDER_MAX_AGE_SEC ?? 24 * 3600);

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

setInterval(() => {
  const nowSec = Math.floor(Date.now() / 1000);

  // Para cada cuenta conectada, procesar SUS recordatorios (filtrados por su número).
  for (const h of listHandles()) {
    const conn = getAccountConnection(h.accountId);
    if (conn.status !== "connected" || !conn.phone) continue;
    // Saltar recordatorios/auto-cancelación si la cuenta apagó la automatización.
    if (isAccountAutomationPaused(h.accountId)) continue;
    const currentOwner = conn.phone;

    for (const order of getOrdersNeedingReminder(currentOwner, REMINDER_MAX, REMINDER_INTERVAL)) {
      if (nowSec - order.created_at > REMINDER_MAX_AGE) continue; // pedido viejo, no recordar
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
      if (nowSec - order.created_at > REMINDER_MAX_AGE) continue; // pedido viejo, no avisar
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

// ─── Watcher de reinicio por cuenta ───────────────────────────────────────────
// La ruta /api/connection/disconnect escribe un flag ".restart-<accountId>" en
// DATA_DIR. Aquí lo detectamos, desconectamos + limpiamos esa cuenta y la
// volvemos a arrancar (para mostrar un QR nuevo).

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

// ─── Errores internos de Baileys ──────────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  console.error("[bot] Error no manejado:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[bot] Excepción no capturada:", err);
});

// ─── Arranque principal ───────────────────────────────────────────────────────

console.log("[bot] Iniciando agente WhatsApp (multi-cuenta)...");
ensureAccountsConnected();
