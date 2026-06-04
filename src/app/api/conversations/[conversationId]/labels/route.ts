import { NextRequest, NextResponse } from "next/server";
import {
  attachLabelToConversation,
  detachLabelFromConversation,
  getLabelsForConversation
} from "@/lib/db";
import { requireOwnedConversation, requireOwnedLabel } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx { params: Promise<{ conversationId: string }>; }

/** GET: lista las labels asignadas a esta conversación. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  if (!requireOwnedConversation(req, id)) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  return NextResponse.json({ labels: getLabelsForConversation(id) });
}

/** POST {labelId}: asigna una label a la conversación. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  if (!requireOwnedConversation(req, id)) return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });

  let body: { labelId?: number };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const labelId = Number(body.labelId);
  if (!Number.isInteger(labelId)) return NextResponse.json({ error: "labelId requerido" }, { status: 400 });
  if (!requireOwnedLabel(req, labelId)) return NextResponse.json({ error: "Label no encontrada" }, { status: 404 });

  attachLabelToConversation(id, labelId);
  return NextResponse.json({ ok: true });
}

/** DELETE ?labelId=N: quita una label de la conversación. */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  if (!requireOwnedConversation(req, id)) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  const labelId = Number(req.nextUrl.searchParams.get("labelId"));
  if (!Number.isInteger(labelId)) return NextResponse.json({ error: "labelId requerido" }, { status: 400 });

  detachLabelFromConversation(id, labelId);
  return NextResponse.json({ ok: true });
}
