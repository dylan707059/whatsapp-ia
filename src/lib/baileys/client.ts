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
import { setConnectionState, getConnectionState } from "../db";
import { setupMessageHandler } from "./handler";
import { registerContact } from "./contact-store";
import { getOwnerNotifyPhones } from "../owner-notifier";
import { AUTH_DIR } from "../paths";

const logger = pino({ level: "silent" });

// Cache en memoria de mensajes recientes para que getMessage funcione
const msgCache = new Map<string, proto.IWebMessageInfo>();

interface BaileysHandle {
  sock: WASocket;
  shutdown: () => Promise<void>;
}

let handle: BaileysHandle | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(code?: number) {
  if (reconnectTimer) return;

  const delay = code === 440 ? 15000 : 5000;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    if (handle) {
      try {
        handle.sock.end(undefined);
      } catch {}
      handle = null;
    }

    start();
  }, delay);
}

export async function start(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version: [number, number, number] | undefined;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
    console.log(`[bot] Versión Baileys: ${version.join(".")}`);
  } catch (err) {
    console.warn("[bot] No se pudo obtener última versión:", err);
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS("Desktop"),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    // Requerido en v6.7+ para que el procesamiento de mensajes no se bloquee
    getMessage: async (key) => {
      const id = key.id ?? "";
      const cached = msgCache.get(id);
      if (cached?.message) return cached.message;
      return proto.Message.fromObject({});
    }
  });

  handle = {
    sock,
    shutdown: async () => {
      try {
        sock.end(undefined);
      } catch {}
    }
  };

  sock.ev.on("creds.update", saveCreds);

  // Llenar mapa LID → teléfono para resolver owners que llegan como @lid
  sock.ev.on("contacts.upsert", (contacts) => {
    console.log(`[contact-store] contacts.upsert: ${contacts.length} contactos`);
    for (const c of contacts) {
      const lid = (c as { lid?: string }).lid;
      if (lid) console.log(`[contact-store] LID encontrado: ${lid} → ${c.id}`);
      registerContact(c.id, lid);
    }
  });
  sock.ev.on("contacts.update", (contacts) => {
    for (const c of contacts) {
      const lid = (c as { lid?: string }).lid;
      if (lid) console.log(`[contact-store] LID actualizado: ${lid} → ${c.id}`);
      registerContact(c.id, lid);
    }
  });

  // Cachear mensajes entrantes para getMessage
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages) {
      if (msg.key?.id) {
        msgCache.set(msg.key.id, msg);
        // Limitar el tamaño del caché
        if (msgCache.size > 500) {
          const first = msgCache.keys().next().value;
          if (first) msgCache.delete(first);
        }
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("[bot] QR generado, guardando en DB...");
      setConnectionState({ status: "qr", qr_string: qr, phone: null });
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "connecting") {
      const current = getConnectionState();
      if (current.status === "disconnected") {
        setConnectionState({ status: "connecting" });
      }
    }

    if (connection === "open") {
      const rawId = sock.user?.id ?? "";
      const phone = rawId.split(":")[0];
      console.log(`[bot] Conectado como ${phone}`);
      setConnectionState({ status: "connected", qr_string: null, phone });

      // Pre-registrar LID de cada owner para resolver @lid JIDs
      const ownerPhones = getOwnerNotifyPhones();
      for (const ownerPhone of ownerPhones) {
        try {
          const results = await sock.onWhatsApp(ownerPhone);
          if (results && results.length > 0) {
            const info = results[0] as { jid: string; lid?: string; exists: boolean };
            if (info.exists && info.lid) {
              registerContact(info.jid, info.lid);
              console.log(`[contact-store] Owner pre-registrado: ${ownerPhone} → LID ${info.lid}`);
            } else {
              console.log(`[contact-store] Owner ${ownerPhone}: sin LID en respuesta`);
            }
          }
        } catch (err) {
          console.error(`[contact-store] Error consultando LID de ${ownerPhone}:`, err);
        }
      }
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })
        ?.output?.statusCode;

      console.log(`[bot] Conexión cerrada. Código: ${statusCode}`);

      if (
        statusCode === DisconnectReason.loggedOut ||
        statusCode === 401
      ) {
        console.log("[bot] Sesión cerrada. No se reconectará.");
        setConnectionState({
          status: "disconnected",
          qr_string: null,
          phone: null
        });
        return;
      }

      scheduleReconnect(statusCode);
    }
  });

  setupMessageHandler(sock);
}

export function getHandle(): BaileysHandle | null {
  return handle;
}
