# Strada.Brain — System Status & Honest Verification Matrix

**Generated:** 2026-06-02 · **Scope:** evidence-based status of the whole
system. No marketing. No comparative ("better than X") claims — those are
unsupported by this repo (see [`eval/README.md`](eval/README.md)).

This document records **what is implemented, at what test level, and what is
degraded in *this specific deployment*.** It is deliberately conservative: where
something is only proven by mocked unit tests, it says so; where it needs a live
external service or credentials, it says so and does **not** assume it works.

---

## How to read the columns

- **Implemented?** Does the code exist and compile/ship?
- **Test level** — the honest ceiling of the automated evidence:
  - `unit-mock` — unit tests with mocked I/O (no real external service).
  - `integration` — real **local** in-process objects / real local SQLite, no
    network.
  - `e2e-live` — exercises a real external service (NOT present unless stated;
    network e2e is not part of the automated suite).
  - `none` — no automated test.
- **Live-verified?** Has it been confirmed against the real external service in
  this deployment? (Mostly **No** — most externals are mocked.)
- **Degradation in THIS deployment** — concrete, given the actual `.env`:
  OpenAI **subscription** auth (chat-only), **no `OPENAI_API_KEY` / `GEMINI_API_KEY`**,
  `KIMI_API_KEY` present (per prior diagnosis possibly **expired**),
  `PROVIDER_CHAIN=openai`, `RAG_ENABLED=false`, **Ollama not running**.

---

## 1. Channels

`src/channels/*`. Channel logic is unit-tested with mocked platform SDKs.
**No channel is live-verified by the automated suite** — real platforms cannot
be reached without tokens, by design (see the integrity rules and
[`deployment/teams-verification.md`](deployment/teams-verification.md)).

| Channel | Implemented? | Test level | Live-verified? | Notes / degradation |
|---|---|---|---|---|
| CLI | Yes | unit-mock (1 test file) | n/a (local) | No auto-approve when readline absent. The most directly exercisable channel locally. |
| Web (portal) | Yes | unit-mock (2 test files) | No | Fail-fast confirmation, verify-gate, CSRF wired. Portal served from prebuilt `web-portal/dist` (needs `npm run build:portal`). |
| Discord | Yes | unit-mock (4 test files) | No | Confirmation off global queue, split-not-truncate, reconnect, Partials. **Open:** reply-callback keyed by chatId needs per-interaction token (skipped). |
| Slack | Yes | unit-mock (1 test file) | No | Confirmation honors `req.options`. |
| Telegram | Yes | unit-mock (1 test file) | No | 429 retry, per-chat serialize, MarkdownV2 escape. **Open:** dead diff-confirmation subsystem (delete-or-wire). |
| Teams | Yes | unit-mock (1 test file) | **No — requires manual runbook** | Async/proactive delivery + single-tenant auth fixed but **only verifiable on a real Azure tenant**: see [`deployment/teams-verification.md`](deployment/teams-verification.md). Do NOT assume async delivery works until that runbook passes. |
| WhatsApp | Yes | unit-mock (1 test file) | No | Reconnect/dedup/chunk. **Open:** LID-format JID mapping (skipped). |
| Matrix | Yes | unit-mock (1 test file) | No | Chunk/retry/sync-health/attachments. |
| IRC | Yes | unit-mock (1 test file) | No | Case-insensitive allowlist. **Open:** interactivity (skipped). |

**Must NOT be assumed to work:** any channel's real platform delivery,
especially **Teams async (delayed) delivery and single-tenant auth**, which have
**no automated coverage** and a known prior bug. The channels **shared layer**
(channel interface/registry, `src/tasks/message-router.ts`,
`src/security/dm-policy.ts`, `access-policy.ts`, `rate-limiter.ts`,
`notification-router.ts`, `mock-channel.ts`) was **not reviewed** in the last
audit (a sub-agent failed on a tool glitch) — treat as unaudited.

---

## 2. Providers (LLM)

`src/agents/providers/*`. Each provider has unit tests; **none make real network
calls** — request/response paths are mocked. Live behavior depends on valid
credentials not present for most providers in this deployment.

