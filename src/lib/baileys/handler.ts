import type { WASocket } from "@whiskeysockets/baileys";
import {
  getOrCreateConversation,
  getConversationById,
  getConversationByPhone,
  insertMessage,
  insertMediaMessage,
  incrementUnread,
  getRecentHistory,
  setConfirmedAt,
  setAiPausedUntil,
  setConversationMode,
  isClientBlocked,
  advancePendingOutbox,
  discardPendingOutboxForConversation,
  findRecentShopifyConversationByName,
  deleteConversation,
  isAutomationPausedForPhone,
  findWaLabelIdByName,
  listWaLabels
} from "../db";
import { detectMedia, saveIncomingMedia, type MediaKind } from "./media";
import { registerContact } from "./contact-store";
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
import { getActiveOrder } from "../orders";
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
  // Mensajes enviados desde el celular del dueño (no desde el bot/dashboard).
  // Los guardamos como role="human" para que aparezcan en el dashboard, y
  // pausamos la IA en esa conv para no responder en paralelo.
  if (msg.key?.fromMe) {
    const msgId: string = msg.key?.id ?? "";
    if (isBotSentMessage(msgId)) return; // skip ecos de mensajes que mando el bot

    // Crear/obtener la conversación con el destinatario para guardarlo.
    // NO pasamos pushName: en mensajes fromMe, pushName es el nombre de la
    // cuenta del dueño ("Eclipse", etc.), no el nombre del cliente. Pasarlo
    // pisaría el nombre real del cliente con el nombre de la tienda.
    const conv = getOrCreateConversation(jid, null, ownerPhone);

    // Multimedia enviada desde el celular → reflejarla en el panel.
    const fromMeMedia = detectMedia(msg.message);
    if (fromMeMedia && fromMeMedia.kind !== "audio" && fromMeMedia.kind !== "sticker") {
      try {
        const saved = await saveIncomingMedia(sock, msg, conv.id);
        if (saved) {
          insertMediaMessage(conv.id, "human", saved.caption, saved.media, msgId || null, true);
          console.log(`[bot] ← (yo desde celular) a ${jid}: [${saved.kind}]`);
        }
      } catch (err) {
        console.error("[bot] Error guardando media fromMe:", err);
      }
    } else {
      // Texto (o tipos no soportados): guardamos el texto si lo hay.
      const textFromMe: string | undefined =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text;
      if (textFromMe?.trim()) {
        insertMessage(conv.id, "human", textFromMe.trim());
        console.log(`[bot] ← (yo desde celular) a ${jid}: "${textFromMe.slice(0, 60)}"`);
      }
    }

    // Pausar IA en esta conv para no pisar al humano que está atendiendo manualmente
    const pauseUntil = Math.floor(Date.now() / 1000) + AI_PAUSE_MINUTES * 60;
    setAiPausedUntil(conv.id, pauseUntil);
    return;
  }

  const senderPhone = resolvePhone(jid);
  const ownerPhones = getOwnerNotifyPhones(ownerPhone);
  const isOwner     = ownerPhones.includes(senderPhone);

  if (jid.endsWith("@lid") && !isOwner) {
    console.log(`[handler] LID sin resolver: ${jid} → senderPhone=${senderPhone} | pushName=${msg.pushName} | ownerPhones=${ownerPhones.join(",")}`);
  }

  // ─── Multimedia entrante + texto ──────────────────────────────────────────
  // Las fotos/videos/documentos del cliente se descargan y se muestran en el
  // panel (antes se perdían). Audios/stickers quedan como placeholder de texto.
  const incomingMedia = detectMedia(msg.message);

  const text: string | undefined =
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text;

  // Nada útil (ni texto ni media): salir.
  if (!text?.trim() && !incomingMedia) return;

  const pushName: string | undefined = msg.pushName;
  console.log(`[bot] ← ${jid}: ${text ? `"${text}"` : `[${incomingMedia?.kind}]`}`);

  // ─── Comandos del owner ───────────────────────────────────────────────────
  // Los mensajes del owner se GUARDAN (para que aparezcan en el dashboard como
  // historial), pero el bot solo ejecuta el comando si empieza con "/". Los
  // mensajes normales del owner quedan visibles pero no disparan IA.
  if (isOwner) {
    if (!text?.trim()) return; // media del owner: se ignora
    const ownerConv = getOrCreateConversation(jid, msg.pushName ?? `Owner +${senderPhone}`, ownerPhone);
    insertMessage(ownerConv.id, "user", text);

    if (text.trim().startsWith("/")) {
      await handleOwnerCommand(sock, jid, senderPhone, text.trim());
    }
    return; // Mensajes del owner sin slash: solo se guardan, no se procesan
  }

  // ─── Bloqueo de cliente ───────────────────────────────────────────────────
  if (isClientBlocked(jid)) {
    console.log(`[bot] Cliente bloqueado ${jid}, ignorando mensaje`);
    return;
  }

  // ─── Deduplicación de conversación por LID ────────────────────────────────
  // Si el mensaje llega con JID @lid (formato privacy de WhatsApp) y no tenemos
  // mapping conocido, puede que ya exista una conversación creada por el
  // webhook de Shopify con el phone real (@s.whatsapp.net). Buscamos por
  // pushName matching en los últimos 30 min: si encontramos un pedido SHOPIFY
  // pendiente con el mismo nombre, reusamos esa conversación y registramos
  // el mapping LID → phone para los próximos mensajes.
  let convo = getOrCreateConversation(jid, pushName ?? null, ownerPhone);
  if (jid.endsWith("@lid")) {
    // Matching difuso por nombre (sin emojis/acentos) + fallback de candidato
    // único. Antes exigía pushName exacto == nombre Shopify, lo que fallaba
    // cuando el cliente tenía emojis en el nombre ("Sol🌼" vs "Sol").
    const shopifyConv = findRecentShopifyConversationByName(ownerPhone, pushName ?? "");
    if (shopifyConv && shopifyConv.id !== convo.id) {
      console.log(
        `[bot] LID ${jid} matchea con conv SHOPIFY #${shopifyConv.id} (${shopifyConv.phone}) ` +
        `por nombre "${pushName ?? "(sin nombre)"}" — fusionando, descartando conv duplicada #${convo.id}`
      );
      // Registrar mapping para futuros mensajes
      registerContact(shopifyConv.phone, jid);
      // Borrar la conversación duplicada recién creada (todavía vacía)
      try {
        deleteConversation(convo.id);
      } catch (err) {
        console.error("[bot] Error borrando conv duplicada:", err);
      }
      convo = shopifyConv;
    }
  }

  // ─── Multimedia del cliente: descargar, guardar y mostrar en el panel ─────
  // (Se maneja aparte del texto; un mensaje con archivo no dispara IA ni se
  //  interpreta como confirmación.)
  if (incomingMedia) {
    await handleIncomingMedia(sock, msg, convo.id, incomingMedia.kind);
    return;
  }

  // Sin media ⇒ mensaje de texto. (El guard de arriba ya garantiza que hay
  // texto; este chequeo además estrecha el tipo de `text` para el resto.)
  if (!text?.trim()) return;

  insertMessage(convo.id, "user", text);
  incrementUnread(convo.id);

  // ─── Interruptor de automatización (botón de pánico) ──────────────────────
  // Si el owner apagó la automatización, guardamos el mensaje (para que lo vea
  // en el dashboard y responda manualmente) pero el bot no hace NADA automático.
  if (isAutomationPausedForPhone(ownerPhone)) {
    console.log(`[bot] Automatización pausada para ${ownerPhone} — mensaje guardado sin responder`);
    return;
  }

  // ─── SILENCIO post-confirmación ───────────────────────────────────────────
  // Una vez que el pedido fue confirmado (confirmed_at != null), el bot deja
  // de hacer cualquier acción automática: ni IA, ni reclamos, ni nada.
  // Cualquier mensaje del cliente queda guardado en el chat para que el owner
  // lo atienda manualmente desde el dashboard.
  {
    const convCheck = getConversationById(convo.id);
    if (convCheck?.confirmed_at) {
      console.log(`[bot] Conversación ${convo.id} ya confirmada, bot en silencio`);
      return;
    }
  }

  // ─── Reclamo ──────────────────────────────────────────────────────────────
  // Descartamos el template pendiente: si el cliente reclama, mandarle
  // "por favor confirma tu pedido" 3 min después sería muy mala UX.
  if (isComplaintMessage(text)) {
    discardPendingOutboxForConversation(convo.id);
    await handleComplaint(sock, jid, convo.id, senderPhone, text, ownerPhone);
    return;
  }

  // ─── Verificar pausa de IA ────────────────────────────────────────────────
  const fresh = getConversationById(convo.id);
  if (!fresh) return;

  const now = Math.floor(Date.now() / 1000);
  const aiPaused = fresh.ai_paused_until && fresh.ai_paused_until > now;

  // Cachear el active order para reusar en checks posteriores
  const activeOrderForConv = getActiveOrder(convo.id);

  // ─── Confirmación del cliente ─────────────────────────────────────────────
  // La confirmación pasa por la cola incluso con IA pausada (HUMAN mode).
  // IMPORTANTE: descartamos el template pendiente ANTES de encolar la tarea.
  // Sin esto, cuando el cliente confirma con su primer mensaje ("listo", "ok"),
  // el flujo avanzaría el template Y handleConfirmation enviaría "Perfecto" →
  // el cliente recibiría dos mensajes del bot (el template + la confirmación).
  if (isConfirmationMessage(text)) {
    const snapId     = convo.id;
    const snapJid    = jid;
    const snapMode   = fresh.mode;
    const snapPhone  = senderPhone;

    console.log(`[bot] Tarea agregada a cola: confirmacion ${snapId}`);
    discardPendingOutboxForConversation(snapId);

    enqueueOrderTask(`confirmacion:${snapId}`, async () => {
      await withCustomerLock(snapPhone, async () => {
        await handleConfirmation(sock, snapJid, snapId, snapMode);
      });
    });
    return;
  }

  // ─── Adelantar outbox programado (confirmaciones Shopify diferidas) ───────
  // Solo para mensajes normales (ni reclamo ni confirmación): si hay un template
  // pendiente con scheduled_at futuro, lo enviamos YA porque el cliente escribió.
  const advanced = advancePendingOutbox(convo.id);
  if (advanced > 0) {
    console.log(
      `[bot] Cliente ${jid} escribió primero — adelantando ${advanced} mensaje(s) en outbox`
    );
  }

  // ─── Flujo normal de IA ───────────────────────────────────────────────────
  if (aiPaused) {
    console.log(`[bot] IA pausada para ${jid}, ignorando mensaje`);
    return;
  }

  if (fresh.mode !== "AI") return;

  // ─── Bloquear IA en convs con pedido SHOPIFY ──────────────────────────────
  // Si la conversación tiene CUALQUIER pedido SHOPIFY (incluso CONFIRMED o
  // CANCELLED), la IA no debe responder: el flujo SHOPIFY ya maneja todas
  // las confirmaciones y cualquier respuesta IA sería duplicada/conflictiva.
  // El cliente puede reenviar los datos del pedido en el chat (típico de
  // Releasit) y sin este check la IA generaría su propia confirmación.
  if (activeOrderForConv && activeOrderForConv.source === "SHOPIFY") {
    console.log(
      `[bot] Conv ${convo.id} tiene order SHOPIFY #${activeOrderForConv.id} ` +
      `(status ${activeOrderForConv.status}) — IA no responde para evitar duplicado`
    );
    return;
  }

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

  // Nota: la auto-extracción de pedido a partir del texto de la IA fue
  // desactivada. Los pedidos ahora se crean SOLO desde el webhook de Shopify
  // (ver /api/webhooks/shopify/orders-create). Esto evita confirmaciones
  // duplicadas y mantiene una única fuente de verdad para los pedidos.
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
    // Para pedidos SHOPIFY que ya están registrados, NO le pedimos campos
    // faltantes al cliente (los datos vienen de Shopify, no del chat).
    // Para pedidos viejos modo AI, sí seguimos pidiendo lo que falta.
    if (mode === "AI" && !activeOrder) {
      const reply = `Para confirmar tu pedido, solo me falta: ${missing.join(", ")}.`;
      insertMessage(conversationId, "assistant", reply);
      await botSend(sock, jid, reply);
    }
    return;
  }

  // Responder al cliente confirmando (siempre, ya que el pedido es válido
  // y el cliente acaba de decir CONFIRMADO; este es el último mensaje del
  // bot — después queda en silencio gracias a confirmed_at)
  const clientReply =
    "Perfecto, tu pedido queda confirmado 💛\n\n" +
    "Ya lo pasamos a despacho. Te estaremos avisando cualquier novedad por este medio.";
  insertMessage(conversationId, "assistant", clientReply);
  // Una sola oportunidad: si falla, NO se reintenta y NO bloquea la
  // notificación interna al dueño (que es la importante).
  try {
    await botSend(sock, jid, clientReply);
  } catch (err) {
    console.error(`[bot] No se pudo enviar "Perfecto" al cliente (no se reintenta):`, err);
  }

  // Enviar notificación interna directamente (ya estamos dentro de la cola)
  const snapshot = { ...orderData };
  await sendOwnerNotificationSequentially(sock, snapshot);

  // Etiquetar el chat en el WhatsApp Business real con "Nuevo pedido".
  try {
    await applyNuevoPedidoLabel(sock, fresh.phone);
  } catch (err) {
    console.error(`[bot] Error etiquetando chat ${fresh.phone}:`, err);
  }

  console.log(`[bot] Finalizando tarea en cola: confirmacion ${conversationId}`);
}

