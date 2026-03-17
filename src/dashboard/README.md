# src/dashboard/

Three independent monitoring servers that can be enabled individually.

## HTTP Dashboard (`DASHBOARD_ENABLED=true`)

**File:** `server.ts`

Pure Node.js `http` module — no Express. Binds to `127.0.0.1` only (localhost).

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Embedded HTML dashboard (auto-refreshes every 3 seconds) |
| `GET /api/metrics` | JSON snapshot from MetricsCollector |
| `GET /health` | Liveness probe: `{"status":"ok"}` |
| `GET /ready` | Deep readiness: checks memory + channel health. Returns 200/207/503. |

**Dashboard displays:** Uptime, total messages, input/output tokens, active sessions, provider name, memory entry count, security stats (secrets redacted, tools blocked), tool usage table, sparkline token chart.

**Security headers:** CSP (with SHA-256 hash of inline script), X-Content-Type-Options, X-Frame-Options: DENY, X-XSS-Protection, Referrer-Policy: no-referrer.

**API authentication defaults:**
- If `WEBSOCKET_DASHBOARD_AUTH_TOKEN` is set, all `/api/*` dashboard endpoints require `Authorization: Bearer <token>`.
- If it is unset, read-only local access still works, but mutating `/api/*` requests are accepted only from trusted same-origin browser requests. This keeps local CSRF closed even without a static token.

**Readiness states:**
- 200: All components healthy
- 207 (Multi-Status): Some components degraded (e.g., HNSW index unhealthy)
- 503: Not ready (channel disconnected, memory unavailable)

## Prometheus Metrics (`ENABLE_PROMETHEUS=true`)

**File:** `prometheus.ts`

Separate HTTP server on port 9090 using `prom-client`.

**Metrics exposed:**
- Counters: `strada_messages_total`, `strada_tool_calls_total`, `strada_tool_errors_total`, `strada_tokens_total`
- Gauges: `strada_active_sessions`, `strada_memory_usage_bytes`, `strada_plugins_loaded`
- Histograms: `strada_request_duration_seconds`, `strada_tool_duration_seconds`, `strada_llm_latency_seconds`, `strada_message_duration_seconds`
- Default Node.js metrics (CPU, heap, GC, event loop lag)

## WebSocket Dashboard (`ENABLE_WEBSOCKET_DASHBOARD=true`)

**File:** `websocket-server.ts`

Uses `ws` library. Serves HTTP (embedded full-featured dashboard) and WebSocket at `/ws`.

**Authentication:**
- If `WEBSOCKET_DASHBOARD_AUTH_TOKEN` is set, the browser must supply that token manually.
- If it is unset, the server generates a process-scoped token and injects it into the same-origin dashboard HTML, so the feature stays usable without running unauthenticated.
- Browser origins default to `localhost` and `127.0.0.1`; `WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS` extends the allowlist for browser clients. Non-browser clients without an `Origin` header are still accepted.

**Protocol:**
1. Server sends `{type:"auth", payload:{requiresAuth:bool}}` on connect
2. Client authenticates if required
3. Server pushes `{type:"metrics", ...}` every 1 second
4. Client can send `{type:"command", payload:{command, data}}` for remote actions

**Commands:** The embedded UI renders buttons for the currently registered command handlers. The server executes only commands whose handlers were explicitly registered by the host application. The current bootstrap does not register any command handlers by default.

**Heartbeat:** Ping every 30 seconds, drop if no pong within 60 seconds.

## MetricsCollector (`metrics.ts`)

In-memory counters (no persistence):
- `totalMessages`, `totalInputTokens`, `totalOutputTokens`
- Rolling window of last 100 token usage entries
- Per-tool call counts and error counts
- `secretsSanitized`, `toolsBlocked` counters
- `readOnlyMode` flag

## Key Files

| File | Purpose |
|------|---------|
| `server.ts` | HTTP dashboard + health/ready endpoints |
| `metrics.ts` | In-memory metrics collector |
| `prometheus.ts` | Prometheus metrics server (port 9090) |
| `websocket-server.ts` | WebSocket real-time dashboard |
