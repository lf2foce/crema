import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NoObjectGeneratedError, type LanguageModelUsage } from "ai";
import { generateJson, modelConfigured, modelSettings, schemaModel, schemaProviderOptions, usageCounts } from "../core/model";

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("ai", async importOriginal => ({ ...await importOriginal<typeof import("ai")>(), generateText: generate }));
const schema = z.object({ count: z.number() });
const usage: LanguageModelUsage = {
  inputTokens: 10, outputTokens: 8, totalTokens: 18,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 5, reasoningTokens: 3 },
};
afterEach(() => { vi.unstubAllEnvs(); generate.mockReset(); });
function setup() {
  vi.stubEnv("CREAMA_PROVIDER", "google"); vi.stubEnv("CREAMA_MODEL", "gemini-3.8-flash");
  vi.stubEnv("GEMINI_API_KEY", "dummy-test-key");
}

describe("schema-only boundary", () => {
  it("blocks unverified providers and unknown/text-only models before any call", () => {
    for (const provider of ["deepseek", "compatible", "__proto__"]) {
      expect(() => modelSettings({ CREAMA_PROVIDER: provider, AI_API_KEY: "dummy" })).toThrow(/not enabled/);
    }
    expect(() => modelSettings({ CREAMA_PROVIDER: "google", CREAMA_MODEL: "gemma-3-27b-it", GEMINI_API_KEY: "dummy" })).toThrow(/not approved/);
    expect(() => modelSettings({ CREAMA_PROVIDER: "google", CREAMA_MODEL: "gemini-3.8-pro", GEMINI_API_KEY: "dummy" })).toThrow(/not approved/);
    expect(() => modelSettings({ CREAMA_PROVIDER: "openai", OPENAI_API_KEY: "dummy" })).toThrow(/missing/);
    expect(generate).not.toHaveBeenCalled();
  });
  it("does not borrow another provider's key", () => {
    expect(() => modelSettings({ CREAMA_PROVIDER: "xai", CREAMA_MODEL: "grok-4", GEMINI_API_KEY: "dummy" })).toThrow(/Missing API key/);
    setup(); vi.stubEnv("CREAMA_PROVIDER", "deepseek"); expect(modelConfigured()).toBe(false);
  });
  it("accepts only validated output and requests a schema", async () => {
    setup(); generate.mockResolvedValue({ output: { count: 1 }, totalUsage: usage, warnings: [] });
    const onUsage = vi.fn();
    expect(await generateJson({ system: "system", prompt: "prompt", schema, onUsage })).toEqual({ count: 1 });
    expect(generate.mock.calls[0][0].output).toBeDefined();
    expect(onUsage).toHaveBeenCalledWith({ input: 10, output: 5, thinking: 3 });
  });
  it("rejects schema downgrade warnings even when returned JSON validates", async () => {
    setup(); generate.mockResolvedValue({ output: { count: 1 }, totalUsage: usage,
      warnings: [{ type: "unsupported", feature: "responseFormat JSON schema" }] });
    await expect(generateJson({ system: "s", prompt: "p", schema })).rejects.toThrow(/No fallback/);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("never accepts invalid data or repairs it by parsing text", async () => {
    setup(); generate.mockResolvedValue({ output: { count: "wrong" }, text: '{"count":1}', totalUsage: usage, warnings: [] });
    await expect(generateJson({ system: "s", prompt: "p", schema })).rejects.toThrow(/validation/);
  });
  it("bounds schema retry to two attempts with the same model and records both usages", async () => {
    setup(); generate.mockRejectedValue(new NoObjectGeneratedError({ message: "invalid", text: "bad",
      response: { id: "test", modelId: "test", timestamp: new Date() }, usage,
      finishReason: "stop" }));
    const onUsage = vi.fn();
    await expect(generateJson({ system: "s", prompt: "p", schema, onUsage })).rejects.toThrow(/two attempts/);
    expect(generate).toHaveBeenCalledTimes(2); expect(onUsage).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][0].model).toBe(generate.mock.calls[1][0].model);
  });
  it("does not retry or disclose raw transport errors", async () => {
    setup(); generate.mockRejectedValue(new Error("credential-secret raw payload"));
    await expect(generateJson({ system: "s", prompt: "p", schema })).rejects.toThrow(/No fallback was attempted/);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("does not double count reasoning when text-token details are absent", () => {
    expect(usageCounts({ ...usage, outputTokenDetails: { textTokens: undefined, reasoningTokens: 3 } })).toEqual({ input: 10, output: 5, thinking: 3 });
  });
});

describe("real adapter wire contracts (offline)", () => {
  it.each([
    ["google", "gemini-3.8-flash", "GEMINI_API_KEY"],
    ["openai", "gpt-4.1", "OPENAI_API_KEY"],
    ["xai", "grok-4.3", "XAI_API_KEY"],
    ["anthropic", "claude-sonnet-4-5", "ANTHROPIC_API_KEY"],
  ])("%s sends native schema, not JSON mode/tool fallback", async (provider, name, key) => {
    const actual = await vi.importActual<typeof import("ai")>("ai");
    let body: Record<string, any> | undefined;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      throw new Error("Offline: intercepted before network");
    };
    const { model } = schemaModel({ CREAMA_PROVIDER: provider, CREAMA_MODEL: name, [key]: "dummy" }, fetch);
    await expect(actual.generateText({ model, output: actual.Output.object({ schema }), prompt: "offline",
      maxRetries: 0, maxOutputTokens: 100, providerOptions: schemaProviderOptions(name) })).rejects.toThrow();
    expect(body).toBeDefined();
    if (provider === "google") {
      expect(body!.generationConfig.responseMimeType).toBe("application/json");
      expect(body!.generationConfig.responseJsonSchema ?? body!.generationConfig.responseSchema).toHaveProperty("properties.count");
    } else if (provider === "anthropic") {
      expect(body!.output_config.format.type).toBe("json_schema");
      expect(body!.output_config.format.schema).toHaveProperty("properties.count");
      expect(body!.tools).toBeUndefined();
    } else {
      const format = body!.response_format ?? body!.text?.format;
      expect(format.type).toBe("json_schema");
      expect(format.json_schema?.schema ?? format.schema).toHaveProperty("properties.count");
      expect(format.json_schema?.strict ?? format.strict).toBe(true);
    }
  });
});
