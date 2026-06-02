import { NextResponse } from "next/server";
import fs from "node:fs";
import { setConnectionState } from "@/lib/db";
import { AUTH_DIR, RESTART_FLAG } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  setConnectionState({
    status: "disconnected",
    qr_string: null,
    phone: null
  });

  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch {}

  try {
    fs.writeFileSync(RESTART_FLAG, Date.now().toString());
  } catch {}

  return NextResponse.json({ ok: true });
}
