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
}

export interface ConversationWithPreview extends Conversation {
  last_message_preview: string | null;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: MessageRole;
  content: string;
  created_at: number;
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

export type PhotoSessionStatus =
  | "WAITING_IMAGES"
  | "QUEUED"
  | "PROCESSING"
  | "NEEDS_PHONE_SELECTION"
  | "PREVIEW"
  | "AWAITING_REPLACE_DECISION"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED"
  | "ERROR";

export interface PhotoConfirmSession {
  id: number;
  owner_phone: string;
  target_phone: string | null;
  status: PhotoSessionStatus;
  image_paths: string;           // JSON array de rutas de archivo
  extracted_order_json: string | null;
  detected_phones_json: string | null;
  duplicate_order_id: number | null;
  created_at: number;
  expires_at: number;
}

export interface ExtractedPhotoOrder {
  fullName: string;
  firstName: string;
  lastName: string;
  phone: string;
  detectedPhones: string[];
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
  confidence: "high" | "medium" | "low";
  missingFields: string[];
}

/**
 * Extrae la parte legible de un JID de WhatsApp para mostrar en la UI.
 * "573019230332@s.whatsapp.net" → "573019230332"
 * "215242420297952@lid"         → "215242420297952"
 */
export function jidToDisplay(jid: string): string {
  return jid.split("@")[0];
}
