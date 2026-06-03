# Contexto completo — Agente WhatsApp con Dashboard

## ¿Qué es?
Bot de WhatsApp con IA para ventas online, con dashboard web para gestionar conversaciones. Desplegado en **Render** (producción), repositorio en **GitHub** (`dylan707059/whatsapp-ia`).

---

## Stack técnico
- **Frontend/Backend:** Next.js 15 (App Router), React 19, Tailwind CSS 4
- **Bot WhatsApp:** `@whiskeysockets/baileys` v6.7+ (multi-device)
- **Base de datos:** SQLite vía `better-sqlite3` v12.10.0 (Node 24, ABI v137)
- **IA:** OpenAI SDK (`gpt-4o` para visión de imágenes, otro modelo para chat con clientes)
- **Runtime:** Node.js 22, `tsx` para TypeScript directo
- **Deploy:** Render con `nixpacks.toml`, Node 22, 512MB RAM límite

---

## Arquitectura
```
Render
├── npm run start:all (concurrently, sin --kill-others)
│   ├── BOT: tsx scripts/start-bot.ts
│   └── WEB: next start
│
├── Bot ←→ SQLite (data/messages.db) ←→ Next.js API
│
└── Local: npm start → instrumentation.ts auto-spawnea el bot
           (skip si RENDER=true, start:all ya lo hace)
```

**Comunicación bot ↔ dashboard:** solo vía SQLite.
- `connection_state`: QR, status, phone conectado
- `outbox`: mensajes escritos en dashboard → bot los envía cada 2s
- `data/.restart`: flag para reiniciar bot y generar QR nuevo
- `data/bot.pid`: PID del bot para evitar duplicados al arrancar

---

## Estructura de carpetas
```
src/
├── app/
│   ├── page.tsx                  → renderiza ConnectionGate
│   ├── global-error.tsx          → auto-reload en ChunkLoadError post-deploy
│   └── api/
│       ├── connection/status     → devuelve QR en PNG + estado actual
│       ├── connection/disconnect → desconecta y limpia sesión
│       ├── conversations         → lista conversaciones del número conectado
│       ├── conversations/[id]    → detalle de conversación
│       ├── messages/[id]         → historial de mensajes
│       ├── mode/[id]             → cambiar modo AI/HUMAN
│       └── orders/[id]           → pedidos de la conversación
├── components/
│   ├── ConnectionGate.tsx        → muestra QR o dashboard según estado
│   ├── QRScreen.tsx              → polling cada 2s, muestra QR o spinner
│   ├── DashboardHeader.tsx
│   ├── ConversationList.tsx
│   └── ConversationPanel.tsx
└── lib/
    ├── db.ts                     → instancia SQLite + todas las queries
    ├── types.ts                  → interfaces TypeScript compartidas
    ├── paths.ts                  → DATA_DIR, AUTH_DIR, DB_PATH, etc.
    ├── baileys/
    │   ├── client.ts             → makeWASocket, reconexión, QR, PID guard
    │   ├── handler.ts            → procesa mensajes entrantes por ownerPhone
    │   ├── send.ts               → botSend (enviar mensajes)
    │   └── contact-store.ts      → mapa LID → teléfono
    ├── photo-openai.ts           → gpt-4o visión para leer imágenes de pedidos
    ├── photo-confirm-flow.ts     → lógica completa /fotoconfirmar
    ├── photo-sessions.ts         → CRUD sesiones de fotoconfirmar en SQLite
    ├── openai.ts                 → generateReply (chat IA con clientes)
    ├── orders.ts                 → CRUD pedidos, hash anti-duplicado
    ├── order-confirmation.ts     → detecta "CONFIRMADO", extrae datos
    ├── owner-notifier.ts         → notifica al dueño por WhatsApp
    ├── commands.ts               → router de comandos del owner
    ├── queue.ts                  → cola de tareas serializada
    ├── customer-lock.ts          → mutex por cliente (evita race conditions)
    ├── complaint.ts              → detección de reclamos
    ├── confirmation-text.ts      → genera texto de confirmación para cliente
    ├── bot-messages.ts           → registro de IDs de mensajes del bot
    ├── phone-utils.ts            → normalizePhone, phoneToJid, etc.
    └── order-events.ts           → log de eventos por pedido
scripts/
├── start-bot.ts                  → arranque, outbox poller, restart watcher, PID file
└── env-loader.ts                 → carga .env.local manualmente
```

