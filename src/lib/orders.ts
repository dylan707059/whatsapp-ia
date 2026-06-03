import crypto from "node:crypto";
import { db } from "./db";
import type { Order, OrderData, OrderStatus } from "./types";
import { normalizePhone } from "./phone-utils";

// ─── Hash de contenido de pedido ──────────────────────────────────────────────

function norm(s: string): string {
  return (s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

function normTotal(s: string): string {
  return (s ?? "").replace(/[^\d]/g, "");
}

export function computeOrderHash(data: {
  phone: string;
  product: string;
  color: string;
  size: string;
  quantity: string;
  total: string;
  address: string;
  city: string;
  department: string;
}): string {
  const raw = [
    normalizePhone(data.phone),
    norm(data.product),
    norm(data.color),
    norm(data.size),
    norm(data.quantity),
    normTotal(data.total),
    norm(data.address),
    norm(data.city),
    norm(data.department)
  ].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

// ─── Consultas ────────────────────────────────────────────────────────────────

const stmtGetActive = db.prepare<[number], Order>(`
  SELECT * FROM orders
  WHERE conversation_id = ? AND status NOT IN ('CANCELLED')
  ORDER BY created_at DESC
  LIMIT 1
`);

const stmtInsert = db.prepare(`
  INSERT INTO orders (
    conversation_id, full_name, first_name, last_name, phone,
    product, color, size, quantity, total, payment, shipping,
    address, city, department, status, source, order_hash
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`);

const stmtUpdate = db.prepare(`
  UPDATE orders SET
    full_name = ?, first_name = ?, last_name = ?, phone = ?,
    product = ?, color = ?, size = ?, quantity = ?, total = ?,
    payment = ?, shipping = ?, address = ?, city = ?, department = ?,
    status = ?, order_hash = ?,
    confirmed_at = NULL, owner_notified_at = NULL,
    updated_at = unixepoch()
  WHERE id = ?
`);

const stmtSetStatus = db.prepare<[string, number]>(
  "UPDATE orders SET status = ?, updated_at = unixepoch() WHERE id = ?"
);

const stmtSetOrderConfirmed = db.prepare<[number]>(
  "UPDATE orders SET confirmed_at = unixepoch(), status = 'CONFIRMED', updated_at = unixepoch() WHERE id = ?"
);

const stmtSetOrderNotified = db.prepare<[number]>(
  "UPDATE orders SET owner_notified_at = unixepoch(), status = 'OWNER_NOTIFIED', updated_at = unixepoch() WHERE id = ?"
);

const stmtGetByPhone = db.prepare<[string, string], Order & { conv_name: string | null }>(`
  SELECT o.*, c.name as conv_name FROM orders o
  JOIN conversations c ON o.conversation_id = c.id
  WHERE o.phone = ? OR c.phone LIKE ?
  ORDER BY o.created_at DESC
  LIMIT 1
`);

const stmtTodayStats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN status = 'PENDING_CONFIRMATION' THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN status = 'CONFIRMED' THEN 1 ELSE 0 END) as confirmed,
    SUM(CASE WHEN status = 'OWNER_NOTIFIED' THEN 1 ELSE 0 END) as notified,
    SUM(CASE WHEN status = 'DISPATCHED' THEN 1 ELSE 0 END) as dispatched
  FROM orders
  WHERE date(created_at, 'unixepoch', 'localtime') = date('now', 'localtime')
    AND status NOT IN ('CANCELLED', 'DRAFT')
`);

const stmtPendingByPhone = db.prepare<[string], Order>(`
  SELECT * FROM orders
  WHERE phone = ? AND status = 'PENDING_CONFIRMATION'
  ORDER BY created_at DESC
  LIMIT 1
`);

const stmtFindByHash = db.prepare<[string], Order>(`
  SELECT * FROM orders
  WHERE order_hash = ? AND status NOT IN ('CANCELLED')
  ORDER BY created_at DESC
  LIMIT 1
`);

// ─── Funciones exportadas ─────────────────────────────────────────────────────

export function getActiveOrder(conversationId: number): Order | undefined {
  return stmtGetActive.get(conversationId);
}

export function upsertOrder(
  conversationId: number,
  data: OrderData,
  status: OrderStatus = "PENDING_CONFIRMATION",
  source?: string
): number {
  const hash = computeOrderHash(data);
  const existing = getActiveOrder(conversationId);

  if (existing && existing.status !== "DISPATCHED" && existing.status !== "CANCELLED") {
    stmtUpdate.run(
      data.fullName, data.firstName, data.lastName, data.phone,
      data.product, data.color, data.size, data.quantity, data.total,
      data.payment, data.shipping, data.address, data.city, data.department,
      status, hash,
      existing.id
    );
    return existing.id;
  }

  const info = stmtInsert.run(
    conversationId, data.fullName, data.firstName, data.lastName, data.phone,
    data.product, data.color, data.size, data.quantity, data.total,
    data.payment, data.shipping, data.address, data.city, data.department,
    status, source ?? "CHAT", hash
  );
  return info.lastInsertRowid as number;
}

export function setOrderStatus(orderId: number, status: OrderStatus): void {
  stmtSetStatus.run(status, orderId);
}

export function setOrderConfirmedAt(orderId: number): void {
  stmtSetOrderConfirmed.run(orderId);
}

export function setOrderOwnerNotifiedAt(orderId: number): void {
  stmtSetOrderNotified.run(orderId);
}

export function getOrderByPhone(
  phone: string
): (Order & { conv_name: string | null }) | undefined {
  return stmtGetByPhone.get(phone, `%${phone}%`);
}

export function hasPendingOrder(normalizedPhone: string): Order | undefined {
  return stmtPendingByPhone.get(normalizedPhone);
}

export function findOrderByHash(hash: string): Order | undefined {
  return stmtFindByHash.get(hash);
}

export interface TodayStats {
  total: number;
  pending: number;
  confirmed: number;
  notified: number;
  dispatched: number;
}

export function getTodayStats(): TodayStats {
  return stmtTodayStats.get() as TodayStats;
}

// ─── Recordatorios SHOPIFY ────────────────────────────────────────────────────
// Devuelve pedidos SHOPIFY pendientes de confirmar cuya última actividad
// (created_at si nunca recordamos, last_reminder_at si ya recordamos) fue
// hace más de N segundos. Limit max reminders defaults a 2.

const stmtOrdersNeedingReminder = db.prepare<
  [number, number],
  Order & { conv_name: string | null; conv_phone: string }
>(`
  SELECT o.*, c.name as conv_name, c.phone as conv_phone
  FROM orders o
  JOIN conversations c ON o.conversation_id = c.id
  WHERE o.source = 'SHOPIFY'
    AND o.status = 'PENDING_CONFIRMATION'
    AND o.reminder_count < ?
    AND COALESCE(o.last_reminder_at, o.created_at) <= ?
  ORDER BY o.created_at ASC
  LIMIT 50
`);

const stmtOrdersToCancel = db.prepare<
  [number, number],
  Order & { conv_name: string | null; conv_phone: string }
>(`
  SELECT o.*, c.name as conv_name, c.phone as conv_phone
  FROM orders o
  JOIN conversations c ON o.conversation_id = c.id
  WHERE o.source = 'SHOPIFY'
    AND o.status = 'PENDING_CONFIRMATION'
    AND o.reminder_count >= ?
    AND COALESCE(o.last_reminder_at, o.created_at) <= ?
  LIMIT 50
`);

const stmtIncrementReminder = db.prepare<[number]>(
  "UPDATE orders SET reminder_count = reminder_count + 1, last_reminder_at = unixepoch(), updated_at = unixepoch() WHERE id = ?"
);

/**
 * Pedidos SHOPIFY que necesitan un recordatorio ahora.
 * @param maxReminders cantidad máxima de recordatorios por pedido (default 2)
 * @param intervalSec  segundos mínimos entre recordatorios (default 7200 = 2h)
 */
export function getOrdersNeedingReminder(
  maxReminders = 2,
  intervalSec = 7200
): Array<Order & { conv_name: string | null; conv_phone: string }> {
  const threshold = Math.floor(Date.now() / 1000) - intervalSec;
  return stmtOrdersNeedingReminder.all(maxReminders, threshold);
}

/**
 * Pedidos SHOPIFY que ya recibieron el máximo de recordatorios y pasó
 * el intervalo final sin confirmación — listos para cancelar.
 */
export function getOrdersToAutoCancel(
  maxReminders = 2,
  intervalSec = 7200
): Array<Order & { conv_name: string | null; conv_phone: string }> {
  const threshold = Math.floor(Date.now() / 1000) - intervalSec;
  return stmtOrdersToCancel.all(maxReminders, threshold);
}

export function incrementReminderCount(orderId: number): void {
  stmtIncrementReminder.run(orderId);
}
