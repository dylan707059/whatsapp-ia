import fs from "node:fs";
import OpenAI from "openai";
import type { ExtractedPhotoOrder } from "./types";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Falta OPENAI_API_KEY en .env.local");
  return new OpenAI({ apiKey });
}

function buildExtractionPrompt(phoneFromCommand?: string): string {
  const phoneHint = phoneFromCommand
    ? `\n\nEl operador indicó que el teléfono del cliente es: ${phoneFromCommand}. Úsalo como referencia.`
    : "";

  return `Eres un asistente experto en leer capturas de pantalla de pedidos de WhatsApp y formularios de ventas colombianos.

Analiza TODAS las imágenes con mucho detalle y extrae los datos del pedido.${phoneHint}

IMPORTANTE: Lee toda la imagen con cuidado. Los pedidos suelen tener campos como:
- Nombre del cliente
- Teléfono / celular
- Producto (nombre del artículo, referencia, modelo)
- Color / referencia de color
- Talla / tamaño (XS, S, M, L, XL, XXL, número, etc.)
- Cantidad (unidades pedidas)
- Total / valor / precio (en pesos colombianos)
- Método de pago (contraentrega, transferencia, etc.)
- Dirección de entrega
- Ciudad
- Departamento

Responde ÚNICAMENTE con JSON válido. Sin texto adicional. Sin markdown. Sin explicaciones.

Formato exacto:
{
  "fullName": "",
  "firstName": "",
  "lastName": "",
  "phone": "",
  "detectedPhones": [],
  "product": "",
  "color": "",
  "size": "",
  "quantity": "",
  "total": "",
  "payment": "Contraentrega",
  "shipping": "Gratis",
  "address": "",
  "city": "",
  "department": "",
  "confidence": "high",
  "missingFields": []
}

Reglas estrictas:
- Lee TODO el texto visible en la imagen, incluyendo capturas de chat de WhatsApp.
- No inventes datos. Si no ves el campo claramente, déjalo vacío.
- phone debe ser colombiano normalizado: 57 + 10 dígitos. Ejemplo: 573147823790.
- Si ves varios teléfonos, ponlos todos en detectedPhones. El más probable del cliente va en phone.
- Si ves solo un teléfono, ponlo en phone Y en detectedPhones.
- Separa nombre y apellido correctamente.
- product: escribe el nombre completo del producto tal como aparece en la imagen.
- color: extrae el color aunque esté abreviado o en código.
- size: extrae la talla aunque sea un número o código.
- quantity: número de unidades pedidas.
- total: valor en pesos colombianos, sin decimales si termina en ,00. Ejemplo: $199.900
- missingFields lista los campos obligatorios que quedaron vacíos: nombre, teléfono, producto, color, talla, cantidad, total, dirección, ciudad, departamento.
- confidence: "high" si extrajiste todos los campos obligatorios, "medium" si faltan 1-3, "low" si faltan más de 3.
- Ciudad y departamento con mayúscula inicial.`;
}

function extractJson(raw: string): string {
  // Quitar bloques markdown si los hay
  return raw
    .replace(/```json\n?/gi, "")
    .replace(/```\n?/g, "")
    .trim();
}

const DEFAULT_ORDER: ExtractedPhotoOrder = {
  fullName: "", firstName: "", lastName: "", phone: "",
  detectedPhones: [], product: "", color: "", size: "",
  quantity: "", total: "", payment: "Contraentrega", shipping: "Gratis",
  address: "", city: "", department: "", confidence: "low", missingFields: []
};

export async function extractOrderFromImages(
  imagePaths: string[],
  phoneFromCommand?: string
): Promise<ExtractedPhotoOrder> {
  const client = getClient();

  const imageContents: OpenAI.Chat.ChatCompletionContentPartImage[] =
    imagePaths.map((p) => {
      const ext    = p.split(".").pop()?.toLowerCase() ?? "jpg";
      const mime   = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const base64 = fs.readFileSync(p).toString("base64");
      return {
        type: "image_url",
        image_url: { url: `data:${mime};base64,${base64}`, detail: "high" }
      };
    });

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildExtractionPrompt(phoneFromCommand)
          },
          ...imageContents
        ]
      }
    ],
    max_completion_tokens: 800
  });

  const raw  = response.choices[0]?.message?.content ?? "{}";
  const json = extractJson(raw);

  try {
    const parsed = JSON.parse(json) as Partial<ExtractedPhotoOrder>;
    return { ...DEFAULT_ORDER, ...parsed };
  } catch {
    console.error("[bot] No se pudo parsear respuesta de OpenAI:", raw.slice(0, 200));
    return { ...DEFAULT_ORDER, confidence: "low", missingFields: ["error al parsear"] };
  }
}
