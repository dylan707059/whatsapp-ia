// Autenticación: hashing de contraseñas y generación de tokens de sesión.
// Solo usa node:crypto — NO importa db.ts (para evitar imports circulares).
// La lógica de sesiones contra la base de datos vive en db.ts.

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

// ─── Contraseñas ──────────────────────────────────────────────────────────────
// Formato almacenado: "salt:hash" (ambos en hex). scrypt es lento a propósito,
// lo que protege contra ataques de fuerza bruta si la DB se filtra.

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = (stored ?? "").split(":");
  if (!salt || !hash) return false;

  const hashBuf = Buffer.from(hash, "hex");
  const testBuf = scryptSync(password, salt, 64);

  if (hashBuf.length !== testBuf.length) return false;
  return timingSafeEqual(hashBuf, testBuf);
}

// ─── Tokens de sesión ─────────────────────────────────────────────────────────
// Token aleatorio de 256 bits — imposible de adivinar. Se guarda en la tabla
// `sessions` y se entrega al navegador como cookie httpOnly.

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}
