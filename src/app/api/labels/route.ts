import { NextRequest, NextResponse } from "next/server";
import { listLabels, createLabel } from "@/lib/db";
import { ownerPhoneFromRequest } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_COLOR = "#5e6ad2";
const COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

export async function GET(req: NextRequest) {
  const labels = listLabels(ownerPhoneFromRequest(req));
  return NextResponse.json({ labels });
}

export async function POST(req: NextRequest) {
  const ownerPhone = ownerPhoneFromRequest(req);

  let body: { name?: string; color?: string };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const name = (body.name || "").trim();
  if (!name) return NextResponse.json({ error: "Nombre requerido" }, { status: 400 });
  if (name.length > 40) return NextResponse.json({ error: "Nombre demasiado largo (máx 40)" }, { status: 400 });

  const color = (body.color || DEFAULT_COLOR).trim();
  if (!COLOR_REGEX.test(color)) {
    return NextResponse.json({ error: "Color inválido. Usar formato #RRGGBB" }, { status: 400 });
  }

  const label = createLabel(ownerPhone, name, color);
  return NextResponse.json({ label });
}
