import { NextRequest, NextResponse } from "next/server";
import { deleteSession } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get("session")?.value;
  if (token) {
    try { deleteSession(token); } catch {}
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.delete("session");
  return res;
}
