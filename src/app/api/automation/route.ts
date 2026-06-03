import { NextRequest, NextResponse } from "next/server";
import { isAccountAutomationPaused, setAccountAutomationPaused } from "@/lib/db";
import { accountFromRequest } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const account = accountFromRequest(req);
  if (!account) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  return NextResponse.json({ paused: isAccountAutomationPaused(account.id) });
}

export async function POST(req: NextRequest) {
  const account = accountFromRequest(req);
  if (!account) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  let paused = true;
  try {
    const body = await req.json();
    paused = Boolean(body.paused);
  } catch {
    // sin body: por defecto pausar
  }

  setAccountAutomationPaused(account.id, paused);
  return NextResponse.json({ ok: true, paused });
}
