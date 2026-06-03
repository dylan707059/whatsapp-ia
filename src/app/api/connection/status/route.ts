import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { getAccountConnection } from "@/lib/db";
import { accountFromRequest } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const account = accountFromRequest(req);
  if (!account) {
    return NextResponse.json({ status: "disconnected" }, { status: 401 });
  }

  const state = getAccountConnection(account.id);

  const shouldShowQr =
    !!state.qr_string &&
    (state.status === "qr" || state.status === "connecting");

  if (shouldShowQr && state.qr_string) {
    const qrPng = await QRCode.toDataURL(state.qr_string, { width: 320, margin: 2 });
    return NextResponse.json({ status: "qr", qrPng, updatedAt: state.updated_at });
  }

  return NextResponse.json({
    status: state.status,
    phone: state.phone,
    updatedAt: state.updated_at
  });
}
