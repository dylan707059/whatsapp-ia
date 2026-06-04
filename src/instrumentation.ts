export async function register() {
  // Solo en runtime Node.js (no edge, no durante next build).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // El bot corre DENTRO del proceso de Next (un solo proceso = menos memoria).
  // bot-runtime usa módulos node: y baileys/better-sqlite3 (externalizados);
  // se importa dinámicamente para no incluirlo en bundles que no son node.
  try {
    const { startBotRuntime } = await import("./lib/bot-runtime");
    startBotRuntime();
  } catch (err) {
    // Un fallo del bot no debe tumbar el servidor web.
    console.error("[next] Error iniciando el bot in-process:", err);
  }
}
