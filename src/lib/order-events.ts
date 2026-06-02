import { db } from "./db";

export type OrderEventType =
  | "PHOTO_CONFIRM_STARTED"
  | "PHOTO_CONFIRM_IMAGE_ADDED"
  | "PHOTO_CONFIRM_QUEUED"
  | "PHOTO_CONFIRM_PROCESSING"
  | "PHOTO_CONFIRM_COMPLETED"
  | "PHOTO_CONFIRM_CANCELLED"
  | "PHOTO_CONFIRM_ERROR"
  | "ORDER_CREATED"
  | "ORDER_UPDATED"
  | "ORDER_REPLACED"
  | "ORDER_DUPLICATE_DETECTED"
  | "ORDER_CANCELLED"
  | "ORDER_EDITED"
  | "ORDER_VALIDATION_FAILED"
  | "CONFIRMATION_PREVIEW_SENT_TO_OWNER"
  | "CONFIRMATION_SENT_TO_CLIENT"
  | "CONFIRMATION_RESENT_TO_CLIENT"
  | "CLIENT_CONFIRMED"
  | "OWNER_NOTIFICATION_STARTED"
  | "OWNER_NOTIFIED"
  | "OWNER_NOTIFICATION_ERROR";

export interface OrderEventInput {
  orderId?: number | null;
  conversationId?: number | null;
  eventType: OrderEventType;
  message?: string;
  metadata?: Record<string, unknown>;
}

const stmtInsert = db.prepare(`
  INSERT INTO order_events (order_id, conversation_id, event_type, message, metadata_json)
  VALUES (?, ?, ?, ?, ?)
`);

export function insertOrderEvent(input: OrderEventInput): void {
  try {
    stmtInsert.run(
      input.orderId   ?? null,
      input.conversationId ?? null,
      input.eventType,
      input.message   ?? null,
      input.metadata  ? JSON.stringify(input.metadata) : null
    );
  } catch (err) {
    console.error("[events] Error guardando evento:", err);
  }
}
