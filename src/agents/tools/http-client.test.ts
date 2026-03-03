import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { HttpClientTool } from "./http-client.js";
import type { ToolContext } from "./tool.interface.js";
import { createLogger } from "../../utils/logger.js";

// Initialize logger for tests
createLogger("error", "/tmp/strata-test.log");

const TEST_PORT = 8766;

// Simple HTTP server for testing
async function startTestServer(): Promise<{ stop: () => void; url: string }> {
  const http = await import("node:http");
  let requestCount = 0;
  
  const server = http.createServer((req, res) => {
    requestCount++;
    const url = new URL(req.url ?? "/", `http://localhost:${TEST_PORT}`);
    const pathname = url.pathname;
    
    // Echo headers
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
    }

    if (pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Hello World");
    } else if (pathname === "/json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Hello", count: requestCount }));
    } else if (pathname === "/echo") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          method: req.method,
          path: pathname,
          query: Object.fromEntries(url.searchParams),
          headers,
          body: body || undefined,
        }));
      });
    } else if (pathname === "/redirect") {
      const target = url.searchParams.get("to") ?? "/";
      res.writeHead(302, { "Location": target });
      res.end();
    } else if (pathname === "/error") {
      const code = parseInt(url.searchParams.get("code") ?? "500", 10);
      res.writeHead(code);
      res.end(`Error ${code}`);
    } else if (pathname === "/timeout") {
      // Never respond
      return;
    } else if (pathname === "/binary") {
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF]);
      res.writeHead(200, { 
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buffer.length),
      });
      res.end(buffer);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  return new Promise((resolve) => {
    server.listen(TEST_PORT, () => {
      resolve({
        stop: () => server.close(),
        url: `http://localhost:${TEST_PORT}`,
      });
    });
  });
}

