import type { WASocket } from "@whiskeysockets/baileys";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import { getOrCreateConversation, insertMessage, getConversationByPhone } from "./db";
import {
  upsertOrder,
  getActiveOrder,
  findOrderByHash,
  computeOrderHash,
  setOrderStatus
} from "./orders";
import { validateOrderData } from "./order-confirmation";
import { buildClientConfirmationText } from "./confirmation-text";
import { extractOrderFromImages } from "./photo-openai";
import {
  createSession,
  getActiveSessionForOwner,
  getSessionById,
  updateSessionStatus,
  addImageToSession,
  getSessionImagePaths,
  saveExtractedData,
  getSessionDetectedPhones,
  extendSessionTTL,
  setSessionTargetPhone,
  setDuplicateOrderId
} from "./photo-sessions";
import { enqueueOrderTask } from "./queue";
import { botSend } from "./baileys/send";
import { normalizePhone, phoneForDisplay, phoneToJid } from "./phone-utils";
import { insertOrderEvent } from "./order-events";
import { withCustomerLock } from "./customer-lock";
import { TMP_ROOT } from "./paths";
import type { OrderData, ExtractedPhotoOrder } from "./types";
const SILENT_LOG = pino({ level: "silent" });

const ACCEPTED_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGES = 4;

// ─── Mapa de campos editables (español → clave ExtractedPhotoOrder) ────────────

const FIELD_MAP: Record<string, keyof ExtractedPhotoOrder> = {
  nombre:       "fullName",
  apellido:     "lastName",
  telefono:     "phone",
  producto:     "product",
  color:        "color",
  talla:        "size",
  cantidad:     "quantity",
  total:        "total",
  pago:         "payment",
  envio:        "shipping",
  direccion:    "address",
  ciudad:       "city",
  departamento: "department"
};

const FIELD_DISPLAY: Record<string, string> = {
  nombre: "Nombre", apellido: "Apellido", telefono: "Teléfono",
  producto: "Producto", color: "Color", talla: "Talla", cantidad: "Cantidad",
  total: "Total", pago: "Pago", envio: "Envío", direccion: "Dirección",
  ciudad: "Ciudad", departamento: "Departamento"
};

