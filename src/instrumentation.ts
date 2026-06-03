export async function register() {
  // Solo en runtime Node.js (no edge, no durante next build).
  // El código que usa módulos node: vive en instrumentation-node.ts y se
  // importa dinámicamente aquí — así el bundle edge (que el middleware fuerza)
  // nunca intenta cargar node:child_process / node:fs / node:path.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // En Render, start:all ya lanza el bot — no spawnear un segundo proceso
  if (process.env.RENDER) return;

  const { startBot } = await import("./instrumentation-node");
  await startBot();
}
