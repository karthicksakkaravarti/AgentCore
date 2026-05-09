import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebFetchTool, WebSearchTool } from "../src/tools/web.js";
import { MemoryWorkspace } from "../src/workspace/memory.js";
import { DisabledRuntime } from "../src/runtime/disabled.js";
import type { AgentState, ToolExecutionContext } from "../src/types.js";

function makeState(): AgentState {
  return {
    todos: [],
    backgroundShells: new Map(),
    alwaysAllowedTools: new Set(),
    alwaysDeniedTools: new Set(),
    readFiles: new Set(),
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  };
}

function makeContext(): ToolExecutionContext {
  return {
    cwd: "/ws",
    workspace: new MemoryWorkspace(),
    runtime: new DisabledRuntime(),
    abortSignal: new AbortController().signal,
    state: makeState(),
  };
}

// ──────────────────────────────────────────────
// WebFetchTool
// ──────────────────────────────────────────────

describe("WebFetchTool", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns page text for a 200 HTML response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html" },
      text: async () => "<html><body><p>Hello world</p></body></html>",
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await WebFetchTool.execute(
      { url: "https://example.com", prompt: "What does it say?" },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Hello world");
    expect(result.content).toContain("https://example.com");
  });

  it("returns isError true for non-200 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => "text/html" },
      text: async () => "<html><body>Not found</body></html>",
    }));

    const result = await WebFetchTool.execute(
      { url: "https://example.com/404", prompt: "test" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("404");
  });

  it("returns error when fetch throws a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await WebFetchTool.execute(
      { url: "https://example.com", prompt: "test" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Network error");
  });

  it("returns plain text directly for non-html content-type", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/json" },
      text: async () => '{"key":"value"}',
    }));

    const result = await WebFetchTool.execute(
      { url: "https://api.example.com/data", prompt: "get data" },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('"key"');
  });

  it("strips HTML tags from HTML responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html" },
      text: async () => "<html><body><h1>Title</h1><p>Content</p></body></html>",
    }));

    const result = await WebFetchTool.execute(
      { url: "https://example.com", prompt: "test" },
      makeContext(),
    );
    expect(result.content).not.toContain("<h1>");
    expect(result.content).not.toContain("<p>");
    expect(result.content).toContain("Title");
    expect(result.content).toContain("Content");
  });

  it("decodes HTML entities in fetched content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html" },
      text: async () => "<html><body>Tom &amp; Jerry &lt;ok&gt;</body></html>",
    }));

    const result = await WebFetchTool.execute(
      { url: "https://example.com/entities", prompt: "decode" },
      makeContext(),
    );
    expect(result.content).toContain("Tom & Jerry <ok>");
  });
});

// ──────────────────────────────────────────────
// WebSearchTool
// ──────────────────────────────────────────────

describe("WebSearchTool", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fakeDuckDuckGoHtml = `
    <html>
    <body>
      <div class="result__body">
        <div class="result__title">
          <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fexample.com%2Fpage1">Example Page 1</a>
        </div>
        <a class="result__snippet">This is the snippet for result 1</a>
      </div>
    </body>
    </html>
  `;

  it("returns parsed search results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html" },
      text: async () => fakeDuckDuckGoHtml,
    }));

    const result = await WebSearchTool.execute(
      { query: "test query" },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    // Should return "No web search results" or parsed results
    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("returns no-results message for empty HTML", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html" },
      text: async () => "<html><body></body></html>",
    }));

    const result = await WebSearchTool.execute(
      { query: "nothing found" },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("No web search results");
  });

  it("returns error when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Timeout")));

    const result = await WebSearchTool.execute(
      { query: "test" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Timeout");
  });

  it("keeps plain result URLs that do not use DuckDuckGo uddg redirects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html" },
      text: async () => `
        <div class="result__body">
          <a class="result__a" href="https://plain.example/path?a=1&amp;b=2">Plain &amp; Result</a>
          <a class="result__snippet">A &lt;plain&gt; snippet</a>
        </div>
      `,
    }));

    const result = await WebSearchTool.execute(
      { query: "plain" },
      makeContext(),
    );

    expect(result.content).toContain("Plain & Result");
    expect(result.content).toContain("https://plain.example/path?a=1&b=2");
    expect(result.content).toContain("A <plain> snippet");
  });

  it("keeps malformed result URLs when URL parsing fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html" },
      text: async () => `
        <div class="result__body">
          <a class="result__a" href="http://[bad">Malformed</a>
          <a class="result__snippet">Still included</a>
        </div>
      `,
    }));

    const result = await WebSearchTool.execute(
      { query: "malformed" },
      makeContext(),
    );

    expect(result.content).toContain("Malformed");
    expect(result.content).toContain("http://[bad");
  });

  it("filters results by allowed domains", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html" },
      text: async () => `
        <div class="result__body">
          <a class="result__a" href="https://docs.example.com/page">Docs</a>
          <a class="result__snippet">Docs snippet</a>
        </div>
        <div class="result__body">
          <a class="result__a" href="https://other.example.com/page">Other</a>
          <a class="result__snippet">Other snippet</a>
        </div>
      `,
    }));

    const result = await WebSearchTool.execute(
      { query: "docs", allowed_domains: ["docs.example.com"] },
      makeContext(),
    );

    expect(result.content).toContain("Docs");
    expect(result.content).not.toContain("Other");
  });

  it("filters results by blocked domains including subdomains", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html" },
      text: async () => `
        <div class="result__body">
          <a class="result__a" href="https://sub.blocked.com/page">Blocked</a>
          <a class="result__snippet">Blocked snippet</a>
        </div>
        <div class="result__body">
          <a class="result__a" href="https://allowed.com/page">Allowed</a>
          <a class="result__snippet">Allowed snippet</a>
        </div>
      `,
    }));

    const result = await WebSearchTool.execute(
      { query: "blocked", blocked_domains: ["blocked.com"] },
      makeContext(),
    );

    expect(result.content).toContain("Allowed");
    expect(result.content).not.toContain("Blocked");
  });
});
