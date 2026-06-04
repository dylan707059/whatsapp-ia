import fs from "node:fs";
import path from "node:path";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import type { WASocket, WAMessage, proto } from "@whiskeysockets/baileys";
import pino from "pino";
import { MEDIA_DIR } from "../paths";
import type { MediaInput } from "../db";

const logger = pino({ level: "silent" });

// Límite de descarga (RAM de 512 MB en Render): no bajamos archivos enormes.
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_DOWNLOAD_BYTES ?? 20 * 1024 * 1024);

export type MediaKind = "image" | "video" | "document" | "audio" | "sticker";

interface DetectedMedia {
  kind: MediaKind;
  mime: string | null;
  caption: string;
  filename: string | null;
  size: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function numOrNull(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && typeof v.toNumber === "function") {
    try { return v.toNumber(); } catch { return null; }
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Detecta si un mensaje de WhatsApp trae multimedia y de qué tipo. */
export function detectMedia(message: proto.IMessage | null | undefined): DetectedMedia | null {
  if (!message) return null;
  // Accedemos de forma laxa: la forma exacta del proto varía entre versiones y
  // WhatsApp envuelve algunos mensajes (ver-una-vez, efímeros, doc con caption).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = message as any;
  const m =
    msg.ephemeralMessage?.message ??
    msg.viewOnceMessage?.message ??
    msg.viewOnceMessageV2?.message ??
    msg.viewOnceMessageV2Extension?.message ??
    msg.documentWithCaptionMessage?.message ??
    msg;

  if (m.imageMessage) {
    const n = m.imageMessage;
    return { kind: "image", mime: n.mimetype ?? "image/jpeg", caption: n.caption ?? "", filename: null, size: numOrNull(n.fileLength) };
  }
  if (m.videoMessage) {
    const n = m.videoMessage;
    return { kind: "video", mime: n.mimetype ?? "video/mp4", caption: n.caption ?? "", filename: null, size: numOrNull(n.fileLength) };
  }
  if (m.documentMessage) {
    const n = m.documentMessage;
    return { kind: "document", mime: n.mimetype ?? "application/octet-stream", caption: n.caption ?? "", filename: n.fileName ?? "documento", size: numOrNull(n.fileLength) };
  }
  if (m.audioMessage) {
    const n = m.audioMessage;
    return { kind: "audio", mime: n.mimetype ?? "audio/ogg", caption: "", filename: null, size: numOrNull(n.fileLength) };
  }
  if (m.stickerMessage) {
    const n = m.stickerMessage;
    return { kind: "sticker", mime: n.mimetype ?? "image/webp", caption: "", filename: null, size: numOrNull(n.fileLength) };
  }
  return null;
}

function extFor(mime: string | null, filename: string | null): string {
  if (filename && filename.includes(".")) {
    const e = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    if (e.length >= 2 && e.length <= 6 && /^\.[a-z0-9]+$/.test(e)) return e;
  }
  const map: Record<string, string> = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/webp": ".webp", "image/gif": ".gif",
    "video/mp4": ".mp4", "video/3gpp": ".3gp", "video/quicktime": ".mov",
    "application/pdf": ".pdf",
    "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/aac": ".aac"
  };
  if (mime) {
    const base = mime.split(";")[0].trim().toLowerCase();
    if (map[base]) return map[base];
    const slash = base.indexOf("/");
    if (slash >= 0) {
      const sub = base.slice(slash + 1).replace(/[^a-z0-9]/g, "").slice(0, 4);
      if (sub) return "." + sub;
    }
  }
  return ".bin";
}

interface SavedMedia {
  media: MediaInput;
  caption: string;
  kind: MediaKind;
}

/**
 * Descarga el multimedia de un mensaje entrante y lo guarda en disco.
 * Devuelve null si el mensaje no trae media descargable (audio/sticker o
 * archivo demasiado grande quedan fuera por diseño/RAM).
 */
export async function saveIncomingMedia(
  sock: WASocket,
  msg: WAMessage,
  conversationId: number
): Promise<SavedMedia | null> {
  const detected = detectMedia(msg.message);
  if (!detected) return null;

  // Audio y stickers: fuera de alcance — el handler guarda un placeholder.
  if (detected.kind === "audio" || detected.kind === "sticker") return null;

  // Demasiado grande: no descargamos (protege la RAM).
  if (detected.size && detected.size > MAX_MEDIA_BYTES) {
    console.warn(`[media] ${detected.kind} de ~${Math.round(detected.size / 1024 / 1024)}MB excede el límite — no se descarga`);
    return null;
  }

  let buffer: Buffer;
  try {
    buffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    )) as Buffer;
  } catch (err) {
    console.error("[media] Error descargando multimedia:", err);
    return null;
  }
  if (!buffer || buffer.length === 0) return null;
  if (buffer.length > MAX_MEDIA_BYTES) return null;

  const ext = extFor(detected.mime, detected.filename);
  const dir = path.join(MEDIA_DIR, String(conversationId));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    fs.writeFileSync(path.join(dir, fname), buffer);
    return {
      media: {
        type: detected.kind,
        path: path.join(String(conversationId), fname),
        mime: detected.mime,
        filename: detected.filename,
        size: buffer.length
      },
      caption: detected.caption,
      kind: detected.kind
    };
  } catch (err) {
    console.error("[media] Error guardando archivo:", err);
    return null;
  }
}

/**
 * Construye el contenido de envío de Baileys para un archivo en disco.
 * Lo lee desde su ruta absoluta (no carga el archivo en RAM hasta el envío).
 */
export function buildOutgoingMediaContent(opts: {
  absPath: string;
  type: string;
  mime: string | null;
  filename: string | null;
  caption: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): any {
  const caption = opts.caption?.trim() ? opts.caption.trim() : undefined;
  if (opts.type === "image") return { image: { url: opts.absPath }, caption };
  if (opts.type === "video") return { video: { url: opts.absPath }, caption };
  // documento y cualquier otro tipo
  return {
    document: { url: opts.absPath },
    mimetype: opts.mime ?? "application/octet-stream",
    fileName: opts.filename ?? "archivo",
    caption
  };
}
