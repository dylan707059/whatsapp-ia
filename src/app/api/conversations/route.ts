import { NextRequest, NextResponse } from "next/server";
import {
  listConversations,
  listArchivedConversations,
  countArchivedConversations,
  getAllConversationLabels,
  getConnectionState
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { phone } = getConnectionState();
  const ownerPhone = phone ?? "";

  const archived = req.nextUrl.searchParams.get("archived") === "true";

  const conversations = archived
    ? listArchivedConversations(ownerPhone)
    : listConversations(ownerPhone);

  const archivedCount = countArchivedConversations(ownerPhone);

  // Enriquecer cada conv con sus labels (lite, solo id/name/color)
  const labelsByConv = getAllConversationLabels(ownerPhone);
  const enriched = conversations.map((c) => ({
    ...c,
    labels: (labelsByConv.get(c.id) ?? []).map((l) => ({
      id: l.id, name: l.name, color: l.color
    }))
  }));

  return NextResponse.json({
    conversations: enriched,
    archivedCount,
    showingArchived: archived
  });
}
