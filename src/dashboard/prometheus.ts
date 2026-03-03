import { createServer, type Server } from "node:http";
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import { getLogger } from "../utils/logger.js";
import type { MetricsCollector } from "./metrics.js";

/**
 * Prometheus Metrics Server
 * 
 * Features:
 * - Prometheus-compatible /metrics endpoint
 * - Counters: messages_total, tool_calls_total, tokens_total
 * - Gauges: active_sessions, memory_usage_bytes, plugins_loaded
 * - Histograms: request_duration_seconds, tool_duration_seconds, llm_latency_seconds
 * - Grafana integration ready
 */
export class PrometheusMetrics {
  private readonly port: number;
  private readonly metrics: MetricsCollector;
  private readonly getMemoryStats: () => { totalEntries: number; hasAnalysisCache: boolean } | undefined;
  private readonly getPluginsStats: () => { loaded: number; directories: string[] } | undefined;
  
  private server: Server | null = null;
  private readonly logger = getLogger();
  private register: Registry;

  // Prometheus metrics
  private messagesTotal!: Counter;
  private toolCallsTotal!: Counter;
  private toolErrorsTotal!: Counter;
  private tokensTotal!: Counter;
  private activeSessions!: Gauge;
  private memoryUsageBytes!: Gauge;
  private pluginsLoaded!: Gauge;
  private requestDurationSeconds!: Histogram;
  private toolDurationSeconds!: Histogram;
  private llmLatencySeconds!: Histogram;
  private messageDurationSeconds!: Histogram;

  constructor(
    port: number,
    metrics: MetricsCollector,
    getMemoryStats: () => { totalEntries: number; hasAnalysisCache: boolean } | undefined,
    getPluginsStats?: () => { loaded: number; directories: string[] } | undefined
  ) {
    this.port = port;
    this.metrics = metrics;
    this.getMemoryStats = getMemoryStats;
    this.getPluginsStats = getPluginsStats as () => { loaded: number; directories: string[] } | undefined;
    this.register = new Registry();

    this.initializeMetrics();
  }

  /**
   * Initialize all Prometheus metrics
   */
  private initializeMetrics(): void {
    // Collect default Node.js metrics (memory, CPU, event loop, etc.)
    collectDefaultMetrics({ register: this.register });

    // Custom counters
    this.messagesTotal = new Counter({
      name: "strata_messages_total",
      help: "Total number of messages processed",
      labelNames: ["status"],
      registers: [this.register]
    });

    this.toolCallsTotal = new Counter({
      name: "strata_tool_calls_total",
      help: "Total number of tool calls",
      labelNames: ["tool", "status"],
      registers: [this.register]
    });

    this.toolErrorsTotal = new Counter({
      name: "strata_tool_errors_total",
      help: "Total number of tool call errors",
      labelNames: ["tool"],
      registers: [this.register]
    });

    this.tokensTotal = new Counter({
      name: "strata_tokens_total",
      help: "Total number of tokens used",
      labelNames: ["type"],
      registers: [this.register]
    });

    // Custom gauges
    this.activeSessions = new Gauge({
      name: "strata_active_sessions",
      help: "Number of active sessions",
      registers: [this.register]
    });

    this.memoryUsageBytes = new Gauge({
      name: "strata_memory_usage_bytes",
      help: "Memory usage in bytes",
      labelNames: ["type"],
      registers: [this.register]
    });

    this.pluginsLoaded = new Gauge({
      name: "strata_plugins_loaded",
      help: "Number of loaded plugins",
      registers: [this.register]
    });

    // Custom histograms
    this.requestDurationSeconds = new Histogram({
      name: "strata_request_duration_seconds",
      help: "Request processing duration in seconds",
      labelNames: ["method"],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.register]
    });

    this.toolDurationSeconds = new Histogram({
      name: "strata_tool_duration_seconds",
      help: "Tool execution duration in seconds",
      labelNames: ["tool"],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: [this.register]
    });

    this.llmLatencySeconds = new Histogram({
      name: "strata_llm_latency_seconds",
      help: "LLM API latency in seconds",
      labelNames: ["provider", "model"],
      buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
      registers: [this.register]
    });