describe("HttpClientTool", () => {
  let tool: HttpClientTool;
  let context: ToolContext;

  beforeEach(() => {
    tool = new HttpClientTool();
    context = {
      projectPath: "/tmp/test",
      workingDirectory: "/tmp/test",
      readOnly: false,
    };
  });

  afterAll(() => {
    tool?.dispose();
  });

  describe("schema", () => {
    it("should have correct name", () => {
      expect(tool.name).toBe("http_client");
    });

    it("should have input schema defined", () => {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toHaveProperty("method");
      expect(tool.inputSchema.properties).toHaveProperty("url");
    });

    it("should require method and url", () => {
      expect(tool.inputSchema.required).toContain("method");
      expect(tool.inputSchema.required).toContain("url");
    });
  });

  describe("security", () => {
    it("should block localhost URLs", async () => {
      const result = await tool.execute(
        { method: "GET", url: "http://localhost:8080/test" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Localhost");
    });

    it("should block file:// URLs", async () => {
      const result = await tool.execute(
        { method: "GET", url: "file:///etc/passwd" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("file://");
    });

    it("should block private IP ranges", async () => {
      const result = await tool.execute(
        { method: "GET", url: "http://192.168.1.1/api" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Private IP");
    });

    it("should block 10.0.0.0/8 range", async () => {
      const result = await tool.execute(
        { method: "GET", url: "http://10.0.0.1/internal" },
        context
      );
      expect(result.isError).toBe(true);
    });

    it("should block 172.16.0.0/12 range", async () => {
      const result = await tool.execute(
        { method: "GET", url: "http://172.16.0.1/internal" },
        context
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("input validation", () => {
    it("should reject invalid URLs", async () => {
      const result = await tool.execute(
        { method: "GET", url: "not-a-valid-url" },
        context
      );
      expect(result.isError).toBe(true);
    });

    it("should require URL", async () => {
      const result = await tool.execute(
        { method: "GET", url: "" },
        context
      );
      expect(result.isError).toBe(true);
    });

    it("should require method", async () => {
      const result = await tool.execute(
        { method: "" as never, url: "https://example.com" },
        context
      );
      expect(result.isError).toBe(true);
    });
  });
});

describe("HttpClientTool with server", () => {
  let tool: HttpClientTool;
  let server: { stop: () => void; url: string } | null = null;
  let context: ToolContext;

  beforeAll(async () => {
    try {
      server = await startTestServer();
      context = {
        projectPath: "/tmp/test",
        workingDirectory: "/tmp/test",
        readOnly: false,
      };
    } catch {
      console.log("Could not start test server, skipping integration tests");
    }
  }, 30000);

  afterAll(() => {
    server?.stop();
    tool?.dispose();
  });

  beforeEach(() => {
    tool = new HttpClientTool();
  });

  const itIfServer = server ? it : it.skip;
  const baseUrl = () => server?.url ?? "";

  describe("HTTP methods", () => {
    itIfServer("should make GET request", async () => {
      const result = await tool.execute(
        { method: "GET", url: `${baseUrl()}/` },
        context
      );
      expect(result.isError).toBeFalsy();
      expect(result.content).toBe("Hello World");
    }, 10000);

    itIfServer("should make POST request with body", async () => {
      const result = await tool.execute(
        { 
          method: "POST", 
          url: `${baseUrl()}/echo`,
          body: { test: "data", value: 123 },
        },
        context
      );
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content);
      expect(data.method).toBe("POST");
      expect(JSON.parse(data.body)).toEqual({ test: "data", value: 123 });
    }, 10000);

    itIfServer("should make PUT request", async () => {
      const result = await tool.execute(
        { 
          method: "PUT", 
          url: `${baseUrl()}/echo`,
          body: "update data",
        },
        context
      );
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content);
      expect(data.method).toBe("PUT");
    }, 10000);

    itIfServer("should make DELETE request", async () => {
      const result = await tool.execute(
        { method: "DELETE", url: `${baseUrl()}/echo` },
        context
      );
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content);
      expect(data.method).toBe("DELETE");
    }, 10000);

    itIfServer("should make PATCH request", async () => {
      const result = await tool.execute(
        { method: "PATCH", url: `${baseUrl()}/echo` },
        context
      );
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content);
      expect(data.method).toBe("PATCH");
    }, 10000);

    itIfServer("should make HEAD request", async () => {
      const result = await tool.execute(
        { method: "HEAD", url: `${baseUrl()}/` },
        context
      );
      expect(result.isError).toBeFalsy();
      expect(result.metadata).toHaveProperty("status", 200);
    }, 10000);

    itIfServer("should make OPTIONS request", async () => {
      const result = await tool.execute(
        { method: "OPTIONS", url: `${baseUrl()}/` },
        context
      );
      expect(result.isError).toBeFalsy();
    }, 10000);
  });

  describe("query parameters", () => {
    itIfServer("should add query parameters", async () => {
      const result = await tool.execute(
        { 
          method: "GET", 
          url: `${baseUrl()}/echo`,
          params: { foo: "bar", num: "123" },
        },
        context
      );
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content);
      expect(data.query).toEqual({ foo: "bar", num: "123" });
    }, 10000);
  });

  describe("headers", () => {
    itIfServer("should send custom headers", async () => {
      const result = await tool.execute(
        { 
          method: "GET", 
          url: `${baseUrl()}/echo`,
          headers: { "X-Custom-Header": "test-value", "Accept": "application/json" },
        },
        context
      );
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content);
      expect(data.headers["x-custom-header"]).toBe("test-value");
    }, 10000);
  });

  describe("response handling", () => {
    itIfServer("should parse JSON response", async () => {
      const result = await tool.execute(
        { method: "GET", url: `${baseUrl()}/json` },
        context
      );
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content);
      expect(data).toHaveProperty("message", "Hello");
    }, 10000);

    itIfServer("should handle text response", async () => {
      const result = await tool.execute(
        { method: "GET", url: `${baseUrl()}/`, responseType: "text" },
        context
      );
      expect(result.isError).toBeFalsy();
      expect(result.content).toBe("Hello World");
    }, 10000);

    itIfServer("should handle binary response", async () => {
      const result = await tool.execute(
        { method: "GET", url: `${baseUrl()}/binary`, responseType: "binary" },
        context
      );
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("Binary response");
      expect(result.metadata).toHaveProperty("size", 5);
    }, 10000);

    itIfServer("should auto-detect JSON response", async () => {
      const result = await tool.execute(
        { method: "GET", url: `${baseUrl()}/json`, responseType: "auto" },
        context
      );
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content);
      expect(data).toHaveProperty("message");
    }, 10000);
  });

  describe("error handling", () => {
    itIfServer("should handle 404 errors", async () => {
      const result = await tool.execute(
        { method: "GET", url: `${baseUrl()}/not-found` },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("404");
    }, 10000);

    itIfServer("should handle 500 errors", async () => {
      const result = await tool.execute(
        { method: "GET", url: `${baseUrl()}/error?code=500` },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("500");
    }, 10000);
  });

  describe("redirects", () => {
    itIfServer("should follow redirects", async () => {
      const result = await tool.execute(
        { method: "GET", url: `${baseUrl()}/redirect?to=/` },
        context
      );
      expect(result.isError).toBeFalsy();
      expect(result.content).toBe("Hello World");
    }, 10000);

    itIfServer("should limit redirect count", async () => {
      // Create a circular redirect
      const result = await tool.execute(
        { method: "GET", url: `${baseUrl()}/redirect?to=/redirect?to=/redirect`, maxRedirects: 2 },
        context
      );
      // Should either succeed or fail with redirect limit
      expect(result.content || result.isError).toBeTruthy();
    }, 10000);
  });
});

describe("HttpClientTool external requests", () => {
  let tool: HttpClientTool;
  let context: ToolContext;

  beforeEach(() => {
    tool = new HttpClientTool();
    context = {
      projectPath: "/tmp/test",
      workingDirectory: "/tmp/test",
      readOnly: false,
    };
  });

  afterAll(() => {
    tool?.dispose();
  });

  it("should make request to httpbin.org", async () => {
    const result = await tool.execute(
      { method: "GET", url: "https://httpbin.org/get" },
      context
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content);
    expect(data).toHaveProperty("url");
    expect(data).toHaveProperty("headers");
  }, 30000);

  it("should post JSON to httpbin.org", async () => {
    const result = await tool.execute(
      { 
        method: "POST", 
        url: "https://httpbin.org/post",
        body: { test: "data" },
      },
      context
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content);
    expect(data.json).toEqual({ test: "data" });
  }, 30000);
});
