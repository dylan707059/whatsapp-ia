import { NextRequest, NextResponse } from "next/server";
import {
  listConversations,
  listArchivedConversations,
  countArchivedConversations,
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

  return NextResponse.json({
    conversations,
    archivedCount,
    showingArchived: archived
  });
}
