"use client";

import { useEffect, useRef } from "react";

type Handlers = Record<string, (data: unknown) => void>;

/**
 * Hook que mantiene una conexión SSE con reconexión automática.
 *
 * Uso:
 *   useEventStream("/api/events", {
 *     conv: (data) => fetchConversations(),
 *     msg:  (data) => fetchMessages(),
 *     conn: (data) => checkStatus()
 *   });
 *
 * Los handlers son referencias estables a callbacks. Para evitar reconexiones
 * cuando cambia el componente padre, pasalos memoizados (useCallback).
 */
export function useEventStream(url: string, handlers: Handlers, enabled = true): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000;
    let closed = false;

    function connect() {
      if (closed) return;
      try {
        source = new EventSource(url);
      } catch (err) {
        console.warn("[sse] Error abriendo EventSource:", err);
        scheduleReconnect();
        return;
      }

      // Resetear backoff al abrir
      source.onopen = () => {
        backoff = 1000;
      };

      // Registrar handlers tipados por nombre de evento
      const knownEvents = new Set<string>(["ready", "conv", "msg", "conn", "heartbeat", "bye"]);
      knownEvents.forEach((evt) => {
        source!.addEventListener(evt, (e: MessageEvent) => {
          const cb = handlersRef.current[evt];
          if (!cb) return;
          try {
            const data = e.data ? JSON.parse(e.data) : null;
            cb(data);
          } catch (err) {
            console.warn(`[sse] Error parseando evento ${evt}:`, err);
          }
        });
      });

      source.onerror = () => {
        // EventSource intenta reconectar solo, pero si la conexión se cierra
        // (server dropped la conexión a los 9 min), nosotros la reabrimos
        try { source?.close(); } catch {}
        source = null;
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (closed) return;
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        backoff = Math.min(backoff * 1.5, 15000);
        connect();
      }, backoff);
    }

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { source?.close(); } catch {}
    };
  }, [url, enabled]);
}
