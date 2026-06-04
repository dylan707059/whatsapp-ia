import { NextRequest, NextResponse } from "next/server";
import { getActiveOrder, setOrderStatus } from "@/lib/orders";
import { requireOwnedConversation } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const conv = requireOwnedConversation(req, id);
  if (!conv) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  const order = getActiveOrder(id) ?? null;
  return NextResponse.json({ order, aiPausedUntil: conv.ai_paused_until });
}

// POST {action}: cambia el estado del pedido ACTIVO de esta conversación.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  if (!requireOwnedConversation(req, id)) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  let body: { action?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 }); }

  const order = getActiveOrder(id);
  if (!order) return NextResponse.json({ error: "Sin pedido activo" }, { status: 404 });

  if (body.action === "dispatch") {
    setOrderStatus(order.id, "DISPATCHED");
    return NextResponse.json({ ok: true, status: "DISPATCHED" });
  }
  if (body.action === "cancel") {
    setOrderStatus(order.id, "CANCELLED");
    return NextResponse.json({ ok: true, status: "CANCELLED" });
  }
  return NextResponse.json({ error: "Acción inválida" }, { status: 400 });
}
