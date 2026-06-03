import { NextRequest, NextResponse } from "next/server";
import { unarchiveConversation, getConversationById } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

export async function POST(_req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);

  if (isNaN(id)) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  if (!getConversationById(id)) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  unarchiveConversation(id);
  return NextResponse.json({ ok: true });
}
