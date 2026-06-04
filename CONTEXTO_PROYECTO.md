# Contexto del Proyecto — Agente WhatsApp (para retomar en otro chat)

> Pega este documento al inicio de un chat nuevo para que la IA tenga todo el contexto.

## 1. Qué es

Sistema **multi-usuario** de **gestión de pedidos por WhatsApp** para tiendas de
**contraentrega** en Colombia, integrado con **Shopify**. Automatiza la
confirmación de pedidos con el cliente y da un **dashboard web** para gestionar
chats y despachos. Tienda actual: **Vittoria / Eclipse** (vittoriaclothes.myshopify.com).

## 2. Stack técnico

- **Next.js 15** (App Router, React 19) — dashboard web + APIs
- **Baileys** (`@whiskeysockets/baileys`) — conexión NO oficial a WhatsApp
- **better-sqlite3** — base de datos local (archivo en disco)
- **OpenAI** — casi sin uso (la IA está "dormida"; todo es por plantillas)
- **TypeScript**, **Tailwind v4**
- Repo GitHub: `github.com/dylan707059/whatsapp-ia` (rama `main`)
- Deploy: **Render** (auto-deploy en cada push a `main`). Cada commit dispara build.

## 3. Arquitectura

- **Un solo proceso** en producción: `start:all` = `next start`. El bot corre
  DENTRO del proceso de Next vía `src/instrumentation.ts` → `src/lib/bot-runtime.ts`
  (se hizo así para ahorrar RAM).
- **Multi-tenant**: cada cuenta tiene su propio WhatsApp y su data aislada.
  La aislación es por `owner_phone` (el número conectado de cada cuenta).
- **Gestor multi-socket**: `src/lib/baileys/client.ts` maneja N sockets (uno por
  cuenta) con `Map<accountId, handle>`. Conexión **lazy**: solo conecta cuentas
  activas/con credenciales (por la RAM de 512MB).

## 4. Archivos clave

- `src/lib/db.ts` — toda la base de datos, tablas, migraciones, helpers
- `src/lib/baileys/client.ts` — conexiones WhatsApp (multi-socket)
- `src/lib/baileys/handler.ts` — procesa mensajes entrantes
- `src/lib/bot-runtime.ts` — pollers: outbox, recordatorios, heartbeat, anti-blast
- `src/lib/shopify.ts` — parseo de pedidos Shopify + plantilla de confirmación
- `src/lib/colombia-zones.ts` — zonas bloqueadas (por cuenta)
- `src/lib/owner-notifier.ts` — notificaciones al dueño (por cuenta)
- `src/lib/orders.ts` — pedidos, stats, panel de pedidos
- `src/lib/auth.ts` — hashing de contraseñas (scrypt)
- `src/lib/request-account.ts` — resuelve cuenta de la sesión + ownership de recursos
- `src/app/api/...` — rutas API (login, settings, accounts, orders-board, webhooks, etc.)
- `src/components/` — UI: ConnectionGate (orquestador), ConversationList, ConversationPanel,
  ConversationInfo, PedidosScreen, SettingsScreen, AccountsScreen, Sidebar, QRScreen

## 5. Base de datos (tablas principales)

- `accounts` — cuentas (email, password_hash, owner_phone, automation_paused,
  automation_resumed_at, is_admin)
- `account_settings` — config por cuenta (shopify_domain, secret, zonas, teléfonos, delay)
- `account_connections` — estado de conexión WhatsApp por cuenta (status, qr, phone, wanted_at)
- `sessions` — sesiones de login (cookie)
- `conversations` — chats (phone=JID, owner_phone, mode AI/HUMAN, archived_at, pinned_at, blocked_at, confirmed_at)
- `messages` — historial de mensajes
- `orders` — pedidos (estado: DRAFT→PENDING_CONFIRMATION→CONFIRMED→OWNER_NOTIFIED→DISPATCHED→CANCELLED)
- `outbox` — cola de envío (scheduled_at, expires_at, notify_owner)
- `labels` / `conversation_labels` — etiquetas
- `app_state` — clave/valor (heartbeat del bot)
- `order_events`, `audit_log` — auditoría

## 6. Flujo de un pedido (lo principal — NO usa IA)

1. Cliente compra en Shopify → webhook a `/api/webhooks/shopify/orders-create`
2. Valida firma HMAC (secret por dominio de tienda) y enruta a la cuenta correcta
3. Rechaza zonas no cubiertas (San Andrés, Amazonas, Vaupés, Guainía, Vichada;
   por nombre, ciudad o código de provincia) y direcciones de oficina
4. Programa la confirmación con **plantilla** (`buildConfirmationMessage`), delay 3 min
5. Se envía a los 3 min O apenas el cliente escribe (lo que pase primero)
6. Cliente responde "CONFIRMADO" (detección por reglas de texto) → avisa al dueño
   con resumen del pedido (notificación interna)
