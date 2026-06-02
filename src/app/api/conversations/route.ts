import { NextResponse } from "next/server";
import { listConversations } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const conversations = listConversations();
  return NextResponse.json(conversations);
}
