import { NextRequest, NextResponse } from "next/server";
import { getWaGroups } from "@/lib/db";
import { ownerPhoneFromRequest } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: lista los grupos de WhatsApp donde está el bot de la cuenta.
 *  Los captura el bot-runtime (que sí tiene el socket) y los guarda en DB,
 *  porque las rutas API corren en otra instancia de módulo. Se usan en
 *  Configuración para elegir grupo de confirmaciones (Dropi) y de envío manual. */
export async function GET(req: NextRequest) {
  const ownerPhone = ownerPhoneFromRequest(req);
  if (!ownerPhone) {
    return NextResponse.json(
      { groups: [], error: "WhatsApp no está conectado" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const groups = getWaGroups(ownerPhone);
  return NextResponse.json({ groups }, { headers: { "Cache-Control": "no-store" } });
}
