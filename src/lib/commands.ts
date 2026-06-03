import type { WASocket } from "@whiskeysockets/baileys";
import {
  getConversationByPhone,
  setConversationMode,
  blockClient,
  unblockClient
} from "./db";
import { getOrderByPhone, getTodayStats } from "./orders";
import { botSend } from "./baileys/send";
import { normalizePhone, phoneForDisplay, phoneToJid } from "./phone-utils";
import { logAudit } from "./audit";

// ─── Router de comandos ───────────────────────────────────────────────────────

export async function handleOwnerCommand(
  sock: WASocket,
  fromJid: string,
  ownerPhone: string,
  text: string
): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const arg   = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "/resumen":
      await botSend(sock, fromJid, await cmdResumen());
      break;

    case "/pedido":
      await botSend(sock, fromJid, await cmdPedido(arg));
      break;

    case "/humano":
      await botSend(sock, fromJid, await cmdSetMode(arg, "HUMAN"));
      break;

    case "/ia":
      await botSend(sock, fromJid, await cmdSetMode(arg, "AI"));
      break;

    case "/bloquear":
      await cmdBloquear(sock, fromJid, ownerPhone, arg);
      break;

    case "/desbloquear":
      await cmdDesbloquear(sock, fromJid, ownerPhone, arg);
      break;

    default:
      await botSend(sock, fromJid, [
        "Comandos disponibles:",
        "/resumen",
        "/pedido TELEFONO",
        "/humano TELEFONO",
        "/ia TELEFONO",
        "/bloquear TELEFONO",
        "/desbloquear TELEFONO"
      ].join("\n"));
  }
}

// ─── Implementaciones ─────────────────────────────────────────────────────────

async function cmdResumen(): Promise<string> {
  const stats = getTodayStats();
  return [
    "*Resumen de hoy*",
    "",
    `Total: ${stats.total}`,
    `Pendientes: ${stats.pending}`,
    `Confirmados: ${stats.confirmed}`,
    `Notificados: ${stats.notified}`,
    `Despachados: ${stats.dispatched}`
  ].join("\n");
}

async function cmdPedido(phoneArg: string): Promise<string> {
  if (!phoneArg) return "Uso: /pedido TELEFONO";
  const phone = phoneArg.replace(/[\s\-+]/g, "");
  const order = getOrderByPhone(phone);
  if (!order) return `No se encontró pedido para ${phone}.`;

  return [
    `*Pedido #${order.id}*`,
    `*Estado:* ${order.status}`,
    `*Cliente:* ${order.full_name ?? "—"}`,
    `*Teléfono:* ${order.phone ?? "—"}`,
    `*Producto:* ${order.product ?? "—"}`,
    `*Color:* ${order.color ?? "—"}`,
    `*Talla:* ${order.size ?? "—"}`,
    `*Total:* ${order.total ?? "—"}`,
    `*Dirección:* ${order.address ?? "—"}`,
    `*Ciudad:* ${order.city ?? "—"}`
  ].join("\n");
}

async function cmdSetMode(phoneArg: string, mode: "AI" | "HUMAN"): Promise<string> {
  if (!phoneArg) return `Uso: /${mode.toLowerCase()} TELEFONO`;
  const phone = phoneArg.replace(/[\s\-+]/g, "");
  const conv  =
    getConversationByPhone(`${phone}@s.whatsapp.net`) ??
    getConversationByPhone(`${phone}@lid`);
  if (!conv) return `No se encontró conversación para ${phone}.`;
  setConversationMode(conv.id, mode);
  return `Conversación de ${phone} pasada a modo *${mode}* ✓`;
}

async function cmdBloquear(
  sock: WASocket,
  ownerJid: string,
  ownerPhone: string,
  phoneArg: string
): Promise<void> {
  if (!phoneArg) {
    await botSend(sock, ownerJid, "Uso: /bloquear TELEFONO");
    return;
  }

  const normPhone = normalizePhone(phoneArg.trim());
  const jid = phoneToJid(normPhone);
  const conv =
    getConversationByPhone(jid) ??
    getConversationByPhone(`${normPhone}@lid`);

  if (!conv) {
    await botSend(sock, ownerJid,
      `No se encontró conversación para ${phoneForDisplay(normPhone)}.`
    );
    return;
  }

  blockClient(conv.id);
  logAudit("CLIENT_BLOCKED", normPhone, `por=${ownerPhone}`);
  console.log(`[bot] Cliente ${normPhone} bloqueado por ${ownerPhone}`);

  await botSend(sock, ownerJid,
    `Cliente ${phoneForDisplay(normPhone)} bloqueado. El bot ya no responderá a sus mensajes.`
  );
}

async function cmdDesbloquear(
  sock: WASocket,
  ownerJid: string,
  ownerPhone: string,
  phoneArg: string
): Promise<void> {
  if (!phoneArg) {
    await botSend(sock, ownerJid, "Uso: /desbloquear TELEFONO");
    return;
  }

  const normPhone = normalizePhone(phoneArg.trim());
  const jid = phoneToJid(normPhone);
  const conv =
    getConversationByPhone(jid) ??
    getConversationByPhone(`${normPhone}@lid`);

  if (!conv) {
    await botSend(sock, ownerJid,
      `No se encontró conversación para ${phoneForDisplay(normPhone)}.`
    );
    return;
  }

  unblockClient(conv.id);
  logAudit("CLIENT_UNBLOCKED", normPhone, `por=${ownerPhone}`);
  console.log(`[bot] Cliente ${normPhone} desbloqueado por ${ownerPhone}`);

  await botSend(sock, ownerJid,
    `Cliente ${phoneForDisplay(normPhone)} desbloqueado. El bot volverá a responderle.`
  );
}
