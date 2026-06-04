import { NextRequest, NextResponse } from "next/server";
import { setConversationMuted } from "@/lib/db";
import { requireOwnedConversation } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const conv = requireOwnedConversation(req, id);
  if (!conv) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  // Toggle: si estaba silenciado, reactivar; si no, silenciar.
  const next = conv.muted_at == null;
  setConversationMuted(id, next);
  return NextResponse.json({ ok: true, muted: next });
}
