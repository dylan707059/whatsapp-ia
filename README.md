# Agente WhatsApp

Bot de WhatsApp local con dashboard, historial de conversaciones y modo IA/Humano.

## Requisitos

- Node.js 20 o superior
- Una cuenta de WhatsApp activa
- API key de [OpenAI](https://platform.openai.com/api-keys)

## Instalación

```bash
npm install
```

## Configuración

Copiar el archivo de ejemplo y completar las variables:

```bash
cp .env.example .env.local
```

Editar `.env.local`:

```env
OPENAI_API_KEY=sk-proj-tu-clave-real
OPENAI_MODEL=gpt-4o-mini
```

### Cómo obtener la API key de OpenAI

1. Crear cuenta en [platform.openai.com](https://platform.openai.com)
2. Ir a **API keys** → **Create new secret key**
3. Copiar la clave y pegarla en `.env.local`

> **Importante:**
> - ChatGPT Plus **no incluye** uso de la API. Son productos separados.
> - La API de OpenAI se cobra según el uso (tokens consumidos).
> - **No compartas tu API key** ni la subas a un repositorio público.
> - Si la key se filtra, revocarla en el panel de OpenAI y crear una nueva de inmediato.

**Modelo recomendado:** `gpt-4o-mini`. Es el más económico con buena calidad de respuesta.

## Uso local

### Opción A — Todo junto

```bash
npm run start:all
```

Levanta el bot y el dashboard en paralelo.

### Opción B — Procesos separados (recomendado para desarrollo)

Terminal 1 — Bot Baileys:
```bash
npm run start:bot
```

Terminal 2 — Dashboard Next.js:
```bash
npm run dev
```

Luego abrir [http://localhost:3000](http://localhost:3000) y escanear el QR.

## Personalizar el system prompt

Editar `src/lib/system-prompt.ts`:

```typescript
export const SYSTEM_PROMPT = `
Tu texto personalizado aquí.
Puede ser en cualquier idioma y tener el rol que necesites.
`.trim();
```

Reiniciar el bot después de cambiar el archivo.

## Estructura de la base de datos

La base de datos SQLite se guarda en `./data/messages.db`. No es necesario crearla manualmente; se inicializa sola al arrancar el bot.

## Volúmenes persistentes (producción)

En EasyPanel u otro servicio, montar como volúmenes persistentes:

| Ruta local | Motivo |
|------------|--------|
| `/app/data` | Base de datos SQLite con historial de conversaciones |
| `/app/auth` | Sesión Baileys (evita escanear QR en cada redespliegue) |

Sin estos volúmenes, cada redespliegue pierde el historial y obliga a escanear el QR.

## Seguridad

**El dashboard no tiene autenticación.**

Si se despliega a internet, es obligatorio protegerlo antes. Opciones:

- Basic Auth en el proxy de EasyPanel (Caddy/Nginx)
- Cloudflare Access (zero-trust)
- VPN

Sin protección, cualquier persona con la URL puede leer las conversaciones y enviar mensajes.

## Solución de problemas

### El QR no aparece en el dashboard

Verificar que el bot esté corriendo con `npm run start:bot`. Si la pantalla muestra el error después de 10 segundos, es que el proceso bot no está activo.

### Error code=440 en loop

1. Verificar que `Browsers.macOS("Desktop")` esté configurado en `src/lib/baileys/client.ts`.
2. Ir a WhatsApp en el teléfono → Dispositivos vinculados → cerrar sesiones viejas.
3. Si persiste, puede ser throttling por IP del servidor. Esperar 24h o cambiar IP.

### Error de OpenAI (401 Unauthorized)

La API key es incorrecta o fue revocada. Crear una nueva en [platform.openai.com/api-keys](https://platform.openai.com/api-keys) y actualizar `.env.local`.

### Error de OpenAI (429 Too Many Requests)

Se alcanzó el límite de uso. Opciones:
- Agregar créditos en [platform.openai.com/billing](https://platform.openai.com/billing)
- Revisar el uso en el panel de OpenAI

## Flujo seguro de /fotoconfirmar

Para confirmar pedidos desde capturas de pantalla. **Solo disponible para números en `OWNER_NOTIFY_PHONES`.**

### Principio base

- Si OpenAI está seguro y todos los datos están completos → envía la confirmación al cliente automáticamente.
- Si tiene dudas, si faltan datos, si hay varios teléfonos posibles o si el pedido parece duplicado → **no envía al cliente** y pide revisión al owner.

### Flujo completo

```
1. Escribir:
   /fotoconfirmar

2. Enviar las fotos del pedido (1 a 4 imágenes JPG, PNG o WEBP).

3. Escribir:
   /listo

4. Si la IA está segura (confidence = high) y no hay duplicado:
   → Envía confirmación al cliente automáticamente.

5. Si la IA tiene dudas (confidence = medium o low):
   → Muestra VISTA PREVIA al owner. El cliente NO recibe nada todavía.

6. Para corregir un dato:
   /editar campo valor
   Ejemplo: /editar talla M

7. Para aprobar y enviar al cliente:
   /enviarconfirmacion

8. Para reenviar una confirmación ya enviada:
   /reenviarconfirmacion 3147823790

9. Si se detecta un pedido duplicado (mismo contenido ya existe):
   → Muestra aviso. Para reemplazar el anterior:
   /reemplazar

10. Para cancelar en cualquier momento:
    /cancelar
```

### Comandos de /fotoconfirmar

| Comando | Descripción |
|---------|-------------|
| `/fotoconfirmar [TELEFONO]` | Inicia sesión. El teléfono es opcional si está en las fotos |
| `/listo` | Procesa las fotos enviadas |
| `/cancelar` | Cancela la sesión activa |
| `/estadofoto` | Muestra estado y cantidad de fotos |
| `/usartelefono N` | Elige el teléfono cuando la IA detectó varios |
| `/editar campo valor` | Corrige un dato del pedido en revisión |
| `/enviarconfirmacion` | Aprueba y envía la confirmación al cliente |
| `/reenviarconfirmacion TELEFONO` | Reenvía la confirmación a un cliente que no respondió |
| `/reemplazar` | Cancela el pedido duplicado y procede con el nuevo |

### Campos editables con /editar

`nombre`, `apellido`, `telefono`, `producto`, `color`, `talla`, `cantidad`, `total`, `pago`, `envio`, `direccion`, `ciudad`, `departamento`

```
/editar nombre Claudia Marcela Herrera
/editar talla M
/editar direccion Calle 10 # 5-20 barrio Centro
/editar ciudad Apartadó
```

### Comandos de gestión adicionales

| Comando | Descripción |
|---------|-------------|
| `/bloquear TELEFONO` | Bloquea un cliente (el bot deja de responderle) |
| `/desbloquear TELEFONO` | Desbloquea un cliente |
| `/humano TELEFONO` | Pasa la conversación a modo HUMAN |
| `/ia TELEFONO` | Reactiva el modo IA |
| `/pedido TELEFONO` | Muestra el último pedido del número |
| `/resumen` | Estadísticas del día |

### Seguridad y control

- Solo `OWNER_NOTIFY_PHONES` puede usar comandos internos. Cualquier otro número que envíe un comando es ignorado.
- Las fotos son temporales (`./data/tmp/fotoconfirmar/`) y se borran al terminar.
- Detección de pedidos duplicados por hash de contenido (teléfono + producto + datos de envío).
- Cola global FIFO: un pedido se procesa completamente antes de empezar el siguiente.
- Bloqueo por cliente: evita procesos cruzados del mismo número.
- Auditoría completa en tabla `order_events`: cada acción relevante queda registrada.
- Sin inventario. Sin catálogo. Solo valida que los datos obligatorios existan.

### Variables de entorno

```env
OPENAI_API_KEY=sk-proj-...        # Necesita soportar visión (gpt-4o / gpt-4o-mini)
OPENAI_MODEL=gpt-4o-mini
OWNER_NOTIFY_PHONES=573204665094,573223272342
```

## Integración con Shopify

Cuando llega un pedido nuevo a Shopify, el bot envía automáticamente un
WhatsApp al cliente pidiendo confirmar los datos antes de despachar.

### Cómo funciona

1. Shopify dispara el webhook `orders/create` cuando se crea un pedido.
2. El endpoint `/api/webhooks/shopify/orders-create` valida la firma HMAC.
3. Se crea/encuentra la conversación del cliente en SQLite y se registra
   un `Order` con `status='PENDING_CONFIRMATION'` y `source='SHOPIFY'`.
4. Se encola un mensaje en `outbox` con el detalle del pedido pidiendo que
   responda **CONFIRMADO**, pero con `scheduled_at = ahora + delay` (default
   3 min) para evitar bloqueo de WhatsApp por enviar mensajes no solicitados.
5. **Anti-bloqueo:**
   - Si el cliente nos escribe **antes** del delay (porque Releasit lo
     instruyó), el handler entrante dispara `advancePendingOutbox()` y la
     confirmación sale en el siguiente tick del poller (~2s).
   - Si el cliente **no escribe** dentro del delay, la confirmación se
     envía igual cuando se cumple el tiempo.
6. La conversación se setea a modo `HUMAN` para que la IA no responda en
   paralelo. Si querés que la IA conteste, togglealo manualmente desde el
   dashboard.
7. Cuando el cliente responde **CONFIRMADO** se dispara el flujo existente
   de `order-confirmation.ts` y se notifica al owner.

### Tunear el delay anti-bloqueo

Variable de entorno opcional `SHOPIFY_CONFIRMATION_DELAY_SECONDS` (default
`180`). Subila si tu flujo de Releasit toma más, o bajala a `0` si querés
enviar la confirmación inmediatamente (NO recomendado: alto riesgo de
bloqueo Baileys).

### Anti-duplicados

El endpoint usa `computeOrderHash()` (mismo que el flujo `/fotoconfirmar`)
para detectar si el mismo pedido ya fue procesado. Si Shopify reenvía el
webhook por reintento, el segundo intento responde `200 OK skipped=duplicate`
sin reenviar el mensaje al cliente.

### Setup en Shopify Admin

1. Ir a **Settings → Notifications → Webhooks** (al final de la página).
2. **Create webhook**:
   - **Event:** `Order creation`
   - **Format:** `JSON`
   - **URL:** `https://TU-DOMINIO-RENDER.onrender.com/api/webhooks/shopify/orders-create`
   - **Webhook API version:** la más reciente.
3. Guardar. Justo arriba de la lista aparece el texto
   *"Tus webhooks se firmarán con `XXXXXX...`"* — ese es el secret.
4. En Render → tu servicio → **Environment** → agregar:
   ```
   SHOPIFY_WEBHOOK_SECRET=XXXXXX...
   ```
5. Render reinicia automáticamente al guardar la variable.

### Probar el webhook

Desde el panel de webhooks en Shopify Admin click **"..." → Enviar prueba**.
Si todo está OK ves en los logs de Render:
```
[shopify] Pedido #XXXX → conv #N (5730...) — mensaje encolado en outbox
[bot] → Outbox enviado a 5730...@s.whatsapp.net
```

### Limitaciones actuales

- Solo procesa pedidos con teléfono. Si el customer no dejó teléfono el
  webhook responde `200 OK skipped=no_phone`.
- Si el bot está desconectado al momento del webhook, el mensaje queda
  encolado en `outbox` y se envía al reconectar.
- El parsing asume que las variantes vienen como `"Color / Talla"`. Si
  tu catálogo usa otro formato, ajustar `toOrderData()` en
  `src/lib/shopify.ts`.

## Mejoras pendientes

- Autenticación en el dashboard (Basic Auth o JWT)
- Notificaciones de mensajes nuevos (browser notifications)
- Búsqueda de conversaciones por nombre o número
- Soporte para imágenes y archivos en el historial
- Límite configurable de historial por conversación
- Múltiples system prompts por conversación
- Exportar conversaciones a CSV
- Webhook configurable para eventos entrantes