| Provider | Implemented? | Test level | Live-verified here? | Notes / degradation |
|---|---|---|---|---|
| OpenAI | Yes | unit-mock | Partially (subscription chat works per logs) | Running in **subscription** auth (`OPENAI_AUTH_MODE`, `gpt-5.2`). Chat-only: **cannot do embeddings or enumerate `/v1/models`** → root cause of embedding + model-picker degradation. Refresh-on-401 landed. |
| **OpenRouter** (newly added) | Yes (`openrouter.ts`, extends `OpenAIProvider`) | unit-mock (constructor, capabilities, header build — see `openrouter.test.ts`) | **No** | Registered in `provider-registry.ts`; config wired (`OPENROUTER_API_KEY`/`OPENROUTER_MODEL` → `openrouterApiKey`). **No `OPENROUTER_API_KEY` set in this `.env`, so it is inert here.** Source-only: the OpenRouter class is **not yet in `dist/`** — a `npm run build` is required before the running daemon can use it. Tests prove header/auth construction, **not** that a real OpenRouter request succeeds. |
| Claude (Anthropic) | Yes | unit-mock | No | No `ANTHROPIC_API_KEY` in this deployment. |
| Gemini | Yes | unit-mock | No | No `GEMINI_API_KEY`. |
| Kimi (Moonshot) | Yes | unit-mock | No | `KIMI_API_KEY` present but **per prior diagnosis possibly expired**; non-primary, so a failure no longer aborts boot (graceful degradation landed). |
| DeepSeek / Groq / Mistral / Together / Fireworks / MiniMax / Qwen / OpenCode | Yes | unit-mock | No | No keys configured here; not in the active `PROVIDER_CHAIN=openai`. |
| Ollama (local) | Yes | unit-mock | **No — not running** | `localhost:11434` refused in this deployment. Any AUTO fallback to Ollama (chat or embeddings) **fails**. |

**Must NOT be assumed to work:** every provider's **real** request path
(all tests are mocked). In this deployment specifically, only **OpenAI
subscription chat** is observed working; OpenRouter/Claude/Gemini/Kimi/Ollama
are **not** functional here without keys / a running server / a rebuild.

---

## 3. Embeddings & hash fallback

`src/rag/embeddings/*`, `src/vault/embedding-adapter.ts`.

| Aspect | Implemented? | Test level | Live here? | Notes / degradation |
|---|---|---|---|---|
| OpenAI embeddings | Yes | unit-mock | **No** | Subscription token **cannot** do embeddings; no `OPENAI_API_KEY`. |
| Ollama embeddings | Yes | unit-mock | **No** | Ollama not running. |
| Embedding resolver / AUTO chain | Yes | unit-mock + integration (resolver logic) | partial | Resolution **logic** is tested locally; the chosen backend then **fails** because no real embedder is reachable. |
| **Hash fallback embeddings** | Yes (active) | unit-mock | **Active in this deployment** | With no real embedder, the system falls back to **hash-based vectors** (warned at `src/core/bootstrap-memory.ts`, `src/core/boot-report.ts`; surfaced by `setup-doctor`). **This is lexical, not semantic** — semantic search / semantic instinct recall quality is **degraded**. |

**Must NOT be assumed to work:** semantic similarity / semantic retrieval.
Under hash fallback, "similar meaning, different words" will **not** match. Any
feature whose value depends on real embeddings (RAG quality, semantic instinct
recall, dedupe by meaning) is **degraded** here. To restore: add a real
embedding key (`OPENAI_API_KEY`/`GEMINI_API_KEY`) **or** run Ollama
(`ollama pull nomic-embed-text`, or `SYSTEM_PRESET=free`).

---

## 4. Vault (Obsidian / SQLite memory)

`src/vault/*`.

