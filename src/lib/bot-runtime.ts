import fs from "node:fs";
import path from "node:path";
import { start, listHandles, isManaged, stopAccount, stopAndWipe } from "./baileys/client";
import {
  getPendingOutbox, claimOutboxItem, unclaimOutboxItem, enqueueOutbox, insertMessage,
  setMessageWaId, getPendingRevokes, markRevokeDone,
  listAllAccounts, getAccountConnection, getConversationById,
  isAccountAutomationPaused, getAppState, setAppState, getAccountById,
  findRecentLidConversationByName, mergeConversationInto,
  getPendingWaLabelOps, markWaLabelOpDone,
  listOrphanLidConversations, findRecentShopifyConversationByName
} from "./db";
import { registerContact } from "./baileys/contact-store";
import {
  getOrdersNeedingReminder,
  getOrdersToAutoCancel,
  incrementReminderCount,
  setOrderStatus,
  touchOrderReminder,
  type OrderWithConv
} from "./orders";
import { insertOrderEvent } from "./order-events";
import { getOwnerNotifyPhones } from "./owner-notifier";
import { registerBotMessage } from "./bot-messages";
import { buildOutgoingMediaContent } from "./baileys/media";
import { AUTH_DIR, DATA_DIR, MEDIA_DIR } from "./paths";
import type { OutboxItem } from "./types";
import type { AnyMessageContent } from "@whiskeysockets/baileys";

// ─── Constantes ───────────────────────────────────────────────────────────────
const WANTED_WINDOW_SEC      = 120;
const MAX_OUTBOX_AGE_SEC     = Number(process.env.MAX_OUTBOX_AGE_SEC ?? 6 * 3600);
const REMINDER_MAX           = Number(process.env.SHOPIFY_REMINDER_MAX ?? 2);
const REMINDER_INTERVAL      = Number(process.env.SHOPIFY_REMINDER_INTERVAL_SEC ?? 7200);
const REMINDER_CHECK_MS      = Number(process.env.SHOPIFY_REMINDER_CHECK_MS ?? 5 * 60 * 1000);
const REMINDER_MAX_AGE       = Number(process.env.SHOPIFY_REMINDER_MAX_AGE_SEC ?? 24 * 3600);
const DOWNTIME_THRESHOLD_SEC = Number(process.env.BOT_DOWNTIME_THRESHOLD_SEC ?? 600); // 10 min
const REMINDER_BATCH         = Number(process.env.SHOPIFY_REMINDER_BATCH ?? 5);       // recordatorios por tick

// Estado de recuperación tras una caída del proceso.
let recoveredFromDowntime = false;
let downtimeSec = 0;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendToOwners(h: any, ownerPhone: string, text: string) {
  for (const phone of getOwnerNotifyPhones(ownerPhone)) {
    try {
      const r = await h.sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
      if (r?.key?.id) registerBotMessage(r.key.id);
    } catch (e) {
      console.error("[bot] Error avisando al dueño:", e);
    }
  }
}

// Aviso al dueño cuando una confirmación venció sin poder enviarse.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function notifyOwnerUnsent(h: any, ownerPhone: string, item: OutboxItem) {
  const conv = getConversationById(item.conversation_id);
  const phone = item.phone.split("@")[0];
  const text = [
    "⚠️ *No se pudo enviar la confirmación*",
    "",
    `Cliente: ${conv?.name || phone}`,
    `Teléfono: ${phone}`,
    "",
    "El bot estaba desconectado en el momento de enviar. Este mensaje NO se reintentará — revisa el pedido manualmente."
  ].join("\n");
  await sendToOwners(h, ownerPhone, text);
}

// Aviso al dueño tras una caída: lista de pedidos que NO recibieron recordatorio.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function notifyOwnerReminderBacklog(h: any, ownerPhone: string, orders: OrderWithConv[]) {
  const lines = orders.slice(0, 30).map((o) => `• #${o.id} ${o.conv_name || o.conv_phone}`);
  const extra = orders.length > 30 ? `\n…y ${orders.length - 30} más` : "";
  const text = [
    "⚠️ *Desconexión detectada*",
    `El bot estuvo caído ~${Math.round(downtimeSec / 60)} min.`,
    "",
    `${orders.length} pedido(s) pendientes NO recibieron recordatorio automático (para no enviar masivo):`,
    "",
    lines.join("\n") + extra,
    "",
    "Revísalos manualmente desde el panel de Pedidos."
  ].join("\n");
  await sendToOwners(h, ownerPhone, text);
}

// ─── Arranque (idempotente) ───────────────────────────────────────────────────
let started = false;