---

## Base de datos (SQLite — `data/messages.db`)

### Tablas principales

**`conversations`**
- `id`, `phone` (JID del cliente), `owner_phone` (número del bot conectado)
- `name`, `mode` (AI | HUMAN), `last_message_at`, `created_at`
- `confirmed_at`, `owner_notified_at`, `ai_paused_until`, `blocked_at`
- UNIQUE en `(phone, owner_phone)` — aislamiento multi-sesión

**`messages`**
- `id`, `conversation_id`, `role` (user | assistant | human), `content`, `created_at`

**`connection_state`** (1 sola fila)
- `status` (disconnected | qr | connecting | connected)
- `qr_string`, `phone`, `updated_at`

**`outbox`**
- `id`, `conversation_id`, `phone`, `content`, `sent`, `created_at`

**`orders`**
- `id`, `conversation_id`, todos los campos del pedido
- `status` (DRAFT | PENDING_CONFIRMATION | CONFIRMED | OWNER_NOTIFIED | DISPATCHED | CANCELLED)
- `order_hash` para detección de duplicados

**`photo_confirm_sessions`**
- `id`, `owner_phone`, `target_phone`, `status`, `image_paths` (JSON array)
- `extracted_order_json`, `detected_phones_json`, `duplicate_order_id`
- `created_at`, `expires_at`

**`order_events`** — log de cada acción sobre un pedido
**`contact_lids`** — mapa LID → teléfono real
**`audit_log`** — log general de eventos

**Migraciones:** automáticas en `db.ts` via `ALTER TABLE IF NOT EXISTS column`.

---

## Multi-sesión (aislamiento de datos por número)

Cada número de WhatsApp conectado ve **solo sus propias conversaciones**:
- `conversations.owner_phone` = número del bot actualmente conectado
- `listConversations(ownerPhone)` filtra por ese campo
- `getOrCreateConversation(phone, name, ownerPhone)` incluye el dueño
- `getConversationByPhone(phone, ownerPhone)` también filtra
- La API `/api/conversations` lee `connection_state.phone` y filtra
- `handler.ts` extrae `ownerPhone` de `sock.user?.id.split(":")[0]`

---

## Flujo de /fotoconfirmar (lectura de imágenes con IA)

1. Owner escribe `/fotoconfirmar` (opcionalmente `/fotoconfirmar 3147823790`)
2. Envía hasta 4 fotos → se guardan en `data/tmp/fotoconfirmar/[sessionId]/`
3. Owner escribe `/listo` → se encola el procesamiento
4. `photo-openai.ts` llama a `gpt-4o` con las imágenes en base64 (`detail: "high"`)
5. Modelo devuelve JSON con todos los campos del pedido
6. **Si confianza "high"** → envía confirmación directo al cliente
7. **Si "medium"/"low"** → manda vista previa al owner para revisar
8. Owner puede `/editar campo valor` para corregir campos
9. Owner escribe `/enviarconfirmacion` para enviar al cliente
10. Sistema detecta duplicados por hash (`phone + product + color + size + ...`)
11. Si hay duplicado → pide `/reemplazar` o `/cancelar`

---

## Flujo de confirmación de pedido (chat)

1. IA responde al cliente con resumen de pedido (emoji 🛍️ → trigger de upsert)
2. Cliente responde "CONFIRMADO" → `isConfirmationMessage()` lo detecta
3. Se encola `handleConfirmation()` con lock por cliente
4. Se validan campos obligatorios, se notifica al owner por WhatsApp
5. Anti-duplicado: revisa `owner_notified_at` antes de notificar

---

## Comandos del owner (por WhatsApp)

