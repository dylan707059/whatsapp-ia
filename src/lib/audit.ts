import { db } from "./db";

export type AuditEventType =
  | "ORDER_CREATED"
  | "ORDER_CONFIRMED"
  | "ORDER_OWNER_NOTIFIED"
  | "ORDER_EDITED"
  | "ORDER_SENT"
  | "ORDER_RESENT"
  | "ORDER_DUPLICATE_DETECTED"
  | "CLIENT_BLOCKED"
  | "CLIENT_UNBLOCKED"
  | "PHOTO_SESSION_STARTED"
  | "PHOTO_SESSION_PREVIEW"
  | "PHOTO_SESSION_COMPLETED"
  | "PHOTO_SESSION_CANCELLED";

const stmtInsert = db.prepare(
  "INSERT INTO audit_log (event_type, phone, detail) VALUES (?, ?, ?)"
);

export function logAudit(
  eventType: AuditEventType,
  phone: string,
  detail?: string
): void {
  try {
    stmtInsert.run(eventType, phone, detail ?? null);
  } catch (err) {
    console.error("[audit] Error guardando evento:", err);
  }
}
