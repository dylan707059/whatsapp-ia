import { NextResponse } from "next/server";
import { listConversations, getConnectionState } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { phone } = getConnectionState();
  const conversations = listConversations(phone ?? "");
  return NextResponse.json(conversations);
}
