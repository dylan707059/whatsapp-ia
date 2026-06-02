import Database from "better-sqlite3";
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

const db = new Database(DB_PATH);

// ─── 1. DDL — siempre primero, antes de cualquier PRAGMA table_info ────────────
// CREATE TABLE IF NOT EXISTS incluye TODAS las columnas actuales.
// En DB nueva: crea las tablas completas (las migraciones serán no-op).
// En DB existente: no hace nada (IF NOT EXISTS).

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS conversations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    phone            TEXT UNIQUE NOT NULL,
    name             TEXT,
    mode             TEXT CHECK(mode IN ('AI','HUMAN')) NOT NULL DEFAULT 'AI',
    last_message_at  INTEGER,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    confirmed_at     INTEGER,
    owner_notified_at INTEGER,
    ai_paused_until  INTEGER,
    blocked_at       INTEGER
  );

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
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(sent, created_at);

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
}
{
  const cols = (db.prepare("PRAGMA table_info(orders)").all() as { name: string }[])
    .map(c => c.name);
  if (!cols.includes("source"))     db.exec("ALTER TABLE orders ADD COLUMN source TEXT");
  if (!cols.includes("order_hash")) db.exec("ALTER TABLE orders ADD COLUMN order_hash TEXT");
}
{
  const cols = (db.prepare("PRAGMA table_info(photo_confirm_sessions)").all() as { name: string }[])
    .map(c => c.name);
  if (!cols.includes("duplicate_order_id"))
    db.exec("ALTER TABLE photo_confirm_sessions ADD COLUMN duplicate_order_id INTEGER");
}

// ─── 3. Exportar instancia ────────────────────────────────────────────────────
export { db };

// ─── 4. Prepared statements (tablas ya garantizadas) ─────────────────────────

// Conversaciones
const stmtGetConvByPhone = db.prepare<[string], Conversation>(
  "SELECT * FROM conversations WHERE phone = ?"
);
const stmtInsertConv = db.prepare<[string, string | null], Conversation>(
  "INSERT INTO conversations (phone, name) VALUES (?, ?) RETURNING *"
);
const stmtUpdateConvName = db.prepare<[string | null, string]>(
  "UPDATE conversations SET name = ? WHERE phone = ?"
);
const stmtGetConvById = db.prepare<[number], Conversation>(
  "SELECT * FROM conversations WHERE id = ?"
);
const stmtSetMode = db.prepare<[string, number]>(
  "UPDATE conversations SET mode = ? WHERE id = ?"
);
const stmtListConversations = db.prepare<[], ConversationWithPreview>(`
  SELECT
    c.*,
    (SELECT content FROM messages
     WHERE conversation_id = c.id
     ORDER BY created_at DESC LIMIT 1) AS last_message_preview
  FROM conversations c
  ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
`);

export function getOrCreateConversation(phone: string, name?: string | null): Conversation {
  const existing = stmtGetConvByPhone.get(phone);
  if (existing) {
    if (name && name !== existing.name) {
      stmtUpdateConvName.run(name, phone);
      existing.name = name;
    }
    return existing;
  }
  return stmtInsertConv.all(phone, name ?? null)[0];
}
export function getConversationById(id: number): Conversation | undefined {
  return stmtGetConvById.get(id);
}
export function listConversations(): ConversationWithPreview[] {
  return stmtListConversations.all();
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
const stmtEnqueue = db.prepare<[number, string, string]>(
  "INSERT INTO outbox (conversation_id, phone, content) VALUES (?, ?, ?)"
);
const stmtPendingOutbox = db.prepare<[number], OutboxItem>(
  "SELECT * FROM outbox WHERE sent = 0 ORDER BY created_at ASC LIMIT ?"
);
const stmtMarkSent = db.prepare<[number]>(
  "UPDATE outbox SET sent = 1 WHERE id = ?"
);
export function enqueueOutbox(conversationId: number, phone: string, content: string): void {
  stmtEnqueue.run(conversationId, phone, content);
}
export function getPendingOutbox(limit = 20): OutboxItem[] {
  return stmtPendingOutbox.all(limit);
}
export function markOutboxSent(id: number): void {
  stmtMarkSent.run(id);
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
const stmtGetConvByJid= db.prepare<[string], Conversation>("SELECT * FROM conversations WHERE phone = ?");
export function setAiPausedUntil(conversationId: number, until: number): void {
  stmtSetAiPause.run(until, conversationId);
}
export function getConversationByPhone(phone: string): Conversation | undefined {
  return stmtGetConvByJid.get(phone);
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
