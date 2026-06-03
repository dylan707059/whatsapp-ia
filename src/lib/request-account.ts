import type { NextRequest } from "next/server";
import { getAccountBySessionToken, type Account } from "./db";

// Resuelve la cuenta autenticada a partir de la cookie de sesión.
export function accountFromRequest(req: NextRequest): Account | undefined {
  const token = req.cookies.get("session")?.value;
  return token ? getAccountBySessionToken(token) : undefined;
}

// Número de WhatsApp conectado de la cuenta autenticada (clave de aislamiento
// de datos: todas las consultas se filtran por este owner_phone). Cadena vacía
// si no hay sesión o la cuenta aún no conectó WhatsApp.
export function ownerPhoneFromRequest(req: NextRequest): string {
  return accountFromRequest(req)?.owner_phone ?? "";
}
