import { NextRequest, NextResponse } from "next/server";
import {
  listWaLabelIdsForChat,
  getWaLabelById,
  setWaLabelAssoc,
  removeWaLabelAssoc,
  enqueueWaLabelOp
} from "@/lib/db";
import { requireOwnedConversation } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx { params: Promise<{ conversationId: string }>; }

/** GET: ids de etiquetas WA asignadas al chat de esta conversación. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const conv = requireOwnedConversation(req, id);
  if (!conv) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  return NextResponse.json({ labelIds: listWaLabelIdsForChat(conv.owner_phone, conv.phone) });
}

/** POST {labelId}: pone una etiqueta WA al chat. Se refleja en el panel al
 *  instante y el bot la sincroniza con el WhatsApp real en ~2s. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const conv = requireOwnedConversation(req, id);
  if (!conv) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  let body: { labelId?: string };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const labelId = body.labelId != null ? String(body.labelId) : "";
  if (!labelId) return NextResponse.json({ error: "labelId requerido" }, { status: 400 });
  if (!getWaLabelById(conv.owner_phone, labelId)) {
    return NextResponse.json({ error: "Etiqueta no encontrada" }, { status: 404 });
  }

  setWaLabelAssoc(conv.owner_phone, labelId, conv.phone);          // reflejo inmediato en el panel
  enqueueWaLabelOp(conv.owner_phone, conv.phone, labelId, "add");  // el bot la aplica en WhatsApp
  return NextResponse.json({ ok: true });
}

/** DELETE ?labelId=...: quita una etiqueta WA del chat (panel → WhatsApp). */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const conv = requireOwnedConversation(req, id);
  if (!conv) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  const labelId = req.nextUrl.searchParams.get("labelId") ?? "";
  if (!labelId) return NextResponse.json({ error: "labelId requerido" }, { status: 400 });

  removeWaLabelAssoc(conv.owner_phone, labelId, conv.phone);
  enqueueWaLabelOp(conv.owner_phone, conv.phone, labelId, "remove");
  return NextResponse.json({ ok: true });
}
