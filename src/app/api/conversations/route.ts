import { NextRequest, NextResponse } from "next/server";
import {
  listConversations,
  listArchivedConversations,
  countArchivedConversations,
  getAllWaLabelsByConversation
} from "@/lib/db";
import { ownerPhoneFromRequest } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ownerPhone = ownerPhoneFromRequest(req);

  const archived = req.nextUrl.searchParams.get("archived") === "true";

  const conversations = archived
    ? listArchivedConversations(ownerPhone)
    : listConversations(ownerPhone);

  const archivedCount = countArchivedConversations(ownerPhone);

  // Enriquecer cada conv con sus etiquetas de WhatsApp Business (id/name/color).
  const labelsByConv = getAllWaLabelsByConversation(ownerPhone);
  const enriched = conversations.map((c) => ({
    ...c,
    labels: labelsByConv.get(c.id) ?? []
  }));

  return NextResponse.json({
    conversations: enriched,
    archivedCount,
    showingArchived: archived
  });
}
