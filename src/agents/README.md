# src/agents/

The agents subsystem contains the orchestrator (agent loop), AI providers, tools, the autonomy layer, and the plugin system.

## Orchestrator (`orchestrator.ts`)

The `Orchestrator` class implements a single-agent, multi-tool loop. There is one orchestrator instance — the tool set defines what it can do.

**Message processing:**
1. Messages are serialized per-chat via `sessionLocks` (concurrent messages for the same chat are queued)
2. Memory retrieval: top 3 matches (TF-IDF, score >= 0.15)
3. RAG retrieval: top 6 C# code chunks (HNSW vectors, score >= 0.2)
4. Explicit project/world memory injection (project root + cached project analysis)
5. LLM call with system prompt + all context + tool definitions
6. Tool execution with autonomy layer analysis (error recovery, stall detection)
7. Self-verification gate: forces `dotnet_build` before responding if `.cs` files were modified
8. Loop repeats up to `MAX_TOOL_ITERATIONS = 50`

**Session management:** LRU map capped at 100 sessions. Session trimming uses provider-aware thresholds (40-message baseline by default); trimmed slices are persisted to memory before leaving the active context window.

**Streaming:** When both the provider (`IStreamingProvider`) and channel (`IChannelStreaming`) support it, responses stream edit-in-place with 500ms throttled updates.

**Confirmation flow:** Write operations (defined in `WRITE_OPERATIONS`) trigger a confirmation dialog via the channel's interactive UI when `requireConfirmation` is enabled.

## Providers (`providers/`)

All providers implement `IAIProvider`. Streaming providers additionally implement `IStreamingProvider`.

Default models are no longer documented here as static truth; runtime resolves them from `provider-registry.ts`, live model intelligence, and any configured model overrides. The dashboard/model selector reads the same shared catalog the orchestrator uses.

Provider selection is a Strada policy decision, not a direct chat target. Strada remains the control plane for every turn, then assigns planner/executor/reviewer/synthesizer work to providers. A user-selected provider/model sets the primary execution worker, while routing and synthesis may still involve other providers. Runtime execution traces expose which provider/model actually handled each phase and review pass.
Strada is also expected to keep driving the task until it has enough evidence. If a worker returns an incomplete analysis, throws the next step back to the user, or makes a broad completion claim without enough support, Strada reopens the loop, routes another review/inspection pass, and only returns once the result is verified or a real external blocker remains.
Clarification is no longer a default user-facing intake step. Workers may still propose a question, but the orchestrator now routes those drafts through an internal `clarification-review` phase first. `ask_user` is treated as a last-resort interaction after Strada has exhausted local inspection, review, and verification paths.
Completion is now governed by an explicit verifier pipeline. Build verification, targeted repro / failing-path checks, log review, Strada.Core / Strada.Modules conformance, and completion review are evaluated as a single control-plane decision before the orchestrator can finish. Runtime traces still show who executed each phase, and phase outcomes now show whether that phase was approved, continued, replanned, blocked, or failed.
PAOR now also carries an internal execution journal and rollback memory. Replanning can reference the last stable checkpoint, avoid exhausted branches, and feed adaptive phase scores back into routing without provider-specific hardcoded lore. Those phase scores now blend verifier clean rate, rollback pressure, retry count, repeated failure fingerprints, and phase-local token cost.

`FallbackChainProvider` tries providers in order, swallows errors from non-last providers. Built via `buildProviderChain()` from `PROVIDER_CHAIN` env var.

`PROVIDER_PRESETS` in `provider-registry.ts` maps names to `{ baseUrl, defaultModel }` for: openai, deepseek, qwen, kimi, minimax, groq, mistral, together, fireworks, gemini.

`model-intelligence.ts` refreshes model metadata from live sources and mines official provider docs/changelogs from `provider-sources.json`, so routing, provider info, and the model selector can adapt without provider-specific hardcoded role tables.

## Tools (`tools/`)

30+ tools implementing `ITool`. Key categories:

