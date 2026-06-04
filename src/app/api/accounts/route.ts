import { NextRequest, NextResponse } from "next/server";
import { listAllAccounts, getAccountByEmail, createAccount } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { accountFromRequest } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const account = accountFromRequest(req);
  if (!account || account.is_admin !== 1) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }
  const accounts = listAllAccounts().map((a) => ({
    id: a.id,
    email: a.email,
    businessName: a.business_name,
    ownerPhone: a.owner_phone,
    automationPaused: a.automation_paused === 1,
    isAdmin: a.is_admin === 1
  }));
  return NextResponse.json({ accounts });
}

export async function POST(req: NextRequest) {
  const account = accountFromRequest(req);
  if (!account || account.is_admin !== 1) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 });
  }

  const email = String(body.email ?? "").toLowerCase().trim();
  const password = String(body.password ?? "");
  const businessName = String(body.businessName ?? "").trim() || null;

  if (!email || !password) {
    return NextResponse.json({ error: "Correo y contraseña son obligatorios" }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "La contraseña debe tener al menos 6 caracteres" }, { status: 400 });
  }
  if (getAccountByEmail(email)) {
    return NextResponse.json({ error: "Ya existe una cuenta con ese correo" }, { status: 409 });
  }

  const created = createAccount(email, hashPassword(password), businessName, null, false);
  return NextResponse.json({ ok: true, account: { id: created.id, email: created.email } });
}
