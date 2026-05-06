import type { AgentTool } from "../types.js";
import { asString, truncateMiddle } from "../utils/json.js";

export const WebFetchTool: AgentTool = {
  name: "WebFetch",
  description:
    "Fetch a URL and return readable page text. The prompt field tells the agent what to focus on.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch." },
      prompt: {
        type: "string",
        description: "What information to extract from the fetched content.",
      },
    },
    required: ["url", "prompt"],
  },
  readOnly: true,
  concurrencySafe: true,
  async execute(input, context) {
    const url = asString(input.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const abort = () => controller.abort();
    context.abortSignal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "agent-core/0.1 (+https://anthropic.com)",
          accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8",
        },
      });
      const contentType = response.headers.get("content-type") || "";
      const raw = await response.text();
      const text = contentType.includes("html") ? htmlToText(raw) : raw;
      return {
        content: truncateMiddle(
          [
            `URL: ${url}`,
            `Status: ${response.status} ${response.statusText}`,
            `Focus: ${asString(input.prompt) || "(none)"}`,
            "",
            text,
          ].join("\n"),
          50000,
        ),
        isError: !response.ok,
      };
    } catch (error) {
      return {
        content: `Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    } finally {
      clearTimeout(timeout);
      context.abortSignal.removeEventListener("abort", abort);
    }
  },
};

export const WebSearchTool: AgentTool = {
  name: "WebSearch",
  description:
    "Search the web using a lightweight public search endpoint and return result titles, URLs, and snippets.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "Only include these domains.",
      },
      blocked_domains: {
        type: "array",
        items: { type: "string" },
        description: "Exclude these domains.",
      },
    },
    required: ["query"],
  },
  readOnly: true,
  concurrencySafe: true,
  async execute(input, context) {
    const query = asString(input.query);
    const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const abort = () => controller.abort();
    context.abortSignal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(searchUrl, {
        signal: controller.signal,
        headers: {
          "user-agent": "agent-core/0.1",
          accept: "text/html",
        },
      });
      const html = await response.text();
      const allowed = toStringArray(input.allowed_domains);
      const blocked = toStringArray(input.blocked_domains);
      const results = parseDuckDuckGo(html)
        .filter((result) => domainAllowed(result.url, allowed, blocked))
        .slice(0, 8);
      return {
        content: results.length
          ? results
              .map(
                (result, index) =>
                  `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`,
              )
              .join("\n\n")
          : `No web search results returned for ${JSON.stringify(query)}.`,
        isError: !response.ok,
      };
    } catch (error) {
      return {
        content: `Failed web search for ${query}: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    } finally {
      clearTimeout(timeout);
      context.abortSignal.removeEventListener("abort", abort);
    }
  },
};

function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function parseDuckDuckGo(html: string): Array<{
  title: string;
  url: string;
  snippet: string;
}> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/<div class="result/gi).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    results.push({
      title: htmlToText(link[2] ?? ""),
      url: cleanDuckUrl(decodeHtml(link[1] ?? "")),
      snippet: snippet ? htmlToText(snippet[1] ?? "") : "",
    });
  }
  return results;
}

function cleanDuckUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.toString();
  } catch {
    return url;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).toLowerCase())
    : [];
}

function domainAllowed(url: string, allowed: string[], blocked: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (blocked.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      return false;
    }
    if (!allowed.length) return true;
    return allowed.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return true;
  }
}
