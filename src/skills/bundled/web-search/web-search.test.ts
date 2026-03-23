import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock global fetch before importing the module under test
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Must import *after* vi.mock so the mock is in place.
const { tools } = await import("./index.js");

const dummyContext = {} as Parameters<(typeof tools)[0]["execute"]>[1];

function findTool(name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// web_fetch_url
// ---------------------------------------------------------------------------

describe("web_fetch_url", () => {
  const tool = findTool("web_fetch_url");

  it("fetches URL and returns text content", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve("Hello, World!"),
    });

    const result = await tool.execute({ url: "https://example.com" }, dummyContext);
    expect(result.content).toBe("Hello, World!");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        headers: { "User-Agent": "StradaBrain/1.0" },
      }),
    );
  });

  it("truncates content longer than 8000 characters", async () => {
    const longContent = "x".repeat(10_000);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(longContent),
    });

    const result = await tool.execute({ url: "https://example.com/long" }, dummyContext);
    expect(result.content).toContain("[Truncated");
    expect(result.content).toContain("10000 chars total");
    // First 8000 chars should be present
    expect(result.content.startsWith("x".repeat(8000))).toBe(true);
  });

  it("rejects URLs without http/https scheme", async () => {
    const result1 = await tool.execute({ url: "file:///etc/passwd" }, dummyContext);
    expect(result1.content).toContain("Error");
    expect(result1.content).toContain("http://");

    const result2 = await tool.execute({ url: "data:text/html,<h1>test</h1>" }, dummyContext);
    expect(result2.content).toContain("Error");

    const result3 = await tool.execute({ url: "javascript:alert(1)" }, dummyContext);
    expect(result3.content).toContain("Error");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects empty or missing URL", async () => {
    const result1 = await tool.execute({}, dummyContext);
    expect(result1.content).toContain("Error");
    expect(result1.content).toContain("required");

    const result2 = await tool.execute({ url: "" }, dummyContext);
    expect(result2.content).toContain("Error");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns error on HTTP failure status", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: () => Promise.resolve(""),
    });

    const result = await tool.execute({ url: "https://example.com/missing" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("404");
  });

  it("returns timeout error when fetch is aborted", async () => {
    mockFetch.mockRejectedValue(new Error("The operation was aborted"));

    const result = await tool.execute({ url: "https://slow.example.com" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("timed out");
  });

  it("returns error on network failure", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await tool.execute({ url: "https://unreachable.example.com" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("ECONNREFUSED");
  });

  it("accepts http:// URLs", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve("plain http"),
    });

    const result = await tool.execute({ url: "http://example.com" }, dummyContext);
    expect(result.content).toBe("plain http");
  });
});

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

describe("web_search", () => {
  const tool = findTool("web_search");

  it("returns parsed search results from DuckDuckGo HTML", async () => {
    const fakeHtml = `
      <div class="result">
        <a class="result__snippet" href="#">First result snippet</a>
      </div>
      <div class="result">
        <a class="result__snippet" href="#">Second result snippet</a>
      </div>
      <div class="result">
        <a class="result__snippet" href="#">Third result snippet</a>
      </div>
    `;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(fakeHtml),
    });

    const result = await tool.execute({ query: "typescript tutorial" }, dummyContext);
    expect(result.content).toContain("Search results for");
    expect(result.content).toContain("1. First result snippet");
    expect(result.content).toContain("2. Second result snippet");
    expect(result.content).toContain("3. Third result snippet");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("duckduckgo.com"),
      expect.anything(),
    );
  });

  it("falls back to result titles when no snippets found", async () => {
    const fakeHtml = `
      <div class="result">
        <a class="result__a" href="#">Title One</a>
      </div>
      <div class="result">
        <a class="result__a" href="#">Title Two</a>
      </div>
    `;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(fakeHtml),
    });

    const result = await tool.execute({ query: "test query" }, dummyContext);
    expect(result.content).toContain("1. Title One");
    expect(result.content).toContain("2. Title Two");
  });

  it("returns no results message when HTML has no matches", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve("<html><body>No results</body></html>"),
    });

    const result = await tool.execute({ query: "asdfqwertyuiop" }, dummyContext);
    expect(result.content).toBe("No results found.");
  });

  it("limits results to 5", async () => {
    let fakeHtml = "";
    for (let i = 1; i <= 10; i++) {
      fakeHtml += `<a class="result__snippet" href="#">Result ${i}</a>\n`;
    }
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(fakeHtml),
    });

    const result = await tool.execute({ query: "many results" }, dummyContext);
    expect(result.content).toContain("5. Result 5");
    expect(result.content).not.toContain("6.");
  });

  it("rejects empty query", async () => {
    const result1 = await tool.execute({}, dummyContext);
    expect(result1.content).toContain("Error");
    expect(result1.content).toContain("required");

    const result2 = await tool.execute({ query: "   " }, dummyContext);
    expect(result2.content).toContain("Error");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("encodes query parameters in the URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve("<html></html>"),
    });

    await tool.execute({ query: "hello world & more" }, dummyContext);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("q=hello%20world%20%26%20more");
  });

  it("returns error on search request failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: () => Promise.resolve(""),
    });

    const result = await tool.execute({ query: "test" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("503");
  });

  it("returns timeout error when search fetch is aborted", async () => {
    mockFetch.mockRejectedValue(new Error("The operation was aborted"));

    const result = await tool.execute({ query: "timeout test" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("timed out");
  });

  it("strips HTML tags from snippets", async () => {
    const fakeHtml = `<a class="result__snippet" href="#">This is <b>bold</b> and <em>italic</em> text</a>`;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(fakeHtml),
    });

    const result = await tool.execute({ query: "html strip" }, dummyContext);
    expect(result.content).toContain("This is bold and italic text");
    expect(result.content).not.toContain("<b>");
    expect(result.content).not.toContain("<em>");
  });
});