    this.messageDurationSeconds = new Histogram({
      name: "strata_message_duration_seconds",
      help: "Full message processing duration in seconds",
      labelNames: ["status"],
      buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
      registers: [this.register]
    });
  }

  /**
   * Start the Prometheus metrics server
   */
  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const url = req.url ?? "/";

      if (url === "/metrics") {
        // Update dynamic metrics before serving
        this.updateDynamicMetrics();
        
        res.writeHead(200, { "Content-Type": this.register.contentType });
        res.end(await this.register.metrics());
        return;
      }

      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          status: "ok", 
          prometheus: true,
          metricsEndpoint: "/metrics"
        }));
        return;
      }

      if (url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PROMETHEUS_INFO_HTML);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    return new Promise((resolve) => {
      this.server!.listen(this.port, "127.0.0.1", () => {
        this.logger.info(`Prometheus metrics server running at http://localhost:${this.port}/metrics`);
        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
    });
  }

  /**
   * Record a message being processed
   */
  recordMessage(status: "success" | "error" = "success"): void {
    this.messagesTotal.inc({ status });
  }

  /**
   * Record a tool call
   */
  recordToolCall(tool: string, durationMs: number, success: boolean = true): void {
    const status = success ? "success" : "error";
    this.toolCallsTotal.inc({ tool, status });
    this.toolDurationSeconds.observe({ tool }, durationMs / 1000);
    
    if (!success) {
      this.toolErrorsTotal.inc({ tool });
    }
  }

  /**
   * Record token usage
   */
  recordTokens(inputTokens: number, outputTokens: number): void {
    this.tokensTotal.inc({ type: "input" }, inputTokens);
    this.tokensTotal.inc({ type: "output" }, outputTokens);
    this.tokensTotal.inc({ type: "total" }, inputTokens + outputTokens);
  }

  /**
   * Record LLM latency
   */
  recordLLMLatency(provider: string, model: string, durationMs: number): void {
    this.llmLatencySeconds.observe({ provider, model }, durationMs / 1000);
  }

  /**
   * Record message processing duration
   */
  recordMessageDuration(status: "success" | "error", durationMs: number): void {
    this.messageDurationSeconds.observe({ status }, durationMs / 1000);
  }

  /**
   * Record request duration (for HTTP/API calls)
   */
  recordRequestDuration(method: string, durationMs: number): void {
    this.requestDurationSeconds.observe({ method }, durationMs / 1000);
  }

  /**
   * Update dynamic gauge values
   */
  private updateDynamicMetrics(): void {
    const snapshot = this.metrics.getSnapshot(this.getMemoryStats?.());
    
    // Update active sessions
    this.activeSessions.set(snapshot.activeSessions);
    
    // Update memory usage
    const memUsage = process.memoryUsage();
    this.memoryUsageBytes.set({ type: "rss" }, memUsage.rss);
    this.memoryUsageBytes.set({ type: "heap_total" }, memUsage.heapTotal);
    this.memoryUsageBytes.set({ type: "heap_used" }, memUsage.heapUsed);
    this.memoryUsageBytes.set({ type: "external" }, memUsage.external || 0);
    
    // Update plugins count
    const pluginsStats = this.getPluginsStats?.();
    if (pluginsStats) {
      this.pluginsLoaded.set(pluginsStats.loaded);
    }
  }

  /**
   * Get current metrics for external use
   */
  async getMetrics(): Promise<string> {
    this.updateDynamicMetrics();
    return this.register.metrics();
  }

  /**
   * Reset all metrics (useful for testing)
   */
  resetMetrics(): void {
    this.register.resetMetrics();
  }
}

