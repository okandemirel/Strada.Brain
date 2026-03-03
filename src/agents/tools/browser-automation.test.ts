import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { BrowserAutomationTool } from "./browser-automation.js";
import type { ToolContext } from "./tool.interface.js";
import { createLogger } from "../../utils/logger.js";

// Initialize logger for tests
createLogger("error", "/tmp/strata-test.log");

const TEST_PORT = 8765;

// Simple HTML server for testing
async function startTestServer(): Promise<{ stop: () => void; url: string }> {
  const http = await import("node:http");
  
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    
    if (url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>Test Page</title></head>
          <body>
            <h1>Hello World</h1>
            <input type="text" id="search" />
            <button id="submit">Submit</button>
            <select id="select">
              <option value="a">Option A</option>
              <option value="b">Option B</option>
            </select>
            <div id="result"></div>
            <script>
              document.getElementById('submit').addEventListener('click', () => {
                document.getElementById('result').textContent = 'Clicked!';
              });
            </script>
          </body>
        </html>
      `);
    } else if (url === "/api/data") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Hello from API", status: "ok" }));
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

describe("BrowserAutomationTool", () => {
  let tool: BrowserAutomationTool;
  let server: { stop: () => void; url: string };
  let context: ToolContext;

  beforeAll(async () => {
    server = await startTestServer();
    context = {
      projectPath: "/tmp/test",
      workingDirectory: "/tmp/test",
      readOnly: false,
    };
  }, 30000);

  afterAll(async () => {
    server.stop();
    await tool?.dispose();
  }, 30000);

  beforeEach(() => {
    tool = new BrowserAutomationTool();
  });

  describe("schema", () => {
    it("should have correct name", () => {
      expect(tool.name).toBe("browser_automation");
    });

    it("should have input schema defined", () => {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toHaveProperty("action");
    });
  });

  describe("security", () => {
    it("should block localhost URLs", async () => {
      const result = await tool.execute(
        { action: "navigate", url: "http://localhost:8080/test" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Localhost");
    });

    it("should block file:// URLs", async () => {
      const result = await tool.execute(
        { action: "navigate", url: "file:///etc/passwd" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("file://");
    });

    it("should block javascript:// URLs", async () => {
      const result = await tool.execute(
        { action: "navigate", url: "javascript:alert(1)" },
        context
      );
      expect(result.isError).toBe(true);
    });

    it("should block private IP ranges", async () => {
      const result = await tool.execute(
        { action: "navigate", url: "http://192.168.1.1/admin" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Private IP");
    });

    it("should block URLs matching blocked patterns", async () => {
      const result = await tool.execute(
        { action: "navigate", url: "https://example.com/admin" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("blocked pattern");
    });
  });

  describe("actions without navigation", () => {
    it("should require URL for navigate action", async () => {
      const result = await tool.execute({ action: "navigate" }, context);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("URL is required");
    });

    it("should require selector for click action", async () => {
      const result = await tool.execute({ action: "click" }, context);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Selector is required");
    });

    it("should require selector for type action", async () => {
      const result = await tool.execute({ action: "type", text: "hello" }, context);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Selector is required");
    });

    it("should require text for type action", async () => {
      const result = await tool.execute({ action: "type", selector: "#input" }, context);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Text is required");
    });

    it("should return error when no session exists", async () => {
      const result = await tool.execute(
        { action: "click", selector: "#button" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("No active browser session");
    });
  });

  describe("input validation", () => {
    it("should reject invalid URLs", async () => {
      const result = await tool.execute(
        { action: "navigate", url: "not-a-valid-url" },
        context
      );
      expect(result.isError).toBe(true);
    });

    it("should reject unknown actions", async () => {
      const result = await tool.execute(
        { action: "unknown_action" as never },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unknown action");
    });
  });
});

describe("BrowserAutomationTool with server", () => {
  let tool: BrowserAutomationTool;
  let server: { stop: () => void; url: string } | null = null;
  let context: ToolContext;

  // Skip these tests if we can't start the server
  const itIfServer = server ? it : it.skip;

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

  afterAll(async () => {
    server?.stop();
    await tool?.dispose();
  }, 30000);

  beforeEach(() => {
    tool = new BrowserAutomationTool();
  });

  itIfServer("should navigate to external URLs", async () => {
    // Test with example.com (reliable test site)
    const result = await tool.execute(
      { action: "navigate", url: "https://example.com" },
      context
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("example.com");
  }, 30000);

  itIfServer("should get page content", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      context
    );

    const result = await tool.execute(
      { action: "get_content" },
      context
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Example Domain");
  }, 30000);

  itIfServer("should evaluate JavaScript", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      context
    );

    const result = await tool.execute(
      { action: "evaluate", script: "document.title" },
      context
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Example Domain");
  }, 30000);

  itIfServer("should block dangerous JavaScript", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      context
    );

    const result = await tool.execute(
      { action: "evaluate", script: "eval('alert(1)')" },
      context
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked patterns");
  }, 30000);

  itIfServer("should take screenshots", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      context
    );

    const result = await tool.execute(
      { action: "screenshot" },
      context
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Screenshot saved");
    expect(result.metadata).toHaveProperty("path");
  }, 30000);
});
