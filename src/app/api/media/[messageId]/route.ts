import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getMessageRow } from "@/lib/db";
import { requireOwnedConversation } from "@/lib/request-account";
import { MEDIA_DIR } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ messageId: string }>;
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { messageId } = await params;
  const id = Number(messageId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const row = getMessageRow(id);
  if (!row || !row.media_path) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  // Ownership: el mensaje debe pertenecer a una conversación de la cuenta autenticada.
  if (!requireOwnedConversation(req, row.conversation_id)) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  // Resolver la ruta de forma segura (no permitir salir de MEDIA_DIR).
  const root = path.resolve(MEDIA_DIR);
  const abs = path.resolve(root, row.media_path);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return NextResponse.json({ error: "Ruta inválida" }, { status: 400 });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return NextResponse.json({ error: "Archivo no disponible" }, { status: 404 });
  }

  const mime = row.media_mime || "application/octet-stream";
  const total = stat.size;
  const download = req.nextUrl.searchParams.get("download") === "1";

  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=86400"
  };
  if (download || row.media_type === "document") {
    const fn = (row.media_filename || "archivo").replace(/["\\\r\n]/g, "");
    headers["Content-Disposition"] = `${download ? "attachment" : "inline"}; filename="${fn}"`;
  }

  // Soporte de Range (necesario para hacer seek en <video>).
  const range = req.headers.get("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${total}` }
        });
      }
      const chunk = readSlice(abs, start, end);
      return new NextResponse(new Uint8Array(chunk), {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(end - start + 1)
        }
      });
    }
  }

  const buf = fs.readFileSync(abs);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: { ...headers, "Content-Length": String(total) }
  });
}

function readSlice(abs: string, start: number, end: number): Buffer {
  const len = end - start + 1;
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}
