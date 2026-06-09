import { NextRequest, NextResponse } from "next/server";
import { getHandle } from "@/lib/baileys/client";
import { accountFromRequest } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: lista los grupos de WhatsApp donde está el bot de la cuenta.
 *  Se usan en Configuración para elegir el grupo de confirmaciones (Dropi) y
 *  el grupo de envío manual al cliente. Devuelve [{ id, name }]. */
export async function GET(req: NextRequest) {
  const account = accountFromRequest(req);
  if (!account) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const handle = getHandle(account.id);
  if (!handle) {
    return NextResponse.json(
      { groups: [], error: "WhatsApp no está conectado" },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sock = handle.sock as any;
    const map = await sock.groupFetchAllParticipating();
    const groups = Object.values(map ?? {})
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((g: any) => ({ id: String(g.id), name: String(g.subject ?? g.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ groups }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[api] Error listando grupos WA:", err);
    return NextResponse.json(
      { groups: [], error: "No se pudieron cargar los grupos" },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}
