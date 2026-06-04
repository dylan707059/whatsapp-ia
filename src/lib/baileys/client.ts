import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  proto
} from "@whiskeysockets/baileys";
import type { WASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import qrcodeTerminal from "qrcode-terminal";
import path from "node:path";
import { setAccountConnection, getAccountConnection, setAccountOwnerPhone } from "../db";
import { setupMessageHandler } from "./handler";
import { registerContact } from "./contact-store";
import { getOwnerNotifyPhones } from "../owner-notifier";
import { AUTH_DIR } from "../paths";

const logger = pino({ level: "silent" });

// Cache global de mensajes recientes (para getMessage). Las claves son ids de
// WhatsApp, únicos entre cuentas, así que un solo cache sirve para todos.
const msgCache = new Map<string, proto.IWebMessageInfo>();

interface BaileysHandle {
  sock: WASocket;
  accountId: number;
  shutdown: () => Promise<void>;
}

// Un socket por cuenta. Multi-tenant: cada cuenta tiene su propia conexión,
// su propia carpeta de credenciales (AUTH_DIR/<accountId>) y su propio QR.
const handles         = new Map<number, BaileysHandle>();
const reconnectTimers = new Map<number, ReturnType<typeof setTimeout>>();
const starting        = new Set<number>();

function authDirFor(accountId: number): string {
  return path.join(AUTH_DIR, String(accountId));
}

function scheduleReconnect(accountId: number, code?: number) {
  if (reconnectTimers.has(accountId)) return;

  const delay = code === 440 ? 15000 : code === undefined ? 10000 : 5000;

  const timer = setTimeout(() => {
    reconnectTimers.delete(accountId);
    const h = handles.get(accountId);
    if (h) {
      try { h.sock.end(undefined); } catch {}
      handles.delete(accountId);
    }
    start(accountId);
  }, delay);

  reconnectTimers.set(accountId, timer);
}

/** True si la cuenta ya tiene socket vivo, arrancando o con reconexión pendiente. */
export function isManaged(accountId: number): boolean {
  return handles.has(accountId) || starting.has(accountId) || reconnectTimers.has(accountId);
}

export async function start(accountId: number): Promise<void> {
  if (starting.has(accountId)) return;
  starting.add(accountId);
  try {
    await _start(accountId);
  } finally {
    starting.delete(accountId);
  }
}

async function _start(accountId: number): Promise<void> {
  const authDir = authDirFor(accountId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let version: [number, number, number] | undefined;
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch (err) {
    console.warn(`[bot] (acc ${accountId}) No se pudo obtener última versión:`, err);
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS("Desktop"),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
    retryRequestDelayMs: 5_000,
    getMessage: async (key) => {
      const id = key.id ?? "";
      const cached = msgCache.get(id);
      if (cached?.message) return cached.message;
      return proto.Message.fromObject({});
    }
  });

  handles.set(accountId, {
    sock,
    accountId,
    shutdown: async () => { try { sock.end(undefined); } catch {} }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) registerContact(c.id, (c as { lid?: string }).lid);
  });
  sock.ev.on("contacts.update", (contacts) => {
    for (const c of contacts) registerContact(c.id, (c as { lid?: string }).lid);
  });

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages) {
      if (msg.key?.id) {
        msgCache.set(msg.key.id, msg);
        while (msgCache.size > 200) {
          const first = msgCache.keys().next().value;
          if (first) msgCache.delete(first); else break;
        }
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      setAccountConnection(accountId, { status: "qr", qr_string: qr, phone: null });
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "connecting") {
      const current = getAccountConnection(accountId);
      if (current.status === "disconnected") {
        setAccountConnection(accountId, { status: "connecting" });
      }
    }

    if (connection === "open") {
      const phone = (sock.user?.id ?? "").split(":")[0];
      console.log(`[bot] (acc ${accountId}) Conectado como ${phone}`);
      setAccountConnection(accountId, { status: "connected", qr_string: null, phone });
      setAccountOwnerPhone(accountId, phone);

      // Pre-registrar LIDs de owners para resolver @lid JIDs
      for (const ownerPhone of getOwnerNotifyPhones(phone)) {
        try {
          const results = await sock.onWhatsApp(ownerPhone);
          const info = results?.[0] as { jid: string; lid?: string; exists: boolean } | undefined;
          if (info?.exists && info.lid) registerContact(info.jid, info.lid);
        } catch (err) {
          console.error(`[bot] (acc ${accountId}) Error consultando LID de ${ownerPhone}:`, err);
        }
      }
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })
        ?.output?.statusCode;
      console.log(`[bot] (acc ${accountId}) Conexión cerrada. Código: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log(`[bot] (acc ${accountId}) Sesión expirada. Limpiando credenciales y regenerando QR...`);
        setAccountConnection(accountId, { status: "disconnected", qr_string: null, phone: null });
        const { rmSync } = await import("node:fs");
        try { rmSync(authDir, { recursive: true, force: true }); } catch {}
        scheduleReconnect(accountId);
        return;
      }

      scheduleReconnect(accountId, statusCode);
    }
  });

  setupMessageHandler(sock);
}

export function getHandle(accountId: number): BaileysHandle | undefined {
  return handles.get(accountId);
}

export function listHandles(): BaileysHandle[] {
  return [...handles.values()];
}

/** Detiene el socket de una cuenta SIN borrar sus credenciales (para liberar
 *  memoria de cuentas inactivas; reconecta sola al volver a usarse). */
export async function stopAccount(accountId: number): Promise<void> {
  const h = handles.get(accountId);
  if (h) {
    try { await h.shutdown(); } catch {}
    handles.delete(accountId);
  }
  const timer = reconnectTimers.get(accountId);
  if (timer) { clearTimeout(timer); reconnectTimers.delete(accountId); }
}

/** Desconecta una cuenta, borra sus credenciales y deja su estado en disconnected. */
export async function stopAndWipe(accountId: number): Promise<void> {
  const h = handles.get(accountId);
  if (h) {
    try { await h.shutdown(); } catch {}
    handles.delete(accountId);
  }
  const timer = reconnectTimers.get(accountId);
  if (timer) { clearTimeout(timer); reconnectTimers.delete(accountId); }

  const { rmSync } = await import("node:fs");
  try { rmSync(authDirFor(accountId), { recursive: true, force: true }); } catch {}

  setAccountConnection(accountId, { status: "disconnected", qr_string: null, phone: null });
}
