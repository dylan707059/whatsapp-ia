import "./env-loader";

import fs from "node:fs";
import { start, getHandle } from "../src/lib/baileys/client";
import { getPendingOutbox, markOutboxSent, getConnectionState } from "../src/lib/db";
import { AUTH_DIR, RESTART_FLAG } from "../src/lib/paths";

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

// ─── Arranque principal ───────────────────────────────────────────────────────

console.log("[bot] Iniciando agente WhatsApp...");
start().catch((err) => {
  console.error("[bot] Error fatal al iniciar:", err);
  process.exit(1);
});