function normalizeFieldKey(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

// ─── Vista previa al owner ────────────────────────────────────────────────────

function buildPreviewText(data: ExtractedPhotoOrder, sessionId: number): string {
  const confLabel =
    data.confidence === "high"   ? "Alta ✅" :
    data.confidence === "medium" ? "Media ⚠️" : "Baja ❌";

  const phone = data.phone ? phoneForDisplay(data.phone) : "—";

  const lines: string[] = [
    "*VISTA PREVIA DEL PEDIDO*",
    "",
    "Revisé las fotos, pero necesito confirmación antes de enviar al cliente.",
    "",
    `*Cliente:* ${data.fullName || "—"}`,
    `*Teléfono:* ${phone}`,
    `*Producto:* ${data.product || "—"}`,
    `*Color:* ${data.color || "—"}`,
    `*Talla:* ${data.size || "—"}`,
    `*Cantidad:* ${data.quantity || "—"}`,
    `*Total:* ${data.total || "—"}`,
    `*Pago:* ${data.payment || "Contraentrega"}`,
    `*Envío:* ${data.shipping || "Gratis"}`,
    "",
    `*Dirección:* ${data.address || "—"}`,
    `*Ciudad:* ${data.city || "—"}`,
    `*Departamento:* ${data.department || "—"}`,
    "",
    `*Confianza:* ${confLabel}`
  ];

  if (data.missingFields.length > 0) {
    lines.push("", `*Faltan:* ${data.missingFields.join(", ")}`);
  }

  lines.push(
    "",
    "Si todo está correcto, responde:",
    "/enviarconfirmacion",
    "",
    "Si necesitas corregir algo, usa:",
    "/editar campo valor",
    "",
    "Ejemplos:",
    "/editar direccion Calle 10 # 5-20 barrio Centro",
    "/editar talla M",
    "/editar color Negro",
    "/editar telefono 3147823790"
  );

  void sessionId; // usado solo por el caller para logging
  return lines.join("\n");
}

// ─── Mensaje de duplicado ─────────────────────────────────────────────────────

function buildDuplicateText(
  dupOrder: import("./types").Order
): string {
  return [
    "*POSIBLE PEDIDO DUPLICADO*",
    "",
    "Este cliente ya tiene un pedido muy parecido:",
    "",
    `*Pedido:* #${dupOrder.id}`,
    `*Cliente:* ${dupOrder.full_name || "—"}`,
    `*Teléfono:* ${dupOrder.phone ? phoneForDisplay(dupOrder.phone) : "—"}`,
    `*Producto:* ${dupOrder.product || "—"}`,
    `*Color:* ${dupOrder.color || "—"}`,
    `*Talla:* ${dupOrder.size || "—"}`,
    `*Total:* ${dupOrder.total || "—"}`,
    `*Estado:* ${dupOrder.status}`,
    "",
    "Para reemplazarlo, responde:",
    "/reemplazar",
    "",
    "Para cancelar esta operación, responde:",
    "/cancelar"
  ].join("\n");
}

// ─── Manejo de imagen entrante del owner ─────────────────────────────────────

export async function handleOwnerImageMessage(
  sock: WASocket,
  ownerJid: string,
  ownerPhone: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  msg: any
): Promise<void> {
  const imageMsg = msg.message?.imageMessage;
  if (!imageMsg) return;

  const mime: string = imageMsg.mimetype ?? "image/jpeg";
  if (!ACCEPTED_MIMES.has(mime)) {
    await botSend(sock, ownerJid, "Solo puedo procesar imágenes JPG, PNG o WEBP para /fotoconfirmar.");
    return;
  }

  const session = getActiveSessionForOwner(ownerPhone);

  if (!session) {
    await botSend(sock, ownerJid,
      "Para confirmar un pedido con fotos, primero escribe /fotoconfirmar.\n\nLuego envía las fotos y termina con /listo."
    );
    return;
  }

  if (session.status === "QUEUED" || session.status === "PROCESSING") {
    await botSend(sock, ownerJid, "Esta sesión ya está en proceso. Espera el resultado.");
    return;
  }

  if (session.status === "PREVIEW" || session.status === "AWAITING_REPLACE_DECISION") {
    await botSend(sock, ownerJid,
      "Ya tienes datos pendientes de revisión. Usa /enviarconfirmacion, /editar, /reemplazar o /cancelar."
    );
    return;
  }

  const paths = getSessionImagePaths(session);
  if (paths.length >= MAX_IMAGES) {
    await botSend(sock, ownerJid, `Ya tienes ${MAX_IMAGES} fotos. Escribe /listo para procesar.`);
    return;
  }

  let buffer: Buffer;
  try {
    buffer = (await downloadMediaMessage(msg, "buffer", {}, {
      logger: SILENT_LOG,
      reuploadRequest: sock.updateMediaMessage
    })) as Buffer;
  } catch (err) {
    console.error("[bot] Error descargando imagen:", err);
    await botSend(sock, ownerJid, "No pude descargar la imagen. Intenta de nuevo.");
    return;
  }

  const ext     = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const dir     = path.join(TMP_ROOT, String(session.id));
  fs.mkdirSync(dir, { recursive: true });
  const imgPath = path.join(dir, `img_${paths.length}.${ext}`);
  fs.writeFileSync(imgPath, buffer);

  addImageToSession(session.id, imgPath);
  const newCount = paths.length + 1;

  insertOrderEvent({
    eventType: "PHOTO_CONFIRM_IMAGE_ADDED",
    message: `Imagen ${newCount} recibida`,
    metadata: { sessionId: session.id, ownerPhone, imageIndex: newCount }
  });

  await botSend(sock, ownerJid,
    `Foto ${newCount} recibida. Puedes enviar hasta ${MAX_IMAGES} fotos.\n\nEscribe /listo para procesar.`
  );
}

// ─── /fotoconfirmar ───────────────────────────────────────────────────────────

export async function cmdFotoConfirmar(
  sock: WASocket,
  ownerJid: string,
  ownerPhone: string,
  arg: string
): Promise<void> {
  const existing = getActiveSessionForOwner(ownerPhone);
  if (existing) {
    await botSend(sock, ownerJid,
      "Ya tienes una sesión activa.\n\nEscribe /listo para procesarla o /cancelar para cancelarla."
    );
    return;
  }

  const targetPhone = arg.trim() ? normalizePhone(arg.trim()) : undefined;
  const session = createSession(ownerPhone, targetPhone);

  insertOrderEvent({
    eventType: "PHOTO_CONFIRM_STARTED",
    message: "/fotoconfirmar iniciado",
    metadata: { sessionId: session.id, ownerPhone, targetPhone }
  });
  console.log(`[bot] /fotoconfirmar iniciado por ${ownerPhone} (sesión ${session.id})`);

  await botSend(sock, ownerJid,
    "Listo. Envíame las fotos del pedido y luego escribe /listo para procesarlas.\n\nPuedes enviar de 1 a 4 imágenes."
  );
}

// ─── /listo ───────────────────────────────────────────────────────────────────

export async function cmdListo(
  sock: WASocket,
  ownerJid: string,
  ownerPhone: string
): Promise<void> {
  const session = getActiveSessionForOwner(ownerPhone);

  if (!session) {
    await botSend(sock, ownerJid, "No tienes una sesión activa.\n\nPara iniciar, escribe /fotoconfirmar.");
    return;
  }

  const imagePaths = getSessionImagePaths(session);
  if (imagePaths.length === 0) {
    await botSend(sock, ownerJid, "No has enviado fotos todavía. Envía las imágenes del pedido primero.");
    return;
  }

  if (session.status === "QUEUED" || session.status === "PROCESSING") {
    await botSend(sock, ownerJid, "Esta sesión ya está en proceso. Espera el resultado.");
    return;
  }

  if (session.status === "PREVIEW") {
    await botSend(sock, ownerJid,
      "Ya tienes una vista previa lista. Usa /enviarconfirmacion para enviar o /editar para corregir datos."
    );
    return;
  }

  if (session.status === "AWAITING_REPLACE_DECISION") {
    await botSend(sock, ownerJid,
      "Hay un duplicado esperando tu decisión. Usa /reemplazar o /cancelar."
    );
    return;
  }

  updateSessionStatus(session.id, "QUEUED");
  insertOrderEvent({
    eventType: "PHOTO_CONFIRM_QUEUED",
    message: "/listo recibido, tarea encolada",
    metadata: { sessionId: session.id, ownerPhone, imageCount: imagePaths.length }
  });

  await botSend(sock, ownerJid,
    "Recibí tus fotos y tu pedido quedó en cola para procesarse.\n\nTe aviso apenas termine."
  );

  const sessionId   = session.id;
  const ownerPhone_ = ownerPhone;

  enqueueOrderTask(`fotoconfirmar:${sessionId}`, async () => {
    await processPhotoConfirmSession(sock, sessionId, ownerPhone_);
  });
}

// ─── /cancelar ────────────────────────────────────────────────────────────────

export async function cmdCancelar(
  sock: WASocket,
  ownerJid: string,
  ownerPhone: string
): Promise<void> {
  const session = getActiveSessionForOwner(ownerPhone);

  if (!session) {
    await botSend(sock, ownerJid, "No tienes una sesión activa.");
    return;
  }

  if (session.status === "PROCESSING") {
    await botSend(sock, ownerJid, "La sesión ya está siendo procesada. Espera el resultado.");
    return;
  }

  updateSessionStatus(session.id, "CANCELLED");
  cleanupSessionImages(session.id);

  insertOrderEvent({
    eventType: "PHOTO_CONFIRM_CANCELLED",
    message: "Sesión cancelada por el owner",
    metadata: { sessionId: session.id, ownerPhone }
  });
  await botSend(sock, ownerJid, "Sesión cancelada.");
}

// ─── /estadofoto ──────────────────────────────────────────────────────────────

export async function cmdEstadoFoto(
  sock: WASocket,
  ownerJid: string,
  ownerPhone: string
): Promise<void> {
  const session = getActiveSessionForOwner(ownerPhone);

  if (!session) {
    await botSend(sock, ownerJid,
      "No tienes una sesión activa.\n\nPara iniciar, escribe /fotoconfirmar."
    );
    return;
  }

  const count = getSessionImagePaths(session).length;
  await botSend(sock, ownerJid,
    `Tienes una sesión activa (${session.id}).\nFotos recibidas: ${count}.\nEstado: ${session.status}.\n\nEscribe /listo para procesar o /cancelar para cancelar.`
  );
}

// ─── /usartelefono N ──────────────────────────────────────────────────────────

export async function cmdUsarTelefono(
  sock: WASocket,
  ownerJid: string,
  ownerPhone: string,
  arg: string
): Promise<void> {
  const session = getActiveSessionForOwner(ownerPhone);

  if (!session || session.status !== "NEEDS_PHONE_SELECTION") {
    await botSend(sock, ownerJid, "No hay selección de teléfono pendiente.");
    return;
  }

  const idx = parseInt(arg.trim()) - 1;
  const detectedPhones = getSessionDetectedPhones(session);

  if (isNaN(idx) || idx < 0 || idx >= detectedPhones.length) {
    await botSend(sock, ownerJid, `Número inválido. Usa un número entre 1 y ${detectedPhones.length}.`);
    return;
  }

  const selectedPhone = normalizePhone(detectedPhones[idx]);
  setSessionTargetPhone(session.id, selectedPhone);
  updateSessionStatus(session.id, "QUEUED");

  await botSend(sock, ownerJid,
    `Usando teléfono ${phoneForDisplay(selectedPhone)}. Procesando...\n\nTe aviso cuando termine.`
  );

  const sessionId   = session.id;
  const ownerPhone_ = ownerPhone;

  enqueueOrderTask(`fotoconfirmar:${sessionId}`, async () => {
    await processPhotoConfirmSession(sock, sessionId, ownerPhone_);
  });
}

// ─── /editar campo valor ──────────────────────────────────────────────────────

export async function cmdEditar(
  sock: WASocket,
  ownerJid: string,
  ownerPhone: string,
  arg: string
): Promise<void> {
  const session = getActiveSessionForOwner(ownerPhone);

  if (!session || (session.status !== "PREVIEW" && session.status !== "AWAITING_REPLACE_DECISION")) {
    await botSend(sock, ownerJid,
      "No tienes un pedido en revisión.\n\nPrimero usa /fotoconfirmar y procesa las fotos."
    );
    return;
  }

  const parts = arg.trim().split(/\s+/);
  if (parts.length < 2) {
    await botSend(sock, ownerJid,
      "Uso: /editar campo valor\n\nCampos válidos:\nnombre, apellido, telefono, producto, color, talla, cantidad, total, pago, envio, direccion, ciudad, departamento\n\nEjemplo: /editar talla M"
    );
    return;
  }

  const fieldKey  = normalizeFieldKey(parts[0]);
  const newValue  = parts.slice(1).join(" ").trim();
  const mappedKey = FIELD_MAP[fieldKey];

  if (!mappedKey) {
    await botSend(sock, ownerJid,
      `No reconozco ese campo: "${parts[0]}"\n\nCampos permitidos:\nnombre, apellido, telefono, producto, color, talla, cantidad, total, pago, envio, direccion, ciudad, departamento`
    );
    return;
  }

  if (!session.extracted_order_json) {
    await botSend(sock, ownerJid, "Error: no hay datos extraídos en la sesión.");
    return;
  }

  const extracted = JSON.parse(session.extracted_order_json) as ExtractedPhotoOrder;

  if (mappedKey === "fullName") {
    // nombre completo → derivar firstName y lastName
    const words = newValue.trim().split(/\s+/);
    extracted.fullName   = newValue.trim();
    extracted.firstName  = words[0] ?? "";
    extracted.lastName   = words.slice(1).join(" ") ?? "";
  } else if (mappedKey === "lastName") {
    extracted.lastName = newValue;
    extracted.fullName = [extracted.firstName, newValue].filter(Boolean).join(" ");
  } else if (mappedKey === "phone") {
    const normPhone = normalizePhone(newValue);
    extracted.phone = normPhone;
    setSessionTargetPhone(session.id, normPhone);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (extracted as any)[mappedKey] = newValue;
  }

  // Quitar el campo de missingFields si ahora tiene valor
  extracted.missingFields = extracted.missingFields.filter(
    (f) => normalizeFieldKey(f) !== fieldKey
  );

  saveExtractedData(session.id, JSON.stringify(extracted), session.detected_phones_json);

  insertOrderEvent({
    eventType: "ORDER_EDITED",
    message: `Campo editado: ${fieldKey}`,
    metadata: { sessionId: session.id, ownerPhone, field: fieldKey, newValue }
  });

  const displayName = FIELD_DISPLAY[fieldKey] ?? fieldKey;
  const displayVal  = mappedKey === "phone" ? phoneForDisplay(extracted.phone) : newValue;

  await botSend(sock, ownerJid, [
    "Dato actualizado correctamente.",
    "",
    `*Campo:* ${displayName}`,
    `*Nuevo valor:* ${displayVal}`,
    "",
    "Para enviar la confirmación al cliente, responde:",
    "/enviarconfirmacion"
  ].join("\n"));
}

// ─── /enviarconfirmacion ──────────────────────────────────────────────────────

export async function cmdEnviarConfirmacion(
  sock: WASocket,
  ownerJid: string,
  ownerPhone: string
): Promise<void> {
  const session = getActiveSessionForOwner(ownerPhone);

  if (!session || session.status !== "PREVIEW") {
    await botSend(sock, ownerJid,
      "No hay vista previa activa. Primero procesa un pedido con /fotoconfirmar."
    );
    return;
  }

  if (!session.extracted_order_json) {
    await botSend(sock, ownerJid, "Error: no hay datos extraídos en la sesión.");
    return;
  }

  updateSessionStatus(session.id, "QUEUED");
  await botSend(sock, ownerJid, "Enviando confirmación al cliente. Te aviso cuando termine.");

  const sessionId   = session.id;
  const ownerPhone_ = ownerPhone;

  enqueueOrderTask(`enviarconfirmacion:${sessionId}`, async () => {
    await sendConfirmationFromSession(sock, sessionId, ownerPhone_);
  });
}

// ─── /reenviarconfirmacion TELEFONO ──────────────────────────────────────────

export async function cmdReenviarConfirmacion(
  sock: WASocket,
  ownerJid: string,
  ownerPhone: string,
  arg: string
): Promise<void> {
  if (!arg.trim()) {
    await botSend(sock, ownerJid,
      "Uso: /reenviarconfirmacion TELEFONO\n\nEjemplo: /reenviarconfirmacion 3147823790"
    );
    return;
  }

  const targetPhone = normalizePhone(arg.trim());
  const clientJid   = phoneToJid(targetPhone);
  const conv        = getConversationByPhone(clientJid);

  if (!conv) {
    await botSend(sock, ownerJid,
      `No encontré conversación para ${phoneForDisplay(targetPhone)}.`
    );
    return;
  }

  const order = getActiveOrder(conv.id);

  if (!order) {
    await botSend(sock, ownerJid,
      `No hay pedido activo para ${phoneForDisplay(targetPhone)}.`
    );
    return;
  }

  if (order.status === "CONFIRMED" || order.status === "OWNER_NOTIFIED" || order.status === "DISPATCHED") {
    await botSend(sock, ownerJid,
      `Ese pedido ya fue confirmado. No reenvié la confirmación.`
    );
    return;
  }

  if (order.status !== "PENDING_CONFIRMATION") {
    await botSend(sock, ownerJid,
      `El pedido #${order.id} está en estado ${order.status} y no se puede reenviar.`
    );
    return;
  }

  const orderData: OrderData = {
    conversationId: conv.id,
    fullName:   order.full_name   ?? "",
    firstName:  order.first_name  ?? "",
    lastName:   order.last_name   ?? "",
    phone:      order.phone       ?? targetPhone,
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

  const phone_ = targetPhone;
  const jid_   = clientJid;
  const orderId_ = order.id;
  const convId_ = conv.id;

  enqueueOrderTask(`reenviarconfirmacion:${targetPhone}`, async () => {
    await withCustomerLock(phone_, async () => {
      const confirmText = buildClientConfirmationText(orderData);

      await botSend(sock, jid_, confirmText);
      insertMessage(convId_, "assistant", confirmText);

      insertOrderEvent({
        orderId: orderId_,
        conversationId: convId_,
        eventType: "CONFIRMATION_RESENT_TO_CLIENT",
        message: "Confirmación reenviada al cliente",
        metadata: { phone: phone_, ownerPhone }
      });
      console.log(`[bot] Confirmación reenviada a ${phone_} (pedido #${orderId_})`);

      await botSend(sock, ownerJid,
        `Confirmación reenviada correctamente al cliente ${phoneForDisplay(phone_)} ✅\n\nEl cliente debe responder CONFIRMADO.`
      );
    });
  });
}

// ─── /reemplazar ──────────────────────────────────────────────────────────────

export async function cmdReemplazar(
  sock: WASocket,
  ownerJid: string,
  ownerPhone: string
): Promise<void> {
  const session = getActiveSessionForOwner(ownerPhone);

  if (!session || session.status !== "AWAITING_REPLACE_DECISION") {
    await botSend(sock, ownerJid,
      "No hay pedido duplicado esperando tu decisión. Usa /fotoconfirmar para iniciar."
    );
    return;
  }

  if (!session.extracted_order_json) {
    await botSend(sock, ownerJid, "Error: no hay datos extraídos en la sesión.");
    return;
  }

  // Cancelar pedido anterior
  if (session.duplicate_order_id) {
    setOrderStatus(session.duplicate_order_id, "CANCELLED");
    insertOrderEvent({
      orderId: session.duplicate_order_id,
      eventType: "ORDER_CANCELLED",
      message: "Cancelado para reemplazo por nuevo pedido",
      metadata: { replacedBySession: session.id, ownerPhone }
    });
    insertOrderEvent({
      orderId: session.duplicate_order_id,
      eventType: "ORDER_REPLACED",
      message: "Reemplazado con nuevo pedido",
      metadata: { sessionId: session.id }
    });
    console.log(`[bot] Pedido #${session.duplicate_order_id} cancelado para reemplazo`);
  }

  const extracted = JSON.parse(session.extracted_order_json) as ExtractedPhotoOrder;

  // Si confianza baja/media → ir a PREVIEW. Si alta → enviar directo.
  if (extracted.confidence !== "high") {
    updateSessionStatus(session.id, "PREVIEW");
    extendSessionTTL(session.id);

    insertOrderEvent({
      eventType: "CONFIRMATION_PREVIEW_SENT_TO_OWNER",
      message: "Vista previa tras reemplazar duplicado",
      metadata: { sessionId: session.id, ownerPhone, confidence: extracted.confidence }
    });

    const preview = buildPreviewText(extracted, session.id);
    await botSend(sock, ownerJid,
      `Pedido anterior cancelado ✅\n\nRevisa los datos antes de enviar al cliente:\n\n${preview}`
    );
    return;
  }

  // Alta confianza: ir directo a enviar
  updateSessionStatus(session.id, "QUEUED");
  await botSend(sock, ownerJid, "Pedido anterior cancelado ✅\n\nEnviando confirmación al cliente...");

  const sessionId   = session.id;
  const ownerPhone_ = ownerPhone;

  enqueueOrderTask(`reemplazar:${sessionId}`, async () => {
    await sendConfirmationFromSession(sock, sessionId, ownerPhone_);
  });
}

// ─── Procesamiento principal (dentro de la cola) ──────────────────────────────

async function processPhotoConfirmSession(
  sock: WASocket,
  sessionId: number,
  ownerPhone: string
): Promise<void> {
  const ownerJid = `${ownerPhone}@s.whatsapp.net`;
  const session  = getSessionById(sessionId);

  if (!session) {
    console.error(`[bot] Sesión ${sessionId} no encontrada en cola`);
    return;
  }

  updateSessionStatus(sessionId, "PROCESSING");
  insertOrderEvent({
    eventType: "PHOTO_CONFIRM_PROCESSING",
    message: "Procesando fotos con OpenAI",
    metadata: { sessionId, ownerPhone }
  });
  await botSend(sock, ownerJid, "Estoy procesando las fotos del pedido. Un momento por favor.");

  const imagePaths = getSessionImagePaths(session);

  let extracted: ExtractedPhotoOrder;
  try {
    extracted = await extractOrderFromImages(imagePaths, session.target_phone ?? undefined);
  } catch (err) {
    console.error(`[bot] Error extrayendo datos:`, err);
    insertOrderEvent({
      eventType: "PHOTO_CONFIRM_ERROR",
      message: "Error al procesar imágenes con OpenAI",
      metadata: { sessionId, ownerPhone, error: String(err) }
    });
    await botSend(sock, ownerJid,
      "Hubo un error al procesar las imágenes. Intenta de nuevo con /fotoconfirmar."
    );
    updateSessionStatus(sessionId, "ERROR");
    cleanupSessionImages(sessionId);
    return;
  }

  console.log(`[bot] Sesión ${sessionId} — confianza: ${extracted.confidence}, teléfonos: ${extracted.detectedPhones.join(", ") || "ninguno"}`);

  saveExtractedData(sessionId, JSON.stringify(extracted), JSON.stringify(extracted.detectedPhones));

  // ─── Resolver teléfono del cliente ────────────────────────────────────────
  let finalPhone = "";
  const targetPhone = session.target_phone;

  if (targetPhone) {
    const normTarget   = normalizePhone(targetPhone);
    const normDetected = extracted.detectedPhones.map(normalizePhone);

    if (normDetected.length > 0 && !normDetected.includes(normTarget)) {
      await botSend(sock, ownerJid, [
        "El teléfono de la captura no coincide con el que escribiste.",
        "",
        `Teléfono del comando: ${phoneForDisplay(normTarget)}`,
        `Detectado en fotos: ${extracted.detectedPhones.map(p => phoneForDisplay(normalizePhone(p))).join(", ")}`,
        "",
        "Revisa antes de enviar."
      ].join("\n"));
      insertOrderEvent({
        eventType: "PHOTO_CONFIRM_ERROR",
        message: "Teléfono del comando no coincide con foto",
        metadata: { sessionId, commandPhone: normTarget }
      });
      updateSessionStatus(sessionId, "ERROR");
      cleanupSessionImages(sessionId);
      return;
    }
    finalPhone = normTarget;
  } else if (extracted.detectedPhones.length > 1 && !extracted.phone) {
    updateSessionStatus(sessionId, "NEEDS_PHONE_SELECTION");

    const list = extracted.detectedPhones
      .map((p, i) => `${i + 1}. ${phoneForDisplay(normalizePhone(p))}`)
      .join("\n");

    await botSend(sock, ownerJid, [
      "Detecté varios teléfonos en las fotos:",
      "",
      list,
      "",
      "Responde con:\n/usartelefono 1",
      "",
      "O cancela con:\n/cancelar"
    ].join("\n"));
    return;
  } else if (extracted.phone) {
    finalPhone = normalizePhone(extracted.phone);
  } else if (extracted.detectedPhones.length === 1) {
    finalPhone = normalizePhone(extracted.detectedPhones[0]);
  }

  if (!finalPhone) {
    await botSend(sock, ownerJid, [
      "No pude detectar el teléfono del cliente en las fotos.",
      "",
      "Puedes:",
      "1. Enviar una foto más clara.",
      "2. Escribir /cancelar y volver a iniciar.",
      "3. Usar /fotoconfirmar TELEFONO para indicarlo manualmente."
    ].join("\n"));
    insertOrderEvent({
      eventType: "PHOTO_CONFIRM_ERROR",
      message: "No se pudo detectar teléfono",
      metadata: { sessionId, ownerPhone }
    });
    updateSessionStatus(sessionId, "ERROR");
    cleanupSessionImages(sessionId);
    return;
  }

  // Fijar teléfono final en sesión y en extracted
  extracted.phone = finalPhone;
  if (!session.target_phone) setSessionTargetPhone(sessionId, finalPhone);
  saveExtractedData(sessionId, JSON.stringify(extracted), JSON.stringify(extracted.detectedPhones));

  // ─── Detección de duplicado por hash ──────────────────────────────────────
  const hash = computeOrderHash({
    phone:      finalPhone,
    product:    extracted.product,
    color:      extracted.color,
    size:       extracted.size,
    quantity:   extracted.quantity,
    total:      extracted.total,
    address:    extracted.address,
    city:       extracted.city,
    department: extracted.department
  });

  const dupOrder = findOrderByHash(hash);

  if (dupOrder) {
    updateSessionStatus(sessionId, "AWAITING_REPLACE_DECISION");
    setDuplicateOrderId(sessionId, dupOrder.id);
    extendSessionTTL(sessionId);

    insertOrderEvent({
      orderId: dupOrder.id,
      eventType: "ORDER_DUPLICATE_DETECTED",
      message: "Hash duplicado detectado",
      metadata: { sessionId, ownerPhone, existingOrderId: dupOrder.id, hash }
    });
    console.log(`[bot] Duplicado detectado: pedido #${dupOrder.id} tiene el mismo hash`);

    await botSend(sock, ownerJid, buildDuplicateText(dupOrder));
    return;
  }

  // ─── Sin duplicado: confianza alta → enviar directo ───────────────────────
  if (extracted.confidence === "high") {
    await sendConfirmationFromSession(sock, sessionId, ownerPhone);
    return;
  }

  // ─── Confianza media/baja → vista previa ──────────────────────────────────
  updateSessionStatus(sessionId, "PREVIEW");
  extendSessionTTL(sessionId);

  insertOrderEvent({
    eventType: "CONFIRMATION_PREVIEW_SENT_TO_OWNER",
    message: `Vista previa enviada (confianza ${extracted.confidence})`,
    metadata: { sessionId, ownerPhone, confidence: extracted.confidence, missingFields: extracted.missingFields }
  });
  console.log(`[bot] Vista previa enviada al owner (confianza ${extracted.confidence})`);

  await botSend(sock, ownerJid, buildPreviewText(extracted, sessionId));
}

// ─── Envío real al cliente ────────────────────────────────────────────────────

async function sendConfirmationFromSession(
  sock: WASocket,
  sessionId: number,
  ownerPhone: string
): Promise<void> {
  const ownerJid = `${ownerPhone}@s.whatsapp.net`;
  const session  = getSessionById(sessionId);

  if (!session || !session.extracted_order_json) {
    await botSend(sock, ownerJid, "Error: datos de sesión no encontrados.");
    return;
  }

  const extracted  = JSON.parse(session.extracted_order_json) as ExtractedPhotoOrder;
  const finalPhone = session.target_phone ?? extracted.phone;

  if (!finalPhone) {
    await botSend(sock, ownerJid, "Error: no hay teléfono del cliente en la sesión.");
    insertOrderEvent({ eventType: "PHOTO_CONFIRM_ERROR", message: "Sin teléfono al intentar enviar", metadata: { sessionId } });
    updateSessionStatus(sessionId, "ERROR");
    cleanupSessionImages(sessionId);
    return;
  }

  const normPhone = normalizePhone(finalPhone);

  await withCustomerLock(normPhone, async () => {
    const clientJid = phoneToJid(normPhone);
    const conv      = getOrCreateConversation(clientJid, extracted.fullName || null);

    const orderData: OrderData = {
      conversationId: conv.id,
      fullName:   extracted.fullName,
      firstName:  extracted.firstName,
      lastName:   extracted.lastName,
      phone:      normPhone,
      product:    extracted.product,
      color:      extracted.color,
      size:       extracted.size,
      quantity:   extracted.quantity,
      total:      extracted.total,
      payment:    extracted.payment  || "Contraentrega",
      shipping:   extracted.shipping || "Gratis",
      address:    extracted.address,
      city:       extracted.city,
      department: extracted.department
    };

    // ─── Validar datos obligatorios ──────────────────────────────────────
    const missing = validateOrderData(orderData);

    if (missing.length > 0) {
      const list = missing.map(m => `- ${m}`).join("\n");
      updateSessionStatus(sessionId, "PREVIEW");
      extendSessionTTL(sessionId);

      insertOrderEvent({
        conversationId: conv.id,
        eventType: "ORDER_VALIDATION_FAILED",
        message: "Faltan datos obligatorios",
        metadata: { sessionId, missingFields: missing }
      });

      await botSend(sock, ownerJid, [
        "No pude enviar la confirmación porque faltan estos datos:",
        "",
        list,
        "",
        "Corrígelos con /editar y luego escribe /enviarconfirmacion",
        "",
        "O cancela con /cancelar"
      ].join("\n"));
      return;
    }

    // ─── Enviar confirmación al cliente ───────────────────────────────────
    const confirmText = buildClientConfirmationText(orderData);

    console.log(`[bot] Enviando confirmación al cliente ${normPhone}`);
    await botSend(sock, clientJid, confirmText);
    insertMessage(conv.id, "assistant", confirmText);

    // ─── Guardar pedido ────────────────────────────────────────────────────
    const orderId = upsertOrder(conv.id, orderData, "PENDING_CONFIRMATION", "PHOTO_CONFIRM_COMMAND");

    insertOrderEvent({
      orderId,
      conversationId: conv.id,
      eventType: "ORDER_CREATED",
      message: "Pedido creado desde /fotoconfirmar",
      metadata: { sessionId, ownerPhone, source: "PHOTO_CONFIRM_COMMAND" }
    });
    insertOrderEvent({
      orderId,
      conversationId: conv.id,
      eventType: "CONFIRMATION_SENT_TO_CLIENT",
      message: "Confirmación enviada al cliente",
      metadata: { phone: normPhone, source: "PHOTO_CONFIRM_COMMAND" }
    });
    console.log(`[bot] Pedido #${orderId} guardado como PENDING_CONFIRMATION`);

    // ─── Cerrar sesión ─────────────────────────────────────────────────────
    updateSessionStatus(sessionId, "COMPLETED");
    cleanupSessionImages(sessionId);

    insertOrderEvent({
      orderId,
      conversationId: conv.id,
      eventType: "PHOTO_CONFIRM_COMPLETED",
      message: "Sesión completada",
      metadata: { sessionId, ownerPhone }
    });

    await botSend(sock, ownerJid, [
      `Confirmación enviada correctamente al cliente ${phoneForDisplay(normPhone)}. ✅`,
      "",
      "El pedido quedó pendiente de que el cliente responda CONFIRMADO.",
      "",
      `Cliente: ${orderData.fullName || phoneForDisplay(normPhone)}`,
      `Producto: ${orderData.product}`,
      `Total: ${orderData.total}`,
      `Ciudad: ${orderData.city}`
    ].join("\n"));

    console.log(`[bot] Sesión ${sessionId} completada`);
  });
}

// ─── Limpieza de imágenes temporales ─────────────────────────────────────────

function cleanupSessionImages(sessionId: number): void {
  try {
    const dir = path.join(TMP_ROOT, String(sessionId));
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[bot] Error borrando imágenes de sesión ${sessionId}:`, err);
  }
}
