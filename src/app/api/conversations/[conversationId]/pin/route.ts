import { NextRequest, NextResponse } from "next/server";
import {
  pinConversation,
  countPinnedConversations,
  getConversationById,
  getConnectionState,
  MAX_PINNED
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx { params: Promise<{ conversationId: string }>; }

export async function POST(_req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const conv = getConversationById(id);
  if (!conv) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  const { phone } = getConnectionState();
  const pinnedCount = countPinnedConversations(phone ?? "");
  if (pinnedCount >= MAX_PINNED && !conv.pinned_at) {
    return NextResponse.json(
      { error: `Máximo ${MAX_PINNED} conversaciones fijadas. Desfija alguna primero.` },
      { status: 409 }
    );
  }

  pinConversation(id);
  return NextResponse.json({ ok: true });
}
