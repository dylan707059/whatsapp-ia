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
  listWaLabels,
  setWaLabelAssoc,
  setAppState
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
import type { Conversation } from "../types";

const AI_PAUSE_MINUTES = 30;

// Extrae el primer número de teléfono colombiano de un texto.
// Detecta: +573117678790  /  573117678790  /  3117678790  (con/sin espacios y guiones)
function extractColombianPhone(text: string): string | null {
  const patterns = [
    /\+?57[\s\-]?(3[\d]{2})[\s\-]?([\d]{3})[\s\-]?([\d]{4})/,  // con código de país
    /\b(3\d{2})[\s\-]?([\d]{3})[\s\-]?([\d]{4})\b/               // solo número local
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const digits = m[0].replace(/\D/g, "");
    if (digits.startsWith("57") && digits.length === 12) return digits;
    if (digits.startsWith("3")  && digits.length === 10) return `57${digits}`;
  }
  return null;
}

function isIndividualJid(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

// Extrae el número real (PN) de un mensaje cuyo remoteJid es @lid.
// WhatsApp suele incluir el número en campos "alt" del key. Probamos varios
// porque el nombre exacto cambió entre versiones de Baileys/WhatsApp.
function extractPnFromMsg(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  msg: any
): string | null {
  const k = msg?.key ?? {};
  const candidates: unknown[] = [
    k.remoteJidAlt, k.participantAlt, k.senderPn, k.participantPn,
    k.remoteJidPn, msg?.senderPn, msg?.participantPn
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.endsWith("@s.whatsapp.net")) {
      const d = c.split("@")[0].split(":")[0];
      if (/^\d{8,15}$/.test(d)) return d;
    }
  }
  return null;
}

