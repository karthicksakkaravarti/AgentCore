import { createAnthropic } from "./anthropic.js";
import { createGemini } from "./gemini.js";
import { createOpenAI } from "./openai.js";
import type { LLMProvider } from "./provider.js";

type ProviderFactoryOptions = {
  id: string;
  apiKey: string;
  model: string;
  baseURL?: string;
};

type ProviderFactory = (options: ProviderFactoryOptions) => LLMProvider;

type ProviderRegistryEntry = {
  factory: ProviderFactory;
  envKey: string;
  baseURL?: string;
  openAICompatible?: boolean;
};

const REGISTRY = {
  anthropic: { factory: createAnthropic, envKey: "ANTHROPIC_API_KEY" },
  openai: { factory: createOpenAI, envKey: "OPENAI_API_KEY" },
  google: { factory: createGemini, envKey: "GOOGLE_API_KEY" },
  minimax: {
    factory: createOpenAI,
    envKey: "MINIMAX_API_KEY",
    baseURL: "https://api.minimax.io/v1",
    openAICompatible: true,
  },
  mistral: {
    factory: createOpenAI,
    envKey: "MISTRAL_API_KEY",
    baseURL: "https://api.mistral.ai/v1",
    openAICompatible: true,
  },
  deepseek: {
    factory: createOpenAI,
    envKey: "DEEPSEEK_API_KEY",
    baseURL: "https://api.deepseek.com/v1",
    openAICompatible: true,
  },
  xai: {
    factory: createOpenAI,
    envKey: "XAI_API_KEY",
    baseURL: "https://api.x.ai/v1",
    openAICompatible: true,
  },
  groq: {
    factory: createOpenAI,
    envKey: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1",
    openAICompatible: true,
  },
  openrouter: {
    factory: createOpenAI,
    envKey: "OPENROUTER_API_KEY",
    baseURL: "https://openrouter.ai/api/v1",
    openAICompatible: true,
  },
  ollama: {
    factory: createOpenAI,
    envKey: "OLLAMA_API_KEY",
    baseURL: "http://localhost:11434/v1",
    openAICompatible: true,
  },
  perplexity: {
    factory: createOpenAI,
    envKey: "PERPLEXITY_API_KEY",
    baseURL: "https://api.perplexity.ai",
    openAICompatible: true,
  },
  together: {
    factory: createOpenAI,
    envKey: "TOGETHER_API_KEY",
    baseURL: "https://api.together.xyz/v1",
    openAICompatible: true,
  },
  aihubmix: {
    factory: createOpenAI,
    envKey: "AIHUBMIX_API_KEY",
    baseURL: "https://aihubmix.com/v1",
    openAICompatible: true,
  },
} satisfies Record<string, ProviderRegistryEntry>;

export type ProviderId = keyof typeof REGISTRY;

export type ProviderInfo = {
  id: ProviderId;
  envKey: string;
  baseURL?: string;
  openAICompatible: boolean;
};

export function resolveProvider(
  modelString: string,
  options: { apiKey?: string } = {},
): LLMProvider {
  const { providerId, model } = parseProviderModel(modelString);
  const entry: ProviderRegistryEntry = REGISTRY[providerId];
  const apiKey =
    providerId === "ollama"
      ? normalizeApiKey(options.apiKey ?? process.env[entry.envKey]) ?? "ollama"
      : normalizeApiKey(options.apiKey ?? process.env[entry.envKey]);
  if (!apiKey) {
    throw new Error(`Missing ${entry.envKey} for provider '${providerId}'`);
  }
  assertHeaderSafeApiKey(apiKey, entry.envKey, providerId);
  return entry.factory({
    id: providerId,
    apiKey,
    model,
    baseURL: entry.baseURL,
  });
}

export function listProviders(): ProviderInfo[] {
  return providerEntries().map(([id, entry]) => ({
    id: id as ProviderId,
    envKey: entry.envKey,
    baseURL: entry.baseURL,
    openAICompatible: entry.openAICompatible === true,
  }));
}

export function parseProviderModel(modelString: string): {
  providerId: ProviderId;
  model: string;
} {
  const slashIndex = modelString.indexOf("/");
  if (slashIndex === -1) {
    return { providerId: "anthropic", model: modelString };
  }

  const providerId = modelString.slice(0, slashIndex);
  const model = modelString.slice(slashIndex + 1);
  if (!isProviderId(providerId)) {
    throw new Error(
      `Unknown provider '${providerId}'. Supported providers: ${Object.keys(
        REGISTRY,
      ).join(", ")}`,
    );
  }
  if (!model) {
    throw new Error(`Missing model after provider prefix '${providerId}/'`);
  }
  return { providerId, model };
}

function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(REGISTRY, value);
}

function providerEntries(): Array<[ProviderId, ProviderRegistryEntry]> {
  return Object.entries(REGISTRY) as Array<[ProviderId, ProviderRegistryEntry]>;
}

function normalizeApiKey(apiKey: string | undefined): string | undefined {
  return apiKey?.trim().replace(/^[`'"\u2018\u2019\u201C\u201D]+/, "").replace(
    /[`'"\u2018\u2019\u201C\u201D]+$/,
    "",
  );
}

function assertHeaderSafeApiKey(
  apiKey: string,
  envKey: string,
  providerId: ProviderId,
): void {
  for (let index = 0; index < apiKey.length; index += 1) {
    const codePoint = apiKey.charCodeAt(index);
    if (codePoint < 32 || codePoint > 126) {
      throw new Error(
        `${envKey} for provider '${providerId}' contains a non-ASCII character at index ${index} (code point ${codePoint}). Re-copy the key with plain quotes or no quotes.`,
      );
    }
  }
}
