import { NextRequest, NextResponse } from "next/server";
import { mergeConversationInto } from "@/lib/db";
import { requireOwnedConversation } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

// POST /api/conversations/[id]/merge  { targetId: number }
// Mueve todos los mensajes/outbox/pedidos de `id` a `targetId` y borra `id`.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const fromId = Number(conversationId);
  if (isNaN(fromId)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  if (!requireOwnedConversation(req, fromId)) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const toId = Number(body.targetId);
  if (isNaN(toId) || toId === fromId) {
    return NextResponse.json({ error: "targetId inválido" }, { status: 400 });
  }

  if (!requireOwnedConversation(req, toId)) {
    return NextResponse.json({ error: "Conversación destino no encontrada" }, { status: 404 });
  }

  try {
    mergeConversationInto(fromId, toId);
    return NextResponse.json({ ok: true, merged: fromId, into: toId });
  } catch (err) {
    console.error("[merge] Error fusionando conversaciones:", err);
    return NextResponse.json({ error: "Error al fusionar" }, { status: 500 });
  }
}
