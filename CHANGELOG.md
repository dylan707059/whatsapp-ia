# Changelog — Agente WhatsApp IA

Historial de todo lo implementado en el proyecto, en orden cronológico.

---

## v2.0 — Multi-sesión, estabilidad y nuevas funcionalidades
*Implementado: junio 2026*

### Correcciones críticas de estabilidad

#### Auto-inicio del bot desde Next.js
- `src/instrumentation.ts`: al arrancar `npm start`, Next.js detecta si el bot está corriendo (via `data/bot.pid`) y lo spawnea automáticamente si no está activo
- `scripts/start-bot.ts`: escribe su PID en `data/bot.pid` al iniciar y lo borra al salir
- En Render (`RENDER=true`), `instrumentation.ts` se salta el spawn porque `start:all` ya lo hace — evitaba duplicar el proceso y causar OOM

#### Fix OOM en Render (512MB)
- `nixpacks.toml`: `NODE_OPTIONS=--max-old-space-size=400` para que el GC actúe antes de llegar al límite de 512MB
- `src/lib/baileys/client.ts`: caché de mensajes reducido de 500 a 100 entradas
- Eliminado `--kill-others` de `start:all` — un crash del bot ya no derrumba el servidor web

#### Fix reconexión en WhatsApp 401/loggedOut
- Antes: el bot se quedaba parado sin reconectar
- Ahora: limpia la carpeta `auth/`, llama `scheduleReconnect()` y genera QR nuevo automáticamente

#### Fix crash por errores internos de Baileys
- `scripts/start-bot.ts`: captura `unhandledRejection` y `uncaughtException` (ej: "Connection Closed" en `sendRetryRequest`) y reconecta en 5 segundos en lugar de salir con código 1
- `src/lib/baileys/client.ts`: flag `starting` evita llamadas paralelas a `start()` cuando hay reconexiones solapadas

#### Fix ChunkLoadError tras redeploy
- `src/app/global-error.tsx`: detecta `ChunkLoadError` y recarga automáticamente la página
- `next.config.ts`: `Cache-Control: no-cache` en páginas HTML para que el browser no cachee chunks viejos

#### QR más lento / menos agresivo
- `connectTimeoutMs: 60_000` (antes 20s) — más tiempo para escanear
- `retryRequestDelayMs: 5_000` entre reintentos internos de Baileys
- Delay de 10s al reconectar cuando la desconexión no tiene código específico

---

### Aislamiento de datos por número (multi-sesión)

- `src/lib/types.ts`: campo `owner_phone` en interfaz `Conversation`
- `src/lib/db.ts`: columna `owner_phone TEXT NOT NULL DEFAULT ''` en tabla `conversations` con migración automática; UNIQUE en `(phone, owner_phone)`; todas las queries filtran por `owner_phone`
- `src/lib/baileys/handler.ts`: extrae `ownerPhone` de `sock.user?.id` y lo pasa al crear/buscar conversaciones
- `src/app/api/conversations/route.ts`: filtra por `connection_state.phone`

**Resultado:** cada número de WhatsApp conectado ve y gestiona únicamente sus propias conversaciones. Los datos de distintos números nunca se mezclan.

---

### Fix outbox y recordatorios por número

- `src/lib/db.ts`: `getPendingOutbox(ownerPhone, limit)` hace JOIN con `conversations` y filtra por `owner_phone` — un WhatsApp nuevo no manda mensajes pendientes de otro número
- `src/lib/orders.ts`: `getOrdersNeedingReminder(ownerPhone, ...)` y `getOrdersToAutoCancel(ownerPhone, ...)` filtran por `conversations.owner_phone`
- `scripts/start-bot.ts`: pasa `connection_state.phone` a las tres funciones

**Resultado:** cada confirmación se envía exactamente una vez, por el número correcto. Una vez marcada `sent=1`, nunca vuelve a enviarse sin importar cuántos reinicios o cambios de número ocurran.

---

### Mejora lectura de imágenes (`/fotoconfirmar`)

- `src/lib/photo-openai.ts`: modelo cambiado de `gpt-4o-mini` a `gpt-4o` (visión más precisa)
- Prompt mejorado: instruye explícitamente a leer producto, color, talla, cantidad y total; menciona que las imágenes pueden ser capturas de chat de WhatsApp

---

## v1.0 — Deploy inicial
*Implementado: junio 2026*

### Infraestructura base

- **Stack:** Next.js 15 (App Router), React 19, Tailwind CSS 4, Baileys 6.7+, better-sqlite3 v12, OpenAI SDK, tsx, concurrently
- **Deploy:** Render con nixpacks.toml, Node 22
- **Comunicación bot ↔ dashboard:** exclusivamente vía SQLite (`data/messages.db`)
- **Fix SQLite durante next build:** paths protegidos para no inicializar la DB en fase de compilación

---

### Bot de WhatsApp

#### Conexión y autenticación
- QR generado por Baileys y guardado en `connection_state.qr_string`
- Dashboard muestra QR en tiempo real, polling cada 2s
- Reconexión automática con delays según código de error (5s, 10s, 15s)
- Flag `data/.restart` permite reiniciar bot y generar QR nuevo desde el dashboard

#### Procesamiento de mensajes entrantes
- Filtra solo JIDs individuales (`@s.whatsapp.net` y `@lid`)
- Ignora mensajes propios del bot; pausa IA 30 min si el dueño escribe manualmente
- Resuelve alias LID → teléfono real mediante contact-store
- Ignora imágenes de clientes; procesa imágenes solo del owner (para `/fotoconfirmar`)

