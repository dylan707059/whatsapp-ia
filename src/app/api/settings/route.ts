import { NextRequest, NextResponse } from "next/server";
import {
  getAccountBySessionToken,
  getAccountSettings,
  upsertAccountSettings
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function accountFromRequest(req: NextRequest) {
  const token = req.cookies.get("session")?.value;
  return token ? getAccountBySessionToken(token) : undefined;
}

// GET: devuelve la config guardada de la cuenta. Si aún no hay (cuenta nueva),
// precarga con los valores de las variables de entorno actuales como defaults,
// para que la pantalla muestre lo que hoy está activo. `configured` indica si
// el usuario ya guardó al menos una vez.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const account = accountFromRequest(req);
  if (!account) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const saved = getAccountSettings(account.id);

  // Multi-tenant: cada cuenta ve SOLO su propia configuración (vacío si no ha
  // guardado nada). No exponemos las variables de entorno globales aquí, para
  // que la config de una cuenta no aparezca en el formulario de otra.
  const settings = {
    shopifyDomain:            saved?.shopify_domain            ?? "",
    shopifyWebhookSecret:     saved?.shopify_webhook_secret    ?? "",
    confirmationDelaySeconds: saved?.confirmation_delay_seconds ?? 180,
    blockedDepartments:       saved?.blocked_departments       ?? "",
    blockedCities:            saved?.blocked_cities            ?? "",
    blockedDepartmentCodes:   saved?.blocked_department_codes  ?? "",
    ownerNotifyPhones:        saved?.owner_notify_phones       ?? "",
    confirmGroupJid:          saved?.confirm_group_jid         ?? "",
    manualGroupJid:           saved?.manual_group_jid          ?? ""
  };

  return NextResponse.json({ configured: Boolean(saved?.configured), settings });
}

// POST: guarda la config de la cuenta.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const account = accountFromRequest(req);
  if (!account) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 });
  }

  const str = (v: unknown): string => String(v ?? "").trim();

  const delayMinutesRaw = Number(body.confirmationDelayMinutes);
  const delaySeconds = Number.isFinite(delayMinutesRaw) && delayMinutesRaw >= 0
    ? Math.round(delayMinutesRaw * 60)
    : 180;

  upsertAccountSettings(account.id, {
    shopifyDomain:           str(body.shopifyDomain) || null,
    shopifyWebhookSecret:    str(body.shopifyWebhookSecret) || null,
    confirmationDelaySeconds: delaySeconds,
    blockedDepartments:      str(body.blockedDepartments) || null,
    blockedCities:           str(body.blockedCities) || null,
    blockedDepartmentCodes:  str(body.blockedDepartmentCodes) || null,
    ownerNotifyPhones:       str(body.ownerNotifyPhones) || null,
    confirmGroupJid:         str(body.confirmGroupJid) || null,
    manualGroupJid:          str(body.manualGroupJid) || null
  });

  return NextResponse.json({ ok: true });
}
