import { NextRequest, NextResponse } from "next/server";
import { setMode } from "@/lib/db";
import { requireOwnedConversation } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);

  if (isNaN(id)) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  if (!requireOwnedConversation(req, id)) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const body = await req.json() as { mode?: string };

  if (body.mode !== "AI" && body.mode !== "HUMAN") {
    return NextResponse.json(
      { error: "Modo inválido. Usa AI o HUMAN." },
      { status: 400 }
    );
  }

  setMode(id, body.mode);
  return NextResponse.json({ ok: true, mode: body.mode });
}
