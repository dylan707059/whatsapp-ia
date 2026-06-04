import { NextRequest, NextResponse } from "next/server";
import {
  listOrdersForOwner,
  getTodayStatsForOwner,
  getOrderWithOwner,
  setOrderStatus
} from "@/lib/orders";
import { accountFromRequest, ownerPhoneFromRequest } from "@/lib/request-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET: lista de pedidos de la cuenta + conteos de hoy.
export async function GET(req: NextRequest) {
  const account = accountFromRequest(req);
  if (!account) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const ownerPhone = account.owner_phone ?? "";
  return NextResponse.json({
    orders: listOrdersForOwner(ownerPhone),
    stats: getTodayStatsForOwner(ownerPhone)
  });
}

// POST {orderId, action}: por ahora action="dispatch" marca como despachado.
export async function POST(req: NextRequest) {
  const ownerPhone = ownerPhoneFromRequest(req);
  if (!ownerPhone) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  let body: { orderId?: number; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 });
  }

  const orderId = Number(body.orderId);
  if (!Number.isInteger(orderId)) {
    return NextResponse.json({ error: "orderId requerido" }, { status: 400 });
  }

  const order = getOrderWithOwner(orderId);
  if (!order || order.conv_owner !== ownerPhone) {
    return NextResponse.json({ error: "Pedido no encontrado" }, { status: 404 });
  }

  const action = body.action ?? "dispatch";
  if (action === "dispatch") {
    setOrderStatus(orderId, "DISPATCHED");
    return NextResponse.json({ ok: true, status: "DISPATCHED" });
  }
  if (action === "cancel") {
    setOrderStatus(orderId, "CANCELLED");
    return NextResponse.json({ ok: true, status: "CANCELLED" });
  }

  return NextResponse.json({ error: "Acción inválida" }, { status: 400 });
}
