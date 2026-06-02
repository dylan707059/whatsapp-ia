import type { WASocket } from "@whiskeysockets/baileys";
import {
  getOrCreateConversation,
  getConversationById,
  getConversationByPhone,
  insertMessage,
  getRecentHistory,
  setConfirmedAt,
  setAiPausedUntil,
  setConversationMode,
  isClientBlocked
} from "../db";
import { generateReply } from "../openai";
import {
  isConfirmationMessage,
  extractOrderData,
  validateOrderData
} from "../order-confirmation";
import {
  sendOwnerNotificationSequentially,
  getOwnerNotifyPhones,
  sleep
} from "../owner-notifier";
import { isComplaintMessage, buildComplaintAlert } from "../complaint";
import { handleOwnerCommand } from "../commands";
import { handleOwnerImageMessage } from "../photo-confirm-flow";
import { getActiveOrder, upsertOrder } from "../orders";
import { registerBotMessage, isBotSentMessage } from "../bot-messages";
import { botSend } from "./send";
import { resolvePhone } from "./contact-store";
import { enqueueOrderTask } from "../queue";
import { insertOrderEvent } from "../order-events";
import { withCustomerLock } from "../customer-lock";

const AI_PAUSE_MINUTES = 30;

function isIndividualJid(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

export function setupMessageHandler(sock: WASocket): void {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await processMessage(sock, msg);
      } catch (err) {
        console.error("[bot] Error procesando mensaje:", err);
      }
    }
  });
}

async function processMessage(
  sock: WASocket,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  msg: any
): Promise<void> {
  const jid: string = msg.key?.remoteJid ?? "";
  if (!isIndividualJid(jid)) return;

  const rawOwnerId  = sock.user?.id ?? "";
  const ownerPhone  = rawOwnerId.split(":")[0];

  // ─── Mensajes fromMe ─────────────────────────────────────────────────────
  if (msg.key?.fromMe) {
    const msgId: string = msg.key?.id ?? "";
    if (isBotSentMessage(msgId)) return;

    const conv = getConversationByPhone(jid, ownerPhone);
    if (conv) {
      const pauseUntil = Math.floor(Date.now() / 1000) + AI_PAUSE_MINUTES * 60;
      setAiPausedUntil(conv.id, pauseUntil);
      console.log(`[bot] IA pausada en ${jid} por ${AI_PAUSE_MINUTES} min`);
    }
    return;
  }

  const senderPhone = resolvePhone(jid);
  const ownerPhones = getOwnerNotifyPhones();
  const isOwner     = ownerPhones.includes(senderPhone);

  if (jid.endsWith("@lid") && !isOwner) {
    console.log(`[handler] LID sin resolver: ${jid} → senderPhone=${senderPhone} | pushName=${msg.pushName} | ownerPhones=${ownerPhones.join(",")}`);
  }

  // ─── Imágenes (solo procesar las de owners para /fotoconfirmar) ───────────
  const imageMsg = msg.message?.imageMessage;
  if (imageMsg) {
    if (isOwner) {
      await handleOwnerImageMessage(sock, jid, senderPhone, msg);
    }
    return; // No-owners: ignorar imágenes
  }

  // ─── Extraer texto ────────────────────────────────────────────────────────
  const text: string | undefined =
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text;

  if (!text?.trim()) return;

  const pushName: string | undefined = msg.pushName;
  console.log(`[bot] ← ${jid}: "${text}"`);

  // ─── Comandos del owner ───────────────────────────────────────────────────
  if (isOwner) {
    if (text.trim().startsWith("/")) {
      await handleOwnerCommand(sock, jid, senderPhone, text.trim());
    }
    return; // Mensajes del owner sin slash: ignorar
  }

  // ─── Bloqueo de cliente ───────────────────────────────────────────────────
  if (isClientBlocked(jid)) {
    console.log(`[bot] Cliente bloqueado ${jid}, ignorando mensaje`);
    return;
  }

  // ─── Guardar mensaje del cliente ──────────────────────────────────────────
  const convo = getOrCreateConversation(jid, pushName ?? null, ownerPhone);
  insertMessage(convo.id, "user", text);

  // ─── Reclamo ──────────────────────────────────────────────────────────────
  if (isComplaintMessage(text)) {
    await handleComplaint(sock, jid, convo.id, senderPhone, text);
    return;
  }

  // ─── Verificar pausa de IA ────────────────────────────────────────────────
  const fresh = getConversationById(convo.id);
  if (!fresh) return;

  const now = Math.floor(Date.now() / 1000);
  const aiPaused = fresh.ai_paused_until && fresh.ai_paused_until > now;

  // ─── Confirmación del cliente ─────────────────────────────────────────────
  // La confirmación pasa por la cola incluso con IA pausada (HUMAN mode)
  if (isConfirmationMessage(text)) {
    const snapId     = convo.id;
    const snapJid    = jid;
    const snapMode   = fresh.mode;
    const snapPhone  = senderPhone;

    console.log(`[bot] Tarea agregada a cola: confirmacion ${snapId}`);

    enqueueOrderTask(`confirmacion:${snapId}`, async () => {
      await withCustomerLock(snapPhone, async () => {
        await handleConfirmation(sock, snapJid, snapId, snapMode);
      });
    });
    return;
  }

  // ─── Flujo normal de IA ───────────────────────────────────────────────────
  if (aiPaused) {
    console.log(`[bot] IA pausada para ${jid}, ignorando mensaje`);
    return;
  }

  if (fresh.mode !== "AI") return;

  const history = getRecentHistory(convo.id, 20);
  console.log(`[bot] Llamando LLM con ${history.length} mensajes...`);

  const t0    = Date.now();
  const reply = await generateReply(history);
  console.log(`[bot] LLM respondió en ${Date.now() - t0}ms`);

  if (!reply || reply === "[[NO_RESPONDER]]") {
    console.log(`[bot] ✗ Sin respuesta (${reply || "vacío"})`);
    return;
  }

  insertMessage(convo.id, "assistant", reply);
  await botSend(sock, jid, reply);
  console.log(`[bot] → Enviado a ${jid}`);

  // Upsert order si el reply es una confirmación de pedido
  if (reply.includes("🛍️")) {
    const draftData = extractOrderData(
      [{ id: 0, conversation_id: convo.id, role: "assistant", content: reply, created_at: 0 }],
      convo.id
    );
    if (draftData) {
      upsertOrder(convo.id, draftData, "PENDING_CONFIRMATION");
      console.log(`[bot] Order upserted para conversación ${convo.id}`);
    }
  }
}

