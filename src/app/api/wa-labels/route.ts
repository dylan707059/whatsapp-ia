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
    // Muestras de JIDs para detectar desajuste de formato (@lid vs @s.whatsapp.net)
    const assocJids = (db.prepare(
      "SELECT DISTINCT chat_jid FROM wa_label_assoc WHERE owner_phone = ? LIMIT 10"
    ).all(ownerPhone) as { chat_jid: string }[]).map((r) => r.chat_jid);
    const convPhones = (db.prepare(
      "SELECT phone FROM conversations WHERE owner_phone = ? LIMIT 10"
    ).all(ownerPhone) as { phone: string }[]).map((r) => r.phone);
    // Cuántas asociaciones tienen un chat_jid que coincide con una conversación
    const matches = (db.prepare(`
      SELECT COUNT(*) AS n FROM wa_label_assoc a
      WHERE a.owner_phone = ?
        AND EXISTS (SELECT 1 FROM conversations c WHERE c.owner_phone = a.owner_phone AND c.phone = a.chat_jid)
    `).get(ownerPhone) as { n: number } | undefined)?.n ?? 0;

    return NextResponse.json({
      labels,
      _diag: {
        loggedIn: Boolean(account),
        ownerPhone: ownerPhone || "(vacío — WhatsApp no conectado para esta cuenta)",
        waLabelsTotal: rawAll,
        waLabelsDeleted: rawDeleted,
        waLabelsActivas: labels.length,
        asociaciones: assoc,
        asociacionesQueCoinciden: matches,
        muestraJidsEtiquetas: assocJids,
        muestraTelefonosConversaciones: convPhones
      }
    });
  }

  return NextResponse.json({ labels }, { headers: { "Cache-Control": "no-store" } });
}