// Intenta resolver un @lid a número real usando el mapa interno de Baileys
// (signalRepository.lidMapping), si la versión lo expone.
function lidMappingPn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sock: any,
  lidJid: string
): string | null {
  try {
    const lm = sock?.signalRepository?.lidMapping;
    const fn = lm?.getPNForLID ?? lm?.getPnForLid;
    if (typeof fn === "function") {
      const pn = fn.call(lm, lidJid);
      if (typeof pn === "string" && pn.includes("@")) {
        const d = pn.split("@")[0].split(":")[0];
        if (/^\d{8,15}$/.test(d)) return d;
      }
    }
  } catch { /* la versión no lo soporta */ }
  return null;
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

  // ─── Resolución temprana de @lid → número real ────────────────────────────
  // Si el mensaje llega por @lid, intentamos sacar el número real de los campos
  // extra del mensaje o del mapa interno de Baileys, y lo registramos YA. Así
  // resolvePhone() lo encuentra y el chat cae en el correcto, SIN duplicarse.
  if (jid.endsWith("@lid")) {
    const pn = extractPnFromMsg(msg) ?? lidMappingPn(sock, jid);
    if (pn) {
      try {
        registerContact(`${pn}@s.whatsapp.net`, jid);
        console.log(`[handler] LID ${jid} resuelto a ${pn} (campo del mensaje/Baileys)`);
      } catch { /* noop */ }
    } else {
      // No se pudo resolver: guardamos los nombres de campo del key para
      // descubrir cuál trae el número en esta versión de WhatsApp (diagnóstico).
      try {
        const keyFields = Object.keys(msg?.key ?? {});
        setAppState("last_unresolved_lid_keys", JSON.stringify({ jid, keyFields, at: Date.now() }));
      } catch { /* noop */ }
    }
  }

  // ─── Mensajes fromMe ─────────────────────────────────────────────────────
  // Mensajes enviados desde el celular del dueño (no desde el bot/dashboard).
  // Los guardamos como role="human" para que aparezcan en el dashboard, y
  // pausamos la IA en esa conv para no responder en paralelo.
  if (msg.key?.fromMe) {
    const msgId: string = msg.key?.id ?? "";
    if (isBotSentMessage(msgId)) return; // skip ecos de mensajes que mando el bot

    // Resolver la conv correcta para el destinatario.
    // Si el destinatario es @lid, buscamos la conv real por teléfono (contact-store)
    // para que el mensaje aparezca en el chat correcto del panel.
    let targetJid = jid;
    if (jid.endsWith("@lid")) {
      const resolved = resolvePhone(jid);
      const rawLid = jid.split("@")[0];
      if (resolved && resolved !== rawLid) {
        targetJid = resolved.includes("@") ? resolved : `${resolved}@s.whatsapp.net`;
      }
    }
    const conv = getOrCreateConversation(targetJid, null, ownerPhone);

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

  // ─── Resolver LID → phone real antes de crear conversación ───────────────
  // Si el JID es @lid y ya tenemos el mapping en contact-store, convertimos
  // al JID real (@s.whatsapp.net) ANTES de tocar la base de datos.
  // Esto evita crear conversaciones duplicadas cuando WhatsApp envía @lid.
  let effectiveJid = jid;
  if (jid.endsWith("@lid") && !isOwner) {
    const lidKey = jid.split("@")[0];
    if (senderPhone !== lidKey) {
      // resolvePhone devolvió un número real distinto al lidKey → tenemos mapping
      effectiveJid = `${senderPhone}@s.whatsapp.net`;
      console.log(`[handler] LID ${jid} resuelto a ${effectiveJid} desde contact-store`);
    } else {
      console.log(`[handler] LID sin resolver: ${jid} → pushName=${msg.pushName} | ownerPhones=${ownerPhones.join(",")}`);
    }
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
  if (isClientBlocked(effectiveJid)) {
    console.log(`[bot] Cliente bloqueado ${effectiveJid}, ignorando mensaje`);
    return;
  }

  // ─── Crear/obtener conversación ─────────────────────────────────────────────
  // Si el LID ya estaba resuelto (effectiveJid = @s.whatsapp.net), caemos
  // directamente en la conv correcta sin crear duplicado.
  // Si sigue siendo @lid, creamos conv temporal y luego deduplicamos.
  let convo = getOrCreateConversation(effectiveJid, pushName ?? null, ownerPhone);

  // ─── Deduplicación de conversación por LID ────────────────────────────────
  // Solo se activa cuando effectiveJid sigue siendo @lid (sin mapping previo).
  // Estrategias en orden de fiabilidad:
  //   1. Contact-store: WhatsApp ya nos dijo que @lid X = teléfono Y → match directo.
  //   2. Teléfono en el mensaje: Releasit manda mensajes con "📱 Teléfono: +57..."
  //   3. Nombre difuso: búsqueda en convs Shopify activas de los últimos 7 días.
  if (effectiveJid.endsWith("@lid")) {
    let shopifyConv: Conversation | undefined;

    // 1. Contact-store (puede haberse registrado entre la resolución inicial y aquí)
    const resolvedPhone2 = resolvePhone(effectiveJid);
    const rawLid2 = effectiveJid.split("@")[0];
    if (resolvedPhone2 && resolvedPhone2 !== rawLid2) {
      const phoneJid2 = resolvedPhone2.includes("@") ? resolvedPhone2 : `${resolvedPhone2}@s.whatsapp.net`;
      const byPhone = getConversationByPhone(phoneJid2, ownerPhone);
      if (byPhone && byPhone.id !== convo.id) {
        shopifyConv = byPhone;
        console.log(`[bot] LID ${jid} → ${resolvedPhone2} (contact-store) — conv #${byPhone.id}`);
      }
    }

    // 2. Teléfono extraído del texto (ej: mensaje de checkout de Releasit/Dropify)
    if (!shopifyConv && text?.trim()) {
      const extracted = extractColombianPhone(text);
      if (extracted) {
        const extractedJid = `${extracted}@s.whatsapp.net`;
        const byExtracted = getConversationByPhone(extractedJid, ownerPhone);
        if (byExtracted && byExtracted.id !== convo.id) {
          shopifyConv = byExtracted;
          console.log(`[bot] LID ${jid}: teléfono extraído "${extracted}" → conv #${byExtracted.id}`);
        }
      }
    }

    // 3. Nombre difuso en convs Shopify activas (últimos 7 días)
    if (!shopifyConv && pushName) {
      const byName = findRecentShopifyConversationByName(ownerPhone, pushName);
      if (byName && byName.id !== convo.id) {
        shopifyConv = byName;
        console.log(`[bot] LID ${jid}: nombre "${pushName}" → conv #${byName.id}`);
      }
    }

    if (shopifyConv) {
      registerContact(shopifyConv.phone, jid);
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
    await handleComplaint(sock, convo.phone, convo.id, senderPhone, text, ownerPhone);
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
    const snapJid    = convo.phone; // usar el JID real de la conv, no el LID
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
  await botSend(sock, convo.phone, reply);
  console.log(`[bot] → Enviado a ${convo.phone}`);

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

  // Releer order desde SQLite. CLAVE anti "el bot no responde": si el cliente
  // confirmó en un chat duplicado (@lid sin pedido), buscamos su pedido real en
  // el chat hermano por nombre y confirmamos ESE. Así el bot SIEMPRE responde y
  // avisa al dueño, sin importar en cuál de los chats duplicados haya escrito.
  console.log(`[bot] Releyendo order desde SQLite`);
  const ownerPhone = (sock.user?.id ?? "").split(":")[0];
  let orderConvId = conversationId;
  let activeOrder = getActiveOrder(conversationId);

  if (!activeOrder && fresh.name) {
    const realConv = findRecentShopifyConversationByName(ownerPhone, fresh.name);
    if (realConv && realConv.id !== conversationId) {
      const siblingOrder = getActiveOrder(realConv.id);
      if (siblingOrder) {
        orderConvId = realConv.id;
        activeOrder = siblingOrder;
        console.log(
          `[bot] Confirmación en chat #${conversationId} sin pedido; uso el pedido ` +
          `del chat real #${realConv.id} ("${fresh.name}")`
        );
      }
    }
  }

  const orderConvRow = orderConvId === conversationId ? fresh : getConversationById(orderConvId);
  const alreadyNotified = activeOrder?.owner_notified_at ?? orderConvRow?.owner_notified_at;

  if (alreadyNotified) {
    console.log(`[bot] Pedido ${activeOrder?.id ?? orderConvId} ya estaba notificado, se omite duplicado`);
    return;
  }

  // Obtener datos desde orders table o historial (del chat que tiene el pedido)
  let orderData = activeOrder ? orderFromRecord(activeOrder, orderConvId) : null;

  if (!orderData) {
    const history = getRecentHistory(orderConvId, 50);
    orderData = extractOrderData(history, orderConvId);
  }

  // Sin datos del pedido: no podemos confirmar nada. NO marcamos confirmed_at
  // para que el cliente pueda reintentar y el flujo no quede en silencio.
  if (!orderData) {
    console.warn(`[bot] Confirmación en conv ${conversationId} sin datos de pedido — se ignora`);
    return;
  }

  const missing = validateOrderData(orderData);

  // Pedido AI incompleto (sin registro en orders): pedimos los campos faltantes
  // y NO confirmamos todavía — el cliente puede completarlos y reintentar.
  // IMPORTANTE: para pedidos SHOPIFY (activeOrder existe) NUNCA bloqueamos por
  // campos faltantes: el dueño DEBE enterarse aunque Shopify haya mandado algún
  // dato vacío. De lo contrario el pedido se pierde (bot en silencio + sin aviso).
  if (missing.length > 0 && mode === "AI" && !activeOrder) {
    const reply = `Para confirmar tu pedido, solo me falta: ${missing.join(", ")}.`;
    insertMessage(conversationId, "assistant", reply);
    await botSend(sock, jid, reply);
    return;
  }

  // A partir de aquí SÍ confirmamos: marcamos el chat con el pedido (para que
  // los recordatorios paren) y también el chat donde escribió (para silenciarlo).
  if (!orderConvRow?.confirmed_at) setConfirmedAt(orderConvId);
  if (orderConvId !== conversationId && !fresh.confirmed_at) setConfirmedAt(conversationId);

  if (missing.length > 0) {
    console.warn(
      `[bot] Pedido SHOPIFY #${activeOrder?.id ?? "?"} confirmado con campos faltantes ` +
      `(${missing.join(", ")}) — se notifica al dueño igual para no perderlo`
    );
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
const LABEL_TARGET = process.env.WA_CONFIRM_LABEL ?? "Nuevo cliente";

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
  // Reflejar la asociación en el panel de inmediato (sin esperar el eco del evento).
  try { setWaLabelAssoc(ownerPhone, labelId, jid); } catch {}
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