| Comando | Función |
|---|---|
| `/fotoconfirmar [tel]` | Iniciar sesión de lectura de foto |
| `/listo` | Procesar fotos enviadas |
| `/editar campo valor` | Corregir campo del pedido en revisión |
| `/enviarconfirmacion` | Enviar confirmación al cliente |
| `/cancelar` | Cancelar sesión activa |
| `/reemplazar` | Reemplazar pedido duplicado detectado |
| `/estadofoto` | Ver estado de sesión activa |
| `/usartelefono N` | Elegir teléfono cuando hay varios detectados |
| `/reenviarconfirmacion TEL` | Reenviar confirmación a cliente |

**Campos editables con /editar:** nombre, apellido, telefono, producto, color, talla, cantidad, total, pago, envio, direccion, ciudad, departamento

---

## Variables de entorno requeridas

```env
OPENAI_API_KEY=...              # Clave OpenAI
OPENAI_MODEL=...                # Opcional, default gpt-4o (para fotos)
OWNER_NOTIFY_PHONES=...         # Números del dueño separados por coma (ej: 573204665094,573223272342)
DATA_DIR=...                    # Opcional, default ./data
AUTH_DIR=...                    # Opcional, default ./auth
```

---

## Configuración de deploy (Render)

**`nixpacks.toml`:**
```toml
providers = ["node"]

[variables]
NIXPACKS_NODE_VERSION = "22"
NODE_OPTIONS = "--max-old-space-size=400"   # Limita heap a 400MB (límite Render = 512MB)

[phases.setup]
nixPkgs = ["nodejs_22", "npm-10_x", "python3", "gcc", "gnumake"]

[phases.install]
cmds = ["npm ci --include=dev"]

[phases.build]
cmds = ["npm run build"]

[start]
cmd = "npm run start:all"
```

**`Procfile`:** `web: npm run start:all`

**`package.json` scripts relevantes:**
```json
"start:bot": "tsx scripts/start-bot.ts",
"start:all": "concurrently --names BOT,WEB --prefix-colors yellow,cyan \"npm run start:bot\" \"npm run start\""
```
*(sin `--kill-others` para que un crash del bot no tire el servidor web)*

---

## Problemas resueltos

| Problema | Causa | Fix |
|---|---|---|
| Bot 401 no reconectaba | `return` sin reconectar en loggedOut | Limpia `auth/` y llama `scheduleReconnect()` |
| Bad Gateway en Render | `--kill-others` mataba Next.js si bot caía | Eliminado `--kill-others` de `start:all` |
| OOM (uso >512MB) | Dos procesos Baileys corriendo en paralelo | `instrumentation.ts` skip si `RENDER=true` + `NODE_OPTIONS=--max-old-space-size=400` |
| ChunkLoadError tras redeploy | Browser cacheaba HTML con chunk hashes viejos | `global-error.tsx` auto-reload + `Cache-Control: no-cache` en HTML |
| Bot crash por error interno Baileys | `unhandledRejection` no capturado | Handler global que reconecta en 5s |
| Dos bots al arrancar localmente | Race condition en `instrumentation.ts` | Flag `starting` en `client.ts` + PID file en `data/bot.pid` |
| QR cambiaba muy rápido | `connectTimeoutMs` demasiado bajo | `connectTimeoutMs: 60_000` + delay 10s en reconexión sin código |
| Imágenes no leían producto/color/talla | Modelo `gpt-4o-mini` con visión limitada | Cambiado a `gpt-4o` + prompt más detallado |
| Datos mezclados entre números | Sin aislamiento por sesión | Columna `owner_phone` en `conversations` + filtros en todas las queries |

---

## next.config.ts

```ts
serverExternalPackages: ["@whiskeysockets/baileys", "better-sqlite3", "pino"],
headers: Cache-Control no-cache en rutas HTML (no en _next/static)
```

---

## Comportamiento del bot ante desconexiones

- **Código 401 / loggedOut:** limpia `auth/`, llama `scheduleReconnect()` → genera QR nuevo
- **Código 440:** reconecta después de 15s
- **Código undefined:** reconecta después de 10s
- **Otros códigos:** reconecta después de 5s
- **Errores internos de Baileys (unhandledRejection):** reconecta en 5s
- **Flag `data/.restart`:** bot detecta cada 1s, limpia auth y reconecta