- **File I/O:** `file_read`, `file_write`, `file_edit`, `file_delete`, `file_rename`, `file_delete_directory`
- **Search:** `glob_search`, `grep_search`, `list_directory`, `code_search` (RAG), `memory_search`
- **Strada codegen:** `strada_analyze_project`, `strada_create_module`, `strada_create_component`, `strada_create_mediator`, `strada_create_system` (`SystemBase` / `JobSystemBase` / `BurstSystem`)
- **Git:** `git_status`, `git_diff`, `git_log`, `git_commit`, `git_push`, `git_branch`, `git_stash`
- **.NET:** `dotnet_build`, `dotnet_test`
- **Shell:** `shell_exec`
- **Code quality:** `code_quality`
- **RAG:** `rag_index`
- **Browser:** `browser_automation` (Playwright — not in default registry)
- **HTTP:** `http_client` (not in default registry)

**Security invariants:** All file tools call `validatePath()`. Shell commands pass through a blocklist. Git arguments are injection-safe. Tool outputs are scrubbed for credentials and capped at 8192 chars.

## Autonomy (`autonomy/`)

Three components instantiated fresh per-message:

- **ErrorRecoveryEngine** — Categorizes C# build errors into 14 classes with recovery guidance
- **TaskPlanner** — Detects stalls (3+ consecutive errors), missing verification (2+ mutations without build), budget warnings (40+ iterations)
- **SelfVerification** — Tracks `.cs`/`.csproj`/`.sln` modifications and blocks final response until `dotnet_build` succeeds

The autonomy layer now also includes:

- **Clarification Review** — Decides whether a worker draft should stay internal (`internal_continue`) or whether Strada really needs a concise user clarification
- **Completion Review** — Forces security/code/simplify review plus log/error verification before a worker can self-certify completion
- **Verifier Pipeline** — Aggregates build verification, targeted repro, log review, conformance, and completion-review results into a single continue/replan/approve control-plane outcome
- **Execution Journal** — Tracks task branches, failed approaches, verifier findings, and rollback memory so replans can reuse stable checkpoints instead of starting blind
- **Task Execution Memory** — Persists session summaries, open items, verifier memory, and learned insights separately from user profile state so recovery context survives without polluting persona/preferences

## Plugins (`plugins/plugin-loader.ts`)

External tools loaded from directories specified in `PLUGIN_DIRS`:

```
plugins/my-plugin/
  plugin.json    # { name, version, description, entry }
  index.js       # exports { tools: ITool[] }
```

Tools are namespaced: `plugin_my-plugin_hello`. Path traversal is validated. All tools get `isPlugin: true`.

## Context (`context/strada-knowledge.ts`)

`STRADA_SYSTEM_PROMPT` — core system prompt establishing agent identity and Strada-specific behavior. It is augmented at runtime with project context, task execution memory, an explicit project/world memory layer (active project root + cached analysis), RAG results, and authoritative local sources such as Strada.Core and Strada.MCP when available.

## Key Files

| File | Purpose |
|------|---------|
| `orchestrator.ts` | Agent loop, session management, streaming, tool dispatch |
| `autonomy/error-recovery.ts` | C# error categorization and recovery injection |
| `autonomy/task-planner.ts` | Stall detection, budget warnings, learning trajectory |
| `autonomy/self-verification.ts` | Build verification gate |
| `autonomy/constants.ts` | MUTATION_TOOLS, VERIFY_TOOLS, COMPILABLE_EXT |
| `context/strada-knowledge.ts` | System prompt, project context builder |
| `plugins/plugin-loader.ts` | External plugin discovery and loading |
| `providers/claude.ts` | Primary provider (Anthropic SDK) |
| `providers/fallback-chain.ts` | Multi-provider failover |
| `providers/provider-registry.ts` | Provider presets and chain builder |
| `tools/tool.interface.ts` | ITool, IEnhancedTool interfaces |
| `tools/tool-core.interface.ts` | ToolContext, ToolExecutionResult types |