| Aspect | Implemented? | Test level | Live here? | Notes |
|---|---|---|---|---|
| SQLite vault store | Yes | integration (real local SQLite) | Yes (local) | Genuinely verifiable in-process; no network. |
| Path policy / traversal guard | Yes | unit + integration | Yes | `path-policy.test.ts` covers sanitization. |
| Obsidian client (HTTP REST plugin) | Yes | unit-mock | **No** | Talks to a local Obsidian REST endpoint — **not** exercised live in the suite. |
| Canvas generator, chunker, watcher, symbol extractor | Yes | unit + integration | Partial | File-watch + chunk logic tested locally. |
| Vault embedding (search ranking) | Yes | unit-mock | Degraded | Inherits the **hash-fallback** degradation above for semantic ranking. |

**Must NOT be assumed to work:** the **Obsidian REST** integration (needs a
running Obsidian + Local REST API plugin); semantic vault search quality (hash
fallback).

---

## 5. Self-learning (instincts / experience replay)

`src/learning/*`. This is the most substantively tested subsystem at the
**mechanics** level, but its **effectiveness** is NOT proven by the suite.

| Aspect | Implemented? | Test level | Live here? | Notes |
|---|---|---|---|---|
| LearningStorage (SQLite) | Yes | integration (real local SQLite) | Yes (local) | Instinct/trajectory/verdict rows persisted & queried for real. |
| LearningPipeline (`observeToolUse`, `runDetectionBatch`) | Yes | unit + integration | Yes (local) | Detection/creation logic exercised in-process. |
| Confidence scoring (5-factor, Wilson, Elo) | Yes | unit | Yes (deterministic) | Pure maths, fully testable offline. |
| Pattern matcher (`findMatchingErrorPatterns`) | Yes | unit + integration | Yes (local) | Lexical/keyword matching tested. |
| Learning metrics counters | Yes | unit | Yes | In-memory observability counters. |
| **Does learning measurably *improve* a second run?** | Partially built | **none (no eval wired)** | **No** | This subjective/behavioral question is **not** answered by `npm test`. A scaffold exists at [`eval/README.md`](eval/README.md) + `scripts/eval/learning-eval.mjs`; it is **not yet wired** and asserts nothing today. |
| **Semantic instinct recall** | Yes | unit-mock | **Degraded** | Cross-session semantic recall relies on embeddings → **hash fallback** here → recall is lexical only. A reworded probe may fail to recall. |

**Must NOT be assumed to work:** that learning produces a **measurable behavioral
improvement** (unproven — needs the eval harness wired); that **semantic**
instinct recall works in this deployment (it falls back to lexical matching).

---

## 6. Loops & daemon

`src/daemon/*`, `src/core/bootstrap*`, `src/memory/unified/consolidation-engine.ts`.

| Aspect | Implemented? | Test level | Live here? | Notes |
|---|---|---|---|---|
| Heartbeat loop | Yes | unit | partial | `STRADA_DAEMON_*` configured in `.env`. |
| Circuit breaker / resilience | Yes | unit | Yes (logic) | |
| Budget tracker | Yes | unit | Yes (logic) | Daily budget configured. |
| Consolidation engine | Yes | unit + integration | partial | Memory consolidation; semantic steps inherit hash-fallback degradation. |
| Bootstrap (staged) | Yes | unit + integration | Yes (boots locally) | Graceful degradation: a non-primary provider failing no longer aborts boot; per-step try/catch; shutdown-leak fixes landed. |
| Autonomous loop | Yes | unit | **Not assumed** | `AUTONOMOUS_DEFAULT_ENABLED` configured; long-running autonomous behavior is **not** covered by automated e2e. |

**Must NOT be assumed to work:** long-running **autonomous** behavior over real
time (no e2e). The daemon **boots** locally; sustained loop correctness under
real workloads is unverified.

---

## 7. Persona / soul / identity

`src/identity/*`, `src/agents/soul/*`, `src/agents/tools/*personality*`,
`src/dashboard/server-personality-routes.ts`, `soul.md`.

| Aspect | Implemented? | Test level | Live here? | Notes |
|---|---|---|---|---|
| Soul loader (`soul.md`) | Yes | unit | Yes (local file) | Loads persona text from repo file. |
| Identity state | Yes | unit | Yes | |
| Personality create/switch tools | Yes | unit | partial | Dashboard routes exist; UI round-trip not e2e-tested. |

