import OpenAI from "openai";
import type { Message } from "./types";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

// Singleton — se inicializa una vez y se reutiliza en todas las llamadas
let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Falta OPENAI_API_KEY en .env.local");
  _client = new OpenAI({ apiKey });
  return _client;
}

/**
 * Verifica con IA si el último mensaje del cliente es una confirmación REAL del
 * pedido (no un saludo, pregunta, reclamo o aceptación ambigua). Se usa solo
 * para mensajes ambiguos ("ok", "vale", "bueno") para no disparar la
 * confirmación por error.
 * @returns true = sí confirma | false = no confirma | null = IA no disponible/error
 */
export async function verifyConfirmationWithAI(
  recent: Message[],
  customerMessage: string
): Promise<boolean | null> {
  if (!process.env.OPENAI_API_KEY) return null;

  const context = recent
    .slice(-8)
    .map((m) => `${m.role === "user" ? "CLIENTE" : "TIENDA"}: ${m.content}`)
    .join("\n");

  const prompt =
    "La tienda le pidió a un cliente que confirme su pedido respondiendo CONFIRMADO.\n" +
    "Analiza el ÚLTIMO mensaje del cliente y decide si está CONFIRMANDO el pedido " +
    "(acepta los datos y quiere que se despache) o NO (saluda, pregunta, reclama, " +
    "quiere cambiar algo, o es ambiguo).\n\n" +
    `Conversación reciente:\n${context}\n\n` +
    `Último mensaje del cliente: "${customerMessage}"\n\n` +
    "¿El cliente está confirmando el pedido para despacho? Responde SOLO una palabra: SI o NO.";

  try {
    const r = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 4,
      temperature: 0
    });
    const ans = (r.choices[0]?.message?.content ?? "").trim().toUpperCase();
    if (ans.startsWith("SI") || ans.startsWith("SÍ")) return true;
    if (ans.startsWith("NO")) return false;
    return null;
  } catch (err) {
    console.error("[bot] Error verificando confirmación con IA:", err);
    return null;
  }
}

