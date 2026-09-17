import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks. web_search uses the global fetch; web_fetch_url goes through the npm
// undici fetch with a pinned dispatcher (plan 0-B.6 / 13F1 / D63), so both are
// pointed at the same mockFetch. DNS is mocked so the resolved-target policy is
// exercised without the network.
// ---------------------------------------------------------------------------

const { mockFetch, mockLookup, agentInstances } = vi.hoisted(() => {
  const agentInstances: Array<{ options: unknown; closed: boolean }> = [];
  return {
    mockFetch: vi.fn(),
    mockLookup: vi.fn(),
    agentInstances,
  };
});

vi.mock("undici", () => {
  class Agent {
    readonly options: unknown;
    closed = false;
    constructor(options: unknown) {
      this.options = options;
      agentInstances.push(this);
    }
    async close(): Promise<void> {
      this.closed = true;
    }
  }
  return { Agent, fetch: mockFetch };
});

vi.mock("node:dns/promises", () => ({
  lookup: mockLookup,
  default: { lookup: mockLookup },
}));

vi.stubGlobal("fetch", mockFetch);

// Must import *after* vi.mock so the mock is in place.
const { tools } = await import("./index.js");

const PUBLIC_V4 = "93.184.216.34";

/** DNS table: hostname -> addresses (a function may return different answers per call). */
const dnsTable = new Map<string, Array<{ address: string; family: number }> | (() => Array<{ address: string; family: number }>)>();

function setDns(hostname: string, addresses: Array<{ address: string; family: number }> | (() => Array<{ address: string; family: number }>)): void {
  dnsTable.set(hostname, addresses);
}

function redirectResponse(status: number, location: string) {
  return {
    ok: false,
    status,
    statusText: "Redirect",
    headers: new Headers({ location }),
    body: { cancel: () => Promise.resolve() },
    text: () => Promise.resolve(""),
  };
}

function okResponse(text: string) {
  return { ok: true, status: 200, statusText: "OK", headers: new Headers(), text: () => Promise.resolve(text) };
}

const dummyContext = {} as Parameters<(typeof tools)[0]["execute"]>[1];

