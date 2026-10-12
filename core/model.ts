// The model boundary. One function: prompt in, validated JSON out.
// The zod schema is both the response schema sent to Gemini and the validator.
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";

export function modelName(): string {
  return process.env.CREAMA_MODEL || "gemini-3.8-flash";
}

/** CREAMA_THINKING = minimal | low | medium | high (default low: proposals are structured, not puzzles). */
export function thinkingLevel(): ThinkingLevel {
  const v = (process.env.CREAMA_THINKING || "low").toUpperCase();
  return (Object.values(ThinkingLevel) as string[]).includes(v) ? (v as ThinkingLevel) : ThinkingLevel.LOW;
}

export function modelConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("No model configured. Set GEMINI_API_KEY (see .env.example).");
  return (client ??= new GoogleGenAI({ apiKey }));
}

function jsonSchema(schema: z.ZodType): unknown {
  const { $schema, ...rest } = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
  return rest;
}

export class ModelError extends Error {}

export interface Usage { input: number; output: number; thinking: number }

export async function generateJson<S extends z.ZodType>(opts: {
  system: string;
  prompt: string;
  schema: S;
  temperature?: number;
  onUsage?: (u: Usage) => void;
}): Promise<z.infer<S>> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ai().models.generateContent({
      model: modelName(),
      contents: attempt === 0 ? opts.prompt : `${opts.prompt}\n\nYour previous answer was invalid: ${lastError}\nReturn valid JSON only.`,
      config: {
        systemInstruction: opts.system,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema(opts.schema),
        temperature: opts.temperature ?? 0.2,
        thinkingConfig: { thinkingLevel: thinkingLevel() },
      },
    });
    const m = res.usageMetadata;
    opts.onUsage?.({ input: m?.promptTokenCount ?? 0, output: m?.candidatesTokenCount ?? 0, thinking: m?.thoughtsTokenCount ?? 0 });
    const text = res.text ?? "";
    try {
      const parsed = opts.schema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
      lastError = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch (e) {
      lastError = `not JSON (${(e as Error).message})`;
    }
  }
  throw new ModelError(`Model returned an invalid response: ${lastError}`);
}
