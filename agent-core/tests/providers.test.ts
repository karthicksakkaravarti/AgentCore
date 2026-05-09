import { describe, expect, it } from "vitest";
import {
  listProviders,
  parseProviderModel,
  resolveProvider,
} from "../src/providers/registry.js";

// ──────────────────────────────────────────────
// parseProviderModel
// ──────────────────────────────────────────────

describe("parseProviderModel", () => {
  it("parses 'anthropic/claude-3-5-sonnet' correctly", () => {
    const result = parseProviderModel("anthropic/claude-3-5-sonnet");
    expect(result.providerId).toBe("anthropic");
    expect(result.model).toBe("claude-3-5-sonnet");
  });

  it("defaults to anthropic when no provider prefix", () => {
    const result = parseProviderModel("claude-3-5-sonnet");
    expect(result.providerId).toBe("anthropic");
    expect(result.model).toBe("claude-3-5-sonnet");
  });

  it("parses 'openai/gpt-4o'", () => {
    const result = parseProviderModel("openai/gpt-4o");
    expect(result.providerId).toBe("openai");
    expect(result.model).toBe("gpt-4o");
  });

  it("parses 'google/gemini-pro'", () => {
    const result = parseProviderModel("google/gemini-pro");
    expect(result.providerId).toBe("google");
    expect(result.model).toBe("gemini-pro");
  });

  it("parses 'groq/llama3-8b-8192'", () => {
    const result = parseProviderModel("groq/llama3-8b-8192");
    expect(result.providerId).toBe("groq");
    expect(result.model).toBe("llama3-8b-8192");
  });

  it("throws for unknown provider prefix", () => {
    expect(() => parseProviderModel("badprovider/model")).toThrow("Unknown provider");
  });

  it("throws for empty model after prefix", () => {
    expect(() => parseProviderModel("anthropic/")).toThrow();
  });

  it("parses openrouter provider", () => {
    const result = parseProviderModel("openrouter/mistral-7b");
    expect(result.providerId).toBe("openrouter");
    expect(result.model).toBe("mistral-7b");
  });
});

// ──────────────────────────────────────────────
// listProviders
// ──────────────────────────────────────────────

describe("listProviders", () => {
  it("returns an array of providers", () => {
    const providers = listProviders();
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
  });

  it("includes anthropic, openai, and google", () => {
    const ids = listProviders().map((p) => p.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    expect(ids).toContain("google");
  });

  it("includes openai-compatible providers", () => {
    const ids = listProviders().map((p) => p.id);
    expect(ids).toContain("groq");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("deepseek");
  });

  it("each provider has envKey, id fields", () => {
    for (const provider of listProviders()) {
      expect(typeof provider.id).toBe("string");
      expect(typeof provider.envKey).toBe("string");
      expect(typeof provider.openAICompatible).toBe("boolean");
    }
  });

  it("anthropic is not openAI-compatible", () => {
    const anthropic = listProviders().find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.openAICompatible).toBe(false);
  });

  it("groq is openAI-compatible", () => {
    const groq = listProviders().find((p) => p.id === "groq");
    expect(groq).toBeDefined();
    expect(groq!.openAICompatible).toBe(true);
  });
});

// ──────────────────────────────────────────────
// resolveProvider
// ──────────────────────────────────────────────

describe("resolveProvider", () => {
  it("throws when API key is missing", () => {
    // Ensure no env key is set for this test
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() =>
        resolveProvider("anthropic/claude-3-5-sonnet"),
      ).toThrow("Missing ANTHROPIC_API_KEY");
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it("uses provided apiKey option", () => {
    const provider = resolveProvider("anthropic/claude-3-5-sonnet", {
      apiKey: "test-key-valid-ascii",
    });
    expect(provider).toBeTruthy();
    expect(provider.id).toBe("anthropic");
    expect(provider.model).toBe("claude-3-5-sonnet");
  });

  it("throws for non-ASCII characters in API key", () => {
    expect(() =>
      resolveProvider("anthropic/claude-3-5-sonnet", {
        apiKey: "bad’key",
      }),
    ).toThrow();
  });

  it("trims quotes from API key", () => {
    // Should not throw — quotes are stripped
    const provider = resolveProvider("anthropic/claude-3-5-sonnet", {
      apiKey: '"test-key-valid-ascii"',
    });
    expect(provider).toBeTruthy();
  });

  it("returns LLMProvider with correct id and model for openai", () => {
    const provider = resolveProvider("openai/gpt-4o", {
      apiKey: "test-openai-key",
    });
    expect(provider.id).toBe("openai");
    expect(provider.model).toBe("gpt-4o");
  });
});
