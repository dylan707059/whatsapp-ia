import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getMessages, insertMessage, insertMediaMessage, enqueueOutbox, type MediaInput } from "@/lib/db";
import { requireOwnedConversation } from "@/lib/request-account";
import { MEDIA_DIR } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

function kindFor(mime: string): "image" | "video" | "document" | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "document";
  return null;
}

function extFor(mime: string, filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot >= 0) {
    const e = filename.slice(dot).toLowerCase();
    if (/^\.[a-z0-9]{1,5}$/.test(e)) return e;
  }
  const map: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
    "video/mp4": ".mp4", "video/quicktime": ".mov", "video/3gpp": ".3gp",
    "application/pdf": ".pdf"
  };
  return map[mime] ?? ".bin";
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  if (!requireOwnedConversation(req, id)) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const messages = getMessages(id, 100);
  return NextResponse.json(messages);
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const conv = requireOwnedConversation(req, id);
  if (!conv) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  const contentType = req.headers.get("content-type") || "";

  // ─── Envío de archivo (multipart/form-data) ───────────────────────────────
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "Formulario inválido" }, { status: 400 });
    }

    const file = form.get("file");
    const caption = (form.get("caption")?.toString() ?? "").trim();
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Falta el archivo" }, { status: 400 });
    }

    const mime = file.type || "application/octet-stream";
    const kind = kindFor(mime);
    if (!kind) {
      return NextResponse.json({ error: "Tipo de archivo no permitido" }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "El archivo supera el límite de 20 MB" }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const dir = path.join(MEDIA_DIR, String(id));
    fs.mkdirSync(dir, { recursive: true });
    const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extFor(mime, file.name)}`;
    fs.writeFileSync(path.join(dir, fname), buf);

    const media: MediaInput = {
      type: kind,
      path: path.join(String(id), fname),
      mime,
      filename: kind === "document" ? (file.name || "documento") : null,
      size: buf.length
    };

    const messageId = insertMediaMessage(id, "human", caption, media);
    // Envío manual desde el panel: ASAP, sin ventana de expiración (igual que
    // el texto manual). El poller del bot lo envía por Baileys.
    enqueueOutbox(id, conv.phone, caption, 0, messageId, 0, false, media);

    return NextResponse.json({ ok: true, messageId });
  }

  // ─── Envío de texto (JSON) ────────────────────────────────────────────────
  const body = await req.json() as { content?: string };
  if (!body.content?.trim()) {
    return NextResponse.json({ error: "Contenido vacío" }, { status: 400 });
  }

  const messageId = insertMessage(id, "human", body.content.trim());
  enqueueOutbox(id, conv.phone, body.content.trim(), 0, messageId);

  return NextResponse.json({ ok: true, messageId });
}
