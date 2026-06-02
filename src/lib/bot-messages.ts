// Registro en memoria de IDs de mensajes enviados por el bot.
// Permite distinguir respuestas automáticas del bot de mensajes manuales
// del operador humano (ambos llegan como fromMe=true en Baileys).

const sentIds = new Set<string>();

export function registerBotMessage(id: string): void {
  sentIds.add(id);
  // Limpiar después de 10 minutos para evitar fuga de memoria
  setTimeout(() => sentIds.delete(id), 10 * 60 * 1000);
}

export function isBotSentMessage(id: string): boolean {
  return sentIds.has(id);
}
