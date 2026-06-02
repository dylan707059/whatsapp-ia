import { NextRequest, NextResponse } from "next/server";
import { getConversationById } from "@/lib/db";
import { getActiveOrder } from "@/lib/orders";

export const runtime = "nodejs";
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

  const order = getActiveOrder(id) ?? null;
  return NextResponse.json({ order, aiPausedUntil: conv.ai_paused_until });
}
