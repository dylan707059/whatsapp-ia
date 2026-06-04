import { NextRequest, NextResponse } from "next/server";
import {
  pinConversation,
  countPinnedConversations,
  MAX_PINNED
} from "@/lib/db";
import { ownerPhoneFromRequest, requireOwnedConversation } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx { params: Promise<{ conversationId: string }>; }

export async function POST(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const conv = requireOwnedConversation(req, id);
  if (!conv) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  const pinnedCount = countPinnedConversations(ownerPhoneFromRequest(req));
  if (pinnedCount >= MAX_PINNED && !conv.pinned_at) {
    return NextResponse.json(
      { error: `Máximo ${MAX_PINNED} conversaciones fijadas. Desfija alguna primero.` },
      { status: 409 }
    );
  }

  pinConversation(id);
  return NextResponse.json({ ok: true });
}
