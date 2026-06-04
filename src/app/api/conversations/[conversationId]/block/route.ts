import { NextRequest, NextResponse } from "next/server";
import { blockClient, unblockClient } from "@/lib/db";
import { requireOwnedConversation } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx { params: Promise<{ conversationId: string }>; }

// POST: alterna el bloqueo del cliente. Bloqueado = el bot ignora sus mensajes.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const conv = requireOwnedConversation(req, id);
  if (!conv) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  if (conv.blocked_at) {
    unblockClient(id);
    return NextResponse.json({ ok: true, blocked: false });
  }
  blockClient(id);
  return NextResponse.json({ ok: true, blocked: true });
}
