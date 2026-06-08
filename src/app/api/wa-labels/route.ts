import { NextRequest, NextResponse } from "next/server";
import { db, listWaLabels, waLabelColorHex } from "@/lib/db";
import { accountFromRequest } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: lista las etiquetas nativas de WhatsApp Business de la cuenta.
 *  Estas se crean en la app de WhatsApp Business; aquí solo se listan.
 *  Con ?debug=1 incluye diagnóstico (conteos crudos) para depurar. */
export async function GET(req: NextRequest) {
  const account = accountFromRequest(req);
  const ownerPhone = account?.owner_phone ?? "";

  const labels = ownerPhone
    ? listWaLabels(ownerPhone).map((l) => ({
        id: l.label_id,
        name: l.name ?? "Etiqueta",
        color: waLabelColorHex(l.color)
      }))
    : [];

  if (req.nextUrl.searchParams.get("debug") === "1") {
    const rawAll = (db.prepare("SELECT COUNT(*) AS n FROM wa_labels WHERE owner_phone = ?")
      .get(ownerPhone) as { n: number } | undefined)?.n ?? 0;
    const rawDeleted = (db.prepare("SELECT COUNT(*) AS n FROM wa_labels WHERE owner_phone = ? AND deleted = 1")
      .get(ownerPhone) as { n: number } | undefined)?.n ?? 0;
    const assoc = (db.prepare("SELECT COUNT(*) AS n FROM wa_label_assoc WHERE owner_phone = ?")
      .get(ownerPhone) as { n: number } | undefined)?.n ?? 0;
    const sample = db.prepare("SELECT label_id, name, color, deleted FROM wa_labels WHERE owner_phone = ? LIMIT 30")
      .all(ownerPhone);
    return NextResponse.json({
      labels,
      _diag: {
        loggedIn: Boolean(account),
        ownerPhone: ownerPhone || "(vacío — WhatsApp no conectado para esta cuenta)",
        waLabelsTotal: rawAll,
        waLabelsDeleted: rawDeleted,
        waLabelsActivas: labels.length,
        asociaciones: assoc,
        muestra: sample
      }
    });
  }

  return NextResponse.json({ labels });
}
