import path from "node:path";
import fs from "node:fs";

export const DATA_DIR: string = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), "data");

export const AUTH_DIR: string = process.env.AUTH_DIR
  ? path.resolve(process.env.AUTH_DIR)
  : path.resolve(process.cwd(), "auth");

export const DB_PATH       = path.join(DATA_DIR, "messages.db");
export const RESTART_FLAG  = path.join(DATA_DIR, ".restart");

// Crear directorios necesarios al importar este módulo
for (const dir of [DATA_DIR, AUTH_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
