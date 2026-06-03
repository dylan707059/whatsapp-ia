import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { setAccountConnection } from "@/lib/db";
import { accountFromRequest } from "@/lib/request-account";
import { DATA_DIR } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const account = accountFromRequest(req);
  if (!account) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  setAccountConnection(account.id, { status: "disconnected", qr_string: null, phone: null });

  // El bot (start-bot.ts) detecta este flag, limpia las credenciales de la
  // cuenta y reinicia su socket para mostrar un QR nuevo.
  try {
    fs.writeFileSync(path.join(DATA_DIR, `.restart-${account.id}`), Date.now().toString());
  } catch {}

  return NextResponse.json({ ok: true });
}
