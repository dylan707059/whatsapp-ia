import type { NextRequest } from "next/server";
import {
  getAccountBySessionToken,
  getConversationById,
  getLabelById,
  type Account,
  type Conversation,
  type Label
} from "./db";

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

// Devuelve la conversación SOLO si pertenece a la cuenta autenticada. null si no
// existe, no es suya, o no hay sesión. Evita que una cuenta acceda a datos de
// otra adivinando el ID.
export function requireOwnedConversation(req: NextRequest, convId: number): Conversation | null {
  const phone = ownerPhoneFromRequest(req);
  if (!phone) return null;
  const conv = getConversationById(convId);
  if (!conv || conv.owner_phone !== phone) return null;
  return conv;
}

// Devuelve la etiqueta SOLO si pertenece a la cuenta autenticada.
export function requireOwnedLabel(req: NextRequest, labelId: number): Label | null {
  const phone = ownerPhoneFromRequest(req);
  if (!phone) return null;
  const label = getLabelById(labelId);
  if (!label || label.owner_phone !== phone) return null;
  return label;
}
