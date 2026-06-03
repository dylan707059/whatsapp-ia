import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import { DATA_DIR, DB_PATH } from "./paths";
import type {
  Conversation,
  ConversationWithPreview,
  Message,
  ConnectionState,
  OutboxItem,
  Order,
  OrderStatus,
  ConversationMode,
  MessageRole,
  ConnectionStatus
} from "./types";

export type {
  Conversation,
  ConversationWithPreview,
  Message,
  ConnectionState,
  OutboxItem,
  Order,
  OrderStatus
};

// paths.ts ya crea DATA_DIR si no existe
void DATA_DIR;

// ─── DB path resolver con fallback en build-time ──────────────────────────────
// Durante `next build` Next.js evalúa todas las rutas API para análisis
// estático. Eso ejecuta este módulo. En el sandbox de build de Render, el
// volumen persistente puede no estar montado/escribible y SQLite tira
// SQLITE_ERROR ("Failed to collect page data"). Detectamos esa fase y caemos
// a un DB temporal descartable — los prepared statements compilan, el build
// pasa, y en runtime real se usa DB_PATH normal.
function resolveDbPath(): string {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return path.join(os.tmpdir(), `next-build-${process.pid}.db`);
  }
  return DB_PATH;
}

const db = new Database(resolveDbPath());