function findTool(name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockLookup.mockReset();
  agentInstances.length = 0;
  dnsTable.clear();
  // Every host used by the legacy tests below is public unless a test says otherwise.
  mockLookup.mockImplementation(async (hostname: string) => {
    const entry = dnsTable.get(hostname);
    if (entry) return typeof entry === "function" ? entry() : entry;
    return [{ address: PUBLIC_V4, family: 4 }];
  });
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

  // ── Plan 0-B.6 (audit 13F1 / D63 + Codex #12): resolved-target SSRF policy ──
  describe("resolved-target policy (plan 0-B.6 / 13F1 / D63)", () => {
    it("refuses a public-looking hostname that resolves to a private address, without fetching", async () => {
      setDns("public-looking.example", [{ address: "10.0.0.1", family: 4 }]);
      const result = await tool.execute({ url: "https://public-looking.example/secret" }, dummyContext);
      expect(result.content).toContain("Error");
      expect(result.content).toContain("blocked");
      expect(result.content).toContain("10.0.0.1");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([
      ["127.0.0.1", "loopback"],
      ["169.254.169.254", "link-local"],
      ["fd00::1", "unique-local"],
      ["::ffff:192.168.1.1", "private"],
    ])("refuses a hostname resolving to %s (%s)", async (address, reason) => {
      setDns("meta.example", [{ address, family: address.includes(":") ? 6 : 4 }]);
      const result = await tool.execute({ url: "http://meta.example/latest/meta-data/" }, dummyContext);
      expect(result.content).toContain("Error");
      expect(result.content).toContain(reason);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refuses when ANY resolved address is forbidden (dual-stack with one private)", async () => {
      setDns("dual.example", [
        { address: PUBLIC_V4, family: 4 },
        { address: "fe80::1", family: 6 },
      ]);
      const result = await tool.execute({ url: "https://dual.example/" }, dummyContext);
      expect(result.content).toContain("Error");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://0xa9.0xfe.0xa9.0xfe/",
      "http://169.254.169.254/",
      "http://[fd00::1]/",
      "http://100.64.0.1/",
      "http://0/",
    ])("refuses IP literal spelling %s without DNS and without fetching", async (url) => {
      const result = await tool.execute({ url }, dummyContext);
      expect(result.content).toContain("Error");
      expect(result.content).toContain("blocked");
      expect(mockLookup).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refuses an unresolvable hostname (fail closed)", async () => {
      mockLookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
      const result = await tool.execute({ url: "https://nxdomain.example/" }, dummyContext);
      expect(result.content).toContain("Error");
      expect(result.content).toContain("could not be resolved");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("re-resolves immediately before the request: DNS rebinding public->private is refused on the second call", async () => {
      let n = 0;
      setDns("rebind.example", () => (n++ === 0 ? [{ address: PUBLIC_V4, family: 4 }] : [{ address: "127.0.0.1", family: 4 }]));
      mockFetch.mockResolvedValue(okResponse("first"));

      const first = await tool.execute({ url: "https://rebind.example/" }, dummyContext);
      expect(first.content).toBe("first");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const second = await tool.execute({ url: "https://rebind.example/" }, dummyContext);
      expect(second.content).toContain("Error");
      expect(second.content).toContain("127.0.0.1");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("follows redirects manually and refuses a public->private redirect at the hop", async () => {
      setDns("internal.corp", [{ address: "10.1.2.3", family: 4 }]);
      mockFetch.mockResolvedValueOnce(redirectResponse(302, "http://internal.corp/admin-api"));
      mockFetch.mockResolvedValueOnce(okResponse("SHOULD NOT BE FETCHED"));

      const result = await tool.execute({ url: "https://example.com/start" }, dummyContext);
      expect(result.content).toContain("Error");
      expect(result.content).toContain("10.1.2.3");
      expect(result.content).not.toContain("SHOULD NOT BE FETCHED");
      // Only the first hop was requested; the Location was refused before any fetch.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: "manual" }));
    });

    it("refuses a redirect to an IP-literal internal address (relative Location resolved against the hop)", async () => {
      mockFetch.mockResolvedValueOnce(redirectResponse(301, "http://169.254.169.254/latest/meta-data/"));
      const result = await tool.execute({ url: "https://example.com/start" }, dummyContext);
      expect(result.content).toContain("Error");
      expect(result.content).toContain("169.254.169.254");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("follows a public->public redirect chain and returns the final body", async () => {
      setDns("cdn.example", [{ address: "151.101.1.1", family: 4 }]);
      mockFetch.mockResolvedValueOnce(redirectResponse(302, "/moved"));
      mockFetch.mockResolvedValueOnce(redirectResponse(307, "https://cdn.example/final"));
      mockFetch.mockResolvedValueOnce(okResponse("final body"));

      const result = await tool.execute({ url: "https://example.com/start" }, dummyContext);
      expect(result.content).toBe("final body");
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[1]?.[0]).toBe("https://example.com/moved");
      expect(mockFetch.mock.calls[2]?.[0]).toBe("https://cdn.example/final");
      // Every hop was resolved (checked) before its request.
      expect(mockLookup).toHaveBeenCalledTimes(3);
      expect(mockLookup.mock.calls.map((c) => c[0])).toEqual(["example.com", "example.com", "cdn.example"]);
    });

    it("stops after the redirect hop bound", async () => {
      mockFetch.mockResolvedValue(redirectResponse(302, "https://example.com/loop"));
      const result = await tool.execute({ url: "https://example.com/start" }, dummyContext);
      expect(result.content).toContain("Error");
      expect(result.content).toContain("Too many redirects");
      expect(mockFetch).toHaveBeenCalledTimes(6); // initial + 5 hops
    });

    it("pins the connection to the vetted addresses via a per-hop undici Agent with a custom lookup", async () => {
      setDns("example.com", [{ address: PUBLIC_V4, family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]);
      mockFetch.mockResolvedValue(okResponse("pinned"));

      await tool.execute({ url: "https://example.com/" }, dummyContext);

      expect(agentInstances).toHaveLength(1);
      const agent = agentInstances[0]!;
      expect(mockFetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ dispatcher: agent }));
      const lookup = (agent.options as { connect: { lookup: (h: string, o: Record<string, unknown>, cb: (...a: unknown[]) => void) => void } }).connect.lookup;
      expect(typeof lookup).toBe("function");

      // all:true (happy eyeballs) -> the vetted list, nothing else.
      const all = await new Promise<unknown[]>((resolve) => lookup("example.com", { all: true }, (...a) => resolve(a)));
      expect(all[0]).toBeNull();
      expect(all[1]).toEqual([
        { address: PUBLIC_V4, family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]);
      // single-address form
      const one = await new Promise<unknown[]>((resolve) => lookup("example.com", { family: 4 }, (...a) => resolve(a)));
      expect(one).toEqual([null, PUBLIC_V4, 4]);
      // Any other hostname (nothing vetted for it) is refused at connect time.
      const other = await new Promise<unknown[]>((resolve) => lookup("evil.example", { all: true }, (...a) => resolve(a)));
      expect(other[0]).toBeInstanceOf(Error);
      // The agent is closed once the body has been read.
      expect(agent.closed).toBe(true);
    });
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