7. Si no confirma → recordatorios (máx 2, cada 2h) → auto-cancelación

## 7. Dashboard

- Lista de chats muestra el **número formateado** (+57 313 794 1545); los @lid
  (privacidad de WhatsApp, sin número real) muestran el nombre
- Búsqueda por número (dígitos) o nombre
- **Panel de Pedidos** (📋): por estado, con "Marcar despachado" y "Copiar para Dropi"
- Clic en el nombre del chat → info del cliente + Bloquear
- Clic derecho en un chat → Anclar, Archivar, Marcar despachado, Cancelar (estilo WhatsApp Web)
- Etiquetas de colores, anclar, archivar
- Archivar en el celular se refleja en el panel (Teléfono→Panel; el inverso es frágil con Baileys)
- Botón ⚙️ Configuración, 👥 Cuentas (admin), 🤖 pausar bot, 🚪 cerrar sesión

## 8. Reglas de control y seguridad (lo más importante)

- **Botón de pánico 🤖**: pausa TODA la automatización; solo queda chat manual
- **Al (re)conectar**: el bot queda EN PAUSA y DESCARTA la cola pendiente →
  NO manda nada viejo al conectar
- **Al activar (despausar)**: se marca `automation_resumed_at`. El bot SOLO
  atiende pedidos creados DESPUÉS de activar. Los viejos pendientes nunca
  reciben recordatorios ni mensajes
- **En pausa, los pedidos de Shopify SÍ se registran** (visibles en el panel)
  pero no se envía confirmación
- **Confirmación = una sola oportunidad**: ventana de 5 min; si no se envía
  (desconexión), se descarta y se AVISA AL DUEÑO (no se reintenta tarde)
- **Anti-blast tras caída**: heartbeat detecta caídas >10 min; al volver, NO
  dispara recordatorios masivos — manda un RESUMEN al dueño
- **Anti-spam**: outbox >6h descartado; recordatorios solo a pedidos <24h y de
  a pocos por tick; cliente escribe primero; delays entre mensajes
- Aislación por cuenta: teléfonos de aviso y zonas bloqueadas son por cuenta

## 9. Seguridad / login

- Login con email+password (scrypt). Cuenta principal = admin.
- Auto-seed de cuentas vía env (`SEED_ACCOUNT_EMAIL/PASSWORD`, `SEED_ACCOUNT2_*`)
- Admin crea cuentas desde el dashboard (👥)
- Rutas API por ID verifican dueño (`requireOwnedConversation`/`requireOwnedLabel`)

## 10. Despliegue

- **Render** plan Starter (512 MB RAM, ~$7/mes) + disco persistente para la data
- Build command: `npm install && DATA_DIR=./data AUTH_DIR=./auth npm run build`
- Start: `npm run start:all` (= `next start`; el bot arranca in-process)
- **Límite**: 512 MB solo aguanta 1 conexión WhatsApp. Para 2+ simultáneas o
  ~50 usuarios → VPS (ej: Hetzner 16 GB ~$30/mes). A escala: PostgreSQL + API
  oficial de WhatsApp (Baileys es no oficial = riesgo de baneo).
- Variables de entorno relevantes (todas opcionales, tienen defaults):
  SEED_ACCOUNT_PASSWORD, SHOPIFY_CONFIRMATION_DELAY_SECONDS (180),
  BOT_DOWNTIME_THRESHOLD_SEC (600), SHOPIFY_REMINDER_BATCH (5),
  MAX_OUTBOX_AGE_SEC (21600), SHOPIFY_REMINDER_MAX_AGE_SEC (86400),
  SHOPIFY_BLOCKED_DEPARTMENTS/CITIES/DEPARTMENT_CODES, OWNER_NOTIFY_PHONES,
  SHOPIFY_WEBHOOK_SECRET, OPENAI_API_KEY

## 11. Integraciones externas

- **Shopify**: webhook `orders/create`. La app oficial **Dropify** sincroniza la
  guía de Dropi a Shopify (toggle "Actualizar automáticamente la guía" activado).
- **Dropi**: maneja la logística/guías. Pendiente: webhook `fulfillments/create`
  de Shopify para mandar la guía al cliente automáticamente (no montado aún).

## 12. Pendientes / ideas futuras

- Webhook de guía (Shopify fulfillments/create → mandar tracking al cliente)
- Cambiar contraseña desde el dashboard
- Borrar/resetear cuentas desde el panel de cuentas
- Respaldo (backup) de la base de datos
- Lista negra de malos pagadores
- Métricas (conversión, devoluciones por zona, ventas)
- Exportar pedidos a CSV
- Respuestas rápidas / plantillas
- Migración a PostgreSQL + API oficial de WhatsApp (a escala)

## 13. Cómo se trabaja

- Editar código → `git commit` → `git push origin main` → Render hace build+deploy automático
- No hay Node en el entorno local del dev; el build lo valida Render
- Si el build falla, se revisa el log de Render (línea roja) y se corrige
