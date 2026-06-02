import fs from "node:fs";
import OpenAI from "openai";
import type { ExtractedPhotoOrder } from "./types";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Falta OPENAI_API_KEY en .env.local");
  return new OpenAI({ apiKey });
}

function buildExtractionPrompt(phoneFromCommand?: string): string {
  const phoneHint = phoneFromCommand
    ? `\n\nEl operador indicó que el teléfono del cliente es: ${phoneFromCommand}. Úsalo como referencia.`
    : "";

  return `Analiza estas imágenes y extrae los datos del pedido.${phoneHint}

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
- No inventes datos. Si no ves el campo, déjalo vacío.
- phone debe ser colombiano normalizado: 57 + 10 dígitos. Ejemplo: 573147823790.
- Si ves varios teléfonos, ponlos todos en detectedPhones. El más probable del cliente va en phone.
- Si ves solo un teléfono, ponlo en phone Y en detectedPhones.
- Separa nombre y apellido correctamente.
- total sin decimales si termina en ,00. Ejemplo: $199.900 (no $199.900,00).
- missingFields lista los campos obligatorios vacíos: nombre, teléfono, producto, color, talla, cantidad, total, dirección, ciudad, departamento.
- confidence: "high" si todo claro, "medium" si hay dudas, "low" si muchas dudas.
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
