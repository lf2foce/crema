// Native schema output only: no JSON-mode, tool emulation, or provider fallback.
import { generateText, NoObjectGeneratedError, Output, type LanguageModelUsage } from "ai";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

export class ModelError extends Error {}
export interface Usage { input: number; output: number; thinking: number }
type Env = Record<string, string | undefined>;
type Provider = "google" | "openai" | "xai" | "anthropic";

// Conservative families; unknown models require review, not a capability flag.
const supported: Record<Provider, RegExp> = {
  google: /^(?:gemini-2\.5-(?:pro|flash|flash-lite)|gemini-3-(?:pro|flash)-preview|gemini-3\.1-(?:pro|flash-lite)-preview|gemini-3\.5-(?:flash|flash-lite)|gemini-3\.[678]-flash)$/,
  openai: /^(?:gpt-4o(?:-mini)?(?:-2024-(?:08-06|07-18|11-20))?|gpt-4\.1(?:-mini|-nano)?(?:-2025-04-14)?|gpt-5(?:\.[1-5])?(?:-mini|-nano)?|o3(?:-mini)?|o4-mini)$/,
  xai: /^grok-(?:4(?:\.(?:3|5|6|7))?|4\.20-(?:non-reasoning|reasoning))$/,
  anthropic: /^claude-(?:sonnet-4-[56]|opus-4-[5-8]|haiku-4-5|(?:sonnet|opus|haiku)-5-5|sonnet-5|opus-5)(?:-\d{8})?$/,
};

export function thinkingLevel(): "minimal" | "low" | "medium" | "high" {
  const value = (process.env.CREMA_THINKING || process.env.CREAMA_THINKING || "low").toLowerCase();
  return ["minimal", "low", "medium", "high"].includes(value) ? value as ReturnType<typeof thinkingLevel> : "low";
}
export function modelName(): string {
  return process.env.CREMA_MODEL || process.env.CREAMA_MODEL || ((process.env.CREMA_PROVIDER || process.env.CREAMA_PROVIDER || "google") === "google" ? "gemini-3.8-flash" : "");
}
export function modelSettings(env: Env = process.env) {
  const provider = env.CREMA_PROVIDER || env.CREAMA_PROVIDER || "google";
  if (!Object.hasOwn(supported, provider)) {
    throw new ModelError(`Provider '${provider}' is not enabled: native schema output has not been verified for this integration. JSON-mode fallback is forbidden.`);
  }
  const p = provider as Provider;
  const name = env.CREMA_MODEL || env.CREAMA_MODEL || (p === "google" ? "gemini-3.8-flash" : "");
  if (!supported[p].test(name)) {
    throw new ModelError(`Model '${name || "(missing)"}' is not approved for native schema output with ${p}. Set a supported CREMA_MODEL.`);
  }
  const key = p === "google" ? env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.PHENAU_GOOGLE_API_KEY
    : p === "openai" ? env.OPENAI_API_KEY : p === "xai" ? env.XAI_API_KEY : env.ANTHROPIC_API_KEY;
  if (!key) throw new ModelError(`Missing API key for ${p}. Set its provider key and restart.`);
  return { provider: p, name, key };
}
export function modelConfigured(): boolean {
  try { modelSettings(); return true; } catch { return false; }
}
/** Fetch injection is for offline contract tests, not configurable key routing. */
export function schemaModel(env: Env = process.env, fetch?: typeof globalThis.fetch) {
  const config = modelSettings(env);
  const settings = { apiKey: config.key, ...(fetch ? { fetch } : {}) };
  const model = config.provider === "google" ? createGoogle(settings)(config.name)
    : config.provider === "openai" ? createOpenAI(settings).chat(config.name)
    : config.provider === "xai" ? createXai(settings)(config.name)
    : createAnthropic(settings)(config.name);
  return { ...config, model };
}
export function usageCounts(usage: LanguageModelUsage): Usage {
  const thinking = usage.outputTokenDetails.reasoningTokens ?? 0;
  return { input: usage.inputTokens ?? 0,
    output: usage.outputTokenDetails.textTokens ?? Math.max(0, (usage.outputTokens ?? 0) - thinking), thinking };
}
export function schemaProviderOptions(name: string) {
  return {
    google: { structuredOutputs: true, ...(name.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: thinkingLevel() } } : {}) },
    openai: { strictJsonSchema: true },
    anthropic: { structuredOutputMode: "outputFormat" },
  };
}
export async function generateJson<S extends z.ZodType>(opts: {
  system: string; prompt: string; schema: S; temperature?: number; onUsage?: (u: Usage) => void;
}): Promise<z.infer<S>> {
  const { model, provider, name } = schemaModel();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await generateText({
        model, output: Output.object({ schema: opts.schema }), system: opts.system,
        prompt: attempt === 0 ? opts.prompt : `${opts.prompt}\n\nThe previous response failed validation. Return an answer matching the response schema.`,
        maxRetries: 1, maxOutputTokens: 8192, abortSignal: AbortSignal.timeout(90_000),
        ...(provider === "google" ? { temperature: opts.temperature ?? 0.2 } : {}),
        providerOptions: schemaProviderOptions(name),
      });
      opts.onUsage?.(usageCounts(result.totalUsage));
      if (result.warnings?.some(w => w.type === "unsupported" && /schema|response.?format|structured/i.test(w.feature))) {
        throw new ModelError("Provider does not support the requested schema output. No fallback is allowed.");
      }
      const parsed = opts.schema.safeParse(result.output);
      if (!parsed.success) throw new ModelError("Model output failed application schema validation.");
      return parsed.data;
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        if (error.usage) opts.onUsage?.(usageCounts(error.usage));
        if (attempt === 0) continue;
        throw new ModelError("Model returned invalid schema output after two attempts. No result was accepted.");
      }
      if (error instanceof ModelError) throw error;
      // Never expose provider payloads, prompts or credentials in UI/API errors.
      throw new ModelError(`Schema-output request failed for ${provider}/${name}. Check credentials, model access and provider schema support. No fallback was attempted.`);
    }
  }
  throw new ModelError("No valid schema output was produced.");
}
