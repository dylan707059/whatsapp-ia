import { NextRequest, NextResponse } from "next/server";
import { getLabelById, updateLabel, deleteLabel } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

interface Ctx { params: Promise<{ labelId: string }>; }

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { labelId } = await params;
  const id = Number(labelId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const existing = getLabelById(id);
  if (!existing) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  let body: { name?: string; color?: string };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const name = (body.name ?? existing.name).trim();
  const color = (body.color ?? existing.color).trim();
  if (!name) return NextResponse.json({ error: "Nombre requerido" }, { status: 400 });
  if (!COLOR_REGEX.test(color)) {
    return NextResponse.json({ error: "Color inválido" }, { status: 400 });
  }

  updateLabel(id, name, color);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { labelId } = await params;
  const id = Number(labelId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  if (!getLabelById(id)) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  deleteLabel(id);
  return NextResponse.json({ ok: true });
}
