export async function register() {
  // Solo en runtime Node.js (no edge, no durante next build)
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { spawn } = await import("node:child_process");
  const path      = await import("node:path");
  const fs        = await import("node:fs");

  const cwd     = process.cwd();
  const pidFile = path.join(cwd, "data", "bot.pid");

  // Si el bot ya está corriendo (escribió su propio PID), no spawnear otro
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (!isNaN(pid)) {
        process.kill(pid, 0); // lanza ESRCH si el proceso ya murió
        console.log(`[next] Bot ya corriendo (PID ${pid})`);
        return;
      }
    }
  } catch {}

  fs.mkdirSync(path.join(cwd, "data"), { recursive: true });

  const isWin    = process.platform === "win32";
  const tsxBin   = path.join(cwd, "node_modules", ".bin", isWin ? "tsx.cmd" : "tsx");
  const botEntry = path.join(cwd, "scripts", "start-bot.ts");

  const child = spawn(tsxBin, [botEntry], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  console.log(`[next] Bot iniciado automáticamente (PID ${child.pid ?? "?"})`);
}
