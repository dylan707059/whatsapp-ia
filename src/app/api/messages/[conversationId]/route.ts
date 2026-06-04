import { NextRequest, NextResponse } from "next/server";
import { getMessages, insertMessage, enqueueOutbox } from "@/lib/db";
import { requireOwnedConversation } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ conversationId: string }>;
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

  const body = await req.json() as { content?: string; role?: string };

  if (!body.content?.trim()) {
    return NextResponse.json({ error: "Contenido vacío" }, { status: 400 });
  }

  // Solo mensajes humanos desde el dashboard
  const messageId = insertMessage(id, "human", body.content.trim());
  enqueueOutbox(id, conv.phone, body.content.trim(), 0, messageId);

  return NextResponse.json({ ok: true, messageId });
}
