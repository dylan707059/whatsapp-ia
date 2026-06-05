// Tipos compartidos entre el bot, la API y los componentes del dashboard.
// Agregar aquí cualquier tipo nuevo antes de usarlo en más de un archivo.

export type ConversationMode = "AI" | "HUMAN";
export type MessageRole = "user" | "assistant" | "human";
export type ConnectionStatus = "disconnected" | "qr" | "connecting" | "connected";
export type OrderStatus =
  | "DRAFT"
  | "PENDING_CONFIRMATION"
  | "CONFIRMED"
  | "OWNER_NOTIFIED"
  | "DISPATCHED"
  | "CANCELLED";

export interface Conversation {
  id: number;
  phone: string;
  name: string | null;
  mode: ConversationMode;
  last_message_at: number | null;
  created_at: number;
  confirmed_at: number | null;
  owner_notified_at: number | null;
  ai_paused_until: number | null;
  blocked_at: number | null;
  owner_phone: string;
  archived_at: number | null;
  pinned_at: number | null;
  unread_count?: number;
  muted_at?: number | null;
}

export interface LabelLite {
  id: number;
  name: string;
  color: string;
}

export interface ConversationWithPreview extends Conversation {
  last_message_preview: string | null;
  order_phone: string | null;
  labels?: LabelLite[];
}

export interface Message {
  id: number;
  conversation_id: number;
  role: MessageRole;
  content: string;
  created_at: number;
  wa_msg_id?: string | null;
  wa_from_me?: number;
  // Multimedia (null/undefined = mensaje de solo texto)
  media_type?: string | null;       // 'image' | 'video' | 'document' | 'audio' | 'sticker'
  media_path?: string | null;
  media_mime?: string | null;
  media_filename?: string | null;
  media_size?: number | null;
}

export interface ConnectionState {
  id: number;
  status: ConnectionStatus;
  qr_string: string | null;
  phone: string | null;
  updated_at: number;
}

export interface OutboxItem {
  id: number;
  conversation_id: number;
  phone: string;
  content: string;
  sent: number;
  scheduled_at: number;
  message_id: number | null;
  expires_at: number;
  notify_owner: number;
  media_type?: string | null;
  media_path?: string | null;
  media_mime?: string | null;
  media_filename?: string | null;
  created_at: number;
}

export interface Order {
  id: number;
  conversation_id: number;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  product: string | null;
  color: string | null;
  size: string | null;
  quantity: string | null;
  total: string | null;
  payment: string | null;
  shipping: string | null;
  address: string | null;
  city: string | null;
  department: string | null;
  status: OrderStatus;
  confirmed_at: number | null;
  owner_notified_at: number | null;
  created_at: number;
  updated_at: number;
  source: string | null;
  order_hash: string | null;
  reminder_count: number;
  last_reminder_at: number | null;
}

// Datos estructurados extraídos del mensaje de confirmación del bot.
export interface OrderData {
  conversationId: number;
  fullName: string;
  firstName: string;
  lastName: string;
  phone: string;
  product: string;
  color: string;
  size: string;
  quantity: string;
  total: string;
  payment: string;
  shipping: string;
  address: string;
  city: string;
  department: string;
}

/**
 * Extrae la parte legible de un JID de WhatsApp para mostrar en la UI.
 * "573019230332@s.whatsapp.net" → "573019230332"
 * "215242420297952@lid"         → "215242420297952"
 */
export function jidToDisplay(jid: string): string {
  return jid.split("@")[0];
}

/**
 * Formatea un número en dígitos a una forma legible.
 * Colombia (57 + 10 dígitos): "573137941545" → "+57 313 794 1545".
 * 10 dígitos: "3137941545" → "313 794 1545".
 */
export function formatPhoneNumber(raw: string): string {
  const d = (raw || "").replace(/\D/g, "");
  if (d.startsWith("57") && d.length === 12) {
    const l = d.slice(2);
    return `+57 ${l.slice(0, 3)} ${l.slice(3, 6)} ${l.slice(6)}`;
  }
  if (d.length === 10) {
    return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  }
  return d;
}

/**
 * Título a mostrar para una conversación.
 * - @s.whatsapp.net → número formateado del JID.
 * - @lid → orderPhone si lo hay (viene de Shopify), sino nombre, sino "Contacto".
 * El orderPhone es el número más fiable para @lid: viene directamente del pedido.
 */
export function chatDisplayTitle(
  jid: string,
  name?: string | null,
  orderPhone?: string | null
): string {
  if (jid.endsWith("@s.whatsapp.net")) {
    return formatPhoneNumber(jid.split("@")[0]);
  }
  // @lid: preferir número del pedido (fuente más fiable)
  if (orderPhone?.trim()) {
    return formatPhoneNumber(orderPhone.trim());
  }
  const n = name?.trim();
  if (n) return n;
  const id = jid.split("@")[0];
  return id.length > 6 ? `Contacto …${id.slice(-4)}` : id;
}
