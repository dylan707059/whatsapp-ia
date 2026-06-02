import type { WASocket } from "@whiskeysockets/baileys";
import { registerBotMessage } from "../bot-messages";

// Wrapper compartido para enviar mensajes y registrar el ID
// en el registro de mensajes del bot (distingue bot vs humano en fromMe).
export async function botSend(
  sock: WASocket,
  jid: string,
  text: string
): Promise<void> {
  const result = await sock.sendMessage(jid, { text });
  if (result?.key?.id) registerBotMessage(result.key.id);
}
