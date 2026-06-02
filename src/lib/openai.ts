import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./system-prompt";
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

export async function generateReply(history: Message[]): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({
      role: (m.role === "human" ? "assistant" : m.role) as "user" | "assistant",
      content: m.content
    }))
  ];

  try {
    const response = await getClient().chat.completions.create({
      model: MODEL,
      messages,
      max_completion_tokens: 600
    });
    return response.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    console.error("[bot] Error llamando OpenAI:", err);
    return "Déjame derivarte con un asesor humano.";
  }
}
