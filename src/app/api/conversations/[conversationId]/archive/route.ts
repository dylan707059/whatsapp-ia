import { NextRequest, NextResponse } from "next/server";
import { archiveConversation } from "@/lib/db";
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

  if (!requireOwnedConversation(req, id)) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  archiveConversation(id);
  return NextResponse.json({ ok: true });
}