// ─── 1. DDL — siempre primero, antes de cualquier PRAGMA table_info ────────────
// CREATE TABLE IF NOT EXISTS incluye TODAS las columnas actuales.
// En DB nueva: crea las tablas completas (las migraciones serán no-op).
// En DB existente: no hace nada (IF NOT EXISTS).

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS conversations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    phone            TEXT NOT NULL,
    owner_phone      TEXT NOT NULL DEFAULT '',
    name             TEXT,
    mode             TEXT CHECK(mode IN ('AI','HUMAN')) NOT NULL DEFAULT 'AI',
    last_message_at  INTEGER,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    confirmed_at     INTEGER,
    owner_notified_at INTEGER,
    ai_paused_until  INTEGER,
    blocked_at       INTEGER,
    archived_at      INTEGER,
    pinned_at        INTEGER,
    UNIQUE(phone, owner_phone)
  );

  CREATE TABLE IF NOT EXISTS labels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_phone TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '#5e6ad2',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_labels_owner ON labels(owner_phone);

  CREATE TABLE IF NOT EXISTS conversation_labels (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    label_id        INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (conversation_id, label_id)
  );

  CREATE INDEX IF NOT EXISTS idx_conv_labels_conv  ON conversation_labels(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_conv_labels_label ON conversation_labels(label_id);

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    role            TEXT CHECK(role IN ('user','assistant','human')) NOT NULL,
    content         TEXT NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv
    ON messages(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS connection_state (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    status     TEXT CHECK(status IN ('disconnected','qr','connecting','connected'))
               NOT NULL DEFAULT 'disconnected',
    qr_string  TEXT,
    phone      TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  INSERT OR IGNORE INTO connection_state (id, status) VALUES (1, 'disconnected');

  CREATE TABLE IF NOT EXISTS outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    phone           TEXT NOT NULL,
    content         TEXT NOT NULL,
    sent            INTEGER NOT NULL DEFAULT 0,
    scheduled_at    INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(sent, scheduled_at);

  CREATE TABLE IF NOT EXISTS orders (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id   INTEGER NOT NULL REFERENCES conversations(id),
    full_name         TEXT,
    first_name        TEXT,
    last_name         TEXT,
    phone             TEXT,
    product           TEXT,
    color             TEXT,
    size              TEXT,
    quantity          TEXT,
    total             TEXT,
    payment           TEXT,
    shipping          TEXT,
    address           TEXT,
    city              TEXT,
    department        TEXT,
    status            TEXT CHECK(status IN (
                        'DRAFT','PENDING_CONFIRMATION','CONFIRMED',
                        'OWNER_NOTIFIED','DISPATCHED','CANCELLED'
                      )) NOT NULL DEFAULT 'DRAFT',
    confirmed_at      INTEGER,
    owner_notified_at INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    source            TEXT,
    order_hash        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_orders_conv   ON orders(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_hash   ON orders(order_hash);

  CREATE TABLE IF NOT EXISTS photo_confirm_sessions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_phone          TEXT NOT NULL,
    target_phone         TEXT,
    status               TEXT NOT NULL DEFAULT 'WAITING_IMAGES',
    image_paths          TEXT NOT NULL DEFAULT '[]',
    extracted_order_json TEXT,
    detected_phones_json TEXT,
    duplicate_order_id   INTEGER,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at           INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_owner
    ON photo_confirm_sessions(owner_phone, status);

  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    phone      TEXT,
    detail     TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_audit_phone ON audit_log(phone, created_at);

  CREATE TABLE IF NOT EXISTS order_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER,
    conversation_id INTEGER,
    event_type      TEXT NOT NULL,
    message         TEXT,
    metadata_json   TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_order_events_conv  ON order_events(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS contact_lids (
    lid        TEXT PRIMARY KEY,
    phone      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// ─── 2. Migraciones — solo para bases de datos antiguas ───────────────────────
// En DB nueva el DDL ya incluyó todas las columnas, así que estos ALTER son no-op.
// En DB existente agregan columnas que faltaban en versiones anteriores.

{
  const cols = (db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[])
    .map(c => c.name);
  if (!cols.includes("confirmed_at"))      db.exec("ALTER TABLE conversations ADD COLUMN confirmed_at INTEGER");
  if (!cols.includes("owner_notified_at")) db.exec("ALTER TABLE conversations ADD COLUMN owner_notified_at INTEGER");
  if (!cols.includes("ai_paused_until"))   db.exec("ALTER TABLE conversations ADD COLUMN ai_paused_until INTEGER");
  if (!cols.includes("blocked_at"))        db.exec("ALTER TABLE conversations ADD COLUMN blocked_at INTEGER");
  if (!cols.includes("owner_phone"))       db.exec("ALTER TABLE conversations ADD COLUMN owner_phone TEXT NOT NULL DEFAULT ''");
  if (!cols.includes("archived_at"))       db.exec("ALTER TABLE conversations ADD COLUMN archived_at INTEGER");
  if (!cols.includes("pinned_at"))         db.exec("ALTER TABLE conversations ADD COLUMN pinned_at INTEGER");
}
{
  const cols = (db.prepare("PRAGMA table_info(orders)").all() as { name: string }[])
    .map(c => c.name);
  if (!cols.includes("source"))           db.exec("ALTER TABLE orders ADD COLUMN source TEXT");
  if (!cols.includes("order_hash"))       db.exec("ALTER TABLE orders ADD COLUMN order_hash TEXT");
  if (!cols.includes("reminder_count"))   db.exec("ALTER TABLE orders ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("last_reminder_at")) db.exec("ALTER TABLE orders ADD COLUMN last_reminder_at INTEGER");
}
{
  const cols = (db.prepare("PRAGMA table_info(photo_confirm_sessions)").all() as { name: string }[])
    .map(c => c.name);
  if (!cols.includes("duplicate_order_id"))
    db.exec("ALTER TABLE photo_confirm_sessions ADD COLUMN duplicate_order_id INTEGER");
}
{
  const cols = (db.prepare("PRAGMA table_info(outbox)").all() as { name: string }[])
    .map(c => c.name);
  if (!cols.includes("scheduled_at")) {
    db.exec("ALTER TABLE outbox ADD COLUMN scheduled_at INTEGER NOT NULL DEFAULT 0");
  }
}

// ─── 3. Exportar instancia ────────────────────────────────────────────────────
export { db };

// ─── 4. Prepared statements (tablas ya garantizadas) ─────────────────────────

// Conversaciones
const stmtGetConvByPhone = db.prepare<[string, string], Conversation>(
  "SELECT * FROM conversations WHERE phone = ? AND owner_phone = ?"
);
const stmtInsertConv = db.prepare<[string, string | null, string], Conversation>(
  "INSERT INTO conversations (phone, name, owner_phone) VALUES (?, ?, ?) RETURNING *"
);
const stmtUpdateConvName = db.prepare<[string | null, string, string]>(
  "UPDATE conversations SET name = ? WHERE phone = ? AND owner_phone = ?"
);
const stmtGetConvById = db.prepare<[number], Conversation>(
  "SELECT * FROM conversations WHERE id = ?"
);
const stmtSetMode = db.prepare<[string, number]>(
  "UPDATE conversations SET mode = ? WHERE id = ?"
);
const stmtListConversations = db.prepare<[string], ConversationWithPreview>(`
  SELECT
    c.*,
    (SELECT content FROM messages
     WHERE conversation_id = c.id
     ORDER BY created_at DESC LIMIT 1) AS last_message_preview
  FROM conversations c
  WHERE c.owner_phone = ?
    AND c.archived_at IS NULL
  ORDER BY
    c.pinned_at DESC NULLS LAST,
    c.last_message_at DESC NULLS LAST,
    c.created_at DESC
`);

const stmtListArchivedConversations = db.prepare<[string], ConversationWithPreview>(`
  SELECT
    c.*,
    (SELECT content FROM messages
     WHERE conversation_id = c.id
     ORDER BY created_at DESC LIMIT 1) AS last_message_preview
  FROM conversations c
  WHERE c.owner_phone = ?
    AND c.archived_at IS NOT NULL
  ORDER BY c.archived_at DESC
`);

const stmtCountArchived = db.prepare<[string], { count: number }>(
  "SELECT COUNT(*) as count FROM conversations WHERE owner_phone = ? AND archived_at IS NOT NULL"
);

const stmtArchiveConv   = db.prepare<[number]>("UPDATE conversations SET archived_at = unixepoch() WHERE id = ?");
const stmtUnarchiveConv = db.prepare<[number]>("UPDATE conversations SET archived_at = NULL WHERE id = ?");

export function getOrCreateConversation(phone: string, name?: string | null, ownerPhone = ""): Conversation {
  const existing = stmtGetConvByPhone.get(phone, ownerPhone);
  if (existing) {
    if (name && name !== existing.name) {
      stmtUpdateConvName.run(name, phone, ownerPhone);
      existing.name = name;
    }
    return existing;
  }
  return stmtInsertConv.all(phone, name ?? null, ownerPhone)[0];
}
export function getConversationById(id: number): Conversation | undefined {
  return stmtGetConvById.get(id);
}
export function listConversations(ownerPhone = ""): ConversationWithPreview[] {
  return stmtListConversations.all(ownerPhone);
}
export function listArchivedConversations(ownerPhone = ""): ConversationWithPreview[] {
  return stmtListArchivedConversations.all(ownerPhone);
}
export function countArchivedConversations(ownerPhone = ""): number {
  return stmtCountArchived.get(ownerPhone)?.count ?? 0;
}
export function archiveConversation(id: number): void {
  stmtArchiveConv.run(id);
}
export function unarchiveConversation(id: number): void {
  stmtUnarchiveConv.run(id);
}
export function setMode(conversationId: number, mode: ConversationMode): void {
  stmtSetMode.run(mode, conversationId);
}

// Mensajes
const stmtInsertMsg = db.prepare<[number, string, string]>(
  "INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)"
);
const stmtUpdateLastMsg = db.prepare<[number]>(
  "UPDATE conversations SET last_message_at = unixepoch() WHERE id = ?"
);
const stmtGetMessages = db.prepare<[number, number], Message>(`
  SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?
`);
const stmtGetHistory = db.prepare<[number, number], Message>(`
  SELECT * FROM (
    SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?
  ) sub ORDER BY created_at ASC
`);
const insertMessageTx = db.transaction(
  (conversationId: number, role: string, content: string): number => {
    const info = stmtInsertMsg.run(conversationId, role, content);
    stmtUpdateLastMsg.run(conversationId);
    return info.lastInsertRowid as number;
  }
);
export function insertMessage(conversationId: number, role: MessageRole, content: string): number {
  return insertMessageTx(conversationId, role, content);
}
export function getMessages(conversationId: number, limit = 50): Message[] {
  return stmtGetMessages.all(conversationId, limit);
}
export function getRecentHistory(conversationId: number, limit = 20): Message[] {
  return stmtGetHistory.all(conversationId, limit);
}

// Estado de conexión
const stmtGetConn = db.prepare<[], ConnectionState>(
  "SELECT * FROM connection_state WHERE id = 1"
);
const stmtSetConn = db.prepare<[ConnectionStatus, string | null, string | null]>(
  "UPDATE connection_state SET status = ?, qr_string = ?, phone = ?, updated_at = unixepoch() WHERE id = 1"
);
export function getConnectionState(): ConnectionState {
  return stmtGetConn.get()!;
}
export function setConnectionState(patch: {
  status: ConnectionStatus;
  qr_string?: string | null;
  phone?: string | null;
}): void {
  const current = getConnectionState();
  stmtSetConn.run(
    patch.status,
    patch.qr_string !== undefined ? patch.qr_string : current.qr_string,
    patch.phone     !== undefined ? patch.phone     : current.phone
  );
}

// Outbox
const stmtEnqueue = db.prepare<[number, string, string, number]>(
  "INSERT INTO outbox (conversation_id, phone, content, scheduled_at) VALUES (?, ?, ?, ?)"
);
const stmtPendingOutbox = db.prepare<[number], OutboxItem>(
  "SELECT * FROM outbox WHERE sent = 0 AND scheduled_at <= unixepoch() ORDER BY created_at ASC LIMIT ?"
);
const stmtMarkSent = db.prepare<[number]>(
  "UPDATE outbox SET sent = 1 WHERE id = ?"
);
const stmtClaimOutbox = db.prepare<[number]>(
  // Marca atómicamente como sent=1 si todavía no lo está. Devuelve 1 si lo
  // claimeamos exitosamente (este proceso es el responsable de enviarlo).
  "UPDATE outbox SET sent = 1 WHERE id = ? AND sent = 0"
);
const stmtAdvancePending = db.prepare<[number], { changes: number }>(
  "UPDATE outbox SET scheduled_at = 0 WHERE conversation_id = ? AND sent = 0 AND scheduled_at > unixepoch()"
);
const stmtFindRecentOutbox = db.prepare<[number, string, number], OutboxItem>(
  // Para dedup: busca si el mismo content fue encolado para la misma conv
  // en los últimos N segundos. Cubre tanto pendientes como ya enviados.
  "SELECT * FROM outbox WHERE conversation_id = ? AND content = ? AND created_at >= ? LIMIT 1"
);

/**
 * Encola un mensaje para envío vía outbox.
 * @param scheduledAt timestamp Unix en segundos. 0 (default) = enviar ASAP.
 *                   Cualquier valor > now hace que el poller espere hasta ese momento.
 * @returns true si se encoló; false si se descartó por duplicado reciente.
 */
export function enqueueOutbox(
  conversationId: number,
  phone: string,
  content: string,
  scheduledAt = 0
): boolean {
  // Dedup: si en los últimos 10 minutos ya pusimos exactamente este content
  // en outbox para la misma conv, NO encolamos otra vez. Evita disparos
  // duplicados desde flujos paralelos (Shopify webhook + IA, retry de webhook,
  // etc.) y evita reenviar al cliente.
  const since = Math.floor(Date.now() / 1000) - 600;
  const existing = stmtFindRecentOutbox.get(conversationId, content, since);
  if (existing) return false;

  stmtEnqueue.run(conversationId, phone, content, scheduledAt);
  return true;
}

export function getPendingOutbox(limit = 20): OutboxItem[] {
  return stmtPendingOutbox.all(limit);
}

export function markOutboxSent(id: number): void {
  stmtMarkSent.run(id);
}

/**
 * Intenta claimear un item de outbox para envío atómico (at-most-once).
 * Devuelve true si el caller debe enviar el mensaje; false si otro proceso
 * ya lo claimeó o ya fue enviado.
 */
export function claimOutboxItem(id: number): boolean {
  const result = stmtClaimOutbox.run(id);
  return result.changes > 0;
}

/**
 * Adelanta todos los mensajes pendientes (futuros) de una conversación
 * para que se envíen en el próximo tick del poller.
 * @returns cantidad de filas adelantadas.
 */
export function advancePendingOutbox(conversationId: number): number {
  const result = stmtAdvancePending.run(conversationId);
  return result.changes;
}

// Buscar conversación reciente con orden SHOPIFY pendiente y matching de nombre
// Se usa para deduplicar cuando un mensaje llega con JID @lid (que no matchea
// la conv creada por el webhook Shopify con @s.whatsapp.net).
const stmtFindShopifyByName = db.prepare<
  [string, string, number],
  Conversation
>(`
  SELECT c.*
  FROM conversations c
  WHERE c.owner_phone = ?
    AND LOWER(c.name) = LOWER(?)
    AND c.created_at >= ?
    AND EXISTS (
      SELECT 1 FROM orders o
      WHERE o.conversation_id = c.id
        AND o.source = 'SHOPIFY'
        AND o.status = 'PENDING_CONFIRMATION'
    )
  ORDER BY c.created_at DESC
  LIMIT 1
`);

export function findRecentShopifyConversationByName(
  ownerPhone: string,
  name: string,
  withinSeconds = 1800
): Conversation | undefined {
  if (!name) return undefined;
  const since = Math.floor(Date.now() / 1000) - withinSeconds;
  return stmtFindShopifyByName.get(ownerPhone, name, since);
}

// Borrar conversación
const stmtDelMessages     = db.prepare<[number]>("DELETE FROM messages WHERE conversation_id = ?");
const stmtDelOutboxPending= db.prepare<[number]>("DELETE FROM outbox WHERE conversation_id = ? AND sent = 0");
const stmtDelConversation = db.prepare<[number]>("DELETE FROM conversations WHERE id = ?");
const deleteConversationTx = db.transaction((id: number) => {
  stmtDelMessages.run(id);
  stmtDelOutboxPending.run(id);
  stmtDelConversation.run(id);
});
export function deleteConversation(id: number): void {
  deleteConversationTx(id);
}

// Confirmación de pedidos
const stmtSetConfirmedAt     = db.prepare<[number]>("UPDATE conversations SET confirmed_at = unixepoch() WHERE id = ?");
const stmtSetOwnerNotifiedAt = db.prepare<[number]>("UPDATE conversations SET owner_notified_at = unixepoch() WHERE id = ?");
export function setConfirmedAt(conversationId: number): void     { stmtSetConfirmedAt.run(conversationId); }
export function setOwnerNotifiedAt(conversationId: number): void { stmtSetOwnerNotifiedAt.run(conversationId); }

// Pausa de IA
const stmtSetAiPause  = db.prepare<[number, number]>("UPDATE conversations SET ai_paused_until = ? WHERE id = ?");
const stmtGetConvByJid = db.prepare<[string, string], Conversation>(
  "SELECT * FROM conversations WHERE phone = ? AND owner_phone = ?"
);
export function setAiPausedUntil(conversationId: number, until: number): void {
  stmtSetAiPause.run(until, conversationId);
}
export function getConversationByPhone(phone: string, ownerPhone = ""): Conversation | undefined {
  return stmtGetConvByJid.get(phone, ownerPhone);
}
export function setConversationMode(conversationId: number, mode: ConversationMode): void {
  stmtSetMode.run(mode, conversationId);
}

// Bloqueo de clientes
const stmtBlockClient  = db.prepare<[number]>("UPDATE conversations SET blocked_at = unixepoch() WHERE id = ?");
const stmtUnblockClient= db.prepare<[number]>("UPDATE conversations SET blocked_at = NULL WHERE id = ?");
const stmtIsBlocked    = db.prepare<[string], { blocked_at: number | null }>(
  "SELECT blocked_at FROM conversations WHERE phone = ?"
);
export function blockClient(conversationId: number): void   { stmtBlockClient.run(conversationId); }
export function unblockClient(conversationId: number): void { stmtUnblockClient.run(conversationId); }
export function isClientBlocked(jid: string): boolean {
  const row = stmtIsBlocked.get(jid);
  return row != null && row.blocked_at != null;
}

// ─── Pinear conversaciones ────────────────────────────────────────────────────
const stmtPinConv     = db.prepare<[number]>("UPDATE conversations SET pinned_at = unixepoch() WHERE id = ?");
const stmtUnpinConv   = db.prepare<[number]>("UPDATE conversations SET pinned_at = NULL WHERE id = ?");
const stmtCountPinned = db.prepare<[string], { count: number }>(
  "SELECT COUNT(*) as count FROM conversations WHERE owner_phone = ? AND pinned_at IS NOT NULL AND archived_at IS NULL"
);

export const MAX_PINNED = 5;

export function pinConversation(id: number): void   { stmtPinConv.run(id); }
export function unpinConversation(id: number): void { stmtUnpinConv.run(id); }
export function countPinnedConversations(ownerPhone = ""): number {
  return stmtCountPinned.get(ownerPhone)?.count ?? 0;
}

// ─── Etiquetas personalizadas ─────────────────────────────────────────────────
export interface Label {
  id: number;
  owner_phone: string;
  name: string;
  color: string;
  created_at: number;
}

const stmtListLabels = db.prepare<[string], Label>(
  "SELECT * FROM labels WHERE owner_phone = ? ORDER BY created_at ASC"
);
const stmtInsertLabel = db.prepare<[string, string, string], Label>(
  "INSERT INTO labels (owner_phone, name, color) VALUES (?, ?, ?) RETURNING *"
);
const stmtUpdateLabel = db.prepare<[string, string, number]>(
  "UPDATE labels SET name = ?, color = ? WHERE id = ?"
);
const stmtDeleteLabel = db.prepare<[number]>("DELETE FROM labels WHERE id = ?");
const stmtGetLabelById = db.prepare<[number], Label>("SELECT * FROM labels WHERE id = ?");

const stmtAttachLabel = db.prepare<[number, number]>(
  "INSERT OR IGNORE INTO conversation_labels (conversation_id, label_id) VALUES (?, ?)"
);
const stmtDetachLabel = db.prepare<[number, number]>(
  "DELETE FROM conversation_labels WHERE conversation_id = ? AND label_id = ?"
);
const stmtLabelsForConv = db.prepare<[number], Label>(`
  SELECT l.* FROM labels l
  JOIN conversation_labels cl ON cl.label_id = l.id
  WHERE cl.conversation_id = ?
  ORDER BY l.created_at ASC
`);
const stmtAllConvLabels = db.prepare<[string], Label & { conversation_id: number }>(`
  SELECT l.*, cl.conversation_id
  FROM labels l
  JOIN conversation_labels cl ON cl.label_id = l.id
  WHERE l.owner_phone = ?
`);

export function listLabels(ownerPhone = ""): Label[] {
  return stmtListLabels.all(ownerPhone);
}
export function createLabel(ownerPhone: string, name: string, color: string): Label {
  return stmtInsertLabel.all(ownerPhone, name, color)[0];
}
export function updateLabel(id: number, name: string, color: string): void {
  stmtUpdateLabel.run(name, color, id);
}
export function deleteLabel(id: number): void {
  stmtDeleteLabel.run(id);
}
export function getLabelById(id: number): Label | undefined {
  return stmtGetLabelById.get(id);
}
export function attachLabelToConversation(convId: number, labelId: number): void {
  stmtAttachLabel.run(convId, labelId);
}
export function detachLabelFromConversation(convId: number, labelId: number): void {
  stmtDetachLabel.run(convId, labelId);
}
export function getLabelsForConversation(convId: number): Label[] {
  return stmtLabelsForConv.all(convId);
}
/** Devuelve un mapa conversationId -> Label[] para todas las labels del owner.
 * Útil para enriquecer la lista de conversaciones sin N+1 queries. */
export function getAllConversationLabels(ownerPhone: string): Map<number, Label[]> {
  const map = new Map<number, Label[]>();
  for (const row of stmtAllConvLabels.all(ownerPhone)) {
    const list = map.get(row.conversation_id) ?? [];
    list.push({
      id: row.id, owner_phone: row.owner_phone, name: row.name,
      color: row.color, created_at: row.created_at
    });
    map.set(row.conversation_id, list);
  }
  return map;
}