// ─── Etiqueta nativa de WhatsApp Business al confirmar ────────────────────────
const LABEL_TARGET = process.env.WA_CONFIRM_LABEL ?? "Nuevo pedido";

async function applyNuevoPedidoLabel(sock: WASocket, convPhoneJid: string): Promise<void> {
  const ownerPhone = (sock.user?.id ?? "").split(":")[0];
  if (!ownerPhone) {
    console.warn("[bot] [label] Sin owner phone — no se etiqueta");
    return;
  }

  // Las etiquetas funcionan mejor sobre el JID real (@s.whatsapp.net).
  // Si la conv quedó como @lid, igual lo intentamos pero avisamos.
  const jid = convPhoneJid;
  if (jid.endsWith("@lid")) {
    console.warn(`[bot] [label] Chat ${jid} es @lid — el etiquetado puede no aplicar`);
  }

  const labelId = findWaLabelIdByName(ownerPhone, LABEL_TARGET);
  if (!labelId) {
    const available = listWaLabels(ownerPhone)
      .map((l) => `"${l.name}"(id=${l.label_id},predef=${l.predefined_id ?? "-"})`)
      .join(", ");
    console.warn(
      `[bot] [label] No encontré la etiqueta "${LABEL_TARGET}" para ${ownerPhone}. ` +
      `Etiquetas disponibles: ${available || "(ninguna sincronizada todavía)"}. ` +
      `Asegurate de tener la etiqueta creada en WhatsApp Business.`
    );
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anySock = sock as any;
  if (typeof anySock.addChatLabel !== "function") {
    console.warn("[bot] [label] addChatLabel no disponible en esta versión de Baileys");
    return;
  }

  await anySock.addChatLabel(jid, labelId);
  console.log(`[bot] [label] ✅ Etiqueta "${LABEL_TARGET}" (id=${labelId}) aplicada a ${jid}`);
}

// ─── Reclamo ──────────────────────────────────────────────────────────────────

async function handleComplaint(
  sock: WASocket,
  jid: string,
  conversationId: number,
  clientPhone: string,
  text: string,
  ownerPhone: string
): Promise<void> {
  console.log(`[bot] Reclamo detectado en conversación ${conversationId}`);
  setConversationMode(conversationId, "HUMAN");

  const reply = "Entiendo, déjame pasarte con un asesor para revisar tu caso de inmediato.";
  insertMessage(conversationId, "assistant", reply);
  await botSend(sock, jid, reply);

  const alert  = buildComplaintAlert(conversationId, clientPhone, text);
  const phones = getOwnerNotifyPhones(ownerPhone);

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

// ─── Multimedia entrante ────────────────────────────────────────────────────

async function handleIncomingMedia(
  sock: WASocket,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  msg: any,
  conversationId: number,
  kind: MediaKind
): Promise<void> {
  // Audio y stickers: no se descargan — guardamos un placeholder visible.
  if (kind === "audio" || kind === "sticker") {
    const label = kind === "audio" ? "🎤 Nota de voz" : "🌟 Sticker";
    insertMessage(conversationId, "user", label);
    incrementUnread(conversationId);
    advancePendingOutbox(conversationId);
    return;
  }

  let saved: Awaited<ReturnType<typeof saveIncomingMedia>> = null;
  try {
    saved = await saveIncomingMedia(sock, msg, conversationId);
  } catch (err) {
    console.error("[bot] Error descargando media entrante:", err);
  }

  if (saved) {
    insertMediaMessage(conversationId, "user", saved.caption, saved.media);
  } else {
    // No se pudo descargar (muy grande o error): placeholder con el tipo.
    const label = kind === "image" ? "📷 Foto" : kind === "video" ? "🎥 Video" : "📄 Documento";
    insertMessage(conversationId, "user", `${label} (no se pudo descargar)`);
  }
  incrementUnread(conversationId);
  advancePendingOutbox(conversationId);
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