// --- Prometheus Info HTML ---
const PROMETHEUS_INFO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strata Brain Prometheus Metrics</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f1117; color: #e1e4e8; padding: 40px;
  }
  h1 { color: #e6522c; margin-bottom: 20px; }
  h2 { color: #58a6ff; margin-top: 30px; margin-bottom: 15px; font-size: 1.2rem; }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 20px; margin-bottom: 20px;
  }
  .metric {
    font-family: 'SF Mono', Monaco, monospace;
    background: #21262d; padding: 8px 12px;
    border-radius: 6px; margin-bottom: 8px;
    font-size: 0.9rem;
  }
  .metric-name { color: #7ee787; }
  .metric-type { color: #79c0ff; font-size: 0.75rem; margin-left: 10px; }
  .metric-help { color: #8b949e; font-size: 0.8rem; margin-top: 4px; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .endpoint {
    display: inline-block;
    background: #238636;
    color: white;
    padding: 10px 20px;
    border-radius: 6px;
    margin-top: 10px;
  }
</style>
</head>
<body>
<h1>📊 Strata Brain Prometheus Metrics</h1>

<div class="card">
  <p>Prometheus metrics endpoint is available at:</p>
  <a href="/metrics" class="endpoint">/metrics</a>
  <p style="margin-top: 15px; color: #8b949e;">
    Configure your Prometheus server to scrape from <code>http://localhost:9090/metrics</code>
  </p>
</div>

<h2>Available Metrics</h2>

<div class="card">
  <h3 style="color: #c9d1d9; margin-bottom: 15px;">Counters</h3>
  
  <div class="metric">
    <span class="metric-name">strata_messages_total</span>
    <span class="metric-type">Counter</span>
    <div class="metric-help">Total number of messages processed (labels: status)</div>
  </div>
  
  <div class="metric">
    <span class="metric-name">strata_tool_calls_total</span>
    <span class="metric-type">Counter</span>
    <div class="metric-help">Total number of tool calls (labels: tool, status)</div>
  </div>
  
  <div class="metric">
    <span class="metric-name">strata_tool_errors_total</span>
    <span class="metric-type">Counter</span>
    <div class="metric-help">Total number of tool call errors (labels: tool)</div>
  </div>
  
  <div class="metric">
    <span class="metric-name">strata_tokens_total</span>
    <span class="metric-type">Counter</span>
    <div class="metric-help">Total number of tokens used (labels: type=input|output|total)</div>
  </div>
</div>

<div class="card">
  <h3 style="color: #c9d1d9; margin-bottom: 15px;">Gauges</h3>
  
  <div class="metric">
    <span class="metric-name">strata_active_sessions</span>
    <span class="metric-type">Gauge</span>
    <div class="metric-help">Number of active sessions</div>
  </div>
  
  <div class="metric">
    <span class="metric-name">strata_memory_usage_bytes</span>
    <span class="metric-type">Gauge</span>
    <div class="metric-help">Memory usage in bytes (labels: type=rss|heap_total|heap_used|external)</div>
  </div>
  
  <div class="metric">
    <span class="metric-name">strata_plugins_loaded</span>
    <span class="metric-type">Gauge</span>
    <div class="metric-help">Number of loaded plugins</div>
  </div>
</div>

<div class="card">
  <h3 style="color: #c9d1d9; margin-bottom: 15px;">Histograms</h3>
  
  <div class="metric">
    <span class="metric-name">strata_request_duration_seconds</span>
    <span class="metric-type">Histogram</span>
    <div class="metric-help">Request processing duration (labels: method)</div>
  </div>
  
  <div class="metric">
    <span class="metric-name">strata_tool_duration_seconds</span>
    <span class="metric-type">Histogram</span>
    <div class="metric-help">Tool execution duration (labels: tool)</div>
  </div>
  
  <div class="metric">
    <span class="metric-name">strata_llm_latency_seconds</span>
    <span class="metric-type">Histogram</span>
    <div class="metric-help">LLM API latency (labels: provider, model)</div>
  </div>
  
  <div class="metric">
    <span class="metric-name">strata_message_duration_seconds</span>
    <span class="metric-type">Histogram</span>
    <div class="metric-help">Full message processing duration (labels: status)</div>
  </div>
</div>

<div class="card">
  <h3 style="color: #c9d1d9; margin-bottom: 15px;">Node.js Default Metrics</h3>
  <p style="color: #8b949e;">
    Standard Node.js metrics are also collected including: 
    <code>process_cpu_seconds_total</code>, 
    <code>process_resident_memory_bytes</code>, 
    <code>nodejs_eventloop_lag_seconds</code>,
    <code>nodejs_gc_duration_seconds</code>, etc.
  </p>
</div>

<h2>Grafana Integration</h2>
<div class="card">
  <p>Import the Grafana dashboard JSON from <code>grafana-dashboard.json</code> to visualize these metrics.</p>
  <p style="margin-top: 10px; color: #8b949e;">
    Recommended scrape interval: 15s<br>
    Retention: 15 days
  </p>
</div>

</body>
</html>`;
