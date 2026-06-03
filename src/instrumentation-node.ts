// Código exclusivo del runtime Node.js — separado de instrumentation.ts para
// que NO se compile en el bundle edge (el middleware fuerza compilación edge, y
// allí los módulos node: no están permitidos). Este archivo solo se importa
// dinámicamente cuando NEXT_RUNTIME === "nodejs" (ver instrumentation.ts).

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export async function startBot(): Promise<void> {
  const cwd     = process.cwd();
  const pidFile = path.join(cwd, "data", "bot.pid");

  // Esperar un poco para que start:all pueda escribir el PID antes de que
  // Next.js intente spawnear otro bot (evita duplicado en producción)
  await new Promise((r) => setTimeout(r, 2500));

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
