import { NextRequest, NextResponse } from "next/server";
import { listWaLabels, waLabelColorHex } from "@/lib/db";
import { accountFromRequest } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: lista las etiquetas nativas de WhatsApp Business de la cuenta.
 *  Estas se crean en la app de WhatsApp Business; aquí solo se listan. */
export async function GET(req: NextRequest) {
  const account = accountFromRequest(req);
  const ownerPhone = account?.owner_phone ?? "";
  if (!ownerPhone) return NextResponse.json({ labels: [] });

  const labels = listWaLabels(ownerPhone).map((l) => ({
    id: l.label_id,
    name: l.name ?? "Etiqueta",
    color: waLabelColorHex(l.color)
  }));

  return NextResponse.json({ labels });
}