// ─── Confirmación (dentro de la cola) ────────────────────────────────────────

async function handleConfirmation(
  sock: WASocket,
  jid: string,
  conversationId: number,
  mode: string
): Promise<void> {
  console.log(`[bot] Iniciando tarea en cola: confirmacion ${conversationId}`);
  console.log(`[bot] Cliente confirmó pedido en conversación ${conversationId}`);

  insertOrderEvent({
    conversationId,
    eventType: "CLIENT_CONFIRMED",
    message: "Cliente respondió CONFIRMADO",
    metadata: { jid, mode }
  });

  const fresh = getConversationById(conversationId);
  if (!fresh) return;

  // Anti-duplicado: releer desde SQLite dentro de la cola
  console.log(`[bot] Releyendo order desde SQLite`);
  const activeOrder     = getActiveOrder(conversationId);
  const alreadyNotified = activeOrder?.owner_notified_at ?? fresh.owner_notified_at;

  if (alreadyNotified) {
    console.log(`[bot] Pedido ${activeOrder?.id ?? conversationId} ya estaba notificado, se omite duplicado`);
    return;
  }

  if (!fresh.confirmed_at) setConfirmedAt(conversationId);

  // Obtener datos desde orders table o historial
  let orderData = activeOrder ? orderFromRecord(activeOrder, conversationId) : null;

  if (!orderData) {
    const history = getRecentHistory(conversationId, 50);
    orderData = extractOrderData(history, conversationId);
  }

  if (!orderData) return;

  const missing = validateOrderData(orderData);

  if (missing.length > 0) {
    if (mode === "AI") {
      const reply = `Para confirmar tu pedido, solo me falta: ${missing.join(", ")}.`;
      insertMessage(conversationId, "assistant", reply);
      await botSend(sock, jid, reply);
    }
    return;
  }

  // Responder al cliente solo en AI
  if (mode === "AI") {
    const clientReply =
      "Perfecto, tu pedido queda confirmado 💛\n\n" +
      "Ya lo pasamos a despacho. Te estaremos avisando cualquier novedad por este medio.";
    insertMessage(conversationId, "assistant", clientReply);
    await botSend(sock, jid, clientReply);
  }

  // Enviar notificación interna directamente (ya estamos dentro de la cola)
  const snapshot = { ...orderData };
  await sendOwnerNotificationSequentially(sock, snapshot);

  console.log(`[bot] Finalizando tarea en cola: confirmacion ${conversationId}`);
}

// ─── Reclamo ──────────────────────────────────────────────────────────────────

async function handleComplaint(
  sock: WASocket,
  jid: string,
  conversationId: number,
  clientPhone: string,
  text: string
): Promise<void> {
  console.log(`[bot] Reclamo detectado en conversación ${conversationId}`);
  setConversationMode(conversationId, "HUMAN");

  const reply = "Entiendo, déjame pasarte con un asesor para revisar tu caso de inmediato.";
  insertMessage(conversationId, "assistant", reply);
  await botSend(sock, jid, reply);

  const alert  = buildComplaintAlert(conversationId, clientPhone, text);
  const phones = getOwnerNotifyPhones();

  for (const phone of phones) {
    try {
      const ownerJid = `${phone}@s.whatsapp.net`;
      const result   = await sock.sendMessage(ownerJid, { text: alert });
      if (result?.key?.id) registerBotMessage(result.key.id);
      await sleep(800);
    } catch (err) {
      console.error(`[bot] Error enviando alerta de reclamo a ${phone}:`, err);
    }
  }
}

// ─── Helper ────────────────────────────────────────────────────────────────────

function orderFromRecord(
  order: import("../types").Order,
  conversationId: number
): import("../types").OrderData | null {
  if (!order.product) return null;
  return {
    conversationId,
    fullName:   order.full_name   ?? "",
    firstName:  order.first_name  ?? "",
    lastName:   order.last_name   ?? "",
    phone:      order.phone       ?? "",
    product:    order.product     ?? "",
    color:      order.color       ?? "",
    size:       order.size        ?? "",
    quantity:   order.quantity    ?? "",
    total:      order.total       ?? "",
    payment:    order.payment     ?? "Contraentrega",
    shipping:   order.shipping    ?? "Gratis",
    address:    order.address     ?? "",
    city:       order.city        ?? "",
    department: order.department  ?? ""
  };
}
