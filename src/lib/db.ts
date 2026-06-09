import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import { DATA_DIR, DB_PATH } from "./paths";
import { hashPassword, generateSessionToken } from "./auth";
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
    unread_count     INTEGER NOT NULL DEFAULT 0,
    muted_at         INTEGER,
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
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    wa_msg_id       TEXT,
    wa_from_me      INTEGER NOT NULL DEFAULT 0,
    media_type      TEXT,
    media_path      TEXT,
    media_mime      TEXT,
    media_filename  TEXT,
    media_size      INTEGER
  );

  CREATE TABLE IF NOT EXISTS revoke_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    remote_jid      TEXT NOT NULL,
    wa_msg_id       TEXT NOT NULL,
    wa_from_me      INTEGER NOT NULL DEFAULT 1,
    processed       INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_revoke_pending ON revoke_queue(processed, created_at);

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
    message_id      INTEGER,
    expires_at      INTEGER NOT NULL DEFAULT 0,
    notify_owner    INTEGER NOT NULL DEFAULT 0,
    media_type      TEXT,
    media_path      TEXT,
    media_mime      TEXT,
    media_filename  TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Estado clave/valor del proceso (ej: latido del bot para detectar caídas).
  CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT
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

  -- Etiquetas nativas de WhatsApp Business capturadas vía eventos labels.edit.
  -- Se usan para etiquetar chats en el WhatsApp real (no en el panel).
  CREATE TABLE IF NOT EXISTS wa_labels (
    owner_phone   TEXT NOT NULL,
    label_id      TEXT NOT NULL,
    name          TEXT,
    color         INTEGER,
    predefined_id INTEGER,
    deleted       INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (owner_phone, label_id)
  );

  -- Asociación etiqueta WA ↔ chat (qué etiqueta tiene cada chat). Se llena con
  -- el evento labels.association de WhatsApp (celular → panel) y cuando el panel
  -- pone/quita una etiqueta (panel → WhatsApp). chat_jid = JID del cliente.
  CREATE TABLE IF NOT EXISTS wa_label_assoc (
    owner_phone TEXT NOT NULL,
    label_id    TEXT NOT NULL,
    chat_jid    TEXT NOT NULL,
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (owner_phone, label_id, chat_jid)
  );

  CREATE INDEX IF NOT EXISTS idx_wa_label_assoc_chat ON wa_label_assoc(owner_phone, chat_jid);

  -- Cola de operaciones de etiqueta del panel hacia WhatsApp (panel → celular).
  -- La ruta API encola aquí; el bot (mismo proceso que el socket) las ejecuta
  -- llamando addChatLabel/removeChatLabel. Evita que la API toque el socket
  -- directamente (que podría estar en otra instancia de módulo).
  CREATE TABLE IF NOT EXISTS wa_label_ops (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_phone TEXT NOT NULL,
    chat_jid    TEXT NOT NULL,
    label_id    TEXT NOT NULL,
    op          TEXT NOT NULL,
    processed   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_wa_label_ops_pending ON wa_label_ops(processed, created_at);

  -- ─── Multi-cuenta (login) ───────────────────────────────────────────────────
  -- Cada cuenta es un negocio distinto. Los datos del sistema se asocian al
  -- negocio via owner_phone (el numero de WhatsApp conectado de esa cuenta).
  CREATE TABLE IF NOT EXISTS accounts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    email            TEXT NOT NULL UNIQUE,
    password_hash    TEXT NOT NULL,
    business_name    TEXT,
    owner_phone      TEXT,
    automation_paused INTEGER NOT NULL DEFAULT 0,
    automation_resumed_at INTEGER,
    is_admin         INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

  -- Configuración por cuenta (reemplaza las variables de entorno globales).
  -- Si un campo queda vacío, el sistema usa el valor de la variable de entorno
  -- como respaldo (ver getActiveAccountSettings y sus consumidores).
  CREATE TABLE IF NOT EXISTS account_settings (
    account_id                 INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    shopify_domain             TEXT,
    shopify_webhook_secret     TEXT,
    confirmation_delay_seconds INTEGER,
    blocked_departments        TEXT,
    blocked_cities             TEXT,
    blocked_department_codes   TEXT,
    owner_notify_phones        TEXT,
    configured                 INTEGER NOT NULL DEFAULT 0,
    updated_at                 INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Estado de conexión de WhatsApp POR CUENTA (multi-tenant). Reemplaza el uso
  -- de la tabla global connection_state. Cada cuenta tiene su propio socket,
  -- su propio QR y su propio número conectado.
  CREATE TABLE IF NOT EXISTS account_connections (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'disconnected',
    qr_string  TEXT,
    phone      TEXT,
    wanted_at  INTEGER,
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
  if (!cols.includes("unread_count"))      db.exec("ALTER TABLE conversations ADD COLUMN unread_count INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("muted_at"))          db.exec("ALTER TABLE conversations ADD COLUMN muted_at INTEGER");
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
  if (!cols.includes("message_id")) {
    db.exec("ALTER TABLE outbox ADD COLUMN message_id INTEGER");
  }
  if (!cols.includes("expires_at")) {
    db.exec("ALTER TABLE outbox ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.includes("notify_owner")) {
    db.exec("ALTER TABLE outbox ADD COLUMN notify_owner INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.includes("media_type"))     db.exec("ALTER TABLE outbox ADD COLUMN media_type TEXT");
  if (!cols.includes("media_path"))     db.exec("ALTER TABLE outbox ADD COLUMN media_path TEXT");
  if (!cols.includes("media_mime"))     db.exec("ALTER TABLE outbox ADD COLUMN media_mime TEXT");
  if (!cols.includes("media_filename")) db.exec("ALTER TABLE outbox ADD COLUMN media_filename TEXT");
}
{
  const cols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[])
    .map(c => c.name);
  if (!cols.includes("wa_msg_id"))  db.exec("ALTER TABLE messages ADD COLUMN wa_msg_id TEXT");
  if (!cols.includes("wa_from_me")) db.exec("ALTER TABLE messages ADD COLUMN wa_from_me INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("media_type"))     db.exec("ALTER TABLE messages ADD COLUMN media_type TEXT");
  if (!cols.includes("media_path"))     db.exec("ALTER TABLE messages ADD COLUMN media_path TEXT");
  if (!cols.includes("media_mime"))     db.exec("ALTER TABLE messages ADD COLUMN media_mime TEXT");
  if (!cols.includes("media_filename")) db.exec("ALTER TABLE messages ADD COLUMN media_filename TEXT");
  if (!cols.includes("media_size"))     db.exec("ALTER TABLE messages ADD COLUMN media_size INTEGER");
}
{
  // account_connections pudo crearse en un deploy previo sin wanted_at.
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='account_connections'"
  ).get();
  if (tableExists) {
    const cols = (db.prepare("PRAGMA table_info(account_connections)").all() as { name: string }[])
      .map(c => c.name);
    if (!cols.includes("wanted_at")) db.exec("ALTER TABLE account_connections ADD COLUMN wanted_at INTEGER");
  }
}
{
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'"
  ).get();
  if (tableExists) {
    const cols = (db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[])
      .map(c => c.name);
    if (!cols.includes("automation_paused"))
      db.exec("ALTER TABLE accounts ADD COLUMN automation_paused INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes("is_admin"))
      db.exec("ALTER TABLE accounts ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes("automation_resumed_at"))
      db.exec("ALTER TABLE accounts ADD COLUMN automation_resumed_at INTEGER");
    // Garantizar al menos un admin: la cuenta más antigua si no hay ninguno.
    const adminCount = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 1").get() as { n: number };
    if (adminCount.n === 0) {
      db.exec("UPDATE accounts SET is_admin = 1 WHERE id = (SELECT id FROM accounts ORDER BY id ASC LIMIT 1)");
    }
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
const CONV_SELECT_FIELDS = `
    c.*,
    (SELECT phone FROM orders WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS order_phone,
    (SELECT CASE
       WHEN media_type = 'image'    THEN '📷 ' || COALESCE(NULLIF(content,''), 'Foto')
       WHEN media_type = 'video'    THEN '🎥 ' || COALESCE(NULLIF(content,''), 'Video')
       WHEN media_type = 'document' THEN '📄 ' || COALESCE(NULLIF(media_filename,''), 'Documento')
       ELSE content END
     FROM messages
     WHERE conversation_id = c.id
     ORDER BY created_at DESC LIMIT 1) AS last_message_preview`;

const stmtListConversations = db.prepare<[string], ConversationWithPreview>(`
  SELECT ${CONV_SELECT_FIELDS}
  FROM conversations c
  WHERE c.owner_phone = ?
    AND c.archived_at IS NULL
  ORDER BY
    c.pinned_at DESC NULLS LAST,
    c.last_message_at DESC NULLS LAST,
    c.created_at DESC
`);

const stmtListArchivedConversations = db.prepare<[string], ConversationWithPreview>(`
  SELECT ${CONV_SELECT_FIELDS}
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

// True si el cliente (role='user') ya envió al menos un mensaje en esta conversación.
// Se usa para decidir si el template de confirmación Shopify va al cliente o a los dueños.
const stmtHasClientMsg = db.prepare<[number], { n: number }>(
  "SELECT COUNT(*) as n FROM messages WHERE conversation_id = ? AND role = 'user' LIMIT 1"
);
export function hasClientMessage(conversationId: number): boolean {
  return (stmtHasClientMsg.get(conversationId)?.n ?? 0) > 0;
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
const stmtEnqueue = db.prepare<[number, string, string, number, number | null, number, number, string | null, string | null, string | null, string | null]>(
  `INSERT INTO outbox
     (conversation_id, phone, content, scheduled_at, message_id, expires_at, notify_owner, media_type, media_path, media_mime, media_filename)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtPendingOutbox = db.prepare<[string, number], OutboxItem>(`
  SELECT o.* FROM outbox o
  JOIN conversations c ON c.id = o.conversation_id
  WHERE o.sent = 0
    AND o.scheduled_at <= unixepoch()
    AND c.owner_phone = ?
  ORDER BY o.created_at ASC
  LIMIT ?
`);
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
  scheduledAt = 0,
  messageId: number | null = null,
  expiresAt = 0,
  notifyOwner = false,
  media: MediaInput | null = null
): boolean {
  // Dedup SOLO para texto: si en las últimas 24h ya pusimos exactamente este
  // content en outbox para la misma conv, NO encolamos otra vez. Los archivos
  // multimedia siempre se encolan (cada envío es único).
  if (!media) {
    const since = Math.floor(Date.now() / 1000) - 86_400;
    const existing = stmtFindRecentOutbox.get(conversationId, content, since);
    if (existing) return false;
  }

  stmtEnqueue.run(
    conversationId, phone, content, scheduledAt, messageId, expiresAt, notifyOwner ? 1 : 0,
    media?.type ?? null, media?.path ?? null, media?.mime ?? null, media?.filename ?? null
  );
  return true;
}

// ─── Estado del proceso (latido para detectar caídas) ─────────────────────────
const stmtGetAppState = db.prepare<[string], { value: string }>(
  "SELECT value FROM app_state WHERE key = ?"
);
const stmtSetAppState = db.prepare<[string, string]>(
  "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);
export function getAppState(key: string): string | undefined {
  return stmtGetAppState.get(key)?.value;
}
export function setAppState(key: string, value: string): void {
  stmtSetAppState.run(key, value);
}

export function getPendingOutbox(ownerPhone: string, limit = 20): OutboxItem[] {
  return stmtPendingOutbox.all(ownerPhone, limit);
}

export function markOutboxSent(id: number): void {
  stmtMarkSent.run(id);
}

const stmtDiscardPendingOutbox = db.prepare<[string], { changes: number }>(`
  UPDATE outbox SET sent = 1
  WHERE sent = 0 AND conversation_id IN (
    SELECT id FROM conversations WHERE owner_phone = ?
  )
`);
/**
 * Descarta (marca como enviados sin enviar) todos los mensajes pendientes de
 * una cuenta. Se usa al (re)conectar para NO disparar la cola vieja.
 * @returns cantidad de mensajes descartados.
 */
export function discardPendingOutboxForOwner(ownerPhone: string): number {
  if (!ownerPhone) return 0;
  return stmtDiscardPendingOutbox.run(ownerPhone).changes;
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

const stmtUnclaimOutbox = db.prepare<[number]>(
  "UPDATE outbox SET sent = 0 WHERE id = ? AND sent = 1"
);

export function unclaimOutboxItem(id: number): void {
  stmtUnclaimOutbox.run(id);
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

const stmtDiscardOutboxForConv = db.prepare<[number]>(
  "UPDATE outbox SET sent = 1 WHERE sent = 0 AND conversation_id = ?"
);

export function discardPendingOutboxForConversation(conversationId: number): number {
  return stmtDiscardOutboxForConv.run(conversationId).changes;
}

// ─── Mensajes: helpers WhatsApp ID + borrado ─────────────────────────────────
const stmtGetMessageById = db.prepare<[number], {
  id: number; conversation_id: number; role: string; content: string;
  created_at: number; wa_msg_id: string | null; wa_from_me: number;
}>("SELECT * FROM messages WHERE id = ?");

const stmtSetMessageWaId = db.prepare<[string, number, number]>(
  "UPDATE messages SET wa_msg_id = ?, wa_from_me = ? WHERE id = ?"
);

const stmtInsertMessageWithWa = db.prepare<[number, string, string, string | null, number]>(
  "INSERT INTO messages (conversation_id, role, content, wa_msg_id, wa_from_me) VALUES (?, ?, ?, ?, ?)"
);

const stmtDeleteMessageById = db.prepare<[number]>(
  "DELETE FROM messages WHERE id = ?"
);

export function getMessageById(id: number): {
  id: number; conversation_id: number; role: string; content: string;
  created_at: number; wa_msg_id: string | null; wa_from_me: number;
} | undefined {
  return stmtGetMessageById.get(id);
}

export function setMessageWaId(messageId: number, waMsgId: string, fromMe: boolean): void {
  stmtSetMessageWaId.run(waMsgId, fromMe ? 1 : 0, messageId);
}

const insertMessageWithWaTx = db.transaction(
  (conversationId: number, role: string, content: string, waMsgId: string | null, fromMe: boolean): number => {
    const info = stmtInsertMessageWithWa.run(conversationId, role, content, waMsgId, fromMe ? 1 : 0);
    stmtUpdateLastMsg.run(conversationId);
    return info.lastInsertRowid as number;
  }
);

/** Inserta mensaje con metadatos de WhatsApp (para que sea revocable). */
export function insertMessageFull(
  conversationId: number,
  role: MessageRole,
  content: string,
  waMsgId: string | null,
  fromMe: boolean
): number {
  return insertMessageWithWaTx(conversationId, role, content, waMsgId, fromMe);
}

// ─── Mensajes multimedia (foto / video / documento) ──────────────────────────
export interface MediaInput {
  type: string;             // 'image' | 'video' | 'document' | 'audio' | 'sticker'
  path: string;             // ruta RELATIVA bajo MEDIA_DIR
  mime: string | null;
  filename: string | null;  // nombre original (para documentos)
  size: number | null;
}

const stmtInsertMediaMsg = db.prepare<[number, string, string, string | null, number, string, string, string | null, string | null, number | null]>(
  `INSERT INTO messages
     (conversation_id, role, content, wa_msg_id, wa_from_me, media_type, media_path, media_mime, media_filename, media_size)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertMediaMessageTx = db.transaction(
  (conversationId: number, role: string, caption: string, waMsgId: string | null, fromMe: boolean, media: MediaInput): number => {
    const info = stmtInsertMediaMsg.run(
      conversationId, role, caption, waMsgId, fromMe ? 1 : 0,
      media.type, media.path, media.mime, media.filename, media.size
    );
    stmtUpdateLastMsg.run(conversationId);
    return info.lastInsertRowid as number;
  }
);
/** Inserta un mensaje con archivo multimedia. `caption` puede ir vacío. */
export function insertMediaMessage(
  conversationId: number,
  role: MessageRole,
  caption: string,
  media: MediaInput,
  waMsgId: string | null = null,
  fromMe = false
): number {
  return insertMediaMessageTx(conversationId, role, caption, waMsgId, fromMe, media);
}

/** Fila completa de un mensaje, con columnas de media (para servir el archivo). */
export interface MessageRow {
  id: number; conversation_id: number; role: string; content: string;
  created_at: number; wa_msg_id: string | null; wa_from_me: number;
  media_type: string | null; media_path: string | null;
  media_mime: string | null; media_filename: string | null; media_size: number | null;
}
const stmtGetMessageRow = db.prepare<[number], MessageRow>("SELECT * FROM messages WHERE id = ?");
export function getMessageRow(id: number): MessageRow | undefined {
  return stmtGetMessageRow.get(id);
}

// ─── No leídos (unread) ───────────────────────────────────────────────────────
const stmtIncrementUnread = db.prepare<[number]>(
  "UPDATE conversations SET unread_count = unread_count + 1 WHERE id = ?"
);
const stmtResetUnread = db.prepare<[number]>(
  "UPDATE conversations SET unread_count = 0 WHERE id = ?"
);
export function incrementUnread(conversationId: number): void {
  stmtIncrementUnread.run(conversationId);
}
export function resetUnread(conversationId: number): void {
  stmtResetUnread.run(conversationId);
}

// ─── Silenciar (mute) por chat ────────────────────────────────────────────────
const stmtSetMuted = db.prepare<[number]>(
  "UPDATE conversations SET muted_at = unixepoch() WHERE id = ?"
);
const stmtSetUnmuted = db.prepare<[number]>(
  "UPDATE conversations SET muted_at = NULL WHERE id = ?"
);
export function setConversationMuted(conversationId: number, muted: boolean): void {
  if (muted) stmtSetMuted.run(conversationId);
  else stmtSetUnmuted.run(conversationId);
}

// ─── Mensajes entrantes recientes (para notificaciones de escritorio) ─────────
export interface IncomingNotice {
  id: number;
  conversation_id: number;
  name: string | null;
  phone: string;
  content: string;
  media_type: string | null;
  muted: number;
}
const stmtIncomingSince = db.prepare<[string, number, number], IncomingNotice>(`
  SELECT m.id, m.conversation_id, c.name, c.phone, m.content, m.media_type,
         (c.muted_at IS NOT NULL) AS muted
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE c.owner_phone = ?
    AND m.id > ?
    AND m.role = 'user'
  ORDER BY m.id ASC
  LIMIT ?
`);
export function getIncomingSince(ownerPhone: string, sinceId: number, limit = 20): IncomingNotice[] {
  if (!ownerPhone) return [];
  return stmtIncomingSince.all(ownerPhone, sinceId, limit);
}

/** Borra el mensaje SOLO de la DB local ("para mí"). */
export function deleteMessageLocal(messageId: number): void {
  stmtDeleteMessageById.run(messageId);
}

// ─── Cola de revokes (delete para todos via Baileys) ─────────────────────────
const stmtEnqueueRevoke = db.prepare<[number, string, string, number]>(
  "INSERT INTO revoke_queue (conversation_id, remote_jid, wa_msg_id, wa_from_me) VALUES (?, ?, ?, ?)"
);
const stmtPendingRevokes = db.prepare<[number], {
  id: number; conversation_id: number; remote_jid: string;
  wa_msg_id: string; wa_from_me: number; created_at: number;
}>("SELECT id, conversation_id, remote_jid, wa_msg_id, wa_from_me, created_at FROM revoke_queue WHERE processed = 0 ORDER BY created_at ASC LIMIT ?");
const stmtMarkRevokeDone = db.prepare<[number]>(
  "UPDATE revoke_queue SET processed = 1 WHERE id = ?"
);

export function enqueueRevoke(conversationId: number, remoteJid: string, waMsgId: string, fromMe: boolean): void {
  stmtEnqueueRevoke.run(conversationId, remoteJid, waMsgId, fromMe ? 1 : 0);
}
export interface PendingRevoke {
  id: number;
  conversation_id: number;
  remote_jid: string;
  wa_msg_id: string;
  wa_from_me: number;
  created_at: number;
}
export function getPendingRevokes(limit = 20): PendingRevoke[] {
  return stmtPendingRevokes.all(limit);
}
export function markRevokeDone(id: number): void {
  stmtMarkRevokeDone.run(id);
}

// Buscar conversación reciente con orden SHOPIFY pendiente y matching de nombre
// Se usa para deduplicar cuando un mensaje llega con JID @lid (que no matchea
// la conv creada por el webhook Shopify con @s.whatsapp.net).
// Devuelve TODAS las convs SHOPIFY con pedido PENDING_CONFIRMATION recientes
// del owner. El matching difuso por nombre se hace en JS (SQLite no puede
// quitar emojis ni acentos de forma confiable).
const stmtRecentShopifyConvs = db.prepare<
  [string, number],
  Conversation
>(`
  SELECT c.*
  FROM conversations c
  WHERE c.owner_phone = ?
    AND c.phone LIKE '%@s.whatsapp.net'
    AND c.created_at >= ?
    AND EXISTS (
      SELECT 1 FROM orders o
      WHERE o.conversation_id = c.id
        AND o.source = 'SHOPIFY'
        AND o.status NOT IN ('CANCELLED')
    )
  ORDER BY c.created_at DESC
  LIMIT 20
`);

// Normaliza un nombre para comparación difusa: minúsculas, sin acentos,
// sin emojis ni símbolos, espacios colapsados.
function normalizeName(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")        // acentos
    .replace(/[^a-z0-9 ]/g, " ")            // emojis/símbolos → espacio
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Busca la conversación SHOPIFY (creada por el webhook, con phone real
 * @s.whatsapp.net) que corresponde a un mensaje entrante por @lid, usando
 * matching difuso de nombre. Estrategias en orden:
 *   1. Nombre normalizado idéntico
 *   2. Comparten el primer nombre (ej: "Sol" vs "Sol🌼" / "Sol Cisneros")
 *   3. Si hay UNA sola conv SHOPIFY pendiente reciente → es ella (fallback)
 */
export function findRecentShopifyConversationByName(
  ownerPhone: string,
  name: string,
  withinSeconds = 604800
): Conversation | undefined {
  const since = Math.floor(Date.now() / 1000) - withinSeconds;
  const candidates = stmtRecentShopifyConvs.all(ownerPhone, since);
  if (candidates.length === 0) return undefined;

  const target = normalizeName(name);

  if (target) {
    // 1) Match exacto normalizado
    const exact = candidates.find((c) => normalizeName(c.name ?? "") === target);
    if (exact) return exact;

    // 2) Match por primer nombre (en cualquier dirección)
    const targetFirst = target.split(" ")[0];
    const byFirst = candidates.find((c) => {
      const cn = normalizeName(c.name ?? "");
      if (!cn) return false;
      const cFirst = cn.split(" ")[0];
      return cFirst === targetFirst
        || cn.startsWith(target)
        || target.startsWith(cn)
        || cn.includes(targetFirst)
        || target.includes(cFirst);
    });
    if (byFirst) return byFirst;
  }

  // 3) Fallback: si hay exactamente UNA conv shopify pendiente creada en los
  //    últimos 10 min, es muy probable que sea el mismo cliente respondiendo
  //    por @lid. Ventana corta para minimizar fusiones accidentales con
  //    números random que escriban en ese rato.
  if (candidates.length === 1) {
    const recentCutoff = Math.floor(Date.now() / 1000) - 600;
    if (candidates[0].created_at >= recentCutoff) return candidates[0];
  }

  return undefined;
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

// ─── Fusión de conversación @lid → conv real ───────────────────────────────────
// Busca convs @lid recientes del owner cuyo nombre coincida con el del pedido.
const stmtRecentLidConvs = db.prepare<[string, number], Conversation>(`
  SELECT c.*
  FROM conversations c
  WHERE c.owner_phone = ?
    AND c.phone LIKE '%@lid'
    AND c.created_at >= ?
    AND NOT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.conversation_id = c.id AND o.source = 'SHOPIFY'
    )
  ORDER BY c.created_at DESC
  LIMIT 20
`);

const stmtMoveMessages = db.prepare<[number, number]>(
  "UPDATE messages SET conversation_id = ? WHERE conversation_id = ?"
);
const stmtMoveOutbox = db.prepare<[number, number]>(
  "UPDATE outbox SET conversation_id = ? WHERE conversation_id = ? AND sent = 0"
);
const stmtMoveOrders = db.prepare<[number, number]>(
  "UPDATE orders SET conversation_id = ? WHERE conversation_id = ?"
);
const stmtDelLidConv = db.prepare<[number]>("DELETE FROM conversations WHERE id = ?");

const mergeConvTx = db.transaction((fromId: number, toId: number) => {
  stmtMoveMessages.run(toId, fromId);
  stmtMoveOutbox.run(toId, fromId);
  stmtMoveOrders.run(toId, fromId);
  stmtDelLidConv.run(fromId);
});

/**
 * Mueve mensajes, outbox y pedidos de `fromId` a `toId` y borra `fromId`.
 * Usado para fusionar una conv @lid huérfana con la conv de teléfono real
 * creada por el webhook de Shopify.
 */
export function mergeConversationInto(fromId: number, toId: number): void {
  mergeConvTx(fromId, toId);
}

/**
 * Busca una conversación @lid reciente del owner cuyo nombre coincida con
 * el nombre del pedido (mismo matching difuso que findRecentShopifyConversationByName).
 * Se usa en el webhook para detectar si el cliente ya escribió antes de que
 * llegara el webhook.
 */
export function findRecentLidConversationByName(
  ownerPhone: string,
  name: string,
  withinSeconds = 7200
): Conversation | undefined {
  const since = Math.floor(Date.now() / 1000) - withinSeconds;
  const candidates = stmtRecentLidConvs.all(ownerPhone, since);
  if (candidates.length === 0) return undefined;

  const target = (name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!target) return undefined;
  const targetFirst = target.split(" ")[0];

  for (const c of candidates) {
    const cn = (c.name || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cn) continue;
    const cFirst = cn.split(" ")[0];
    if (
      cn === target ||
      cFirst === targetFirst ||
      cn.startsWith(target) ||
      target.startsWith(cn)
    ) return c;
  }

  return undefined;
}

// Lista los chats @lid huérfanos (sin pedido Shopify) del owner, recientes.
// Se usa en la barrida periódica de fusión para limpiar duplicados que se
// crearon por temas de tiempo (cliente respondió por @lid antes/después del
// webhook, o el nombre no coincidió en ese instante).
const stmtListOrphanLid = db.prepare<[string, number], Conversation>(`
  SELECT c.*
  FROM conversations c
  WHERE c.owner_phone = ?
    AND c.phone LIKE '%@lid'
    AND c.created_at >= ?
    AND NOT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.conversation_id = c.id AND o.source = 'SHOPIFY'
    )
  ORDER BY c.created_at DESC
  LIMIT 100
`);
export function listOrphanLidConversations(ownerPhone: string, withinSeconds = 604800): Conversation[] {
  if (!ownerPhone) return [];
  return stmtListOrphanLid.all(ownerPhone, Math.floor(Date.now() / 1000) - withinSeconds);
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

// ─── Cuentas y sesiones (login) ───────────────────────────────────────────────
export interface Account {
  id: number;
  email: string;
  password_hash: string;
  business_name: string | null;
  owner_phone: string | null;
  automation_paused: number;
  automation_resumed_at: number | null;
  is_admin: number;
  created_at: number;
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 días

const stmtGetAccountByEmail = db.prepare<[string], Account>(
  "SELECT * FROM accounts WHERE email = ?"
);
const stmtGetAccountById = db.prepare<[number], Account>(
  "SELECT * FROM accounts WHERE id = ?"
);
const stmtInsertAccount = db.prepare<[string, string, string | null, string | null, number], Account>(
  "INSERT INTO accounts (email, password_hash, business_name, owner_phone, is_admin) VALUES (?, ?, ?, ?, ?) RETURNING *"
);
const stmtInsertSession = db.prepare<[string, number, number]>(
  "INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)"
);
const stmtGetSessionAccount = db.prepare<[string, number], Account>(`
  SELECT a.* FROM accounts a
  JOIN sessions s ON s.account_id = a.id
  WHERE s.token = ? AND s.expires_at > ?
`);
const stmtDeleteSession = db.prepare<[string]>("DELETE FROM sessions WHERE token = ?");

export function getAccountByEmail(email: string): Account | undefined {
  return stmtGetAccountByEmail.get(email.toLowerCase().trim());
}
export function getAccountById(id: number): Account | undefined {
  return stmtGetAccountById.get(id);
}
export function createAccount(
  email: string,
  passwordHash: string,
  businessName: string | null = null,
  ownerPhone: string | null = null,
  isAdmin = false
): Account {
  return stmtInsertAccount.all(email.toLowerCase().trim(), passwordHash, businessName, ownerPhone, isAdmin ? 1 : 0)[0];
}

const stmtIsAdmin = db.prepare<[number], { is_admin: number }>(
  "SELECT is_admin FROM accounts WHERE id = ?"
);
export function isAccountAdmin(accountId: number): boolean {
  return (stmtIsAdmin.get(accountId)?.is_admin ?? 0) === 1;
}

/** Crea una sesión nueva y devuelve su token (para guardar en cookie). */
export function createSession(accountId: number): string {
  const token = generateSessionToken();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  stmtInsertSession.run(token, accountId, expiresAt);
  return token;
}

/** Devuelve la cuenta asociada a un token de sesión válido (o undefined). */
export function getAccountBySessionToken(token: string): Account | undefined {
  if (!token) return undefined;
  const now = Math.floor(Date.now() / 1000);
  return stmtGetSessionAccount.get(token, now);
}

export function deleteSession(token: string): void {
  if (token) stmtDeleteSession.run(token);
}

// ─── Configuración por cuenta ─────────────────────────────────────────────────
export interface AccountSettings {
  account_id: number;
  shopify_domain: string | null;
  shopify_webhook_secret: string | null;
  confirmation_delay_seconds: number | null;
  blocked_departments: string | null;
  blocked_cities: string | null;
  blocked_department_codes: string | null;
  owner_notify_phones: string | null;
  configured: number;
  updated_at: number;
}

const stmtGetSettings = db.prepare<[number], AccountSettings>(
  "SELECT * FROM account_settings WHERE account_id = ?"
);
const stmtActiveSettings = db.prepare<[], AccountSettings>(
  "SELECT * FROM account_settings WHERE configured = 1 ORDER BY account_id ASC LIMIT 1"
);
const stmtUpsertSettings = db.prepare(`
  INSERT INTO account_settings (
    account_id, shopify_domain, shopify_webhook_secret, confirmation_delay_seconds,
    blocked_departments, blocked_cities, blocked_department_codes, owner_notify_phones,
    configured, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, unixepoch())
  ON CONFLICT(account_id) DO UPDATE SET
    shopify_domain             = excluded.shopify_domain,
    shopify_webhook_secret     = excluded.shopify_webhook_secret,
    confirmation_delay_seconds = excluded.confirmation_delay_seconds,
    blocked_departments        = excluded.blocked_departments,
    blocked_cities             = excluded.blocked_cities,
    blocked_department_codes   = excluded.blocked_department_codes,
    owner_notify_phones        = excluded.owner_notify_phones,
    configured                 = 1,
    updated_at                 = unixepoch()
`);

export function getAccountSettings(accountId: number): AccountSettings | undefined {
  return stmtGetSettings.get(accountId);
}

export interface AccountSettingsInput {
  shopifyDomain: string | null;
  shopifyWebhookSecret: string | null;
  confirmationDelaySeconds: number | null;
  blockedDepartments: string | null;
  blockedCities: string | null;
  blockedDepartmentCodes: string | null;
  ownerNotifyPhones: string | null;
}

export function upsertAccountSettings(accountId: number, data: AccountSettingsInput): void {
  stmtUpsertSettings.run(
    accountId,
    data.shopifyDomain,
    data.shopifyWebhookSecret,
    data.confirmationDelaySeconds,
    data.blockedDepartments,
    data.blockedCities,
    data.blockedDepartmentCodes,
    data.ownerNotifyPhones
  );
}

/**
 * Devuelve la configuración de la cuenta activa (single-tenant por ahora: la
 * primera cuenta configurada). La usan los consumidores (webhook, zonas,
 * notificaciones) prefiriendo estos valores sobre las variables de entorno.
 * Defensivo: si algo falla, devuelve undefined y los consumidores caen al env.
 */
export function getActiveAccountSettings(): AccountSettings | undefined {
  try {
    return stmtActiveSettings.get();
  } catch {
    return undefined;
  }
}

const stmtSettingsByDomain = db.prepare<[string], AccountSettings>(
  "SELECT * FROM account_settings WHERE lower(shopify_domain) = lower(?) AND configured = 1 LIMIT 1"
);

/** Resuelve la cuenta dueña de un webhook por el dominio de su tienda Shopify. */
export function getAccountSettingsByShopDomain(domain: string): AccountSettings | undefined {
  if (!domain.trim()) return undefined;
  try {
    return stmtSettingsByDomain.get(domain.trim());
  } catch {
    return undefined;
  }
}

// ─── Conexión de WhatsApp por cuenta (multi-tenant) ───────────────────────────
export interface AccountConnection {
  account_id: number;
  status: ConnectionStatus;
  qr_string: string | null;
  phone: string | null;
  wanted_at: number | null;
  updated_at: number;
}

const stmtGetAcctConn = db.prepare<[number], AccountConnection>(
  "SELECT * FROM account_connections WHERE account_id = ?"
);
const stmtEnsureConnRow = db.prepare(
  "INSERT INTO account_connections (account_id, status) VALUES (?, 'disconnected') ON CONFLICT(account_id) DO NOTHING"
);
const stmtMarkWanted = db.prepare<[number]>(
  "UPDATE account_connections SET wanted_at = unixepoch() WHERE account_id = ?"
);
const stmtUpsertAcctConn = db.prepare(`
  INSERT INTO account_connections (account_id, status, qr_string, phone, updated_at)
  VALUES (?, ?, ?, ?, unixepoch())
  ON CONFLICT(account_id) DO UPDATE SET
    status     = excluded.status,
    qr_string  = excluded.qr_string,
    phone      = excluded.phone,
    updated_at = unixepoch()
`);
const stmtListAccounts = db.prepare<[], Account>(
  "SELECT * FROM accounts ORDER BY id ASC"
);
const stmtSetAcctOwnerPhone = db.prepare<[string, number]>(
  "UPDATE accounts SET owner_phone = ? WHERE id = ?"
);
const stmtGetAccountByOwnerPhone = db.prepare<[string], Account>(
  "SELECT * FROM accounts WHERE owner_phone = ? LIMIT 1"
);

export function getAccountConnection(accountId: number): AccountConnection {
  return (
    stmtGetAcctConn.get(accountId) ?? {
      account_id: accountId,
      status: "disconnected",
      qr_string: null,
      phone: null,
      wanted_at: null,
      updated_at: 0
    }
  );
}

/**
 * Marca que la cuenta está siendo usada activamente (el dashboard/QR de esa
 * cuenta consultó su estado). El bot solo mantiene conexiones de WhatsApp para
 * cuentas "deseadas" recientemente o ya conectadas — así no arranca todas a la
 * vez y no se queda sin memoria.
 */
export function markAccountWanted(accountId: number): void {
  stmtEnsureConnRow.run(accountId);
  stmtMarkWanted.run(accountId);
}

export function setAccountConnection(
  accountId: number,
  patch: { status: ConnectionStatus; qr_string?: string | null; phone?: string | null }
): void {
  const current = getAccountConnection(accountId);
  stmtUpsertAcctConn.run(
    accountId,
    patch.status,
    patch.qr_string !== undefined ? patch.qr_string : current.qr_string,
    patch.phone !== undefined ? patch.phone : current.phone
  );
}

export function listAllAccounts(): Account[] {
  return stmtListAccounts.all();
}

export function setAccountOwnerPhone(accountId: number, phone: string): void {
  stmtSetAcctOwnerPhone.run(phone, accountId);
}

export function getAccountByOwnerPhone(phone: string): Account | undefined {
  return stmtGetAccountByOwnerPhone.get(phone);
}

// ─── Interruptor de automatización (botón de pánico, por cuenta) ──────────────
// Cuando está pausada, el bot NO hace nada automático (ni IA, ni confirmaciones,
// ni recordatorios, ni avisos). Los mensajes entrantes se guardan igual y el
// owner puede seguir escribiendo manualmente.
const stmtPauseAuto = db.prepare<[number]>(
  "UPDATE accounts SET automation_paused = 1 WHERE id = ?"
);
const stmtResumeAuto = db.prepare<[number]>(
  "UPDATE accounts SET automation_paused = 0, automation_resumed_at = unixepoch() WHERE id = ?"
);
const stmtIsAutoPaused = db.prepare<[number], { automation_paused: number }>(
  "SELECT automation_paused FROM accounts WHERE id = ?"
);

export function setAccountAutomationPaused(accountId: number, paused: boolean): void {
  // Al ACTIVAR (despausar) marcamos automation_resumed_at = ahora. A partir de
  // ese momento el bot solo atiende pedidos NUEVOS — los viejos pendientes no
  // reciben recordatorios ni nada.
  if (paused) stmtPauseAuto.run(accountId);
  else stmtResumeAuto.run(accountId);
}
export function isAccountAutomationPaused(accountId: number): boolean {
  return (stmtIsAutoPaused.get(accountId)?.automation_paused ?? 0) === 1;
}
/** Pausa de automatización resuelta por el número de WhatsApp conectado. */
export function isAutomationPausedForPhone(phone: string): boolean {
  if (!phone) return false;
  const acc = getAccountByOwnerPhone(phone);
  return acc ? acc.automation_paused === 1 : false;
}

// ─── Etiquetas nativas de WhatsApp Business ───────────────────────────────────
export interface WaLabel {
  owner_phone: string;
  label_id: string;
  name: string | null;
  color: number | null;
  predefined_id: number | null;
  deleted: number;
}

const stmtUpsertWaLabel = db.prepare<[string, string, string | null, number | null, number | null, number]>(
  `INSERT INTO wa_labels (owner_phone, label_id, name, color, predefined_id, deleted, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, unixepoch())
   ON CONFLICT(owner_phone, label_id) DO UPDATE SET
     name = excluded.name, color = excluded.color,
     predefined_id = excluded.predefined_id, deleted = excluded.deleted,
     updated_at = unixepoch()`
);
const stmtListWaLabels = db.prepare<[string], WaLabel>(
  "SELECT * FROM wa_labels WHERE owner_phone = ? AND deleted = 0"
);

export function upsertWaLabel(ownerPhone: string, label: {
  id: string; name?: string | null; color?: number | null;
  predefinedId?: number | null; deleted?: boolean;
}): void {
  stmtUpsertWaLabel.run(
    ownerPhone, label.id, label.name ?? null, label.color ?? null,
    label.predefinedId ?? null, label.deleted ? 1 : 0
  );
}

export function listWaLabels(ownerPhone: string): WaLabel[] {
  return stmtListWaLabels.all(ownerPhone);
}

export function getWaLabelById(ownerPhone: string, labelId: string): WaLabel | undefined {
  return listWaLabels(ownerPhone).find((l) => l.label_id === labelId);
}

// ─── Paleta de colores de etiquetas de WhatsApp Business ──────────────────────
// WhatsApp guarda el color como un índice entero. Lo mapeamos a un hex parecido
// para mostrarlo en el panel. Si el índice se sale del rango, usamos módulo.
const WA_LABEL_COLORS = [
  "#94a3b8", // 0  gris (default)
  "#ef9a9a", // 1  rojo claro
  "#f48fb1", // 2  rosa
  "#ce93d8", // 3  morado
  "#b39ddb", // 4  violeta
  "#9fa8da", // 5  índigo
  "#90caf9", // 6  azul
  "#81d4fa", // 7  celeste
  "#80deea", // 8  cian
  "#80cbc4", // 9  teal
  "#a5d6a7", // 10 verde
  "#c5e1a5", // 11 verde lima
  "#e6ee9c", // 12 lima
  "#fff59d", // 13 amarillo
  "#ffe082", // 14 ámbar
  "#ffcc80", // 15 naranja
  "#ffab91", // 16 naranja oscuro
  "#bcaaa4", // 17 marrón
  "#b0bec5", // 18 azul gris
  "#f8bbd0"  // 19 rosa claro
];

/** Convierte el índice de color de una etiqueta WA a un hex para el panel. */
export function waLabelColorHex(color: number | null): string {
  if (color == null || !Number.isFinite(color)) return WA_LABEL_COLORS[0];
  const idx = ((Math.trunc(color) % WA_LABEL_COLORS.length) + WA_LABEL_COLORS.length) % WA_LABEL_COLORS.length;
  return WA_LABEL_COLORS[idx];
}

// ─── Asociaciones etiqueta WA ↔ chat ──────────────────────────────────────────
const stmtSetWaAssoc = db.prepare<[string, string, string]>(
  `INSERT INTO wa_label_assoc (owner_phone, label_id, chat_jid, updated_at)
   VALUES (?, ?, ?, unixepoch())
   ON CONFLICT(owner_phone, label_id, chat_jid) DO UPDATE SET updated_at = unixepoch()`
);
const stmtRemoveWaAssoc = db.prepare<[string, string, string]>(
  "DELETE FROM wa_label_assoc WHERE owner_phone = ? AND label_id = ? AND chat_jid = ?"
);
const stmtWaAssocForChat = db.prepare<[string, string], { label_id: string }>(
  "SELECT label_id FROM wa_label_assoc WHERE owner_phone = ? AND chat_jid = ?"
);
const stmtAllWaAssoc = db.prepare<
  [string],
  { chat_jid: string; label_id: string; name: string | null; color: number | null }
>(`
  SELECT a.chat_jid, a.label_id, l.name, l.color
  FROM wa_label_assoc a
  JOIN wa_labels l ON l.owner_phone = a.owner_phone AND l.label_id = a.label_id
  WHERE a.owner_phone = ? AND l.deleted = 0
`);
const stmtConvIdByJid = db.prepare<[string], { id: number; phone: string }>(
  "SELECT id, phone FROM conversations WHERE owner_phone = ?"
);
const stmtAllContactLids = db.prepare<[], { lid: string; phone: string }>(
  "SELECT lid, phone FROM contact_lids"
);
const stmtLidByPhone = db.prepare<[string], { lid: string }>(
  "SELECT lid FROM contact_lids WHERE phone = ? LIMIT 1"
);

/** Devuelve el JID que WhatsApp reconoce para un chat: si la conversación quedó
 *  como número real (@s.whatsapp.net) pero conocemos su @lid, devolvemos el @lid
 *  (que es como WhatsApp identifica el chat para etiquetas). Si no, el original. */
export function preferLidJid(jid: string): string {
  if (!jid || jid.endsWith("@lid")) return jid;
  const phone = jid.split("@")[0];
  const row = stmtLidByPhone.get(phone);
  return row ? `${row.lid}@lid` : jid;
}

export function setWaLabelAssoc(ownerPhone: string, labelId: string, chatJid: string): void {
  if (!ownerPhone || !labelId || !chatJid) return;
  stmtSetWaAssoc.run(ownerPhone, labelId, chatJid);
}
export function removeWaLabelAssoc(ownerPhone: string, labelId: string, chatJid: string): void {
  if (!ownerPhone || !labelId || !chatJid) return;
  stmtRemoveWaAssoc.run(ownerPhone, labelId, chatJid);
}
export function listWaLabelIdsForChat(ownerPhone: string, chatJid: string): string[] {
  // Match por clave normalizada (resuelve @lid ↔ teléfono) igual que la lista.
  const lidToPhone = new Map<string, string>();
  for (const r of stmtAllContactLids.all()) lidToPhone.set(r.lid, r.phone);
  const keyOf = (jid: string): string => {
    if (jid.endsWith("@lid")) {
      const lid = jid.split("@")[0];
      const phone = lidToPhone.get(lid);
      return phone ? `p:${phone}` : `lid:${lid}`;
    }
    return `p:${jid.split("@")[0]}`;
  };
  const target = keyOf(chatJid);
  const ids: string[] = [];
  for (const row of stmtAllWaAssoc.all(ownerPhone)) {
    if (keyOf(row.chat_jid) === target) ids.push(row.label_id);
  }
  return ids;
}

// ─── Cola de operaciones de etiqueta (panel → WhatsApp) ───────────────────────
export interface WaLabelOp {
  id: number;
  owner_phone: string;
  chat_jid: string;
  label_id: string;
  op: string; // 'add' | 'remove'
  processed: number;
  created_at: number;
}
const stmtEnqueueWaOp = db.prepare<[string, string, string, string]>(
  "INSERT INTO wa_label_ops (owner_phone, chat_jid, label_id, op) VALUES (?, ?, ?, ?)"
);
const stmtPendingWaOps = db.prepare<[string, number], WaLabelOp>(
  "SELECT * FROM wa_label_ops WHERE processed = 0 AND owner_phone = ? ORDER BY created_at ASC LIMIT ?"
);
const stmtMarkWaOpDone = db.prepare<[number]>(
  "UPDATE wa_label_ops SET processed = 1 WHERE id = ?"
);

export function enqueueWaLabelOp(ownerPhone: string, chatJid: string, labelId: string, op: "add" | "remove"): void {
  if (!ownerPhone || !chatJid || !labelId) return;
  stmtEnqueueWaOp.run(ownerPhone, chatJid, labelId, op);
}
export function getPendingWaLabelOps(ownerPhone: string, limit = 20): WaLabelOp[] {
  return stmtPendingWaOps.all(ownerPhone, limit);
}
export function markWaLabelOpDone(id: number): void {
  stmtMarkWaOpDone.run(id);
}

/** Mapa conversationId → etiquetas WA (id/name/color) para enriquecer la lista
 *  de chats sin N+1 queries. Une la asociación con la conversación por su JID. */
export function getAllWaLabelsByConversation(
  ownerPhone: string
): Map<number, Array<{ id: string; name: string; color: string }>> {
  const map = new Map<number, Array<{ id: string; name: string; color: string }>>();
  if (!ownerPhone) return map;

  // Mapa lid → teléfono real (para resolver @lid a número).
  const lidToPhone = new Map<string, string>();
  for (const r of stmtAllContactLids.all()) lidToPhone.set(r.lid, r.phone);

  // Clave normalizada de un JID: usa el número real cuando se puede resolver,
  // así matchea tanto si el chat quedó como @lid o como @s.whatsapp.net.
  const keyOf = (jid: string): string => {
    if (jid.endsWith("@lid")) {
      const lid = jid.split("@")[0];
      const phone = lidToPhone.get(lid);
      return phone ? `p:${phone}` : `lid:${lid}`;
    }
    return `p:${jid.split("@")[0]}`;
  };

  // clave normalizada → conversation.id
  const convByKey = new Map<string, number>();
  for (const c of stmtConvIdByJid.all(ownerPhone)) convByKey.set(keyOf(c.phone), c.id);

  for (const row of stmtAllWaAssoc.all(ownerPhone)) {
    const convId = convByKey.get(keyOf(row.chat_jid));
    if (convId == null) continue;
    const list = map.get(convId) ?? [];
    list.push({ id: row.label_id, name: row.name ?? "Etiqueta", color: waLabelColorHex(row.color) });
    map.set(convId, list);
  }
  return map;
}

// Normaliza para comparar nombres de etiqueta (sin acentos/emojis/case).
function normLabelName(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Busca el label_id de una etiqueta por nombre (difuso). Para "Nuevo pedido"
 * también matchea la predefinida de WhatsApp Business (predefinedId = 2 =
 * "New order"). Devuelve undefined si no se encontró.
 */
export function findWaLabelIdByName(ownerPhone: string, name: string): string | undefined {
  const target = normLabelName(name);
  const labels = listWaLabels(ownerPhone);

  // 1) Match por nombre normalizado
  const byName = labels.find((l) => normLabelName(l.name ?? "") === target);
  if (byName) return byName.label_id;

  // 2) "Nuevo pedido" / "new order" → predefinida #2 de WhatsApp Business
  const isNuevoPedido = target.includes("nuevo pedido") || target.includes("new order");
  if (isNuevoPedido) {
    const predef = labels.find((l) => l.predefined_id === 2);
    if (predef) return predef.label_id;
  }

  // 3) Match parcial por inclusión
  const partial = labels.find((l) => {
    const ln = normLabelName(l.name ?? "");
    return ln && (ln.includes(target) || target.includes(ln));
  });
  return partial?.label_id;
}

// ─── Auto-seed de la cuenta inicial desde variables de entorno ────────────────
// Idempotente: si la cuenta ya existe, no hace nada. Permite crear la primera
// cuenta en Render sin exponer la contraseña en el código — basta con definir
// SEED_ACCOUNT_EMAIL y SEED_ACCOUNT_PASSWORD en el panel de Render una vez.
// El email tiene un valor por defecto para reducir fricción.
function seedAccountFromEnv(
  emailVar: string,
  passVar: string,
  bizVar: string,
  phoneVar: string,
  isAdmin: boolean,
  defaultEmail?: string
): void {
  const password = process.env[passVar];
  if (!password) return;
  const email = (process.env[emailVar] || defaultEmail || "").toLowerCase().trim();
  if (!email) return;
  if (getAccountByEmail(email)) return;
  createAccount(
    email,
    hashPassword(password),
    process.env[bizVar] || null,
    process.env[phoneVar] || null,
    isAdmin
  );
  console.log(`[auth] Cuenta creada por seed: ${email}`);
}

if (process.env.NEXT_PHASE !== "phase-production-build") {
  try {
    // Cuenta principal = admin (puede crear otras cuentas desde el dashboard)
    seedAccountFromEnv(
      "SEED_ACCOUNT_EMAIL", "SEED_ACCOUNT_PASSWORD",
      "SEED_ACCOUNT_BUSINESS", "SEED_ACCOUNT_OWNER_PHONE",
      true, "dylangofo1@gmail.com"
    );
    // Cuenta secundaria opcional (para pruebas), NO admin.
    seedAccountFromEnv(
      "SEED_ACCOUNT2_EMAIL", "SEED_ACCOUNT2_PASSWORD",
      "SEED_ACCOUNT2_BUSINESS", "SEED_ACCOUNT2_OWNER_PHONE",
      false
    );
  } catch (err) {
    console.error("[auth] Error en auto-seed de cuentas:", err);
  }
}