export function startBotRuntime(): void {
  if (started) return;
  started = true;
  console.log("[bot] Iniciando agente WhatsApp (multi-cuenta, in-process)...");

  // Detección de caída: comparar el último latido guardado con ahora.
  try {
    const prev = Number(getAppState("bot_heartbeat") ?? 0);
    const now = Math.floor(Date.now() / 1000);
    if (prev > 0 && now - prev > DOWNTIME_THRESHOLD_SEC) {
      recoveredFromDowntime = true;
      downtimeSec = now - prev;
      console.log(`[bot] Caída detectada (~${Math.round(downtimeSec / 60)} min). Recordatorios atrasados se avisarán al dueño, no se enviarán masivos.`);
    }
    setAppState("bot_heartbeat", String(now));
  } catch (err) {
    console.error("[bot] Error en detección de caída:", err);
  }

  // Latido cada 30s para detectar futuras caídas.
  setInterval(() => {
    try { setAppState("bot_heartbeat", String(Math.floor(Date.now() / 1000))); } catch {}
  }, 30000);

  // Asegurar conexiones
  setInterval(ensureAccountsConnected, 5000);

  // ─── Outbox poller + revokes ────────────────────────────────────────────────
  setInterval(async () => {
    const nowSec = Math.floor(Date.now() / 1000);

    for (const h of listHandles()) {
      const conn = getAccountConnection(h.accountId);
      if (conn.status !== "connected" || !conn.phone) continue;

      for (const item of getPendingOutbox(conn.phone, 20)) {
        // Mensaje automático vencido (no se pudo enviar en su ventana): descartar.
        if (item.expires_at > 0 && nowSec > item.expires_at) {
          claimOutboxItem(item.id);
          if (item.notify_owner) {
            try { await notifyOwnerUnsent(h, conn.phone, item); } catch {}
          }
          console.log(`[bot] Outbox #${item.id} VENCIDO (ventana) — descartado${item.notify_owner ? " + aviso al dueño" : ""}`);
          continue;
        }
        // Mensaje muy viejo en general (manual sin ventana): descartar.
        if (nowSec - item.created_at > MAX_OUTBOX_AGE_SEC) {
          claimOutboxItem(item.id);
          console.log(`[bot] Outbox #${item.id} descartado por antiguo (${Math.round((nowSec - item.created_at) / 3600)}h)`);
          continue;
        }
        if (!claimOutboxItem(item.id)) continue;
        try {
          let content: AnyMessageContent;
          if (item.media_type && item.media_path) {
            const absPath = path.join(MEDIA_DIR, item.media_path);
            if (!fs.existsSync(absPath)) {
              console.error(`[bot] Outbox #${item.id}: archivo no existe (${absPath}) — descartado`);
              continue; // ya está claimeado (sent=1): no se reintenta
            }
            content = buildOutgoingMediaContent({
              absPath,
              type: item.media_type,
              mime: item.media_mime ?? null,
              filename: item.media_filename ?? null,
              caption: item.content ?? ""
            });
          } else {
            content = { text: item.content };
          }
          const result = await h.sock.sendMessage(item.phone, content);
          const waMsgId = result?.key?.id;
          if (waMsgId) {
            // Registrar el id para que el eco fromMe NO se vuelva a guardar/descargar.
            registerBotMessage(waMsgId);
            if (item.message_id) {
              try { setMessageWaId(item.message_id, waMsgId, true); } catch {}
            }
          }
        } catch (err) {
          console.error(`[bot] (acc ${h.accountId}) Error enviando outbox #${item.id}, revirtiendo:`, err);
          try { unclaimOutboxItem(item.id); } catch {}
        }
      }

      // ─── Operaciones de etiqueta encoladas por el panel (panel → WhatsApp) ──
      for (const op of getPendingWaLabelOps(conn.phone, 20)) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sock = h.sock as any;
          const fn = op.op === "remove" ? sock.removeChatLabel : sock.addChatLabel;
          if (typeof fn !== "function") {
            console.warn(`[bot] addChatLabel/removeChatLabel no disponible — op #${op.id} descartada`);
            markWaLabelOpDone(op.id);
            continue;
          }
          await fn.call(sock, op.chat_jid, op.label_id);
          markWaLabelOpDone(op.id);
          console.log(`[bot] (acc ${h.accountId}) Etiqueta ${op.label_id} ${op.op === "remove" ? "quitada de" : "puesta a"} ${op.chat_jid} (desde panel)`);
        } catch (err) {
          console.error(`[bot] Error aplicando op de etiqueta #${op.id}:`, err);
          markWaLabelOpDone(op.id); // no reintentar para no trabar la cola
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

  // ─── Recordatorios Shopify (por cuenta, anti-blast tras caída) ───────────────
  setInterval(async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const recovering = recoveredFromDowntime;
    recoveredFromDowntime = false; // la recuperación se procesa una sola vez

    for (const h of listHandles()) {
      const conn = getAccountConnection(h.accountId);
      if (conn.status !== "connected" || !conn.phone) continue;
      if (isAccountAutomationPaused(h.accountId)) continue;
      const currentOwner = conn.phone;

      // Marca de agua: solo pedidos creados DESPUÉS de la última activación.
      const resumedAt = getAccountById(h.accountId)?.automation_resumed_at ?? 0;

      // ─── Auto-fusión previa al recordatorio ──────────────────────────────────
      // Antes de enviar recordatorios, intentar unir chats @lid huérfanos con
      // la conv del pedido. Evita mandar recordatorios por chats divididos donde
      // el cliente ya confirmó por el otro chat.
      const candidatesForMerge = getOrdersNeedingReminder(currentOwner, REMINDER_MAX, REMINDER_INTERVAL)
        .filter((o) => o.created_at >= resumedAt && nowSec - o.created_at <= REMINDER_MAX_AGE);
      for (const order of candidatesForMerge) {
        if (!order.conv_name) continue;
        try {
          const lidConv = findRecentLidConversationByName(currentOwner, order.conv_name, 14400); // 4h
          if (lidConv && lidConv.id !== order.conversation_id) {
            console.log(
              `[bot] Auto-fusión: conv @lid #${lidConv.id} → conv pedido #${order.conversation_id} ` +
              `(${order.conv_name}) antes de recordatorio`
            );
            mergeConversationInto(lidConv.id, order.conversation_id);
            registerContact(order.conv_phone, lidConv.phone);
          }
        } catch (err) {
          console.error(`[bot] Error en auto-fusión para order #${order.id}:`, err);
        }
      }

      const due = getOrdersNeedingReminder(currentOwner, REMINDER_MAX, REMINDER_INTERVAL)
        .filter((o) => o.created_at >= resumedAt && nowSec - o.created_at <= REMINDER_MAX_AGE);

      // Tras una caída: avisar al dueño en vez de enviar masivo.
      if (recovering) {
        if (due.length > 0) {
          try { await notifyOwnerReminderBacklog(h, currentOwner, due); } catch {}
          for (const o of due) touchOrderReminder(o.id); // posponer, no spamear
        }
        continue; // en recuperación no enviamos recordatorios ni cancelaciones
      }

      // Operación normal: enviar de a pocos (cap) para no ser cansón.
      let sentCount = 0;
      for (const order of due) {
        if (sentCount >= REMINDER_BATCH) break;
        try {
          const attemptNumber = order.reminder_count + 1;
          const orderNumberText = order.id ? `#${order.id}` : "";
          const text = buildReminderText(attemptNumber, order.first_name, orderNumberText);
          const reminderMsgId = insertMessage(order.conversation_id, "assistant", text);
          enqueueOutbox(order.conversation_id, order.conv_phone, text, 0, reminderMsgId);
          incrementReminderCount(order.id);
          sentCount++;
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
        if (order.created_at < resumedAt) continue; // anterior a la activación
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

  // ─── Barrida de fusión de chats duplicados @lid (cada 60s) ──────────────────
  // Limpia duplicados que se crearon por temas de tiempo: busca chats @lid
  // huérfanos (sin pedido Shopify) y los fusiona con el chat real del mismo
  // cliente (por nombre + pedido Shopify). Así, aunque un chat se duplique,
  // se une solo en ~1 minuto.
  const normName = (s: string | null) => (s || "")
    .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  setInterval(() => {
    for (const acc of listAllAccounts()) {
      const conn = getAccountConnection(acc.id);
      if (conn.status !== "connected" || !conn.phone) continue;
      const owner = conn.phone;
      try {
        for (const orphan of listOrphanLidConversations(owner)) {
          if (!orphan.name) continue;
          const real = findRecentShopifyConversationByName(owner, orphan.name);
          if (!real || real.id === orphan.id || real.phone.endsWith("@lid")) continue;
          // Seguridad anti-fusión-errónea: exigir nombre completo idéntico
          // (no solo primer nombre) para no unir a dos personas distintas.
          const a = normName(orphan.name), b = normName(real.name);
          if (!a || a !== b) continue;
          console.log(
            `[bot] Fusión periódica: chat @lid #${orphan.id} ("${orphan.name}") → ` +
            `chat real #${real.id} (${real.phone})`
          );
          mergeConversationInto(orphan.id, real.id);
          registerContact(real.phone, orphan.phone);
        }
      } catch (err) {
        console.error(`[bot] Error en barrida de fusión (acc ${acc.id}):`, err);
      }
    }
  }, 60000);

  // ─── Watcher de reinicio por cuenta ─────────────────────────────────────────
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
