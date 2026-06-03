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
}

export interface LabelLite {
  id: number;
  name: string;
  color: string;
}

export interface ConversationWithPreview extends Conversation {
  last_message_preview: string | null;
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