**Must NOT be assumed to work:** that persona changes are reflected **end-to-end
through the web UI** (no e2e); persona only affects output via a **real LLM**,
which here means OpenAI subscription only.

---

## 8. Web settings / dashboard

`src/dashboard/server-settings-routes.ts`, `server-provider-routes.ts`,
`web-portal/src/pages/settings/*`.

| Aspect | Implemented? | Test level | Live here? | Notes |
|---|---|---|---|---|
| Settings REST routes (backend) | Yes | unit-mock | partial | Route handlers tested with mocked deps. |
| Settings UI (portal) | Yes | unit-mock (portal vitest) | No (no e2e) | Served from prebuilt `web-portal/dist`; needs `npm run build:portal` to reflect source changes. |
| Chat view crash guard | Yes (fixed) | unit | partial | Prior `T.filter` crash fixed via array guards. |

**Must NOT be assumed to work:** full settings **save→reload→effect** round-trip
through the live portal (no e2e). Source changes in the portal are **not** live
until rebuilt.

---

## 9. Model picker

`src/agents/providers/model-intelligence.ts`, `provider-catalog.ts`,
`src/dashboard/server-provider-routes.ts`, PrimaryWorkerSelector.

| Aspect | Implemented? | Test level | Live here? | Notes |
|---|---|---|---|---|
| Model intelligence / auto-update | Yes | unit | Yes (verified healthy previously) | Catalog auto-update reported healthy. |
| Model picker population | Yes | unit-mock | **Degraded** | In this deployment the picker shows **essentially one model (`gpt-5.2`)** because the **subscription token's `listModels()` returns a single model** and the catalog backfill is thin. contextWindow filter relaxed + selector guards landed to reduce the damage. |

**Must NOT be assumed to work:** a **rich multi-model** picker in this
deployment. With only subscription auth and no other provider keys, the picker's
selectable set is **minimal**. Adding provider API keys (or OpenRouter, after a
rebuild) is what would populate it.

---

## Deployment-wide caveats (apply to everything above)

1. **Subscription auth = chat-only.** No embeddings, no model enumeration. This
   single fact drives the embedding hash-fallback (§3), degraded semantic
   learning recall (§5), and the thin model picker (§9).
2. **No `OPENAI_API_KEY` / `GEMINI_API_KEY`; Ollama off.** Any feature requiring
   a real embedder or a local model is degraded or non-functional here.
3. **OpenRouter is added in source but not in `dist/` and has no key set.** It is
   **inert** in this deployment until both a key is configured **and** the
   package is rebuilt (`npm run build`).
4. **All external integrations are mock-tested, not live.** Channels (esp.
   Teams), Obsidian REST, and every remote LLM provider have **no live
   automated coverage**. Do not equate a green unit suite with a working
   integration.
5. **The channels shared layer is unaudited** (see §1).
6. **No comparative/quality claims are made anywhere.** "How good are the
   answers" and "better than openclaw/hermes" are explicitly out of scope and
   unprovable from this repo — see [`eval/README.md`](eval/README.md).

---

## Quick remediation map

| Symptom in this deployment | Root cause | Fix |
|---|---|---|
| Hash-fallback embeddings / weak semantic search | Subscription token can't embed; no key; Ollama off | Add `OPENAI_API_KEY`/`GEMINI_API_KEY`, **or** run Ollama (`SYSTEM_PRESET=free`). |
| Model picker shows ~1 model | Subscription `listModels()` returns one | Add provider API keys (incl. OpenRouter) **and** `npm run build`. |
| OpenRouter does nothing | No `OPENROUTER_API_KEY`; class not in `dist/` | Set `OPENROUTER_API_KEY` (+ `OPENROUTER_MODEL`) and rebuild. |
| Kimi failures at boot | `KIMI_API_KEY` possibly expired | Refresh the key (non-primary, so boot is unaffected). |
| Teams async replies unconfirmed | No live tenant tested | Run [`deployment/teams-verification.md`](deployment/teams-verification.md). |
