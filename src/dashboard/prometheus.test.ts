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

describe("PrometheusMetrics", () => {
  let prometheus: PrometheusMetrics;
  let metrics: MetricsCollector;
  let currentPort = 19990;

  beforeEach(() => {
    // Clear registry before each test
    register.clear();
    
    metrics = new MetricsCollector();
    prometheus = new PrometheusMetrics(
      currentPort++,
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
    await prometheus.start();
    
    const port = currentPort - 1;
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
    await prometheus.start();

    const port = currentPort - 1;
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
    await prometheus.start();

    prometheus.recordMessage("success");
    prometheus.recordMessage("success");
    prometheus.recordMessage("error");

    const metricsText = await prometheus.getMetrics();
    
    expect(metricsText).toContain('strada_messages_total{status="success"} 2');
    expect(metricsText).toContain('strada_messages_total{status="error"} 1');
  });

  it("should record tool call metrics", async () => {
    await prometheus.start();

    prometheus.recordToolCall("file_read", 100, true);
    prometheus.recordToolCall("file_read", 200, true);
    prometheus.recordToolCall("file_write", 500, false);

    const metricsText = await prometheus.getMetrics();
    
    expect(metricsText).toContain('strada_tool_calls_total{tool="file_read",status="success"} 2');
    expect(metricsText).toContain('strada_tool_calls_total{tool="file_write",status="error"} 1');
    expect(metricsText).toContain('strada_tool_errors_total{tool="file_write"} 1');
  });

  it("should record token usage", async () => {
    await prometheus.start();

    prometheus.recordTokens(100, 50);
    prometheus.recordTokens(200, 100);

    const metricsText = await prometheus.getMetrics();
    
    expect(metricsText).toContain('strada_tokens_total{type="input"} 300');
    expect(metricsText).toContain('strada_tokens_total{type="output"} 150');
    expect(metricsText).toContain('strada_tokens_total{type="total"} 450');
  });

  it("should record LLM latency", async () => {
    await prometheus.start();

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
    await prometheus.start();

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
    await prometheus.start();

    prometheus.recordRequestDuration("GET", 100);
    prometheus.recordRequestDuration("POST", 200);

    const metricsText = await prometheus.getMetrics();
    
    expect(metricsText).toContain('strada_request_duration_seconds_bucket');
    expect(metricsText).toContain('method="GET"');
    expect(metricsText).toContain('method="POST"');
  });

  it("should update dynamic metrics", async () => {
    await prometheus.start();

    const metricsText = await prometheus.getMetrics();
    
    expect(metricsText).toContain("strada_active_sessions");
    expect(metricsText).toContain("strada_plugins_loaded 5");
    expect(metricsText).toContain('strada_memory_usage_bytes{type="rss"}');
  });

  it("should serve HTML info page on root endpoint", async () => {
    await prometheus.start();

    const port = currentPort - 1;
    const response = await fetch(`http://localhost:${port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    
    const html = await response.text();
    expect(html).toContain("Strada Brain Prometheus Metrics");
    expect(html).toContain("/metrics");
    expect(html).toContain("strada_messages_total");
  });

  it("should return 404 for unknown endpoints", async () => {
    await prometheus.start();

    const port = currentPort - 1;
    const response = await fetch(`http://localhost:${port}/unknown`);
    expect(response.status).toBe(404);
  });

  it("should reset metrics when requested", async () => {
    await prometheus.start();

    prometheus.recordMessage("success");
    
    let metricsText = await prometheus.getMetrics();
    expect(metricsText).toContain('strada_messages_total{status="success"} 1');

    prometheus.resetMetrics();
    
    metricsText = await prometheus.getMetrics();
    expect(metricsText).not.toContain('strada_messages_total{status="success"} 1');
  });
});
