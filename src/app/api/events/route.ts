import type { NextRequest } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE endpoint que empuja eventos al cliente cuando hay cambios.
 *
 * Estrategia:
 * - Cada POLL_MS leemos timestamps "tope" de tablas relevantes
 * - Si cambian, emitimos un evento {type, data} al cliente
 * - Heartbeat cada HEARTBEAT_MS para mantener viva la conexión
 *
 * Tipos de evento emitidos:
 *   - "ready"      al conectar (con snapshot inicial)
 *   - "conv"       cualquier cambio en conversaciones (cliente refetchea lista)
 *   - "msg"        nuevo/cambio en mensajes (con conversationId)
 *   - "conn"       cambio en connection_state
 *   - "heartbeat"  ping de mantenimiento
 */

const POLL_MS      = 800;
const HEARTBEAT_MS = 25_000;
const MAX_DURATION_MS = 9 * 60 * 1000; // 9 min — el cliente reconecta solo

interface Snapshot {
  convMaxTs: number;       // MAX(updated_at de orders + last_message_at de convs)
  convCount: number;       // cantidad total de convs activas
  msgMaxId: number;        // último id de messages (para detectar nuevos)
  connUpdatedAt: number;   // updated_at de connection_state
}

const stmtConvSnap = db.prepare<[], { ts: number | null; cnt: number }>(`
  SELECT
    COALESCE(MAX(last_message_at), 0) AS ts,
    COUNT(*) AS cnt
  FROM conversations
`);
const stmtMsgMax = db.prepare<[], { mx: number | null }>(
  "SELECT COALESCE(MAX(id), 0) AS mx FROM messages"
);
const stmtConvLabelTs = db.prepare<[], { ts: number | null }>(
  "SELECT COALESCE(MAX(created_at), 0) AS ts FROM conversation_labels"
);
const stmtConnMax = db.prepare<[], { ts: number | null }>(
  "SELECT COALESCE(MAX(updated_at), 0) AS ts FROM account_connections"
);

function readSnapshot(): Snapshot {
  const c = stmtConvSnap.get() ?? { ts: 0, cnt: 0 };
  const m = stmtMsgMax.get() ?? { mx: 0 };
  const cl = stmtConvLabelTs.get() ?? { ts: 0 };
  const conn = stmtConnMax.get() ?? { ts: 0 };
  return {
    convMaxTs: Math.max(c.ts ?? 0, cl.ts ?? 0),
    convCount: c.cnt ?? 0,
    msgMaxId: m.mx ?? 0,
    connUpdatedAt: conn.ts ?? 0
  };
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream({
    start(controller) {
      let last = readSnapshot();
      let lastHeartbeat = Date.now();

      // Estado inicial al cliente
      controller.enqueue(encoder.encode(sseEvent("ready", { snapshot: last })));

      const interval = setInterval(() => {
        if (req.signal.aborted) return;

        // Auto-cierre suave a los 9 min; cliente reconecta
        if (Date.now() - startedAt > MAX_DURATION_MS) {
          try { controller.enqueue(encoder.encode(sseEvent("bye", { reason: "max_duration" }))); } catch {}
          cleanup();
          return;
        }

        try {
          const snap = readSnapshot();

          // Cambios en conversaciones (incluye agregar/quitar labels y nuevos chats)
          if (snap.convMaxTs !== last.convMaxTs || snap.convCount !== last.convCount) {
            controller.enqueue(encoder.encode(sseEvent("conv", {
              maxTs: snap.convMaxTs,
              count: snap.convCount
            })));
          }

          // Nuevos mensajes (cualquier conv) — el cliente decide si actualizar
          if (snap.msgMaxId !== last.msgMaxId) {
            controller.enqueue(encoder.encode(sseEvent("msg", {
              maxId: snap.msgMaxId
            })));
          }

          // Cambios en connection_state (QR / connected / disconnected)
          if (snap.connUpdatedAt !== last.connUpdatedAt) {
            controller.enqueue(encoder.encode(sseEvent("conn", {
              updatedAt: snap.connUpdatedAt
            })));
          }

          last = snap;

          // Heartbeat
          if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
            controller.enqueue(encoder.encode(sseEvent("heartbeat", { t: Date.now() })));
            lastHeartbeat = Date.now();
          }
        } catch (err) {
          console.error("[sse] Error en poll:", err);
        }
      }, POLL_MS);

      function cleanup() {
        clearInterval(interval);
        try { controller.close(); } catch {}
      }

      req.signal.addEventListener("abort", cleanup);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"  // disable nginx buffering en proxies
    }
  });
}
