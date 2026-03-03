import { createServer, type Server } from "node:http";
import { getLogger } from "../utils/logger.js";
import type { MetricsCollector } from "./metrics.js";

/**
 * Lightweight HTTP dashboard server.
 * No external dependencies — uses Node.js built-in http module.
 *
 * Endpoints:
 *   GET /           — Dashboard HTML page (auto-refreshing)
 *   GET /api/metrics — JSON metrics snapshot
 *   GET /health     — Health check
 */
export class DashboardServer {
  private readonly port: number;
  private readonly metrics: MetricsCollector;
  private readonly getMemoryStats: () => { totalEntries: number; hasAnalysisCache: boolean } | undefined;
  // @ts-ignore - Reserved for future read-only mode indicator in dashboard
  private readonly _isReadOnly: () => boolean;
  private server: Server | null = null;

  constructor(
    port: number,
    metrics: MetricsCollector,
    getMemoryStats: () => { totalEntries: number; hasAnalysisCache: boolean } | undefined,
    isReadOnly: () => boolean = () => false
  ) {
    this.port = port;
    this.metrics = metrics;
    this.getMemoryStats = getMemoryStats;
    this._isReadOnly = isReadOnly;
  }

  async start(): Promise<void> {
    const logger = getLogger();

    this.server = createServer((req, res) => {
      const url = req.url ?? "/";

      if (url === "/api/metrics") {
        const snapshot = this.metrics.getSnapshot(this.getMemoryStats());
        res.writeHead(200, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(snapshot));
        return;
      }

      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    return new Promise((resolve) => {
      this.server!.listen(this.port, "127.0.0.1", () => {
        logger.info(`Dashboard running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
    });
  }
}

// --- Embedded Dashboard HTML ---
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strata Brain Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f1117; color: #e1e4e8; padding: 20px;
  }
  h1 { color: #58a6ff; margin-bottom: 20px; font-size: 1.5rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 16px; text-align: center;
  }
  .card .label { color: #8b949e; font-size: 0.85rem; margin-bottom: 4px; }
  .card .value { font-size: 1.8rem; font-weight: 700; color: #58a6ff; }
  .card .sub { color: #8b949e; font-size: 0.75rem; margin-top: 4px; }
  .section { margin-bottom: 24px; }
  .section h2 { color: #c9d1d9; font-size: 1.1rem; margin-bottom: 12px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-size: 0.8rem; text-transform: uppercase; }
  td { font-size: 0.9rem; }
  .bar-container { background: #21262d; border-radius: 4px; height: 20px; overflow: hidden; }
  .bar { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .bar-input { background: #3fb950; }
  .bar-output { background: #f85149; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; }
  .badge-ok { background: #238636; color: #fff; }
  .badge-err { background: #da3633; color: #fff; }
  .badge-warn { background: #f0883e; color: #000; }
  .badge-info { background: #58a6ff; color: #fff; }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; margin-right: 6px; }
  .status-dot.readonly { background: #f0883e; }
  .readonly-banner {
    background: linear-gradient(90deg, #f0883e 0%, #da3633 100%);
    color: #fff;
    padding: 12px 20px;
    margin: -20px -20px 20px -20px;
    font-weight: 600;
    text-align: center;
    display: none;
  }
  .readonly-banner.active { display: block; }
  #last-update { color: #484f58; font-size: 0.75rem; }
</style>
</head>
<body>
<div id="readonly-banner" class="readonly-banner">🔒 READ-ONLY MODE ACTIVE - Write operations are disabled</div>
<h1><span id="status-dot" class="status-dot"></span>Strata Brain Dashboard</h1>
<div class="grid" id="cards"></div>

<div class="section">
  <h2>Tool Usage</h2>
  <table id="tool-table">
    <thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Distribution</th></tr></thead>
    <tbody></tbody>
  </table>
</div>

<div class="section">
  <h2>Recent Token Usage</h2>
  <div id="token-chart" style="height:120px;display:flex;align-items:flex-end;gap:2px;"></div>
</div>

<p id="last-update"></p>

<script>
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return d + 'd ' + (h % 24) + 'h';
  if (h > 0) return h + 'h ' + (m % 60) + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

async function refresh() {
  try {
    const res = await fetch('/api/metrics');
    const data = await res.json();

    // Read-only mode indicator
    const banner = document.getElementById('readonly-banner');
    const statusDot = document.getElementById('status-dot');
    if (data.readOnlyMode) {
      banner.classList.add('active');
      statusDot.classList.add('readonly');
    } else {
      banner.classList.remove('active');
      statusDot.classList.remove('readonly');
    }

    // Cards
    const cards = [
      card('Uptime', fmtDuration(data.uptime)),
      card('Messages', fmt(data.totalMessages)),
      card('Input Tokens', fmt(data.totalTokens.input)),
      card('Output Tokens', fmt(data.totalTokens.output)),
      card('Active Sessions', data.activeSessions),
      card('Provider', data.providerName, data.memoryStats ? 'Memory: ' + data.memoryStats.totalEntries + ' entries' : ''),
    ];
    
    // Add security stats if available
    if (data.securityStats && (data.securityStats.secretsSanitized > 0 || data.securityStats.toolsBlocked > 0)) {
      cards.push(card('Secrets Redacted', fmt(data.securityStats.secretsSanitized), data.securityStats.toolsBlocked > 0 ? data.securityStats.toolsBlocked + ' tools blocked' : ''));
    }
    
    // Add read-only indicator card
    if (data.readOnlyMode) {
      cards.push(card('Mode', '🔒 Read-Only', 'Write operations disabled'));
    }
    
    document.getElementById('cards').innerHTML = cards.join('');

    // Tool table
    const tbody = document.querySelector('#tool-table tbody');
    const tools = Object.entries(data.toolCallCounts).sort((a,b) => b[1] - a[1]);
    const maxCalls = Math.max(...tools.map(t => t[1]), 1);
    tbody.innerHTML = tools.map(([name, calls]) => {
      const errors = data.toolErrorCounts[name] || 0;
      const pct = (calls / maxCalls * 100).toFixed(0);
      return '<tr><td>' + esc(name) + '</td><td>' + esc(calls) + '</td>'
        + '<td>' + (errors > 0 ? '<span class="badge badge-err">' + errors + '</span>' : '<span class="badge badge-ok">0</span>') + '</td>'
        + '<td><div class="bar-container"><div class="bar bar-input" style="width:' + pct + '%"></div></div></td></tr>';
    }).join('');

    // Token chart (sparkline)
    const chart = document.getElementById('token-chart');
    const recent = data.recentTokenUsage.slice(-50);
    const maxTokens = Math.max(...recent.map(t => t.inputTokens + t.outputTokens), 1);
    chart.innerHTML = recent.map(t => {
      const total = t.inputTokens + t.outputTokens;
      const h = Math.max(4, (total / maxTokens) * 100);
      const inPct = t.inputTokens / (total || 1) * 100;
      return '<div style="flex:1;height:' + h + '%;display:flex;flex-direction:column;justify-content:flex-end">'
        + '<div class="bar-input" style="height:' + inPct + '%;border-radius:2px 2px 0 0"></div>'
        + '<div class="bar-output" style="height:' + (100-inPct) + '%;border-radius:0 0 2px 2px"></div>'
        + '</div>';
    }).join('');

    document.getElementById('last-update').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('last-update').textContent = 'Error: ' + e.message;
  }
}

function card(label, value, sub) {
  return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div>'
    + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
