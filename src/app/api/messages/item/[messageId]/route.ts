import { NextRequest, NextResponse } from "next/server";
import {
  getMessageById,
  deleteMessageLocal,
  enqueueRevoke
} from "@/lib/db";
import { requireOwnedConversation } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ messageId: string }>;
}

/**
 * Borra un mensaje:
 *   - ?for=me        → solo de la DB local (dashboard). Default.
 *   - ?for=everyone  → encola un revoke a WhatsApp (vía Baileys delete) y
 *                      luego borra de la DB local. Solo aplica a mensajes
 *                      enviados por el bot (wa_from_me=1) dentro de la
 *                      ventana de tiempo permitida por WhatsApp (~1h).
 */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { messageId } = await params;
  const id = Number(messageId);
  if (isNaN(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const msg = getMessageById(id);
  if (!msg) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  // El mensaje debe pertenecer a una conversación de la cuenta autenticada.
  const conv = requireOwnedConversation(req, msg.conversation_id);
  if (!conv) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  const target = req.nextUrl.searchParams.get("for") ?? "me";

  if (target === "everyone") {
    // Solo podemos revocar mensajes que el bot mando (wa_from_me=1)
    if (msg.wa_from_me !== 1 || !msg.wa_msg_id) {
      return NextResponse.json(
        { error: "No se puede borrar para todos: el bot no envió este mensaje" },
        { status: 400 }
      );
    }

    enqueueRevoke(msg.conversation_id, conv.phone, msg.wa_msg_id, true);
    // El revoke real lo procesa el bot en el siguiente tick (~2s)
    deleteMessageLocal(id);
    return NextResponse.json({ ok: true, mode: "everyone" });
  }

  // for=me: solo DB
  deleteMessageLocal(id);
  return NextResponse.json({ ok: true, mode: "me" });
}