#### IA de ventas (system prompt)
- Convierte mensajes de pedido en confirmación formateada lista para enviar al cliente
- Responde `[[NO_RESPONDER]]` si el mensaje no es un pedido
- Soporta múltiples productos en un mismo pedido
- Reglas: no inventa datos, corrige tildes/mayúsculas, normaliza teléfonos, formatea totales

---

### Flujo de confirmación de pedidos

#### Por chat (IA)
1. IA detecta pedido → extrae datos → manda resumen con emoji 🛍️
2. `isConfirmationMessage()` detecta "CONFIRMADO" y variantes
3. Se validan campos obligatorios; si faltan, la IA los solicita
4. Confirmado → notifica al dueño por WhatsApp con todos los datos
5. Anti-duplicado: verifica `owner_notified_at` antes de notificar

#### Por foto (`/fotoconfirmar`)
1. `/fotoconfirmar [teléfono]` — inicia sesión
2. Owner envía hasta 4 fotos → se guardan en `data/tmp/fotoconfirmar/[sessionId]/`
3. `/listo` — encola procesamiento con gpt-4o visión
4. Confianza alta → envía directo; media/baja → vista previa para revisar
5. `/editar campo valor` — corrige cualquier campo
6. `/enviarconfirmacion` — envía al cliente
7. Detección de duplicados por hash SHA256 del pedido

---

### Integración Shopify

- Webhook `POST /api/webhooks/shopify/orders-create` con validación HMAC
- Parsea pedido: cliente, productos, variantes (color/talla), total, dirección
- Detecta variantes de 3 partes para sets (top + pantalón con tallas separadas)
- Convierte conversación a modo HUMAN al recibir pedido Shopify
- Delay de 3 minutos antes de enviar (adelantable si el cliente escribe primero)
- Rechaza zonas no cubiertas: San Andrés, Amazonas, Vaupés, Guainía, Vichada + ciudades remotas
- Rechaza envíos a oficinas de transportadoras y puntos de retiro
- Recordatorios automáticos: hasta 2, cada 2 horas, solo si no hay actividad reciente
- Auto-cancelación después del último recordatorio sin confirmación

---

### Dashboard

#### Conexión
- `ConnectionGate`: muestra QR o dashboard según estado
- `QRScreen`: polling QR, spinner mientras bot inicia, auto-reload en 30s si no aparece QR

#### Conversaciones
- Lista ordenada por última actividad, con preview de último mensaje
- Badges de modo (IA / HUMAN)
- Buscar por nombre o teléfono
- Fijar conversaciones importantes arriba
- Archivar conversaciones inactivas
- Etiquetas con colores personalizables
- Contador de chats archivados

#### Panel de conversación
- Historial de mensajes con burbujas diferenciadas (cliente / bot / humano)
- Borrar mensajes: solo para mí o para todos (revocación en WhatsApp)
- Resumen del pedido activo inline
- Switch AI/HUMAN por conversación
- Compositor de mensaje en modo HUMAN

#### Tiempo real y rendimiento
- SSE (`/api/events`) reemplaza polling — eventos push del servidor al browser
- Optimistic UI: acciones se reflejan instantáneo
- Skeletons de carga
- Tema oscuro/claro persistente

---

### Comandos del dueño por WhatsApp

| Comando | Función |
|---|---|
| `/fotoconfirmar [tel]` | Iniciar sesión de lectura de foto |
| `/listo` | Procesar fotos enviadas |
| `/editar campo valor` | Corregir campo del pedido en revisión |
| `/enviarconfirmacion` | Enviar confirmación al cliente |
| `/cancelar` | Cancelar sesión activa |
| `/reemplazar` | Reemplazar pedido duplicado |
| `/estadofoto` | Ver estado de sesión activa |
| `/usartelefono N` | Elegir teléfono cuando hay varios detectados |
| `/reenviarconfirmacion TEL` | Reenviar confirmación a un cliente |
| `/resumen` | Stats del día (total, pendientes, confirmados, etc.) |
| `/pedido TEL` | Ver último pedido de un cliente |
| `/bloquear TEL` | Bloquear cliente (bot lo ignora) |
| `/desbloquear TEL` | Desbloquear cliente |
| `/humano TEL` | Poner conversación en modo HUMAN |
| `/ia TEL` | Volver a modo IA |

---

### Variables de entorno

| Variable | Descripción | Default |
|---|---|---|
| `OPENAI_API_KEY` | Clave OpenAI | requerido |
| `OPENAI_MODEL` | Modelo para fotos | `gpt-4o` |
| `OWNER_NOTIFY_PHONES` | Teléfonos del dueño (coma) | requerido |
| `SHOPIFY_WEBHOOK_SECRET` | Secret HMAC Shopify | requerido para Shopify |
| `SHOPIFY_CONFIRMATION_DELAY_SECONDS` | Delay antes de enviar confirmación | `180` |
| `SHOPIFY_REMINDER_MAX` | Máximo de recordatorios | `2` |
| `SHOPIFY_REMINDER_INTERVAL_SEC` | Segundos entre recordatorios | `7200` |
| `SHOPIFY_REMINDER_CHECK_MS` | Frecuencia del poller de recordatorios | `300000` |
| `DATA_DIR` | Directorio de datos | `./data` |
| `AUTH_DIR` | Directorio de credenciales WhatsApp | `./auth` |
