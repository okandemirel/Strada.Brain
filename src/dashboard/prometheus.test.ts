import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { register } from "prom-client";
import { PrometheusMetrics } from "./prometheus.js";
import { MetricsCollector } from "./metrics.js";

// Mock logger
vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe.skipIf(!process.env["LOCAL_SERVER_TESTS"])("PrometheusMetrics", () => {
  let prometheus: PrometheusMetrics;
  let metrics: MetricsCollector;

  function getPort(instance: PrometheusMetrics): number {
    const addr = (
      instance as unknown as { server: { address: () => { port: number } | string | null } }
    ).server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Prometheus server has no bound address");
    }
    return addr.port;
  }

  async function safeStart(instance: PrometheusMetrics): Promise<number | null> {
    try {
      await instance.start();
      return getPort(instance);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        console.warn("Skipping: EPERM on prometheus.start()");
        return null;
      }
      throw err;
    }
  }

  beforeEach(() => {
    // Clear registry before each test
    register.clear();
    
    metrics = new MetricsCollector();
    prometheus = new PrometheusMetrics(
      0,
      metrics,
      () => ({ totalEntries: 100, hasAnalysisCache: true }),
      () => ({ loaded: 5, directories: ["./plugins"] })
    );
  });

  afterEach(async () => {
    await prometheus.stop();
    register.clear();
  });

  it("should start and stop the server", async () => {
    const port = await safeStart(prometheus);
    if (port === null) return;

    const response = await fetch(`http://localhost:${port}/health`);
    expect(response.status).toBe(200);
    
    const body = await response.json();
    expect(body).toMatchObject({
      status: "ok",
      prometheus: true,
      metricsEndpoint: "/metrics"
    });
  });

  it("should expose metrics endpoint", async () => {
    const port = await safeStart(prometheus);
    if (port === null) return;

    const response = await fetch(`http://localhost:${port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    
    const metricsText = await response.text();
    
    // Check for custom metrics
    expect(metricsText).toContain("strada_messages_total");
    expect(metricsText).toContain("strada_tool_calls_total");
    expect(metricsText).toContain("strada_tokens_total");
    expect(metricsText).toContain("strada_active_sessions");
    expect(metricsText).toContain("strada_memory_usage_bytes");
    expect(metricsText).toContain("strada_plugins_loaded");
    expect(metricsText).toContain("strada_request_duration_seconds");
    expect(metricsText).toContain("strada_tool_duration_seconds");
    expect(metricsText).toContain("strada_llm_latency_seconds");
    
    // Check for default Node.js metrics
    expect(metricsText).toContain("process_cpu_seconds_total");
    expect(metricsText).toContain("process_resident_memory_bytes");
  });

  it("should record message metrics", async () => {
    if ((await safeStart(prometheus)) === null) return;

    prometheus.recordMessage("success");
    prometheus.recordMessage("success");
    prometheus.recordMessage("error");

    const metricsText = await prometheus.getMetrics();
    
    expect(metricsText).toContain('strada_messages_total{status="success"} 2');
    expect(metricsText).toContain('strada_messages_total{status="error"} 1');
  });

  it("should record tool call metrics", async () => {
    if ((await safeStart(prometheus)) === null) return;

    prometheus.recordToolCall("file_read", 100, true);
    prometheus.recordToolCall("file_read", 200, true);
    prometheus.recordToolCall("file_write", 500, false);

    const metricsText = await prometheus.getMetrics();
    
    expect(metricsText).toContain('strada_tool_calls_total{tool="file_read",status="success"} 2');
    expect(metricsText).toContain('strada_tool_calls_total{tool="file_write",status="error"} 1');
    expect(metricsText).toContain('strada_tool_errors_total{tool="file_write"} 1');
  });

  it("should record token usage", async () => {
    if ((await safeStart(prometheus)) === null) return;

    prometheus.recordTokens(100, 50);
    prometheus.recordTokens(200, 100);

    const metricsText = await prometheus.getMetrics();
    
    expect(metricsText).toContain('strada_tokens_total{type="input"} 300');
    expect(metricsText).toContain('strada_tokens_total{type="output"} 150');
    expect(metricsText).toContain('strada_tokens_total{type="total"} 450');
  });

  it("should record LLM latency", async () => {
    if ((await safeStart(prometheus)) === null) return;

    prometheus.recordLLMLatency("claude", "claude-3-opus", 1500);
    prometheus.recordLLMLatency("claude", "claude-3-opus", 2000);
    prometheus.recordLLMLatency("openai", "gpt-4", 800);

    const metricsText = await prometheus.getMetrics();
    
    expect(metricsText).toContain('strada_llm_latency_seconds_bucket');
    expect(metricsText).toContain('provider="claude",model="claude-3-opus"');
    expect(metricsText).toContain('provider="openai",model="gpt-4"');
    expect(metricsText).toContain('strada_llm_latency_seconds_count');
  });

  it("should record message duration", async () => {
    if ((await safeStart(prometheus)) === null) return;

    prometheus.recordMessageDuration("success", 5000);
    prometheus.recordMessageDuration("success", 8000);
    prometheus.recordMessageDuration("error", 2000);

    const metricsText = await prometheus.getMetrics();
    
    expect(metricsText).toContain('strada_message_duration_seconds_bucket');
    expect(metricsText).toContain('status="success"');
    expect(metricsText).toContain('status="error"');
    expect(metricsText).toContain('strada_message_duration_seconds_count');
  });

  it("should record request duration", async () => {
    if ((await safeStart(prometheus)) === null) return;

    prometheus.recordRequestDuration("GET", 100);
    prometheus.recordRequestDuration("POST", 200);

    const metricsText = await prometheus.getMetrics();
    
    expect(metricsText).toContain('strada_request_duration_seconds_bucket');
    expect(metricsText).toContain('method="GET"');
    expect(metricsText).toContain('method="POST"');
  });

  it("should update dynamic metrics", async () => {
    if ((await safeStart(prometheus)) === null) return;

    const metricsText = await prometheus.getMetrics();
    
    expect(metricsText).toContain("strada_active_sessions");
    expect(metricsText).toContain("strada_plugins_loaded 5");
    expect(metricsText).toContain('strada_memory_usage_bytes{type="rss"}');
  });

  it("should serve HTML info page on root endpoint", async () => {
    const port = await safeStart(prometheus);
    if (port === null) return;

    const response = await fetch(`http://localhost:${port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    
    const html = await response.text();
    expect(html).toContain("Strada Brain Prometheus Metrics");
    expect(html).toContain("/metrics");
    expect(html).toContain("strada_messages_total");
  });

  it("should return 404 for unknown endpoints", async () => {
    const port = await safeStart(prometheus);
    if (port === null) return;

    const response = await fetch(`http://localhost:${port}/unknown`);
    expect(response.status).toBe(404);
  });

  it("should reset metrics when requested", async () => {
    if ((await safeStart(prometheus)) === null) return;

    prometheus.recordMessage("success");
    
    let metricsText = await prometheus.getMetrics();
    expect(metricsText).toContain('strada_messages_total{status="success"} 1');

    prometheus.resetMetrics();
    
    metricsText = await prometheus.getMetrics();
    expect(metricsText).not.toContain('strada_messages_total{status="success"} 1');
  });
});
