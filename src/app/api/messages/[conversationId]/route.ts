import { NextRequest, NextResponse } from "next/server";
import {
  getConversationById,
  getMessages,
  insertMessage,
  enqueueOutbox
} from "@/lib/db";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);

  if (isNaN(id)) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  const conv = getConversationById(id);
  if (!conv) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const messages = getMessages(id, 100);
  return NextResponse.json(messages);
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);

  if (isNaN(id)) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  const conv = getConversationById(id);
  if (!conv) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const body = await req.json() as { content?: string; role?: string };

  if (!body.content?.trim()) {
    return NextResponse.json({ error: "Contenido vacío" }, { status: 400 });
  }

  // Solo mensajes humanos desde el dashboard
  const messageId = insertMessage(id, "human", body.content.trim());
  enqueueOutbox(id, conv.phone, body.content.trim());

  return NextResponse.json({ ok: true, messageId });
}
