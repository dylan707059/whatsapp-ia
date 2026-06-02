import { db } from "./db";
import type { PhotoConfirmSession, PhotoSessionStatus } from "./types";

const SESSION_TTL        = 10 * 60; // 10 minutos en segundos
const SESSION_PREVIEW_TTL = 30 * 60; // 30 minutos cuando está en PREVIEW
const ACTIVE_STATUSES = [
  "WAITING_IMAGES", "QUEUED", "PROCESSING",
  "NEEDS_PHONE_SELECTION", "PREVIEW", "AWAITING_REPLACE_DECISION"
];

// ─── Consultas ────────────────────────────────────────────────────────────────

const stmtCreate = db.prepare(`
  INSERT INTO photo_confirm_sessions (owner_phone, target_phone, expires_at)
  VALUES (?, ?, ?)
`);

const stmtGetById = db.prepare<[number], PhotoConfirmSession>(
  "SELECT * FROM photo_confirm_sessions WHERE id = ?"
);

const stmtGetActive = db.prepare<[string, number], PhotoConfirmSession>(`
  SELECT * FROM photo_confirm_sessions
  WHERE owner_phone = ?
    AND expires_at > ?
    AND status IN ('WAITING_IMAGES','QUEUED','PROCESSING','NEEDS_PHONE_SELECTION')
  ORDER BY created_at DESC
  LIMIT 1
`);

const stmtUpdateStatus = db.prepare<[string, number]>(
  "UPDATE photo_confirm_sessions SET status = ? WHERE id = ?"
);

const stmtUpdatePaths = db.prepare<[string, number]>(
  "UPDATE photo_confirm_sessions SET image_paths = ? WHERE id = ?"
);

const stmtUpdateExtracted = db.prepare<[string, string | null, number]>(
  "UPDATE photo_confirm_sessions SET extracted_order_json = ?, detected_phones_json = ? WHERE id = ?"
);

const stmtExpireOld = db.prepare(
  `UPDATE photo_confirm_sessions SET status = 'EXPIRED'
   WHERE expires_at <= ? AND status IN ('WAITING_IMAGES','QUEUED')`
);

const stmtExtendTTL = db.prepare<[number, number]>(
  "UPDATE photo_confirm_sessions SET expires_at = ? WHERE id = ?"
);

const stmtSetTargetPhone = db.prepare<[string, number]>(
  "UPDATE photo_confirm_sessions SET target_phone = ? WHERE id = ?"
);

const stmtSetDuplicateOrderId = db.prepare<[number, number]>(
  "UPDATE photo_confirm_sessions SET duplicate_order_id = ? WHERE id = ?"
);

// ─── API ──────────────────────────────────────────────────────────────────────

export function createSession(
  ownerPhone: string,
  targetPhone?: string
): PhotoConfirmSession {
  const now       = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL;
  const info      = stmtCreate.run(ownerPhone, targetPhone ?? null, expiresAt);
  return stmtGetById.get(info.lastInsertRowid as number)!;
}

export function getSessionById(id: number): PhotoConfirmSession | undefined {
  return stmtGetById.get(id);
}

export function getActiveSessionForOwner(
  ownerPhone: string
): PhotoConfirmSession | undefined {
  const now = Math.floor(Date.now() / 1000);
  return stmtGetActive.get(ownerPhone, now);
}

export function isSessionActive(session: PhotoConfirmSession): boolean {
  return (
    ACTIVE_STATUSES.includes(session.status) &&
    session.expires_at > Math.floor(Date.now() / 1000)
  );
}

export function updateSessionStatus(
  id: number,
  status: PhotoSessionStatus
): void {
  stmtUpdateStatus.run(status, id);
}

export function addImageToSession(id: number, imagePath: string): void {
  const session = stmtGetById.get(id);
  if (!session) return;
  const paths: string[] = JSON.parse(session.image_paths || "[]");
  paths.push(imagePath);
  stmtUpdatePaths.run(JSON.stringify(paths), id);
}

export function getSessionImagePaths(session: PhotoConfirmSession): string[] {
  return JSON.parse(session.image_paths || "[]");
}

export function saveExtractedData(
  id: number,
  extractedJson: string,
  detectedPhonesJson: string | null
): void {
  stmtUpdateExtracted.run(extractedJson, detectedPhonesJson, id);
}

export function expireOldSessions(): void {
  stmtExpireOld.run(Math.floor(Date.now() / 1000));
}

export function extendSessionTTL(id: number): void {
  const newExpiry = Math.floor(Date.now() / 1000) + SESSION_PREVIEW_TTL;
  stmtExtendTTL.run(newExpiry, id);
}

export function setSessionTargetPhone(id: number, phone: string): void {
  stmtSetTargetPhone.run(phone, id);
}

export function setDuplicateOrderId(sessionId: number, orderId: number): void {
  stmtSetDuplicateOrderId.run(orderId, sessionId);
}

export function getSessionDetectedPhones(
  session: PhotoConfirmSession
): string[] {
  if (!session.detected_phones_json) return [];
  return JSON.parse(session.detected_phones_json);
}
