import { NextRequest, NextResponse } from "next/server";
import { getIncomingSince } from "@/lib/db";
import { ownerPhoneFromRequest } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Devuelve los mensajes ENTRANTES (del cliente) con id > since, de la cuenta
 * autenticada. Lo usa el manager de notificaciones de escritorio.
 */
export async function GET(req: NextRequest) {
  const owner = ownerPhoneFromRequest(req);
  if (!owner) return NextResponse.json({ items: [] });

  const since = Number(req.nextUrl.searchParams.get("since") ?? 0) || 0;
  const items = getIncomingSince(owner, since, 20);
  return NextResponse.json({ items });
}
