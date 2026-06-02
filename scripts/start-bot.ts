import "./env-loader";

import fs from "node:fs";
import path from "node:path";
import { start, getHandle } from "../src/lib/baileys/client";
import { getPendingOutbox, markOutboxSent, getConnectionState } from "../src/lib/db";
import { AUTH_DIR, DATA_DIR, RESTART_FLAG } from "../src/lib/paths";

// Escribir PID para que Next.js (instrumentation.ts) detecte que ya estamos corriendo
fs.writeFileSync(path.join(DATA_DIR, "bot.pid"), String(process.pid));
process.on("exit", () => {
  try { fs.unlinkSync(path.join(DATA_DIR, "bot.pid")); } catch {}
});

// ─── Outbox poller ────────────────────────────────────────────────────────────

setInterval(async () => {
  const handle = getHandle();
  if (!handle) return;
  if (getConnectionState().status !== "connected") return;

  for (const item of getPendingOutbox(20)) {
    try {
      await handle.sock.sendMessage(item.phone, { text: item.content });
      markOutboxSent(item.id);
      console.log(`[bot] → Outbox enviado a ${item.phone}`);
    } catch (err) {
      console.error(`[bot] Error enviando outbox #${item.id}:`, err);
    }
  }
}, 2000);

// ─── Restart flag watcher ─────────────────────────────────────────────────────

setInterval(async () => {
  if (!fs.existsSync(RESTART_FLAG)) return;

  console.log("[bot] Flag de reinicio detectado. Reiniciando...");

  try { fs.unlinkSync(RESTART_FLAG); } catch {}

  const handle = getHandle();
  if (handle) {
    try { await handle.shutdown(); } catch {}
  }

  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}

  await start();
}, 1000);

// ─── Capturar errores internos de Baileys (e.g. "Connection Closed" en retry) ─

process.on("unhandledRejection", (reason) => {
  console.error("[bot] Error no manejado, reconectando en 5s...", reason);
  setTimeout(() => start().catch(console.error), 5000);
});

process.on("uncaughtException", (err) => {
  console.error("[bot] Excepción no capturada, reconectando en 5s...", err);
  setTimeout(() => start().catch(console.error), 5000);
});

// ─── Arranque principal ───────────────────────────────────────────────────────

console.log("[bot] Iniciando agente WhatsApp...");
start().catch((err) => {
  console.error("[bot] Error fatal al iniciar:", err);
  setTimeout(() => start().catch(console.error), 5000);
});
