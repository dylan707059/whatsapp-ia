"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { chatDisplayTitle } from "@/lib/types";

interface NoticeItem {
  id: number;
  conversation_id: number;
  name: string | null;
  phone: string;
  content: string;
  media_type: string | null;
  muted: number;
}

function previewOf(it: NoticeItem): string {
  if (it.media_type === "image") return it.content?.trim() ? `📷 ${it.content}` : "📷 Foto";
  if (it.media_type === "video") return it.content?.trim() ? `🎥 ${it.content}` : "🎥 Video";
  if (it.media_type === "document") return "📄 Documento";
  return it.content || "Nuevo mensaje";
}

interface Result {
  perm: NotificationPermission;
  requestPerm: () => void;
  onReady: (data: unknown) => void;
  onMsg: (data: unknown) => void;
}

/**
 * Notificaciones de escritorio + sonido para mensajes entrantes.
 * Se engancha al stream SSE existente (se le pasan los handlers onReady/onMsg
 * para no abrir otra conexión). No notifica chats silenciados ni el chat abierto.
 */
export function useDesktopNotifications(selectedId: number | null): Result {
  const lastSeenRef = useRef<number | null>(null);
  const selectedRef = useRef<number | null>(selectedId);
  selectedRef.current = selectedId;
  const audioRef = useRef<AudioContext | null>(null);
  const [perm, setPerm] = useState<NotificationPermission>("default");

  useEffect(() => {
    if (typeof Notification !== "undefined") setPerm(Notification.permission);
  }, []);

  // Crear/reanudar el audio en el primer gesto (los navegadores lo bloquean
  // hasta que hay interacción del usuario).
  useEffect(() => {
    function ensureAudio() {
      try {
        if (!audioRef.current) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const Ctx = window.AudioContext || (window as any).webkitAudioContext;
          if (Ctx) audioRef.current = new Ctx();
        }
        audioRef.current?.resume?.();
      } catch {}
    }
    window.addEventListener("click", ensureAudio);
    return () => window.removeEventListener("click", ensureAudio);
  }, []);

  function beep() {
    const ctx = audioRef.current;
    if (!ctx) return;
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 660;
      o.connect(g);
      g.connect(ctx.destination);
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.0008, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.3);
      o.start(t);
      o.stop(t + 0.32);
    } catch {}
  }

  const onReady = useCallback((data: unknown) => {
    const snap = (data as { snapshot?: { msgMaxId?: number } })?.snapshot;
    if (snap && typeof snap.msgMaxId === "number") lastSeenRef.current = snap.msgMaxId;
  }, []);

  const onMsg = useCallback((data: unknown) => {
    const maxId = (data as { maxId?: number })?.maxId ?? 0;
    if (lastSeenRef.current == null) { lastSeenRef.current = maxId; return; }
    const since = lastSeenRef.current;
    if (maxId <= since) return;
    lastSeenRef.current = maxId;

    (async () => {
      try {
        const res = await fetch(`/api/notifications?since=${since}`);
        if (!res.ok) return;
        const { items } = await res.json() as { items: NoticeItem[] };
        const visible =
          typeof document !== "undefined" &&
          document.visibilityState === "visible" &&
          document.hasFocus();

        for (const it of items) {
          if (it.muted) continue; // chat silenciado: sin popup ni sonido
          if (visible && it.conversation_id === selectedRef.current) continue;

          beep();
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            try {
              const n = new Notification(chatDisplayTitle(it.phone, it.name), {
                body: previewOf(it),
                tag: `conv-${it.conversation_id}`,
                icon: "/favicon.ico"
              });
              n.onclick = () => { try { window.focus(); } catch {} n.close(); };
            } catch {}
          }
        }
      } catch {}
    })();
  }, []);

  const requestPerm = useCallback(() => {
    if (typeof Notification === "undefined") return;
    Notification.requestPermission().then(setPerm).catch(() => {});
    try {
      if (!audioRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        if (Ctx) audioRef.current = new Ctx();
      }
      audioRef.current?.resume?.();
    } catch {}
  }, []);

  return { perm, requestPerm, onReady, onMsg };
}
