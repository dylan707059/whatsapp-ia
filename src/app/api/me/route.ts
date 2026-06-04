import { NextRequest, NextResponse } from "next/server";
import { accountFromRequest } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const account = accountFromRequest(req);
  if (!account) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  return NextResponse.json({
    email: account.email,
    businessName: account.business_name,
    isAdmin: account.is_admin === 1
  });
}
