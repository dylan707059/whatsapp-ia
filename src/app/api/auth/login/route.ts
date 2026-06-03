import { NextRequest, NextResponse } from "next/server";
import { getAccountByEmail, createSession } from "@/lib/db";
import { verifyPassword } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let email = "";
  let password = "";
  try {
    const body = await req.json();
    email = String(body.email ?? "").toLowerCase().trim();
    password = String(body.password ?? "");
  } catch {
    return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 });
  }

  if (!email || !password) {
    return NextResponse.json({ error: "Correo y contraseña son obligatorios" }, { status: 400 });
  }

  const account = getAccountByEmail(email);
  // Mismo mensaje para email inexistente y contraseña mala (no filtrar cuáles emails existen).
  if (!account || !verifyPassword(password, account.password_hash)) {
    return NextResponse.json({ error: "Correo o contraseña incorrectos" }, { status: 401 });
  }

  const token = createSession(account.id);

  const res = NextResponse.json({ ok: true, businessName: account.business_name });
  res.cookies.set("session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === "production"
  });
  return res;
}
