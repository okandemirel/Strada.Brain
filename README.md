<p align="center">
  <img src="icon/strada-brain-icon.png" alt="Strada.Brain Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>AI-Powered Development Agent for Unity / Strada.Core Projects</strong><br/>
  An autonomous coding agent that connects to a web dashboard, Telegram, Discord, Slack, WhatsApp, or your terminal &mdash; reads your codebase, writes code, runs builds, learns from its mistakes, and operates autonomously with a 24/7 daemon loop. Now with multi-agent orchestration, task delegation, memory consolidation, a deployment subsystem with approval gates, media sharing with LLM vision support, a configurable personality system via SOUL.md, control-plane clarification review, intelligent multi-provider routing with task-aware dynamic switching, confidence-based consensus verification, an autonomous Agent Core with OODA reasoning loop, an extensible skill ecosystem with SKILL.md manifests and a git-based registry, and Strada.MCP integration.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/tests-4527%2B-brightgreen?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
</p>

<p align="center">
  <strong>English</strong> |
  <a href="README.tr.md">T&uuml;rk&ccedil;e</a> |
  <a href="README.zh.md">&#20013;&#25991;</a> |
  <a href="README.ja.md">&#26085;&#26412;&#35486;</a> |
  <a href="README.ko.md">&#54620;&#44397;&#50612;</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Espa&ntilde;ol</a> |
  <a href="README.fr.md">Fran&ccedil;ais</a>
</p>

---

## What Is This?

Strada.Brain is an AI agent you talk to through a chat channel. You describe what you want -- "create a new ECS system for player movement" or "find all components that use health" -- and the agent reads your C# project, writes the code, runs `dotnet build`, fixes errors automatically, and sends you the result.

It has persistent memory backed by SQLite + HNSW vectors, learns from past errors using hybrid weighted confidence scoring, decomposes complex goals into parallel DAG execution, automatically synthesizes multi-tool chains with saga rollback, and can run as a 24/7 daemon with proactive triggers. It supports multi-agent orchestration with per-channel session isolation, hierarchical task delegation across agent tiers, automatic memory consolidation, a runtime self-improvement loop that materializes reusable `skill` / `workflow` / `knowledge_patch` artifacts in shadow mode before promoting them to active guidance, a deployment subsystem with human-in-the-loop approval gates and circuit breaker protection, and a modern glassmorphism web portal with Magic UI components (shadcn/ui + 21st.dev) featuring animated metrics, blur transitions, and a persistent notification center.

New in this release: Strada.Brain now features an **Agent Core** -- an autonomous OODA reasoning engine that observes the environment (file changes, git state, build results), reasons about priorities using learned patterns, and takes action proactively. The **multi-provider routing** system dynamically selects the best AI provider for each task type (planning, code generation, debugging, review) with configurable presets (budget/balanced/performance). A **confidence-based consensus** system automatically consults a second provider when the agent's confidence is low, preventing errors on critical operations. All features gracefully degrade -- with a single provider, the system works identically to before with zero overhead.

**This is not a library or an API.** It is a standalone application you run. It connects to your chat platform, reads your Unity project on disk, and operates autonomously within the boundaries you configure.

---

## Quick Start

### Prerequisites

- **Node.js 20.19+** (or **22.12+**) — if Node.js is not installed, the launcher will offer to download a portable copy automatically (Windows only, ~30 MB one-time download, stored in `%LOCALAPPDATA%\Strada\node`). You can also point to a custom binary with `STRADA_NODE_PATH`.
- At least one supported AI provider configured (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.), a Claude subscription token (`ANTHROPIC_AUTH_MODE=claude-subscription` + `ANTHROPIC_AUTH_TOKEN`), an OpenAI ChatGPT/Codex subscription session (`OPENAI_AUTH_MODE=chatgpt-subscription`), or an `ollama`-only `PROVIDER_CHAIN`
- A **Unity project** (the path you give the agent). Strada.Core is recommended for full framework-aware assistance; without it, Strada.Brain still runs with reduced Strada-specific guidance.

### 1. Install

```bash
# Clone from source (currently the canonical install path)
git clone https://github.com/okandemirel/Strada.Brain.git Strada.Brain

# No `cd` required: use the checkout directly from the parent folder
./Strada.Brain/strada install-command
./Strada.Brain/strada setup

# Optional shorter shell
cd Strada.Brain
```

```powershell
# Windows PowerShell source checkout
git clone https://github.com/okandemirel/Strada.Brain.git Strada.Brain
.\Strada.Brain\strada.ps1 install-command
.\Strada.Brain\strada.ps1 setup
```

> **Windows note**: If PowerShell blocks `.\strada.ps1` with an execution policy error, use `strada.cmd` instead (works in both CMD and PowerShell without policy changes):
> ```
> .\Strada.Brain\strada.cmd install-command
> .\Strada.Brain\strada.cmd setup
> ```
> Or allow local scripts: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`
>
> If you see `SyntaxError: Unexpected identifier 'pipefail'`, you ran `node strada` which tries to parse the bash launcher as JavaScript. Use `.\strada.cmd`, `.\strada.ps1`, or `node strada.js` instead.

`./strada` is the canonical source-checkout launcher on macOS/Linux. On Windows, use `.\strada.ps1` from the checkout root, with `strada.cmd` as the companion wrapper for Command Prompt and bare-PATH launches. On first run the source launcher prepares the local checkout automatically, so normal setup no longer requires manual `npm install`, `npm run bootstrap`, or `npm link`.

> **No Node.js? No problem.** On Windows, if `node` is not found on the system PATH, the launcher (`strada.cmd` / `strada.ps1`) will prompt you to download a portable Node.js automatically. The portable runtime is stored in `%LOCALAPPDATA%\Strada\node` and is used only by Strada — it does not modify your system PATH or interfere with other tools. You can skip the prompt and install Node.js yourself from <https://nodejs.org>, or point to any existing binary with `set STRADA_NODE_PATH=C:\path\to\node.exe`.

If you skip `./strada install-command`, keep using `./Strada.Brain/strada ...` from the parent folder or `./strada ...` from the repository root. Once installed, bare `strada ...` works from anywhere.

On macOS/Linux, `./strada install-command` updates your shell profile automatically so future terminals pick up the `strada` command without a manual PATH edit. On Windows, `.\strada.ps1 install-command` installs `strada.cmd` and `strada.ps1` into `%LOCALAPPDATA%\Strada\bin` and updates the user PATH.

To remove the user-local command later, run `strada uninstall` (or `./strada uninstall` / `.\strada.ps1 uninstall` from the checkout). Add `--purge-config` to also remove Strada runtime state such as `.env`, `.strada-memory`, `.whatsapp-session`, logs, and `HEARTBEAT.md` under the active runtime root. On source checkouts, the same `--purge-config` flag also removes generated artifacts like `node_modules/`, `dist/`, `web-portal/node_modules`, and `web-portal/dist` so you can rerun the checkout from a true zero-install state. The repository checkout itself is never deleted automatically.

If you ever run `npm` manually, do it from the repository root, the folder that contains `package.json`. If you see an error like `ENOENT ... /Strada/package.json`, you are one directory too high; either `cd Strada.Brain` first or prefix the command with `cd Strada.Brain && ...`.

`strada-brain` is not currently published on the public npm registry, so `npm install -g strada-brain` will return `E404`. Until a registry release exists, use the source checkout flow above.

When Strada is installed from a packaged npm/tarball release, it keeps its runtime config in `~/.strada` by default on macOS/Linux and `%LOCALAPPDATA%\Strada` on Windows instead of depending on the current working directory. Override this with `STRADA_HOME=/custom/path` when you need a different app home.

### 2. Setup

```bash
# Interactive setup wizard (terminal or web browser)
./strada setup

# Skip the chooser and jump straight into one setup surface
./strada setup --web
./strada setup --terminal
```

```powershell
# Windows PowerShell source checkout
.\strada.ps1 setup
.\strada.ps1 setup --web
.\strada.ps1 setup --terminal
```

If `./strada setup --web` detects an older Node runtime that cannot build the full portal bundle, Strada keeps web as the primary path. On macOS/Linux it prefers `nvm` and can relaunch setup for you after the upgrade, running that guided flow inside a temporary clean HOME so incompatible `prefix` / `globalconfig` npm settings do not block `nvm`. On Windows it prefers `nvm-windows`, then `winget`, then the direct Node download path, and it always shows the exact rerun command for `.\strada.ps1 setup --web`. If you decline the upgrade, Strada offers to continue with terminal setup instead.
If Node 22 is already installed in `nvm`, Strada reuses that runtime instead of downloading it again. The setup browser flow opens on the root local URL and stays on that same URL when it hands off to the main app.
That first-run browser open also carries an explicit setup flag, so a stale cached portal tab still resolves into the setup wizard instead of a dead "Not Found" page.
If the first web handoff races the restart, Strada now retries that launch automatically before surfacing an error. Once the config is saved, Strada keeps the handoff page alive on the same URL until the main app is ready, so do not re-run setup.

The wizard asks for your Unity project path, AI provider access, default channel, language, and per-provider default model selections. `./strada setup` now prefers **Web Browser** by default; choose **Terminal** only when you explicitly want the faster text flow.
The configured `UNITY_PROJECT_PATH` is the authoritative project scope for Strada's coding work. If another Unity project is currently open in the editor, Strada may surface a startup warning about the mismatch, but it does not silently switch scope away from the setup-selected project.
Terminal setup accepts comma-separated providers in a single prompt (e.g. `kimi,deepseek`) for fallback / multi-agent orchestration, or you can add them one at a time interactively. The "Add another?" loop only appears when a single provider is entered. The embedding provider choice stays separate.
Every selected response worker must pass preflight before setup can finish. Setup, `strada doctor`, and startup now use the same contract, so invalid provider chains are rejected instead of being silently skipped.
Fresh setup now enables both multi-agent orchestration and task delegation by default. If you want the legacy single-agent path, explicitly set `MULTI_AGENT_ENABLED=false`; delegation does not initialize when multi-agent is disabled even if `TASK_DELEGATION_ENABLED=true`.
When OpenAI uses `chatgpt-subscription`, setup validates the local Codex/ChatGPT session with a real Responses probe before saving. Expired subscription sessions are rejected during setup and reported by `strada doctor`.
When Claude uses `claude-subscription`, setup expects an `ANTHROPIC_AUTH_TOKEN` generated after `claude auth login --claudeai` and `claude setup-token`, warns that Anthropic documents this flow as limited to Claude Code / Claude.ai, and still requires the selected response worker to pass preflight before save completes.
After you save the web wizard, Strada exposes explicit handoff states on the same URL (`saved`, `booting`, `ready`, `failed`) so refreshes can survive the transition and bootstrap failures stay visible until you retry setup.
That handoff is now server-owned: once the first resolved web identity/session exists, Strada sends one assistant-authored welcome in the configured language and applies any setup-time autonomy bootstrap exactly once.
Setup writes global provider-model defaults into `.env`, while chat and Settings keep using identity-scoped provider/model overrides on top of those defaults.
If the first real chat message is technical, Strada still starts solving immediately and only learns whatever name/style/detail preferences it can infer from that same reply.
If RAG is enabled without a usable embedding provider, the wizard now lets you continue to the review step but keeps Save blocked until you choose a valid embedding provider or disable RAG.

> **Windows web setup fix:** Earlier versions had a path-separator bug that caused the web setup page to appear blank on Windows (all static assets were blocked by the path traversal guard). This is now fixed — both `.\strada.ps1 setup --web` and the post-setup web portal at `127.0.0.1:3000` work correctly on Windows. If you previously had to fall back to terminal setup on Windows, web setup is now the recommended path.

After the first successful setup, running `./strada` with no subcommand becomes your smart launcher:
- first use: opens setup automatically if config is missing
- later uses: shows a terminal launcher so you can choose web, CLI, daemon mode, setup, or doctor

After setup, run a readiness check before you start the agent:

```bash
# From the source checkout
./strada doctor

# Or, after installing the user-local command
strada doctor
```

```powershell
# Windows PowerShell source checkout
.\strada.ps1 doctor
```

For git/source installs, `strada doctor` treats a missing `dist/` folder as a warning when the source launcher is already usable. It now shows the exact repo-root `npm run bootstrap` command only when you want packaged build artifacts.

Alternatively, create `.env` manually:

```env
# Claude via API key
ANTHROPIC_API_KEY=sk-ant-...

# Or Claude via subscription token
# 1. claude auth login --claudeai
# 2. claude setup-token
ANTHROPIC_AUTH_MODE=claude-subscription
ANTHROPIC_AUTH_TOKEN=sk-ant-sid01-...

# Or use another supported provider key instead
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Must contain Assets/
# Optional: enable internal system auth / JWT sessions
JWT_SECRET=<generate with: openssl rand -hex 64>
```

### 3. Run

```bash
# Smart launcher from the source checkout
./strada

# Windows PowerShell source launcher
.\strada.ps1

# Bare command after `./strada install-command`
strada

# Start your configured default channel directly in daemon mode
./strada --daemon

# Start with default web channel
./strada start

# Interactive CLI mode (fastest way to test)
./strada start --channel cli

# Daemon mode (24/7 autonomous operation with proactive triggers)
./strada start --channel web --daemon

# Other chat channels
./strada start --channel telegram
./strada start --channel discord
./strada start --channel slack
./strada start --channel whatsapp

# Always-on supervisor with auto-restart
./strada supervise --channel web
```

### 4. CLI Commands

```bash
./strada                  # Canonical source-checkout launcher
.\strada.ps1             # Canonical Windows PowerShell source-checkout launcher
strada.cmd               # Windows Command Prompt companion launcher inside the checkout
node strada.js            # Universal Node.js entry point (works on any OS without shell wrappers)
./strada install-command  # Install a user-local bare `strada` command
.\strada.ps1 install-command # Windows source-checkout bare-command install
./strada uninstall        # Remove the installed bare command and managed PATH/profile changes
.\strada.ps1 uninstall    # Windows source-checkout bare-command uninstall
strada uninstall --purge-config # Also remove Strada runtime state and source-checkout generated artifacts for a zero-install rerun
strada                    # Smart launcher after install-command
strada --daemon           # Start the configured default channel in daemon mode
strada --web              # Open the web channel, or continue web-first setup on a fresh machine
strada --terminal         # Open the terminal channel, or force terminal setup on a fresh machine
./strada setup --web      # Launch the browser wizard directly
./strada setup --terminal # Use the terminal wizard directly
.\strada.ps1 setup --web  # Windows PowerShell browser wizard
.\strada.ps1 setup --terminal # Windows PowerShell terminal wizard
./strada doctor           # Verify install/build/config readiness
.\strada.ps1 doctor       # Windows PowerShell readiness check
./strada start            # Start the agent
./strada supervise        # Run with auto-restart supervisor
./strada update           # Check and apply updates
./strada update --check   # Check for updates without applying
./strada version-info     # Show version, install method, update status
```

### 4. Talk to It

Once running, send a message through your configured channel:

```
> Analyze the project structure
> Create a new module called "Combat" with a DamageSystem and HealthComponent
> Find all systems that query for PositionComponent
> Run the build and fix any errors
```

**Web channel:** No terminal needed -- interact through the web dashboard at `127.0.0.1:3000`.

### 5. Auto-Update

Strada.Brain automatically checks for updates daily and applies them when idle. Source checkouts and `./strada install-command` installs update through git — including automatic `npm install` for new dependencies and a post-update health check that rolls back on failure. After a successful git auto-update, Strada also refreshes the installed bare-command wrappers so `strada` keeps following the current checkout. npm-based update commands only apply after a public npm release exists. Auto-restart only triggers when running under `strada daemon`; direct `strada start` users receive a notification to restart manually. Immediate update checks can be triggered via `POST /api/update` (requires dashboard auth).

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_UPDATE_ENABLED` | `true` | Enable/disable auto-update |
| `AUTO_UPDATE_INTERVAL_HOURS` | `24` | Check frequency (hours) |
| `AUTO_UPDATE_IDLE_TIMEOUT_MIN` | `5` | Minutes idle before applying update |
| `AUTO_UPDATE_CHANNEL` | `latest` | npm dist-tag: `stable` or `latest` |
| `AUTO_UPDATE_NOTIFY` | `true` | Send update notifications when checks or installs occur |
| `AUTO_UPDATE_AUTO_RESTART` | `true` | Auto-restart after update when idle (requires `strada daemon`) |

---

## Web Portal

The built-in web portal (`http://localhost:3000`) provides a full AI workspace with 4 context-adaptive modes:

| Mode | Shortcut | Description |
|------|----------|-------------|
| **Chat** | `Alt+1` | Conversational interface with file attachments, voice input, and markdown rendering |
| **Monitor** | `Alt+2` | Real-time DAG visualization of goal decomposition, task statuses, review pipeline, and intervention controls |
| **Canvas** | `Alt+3` | Visual workspace with tldraw — 9 custom shapes (CodeBlock, UMLClass, APIEndpoint, DataFlow, etc.) auto-generated from agent output |
| **Code** | `Alt+4` | IDE-like view with Monaco editor (multi-tab, syntax highlighting), file tree explorer, and terminal output |

**Auto-switching:** The portal automatically switches modes based on agent activity — goal execution opens Monitor, file writes open Code, visual output opens Canvas. Users can override with manual mode selection; sending a chat message resets the override.

**Keyboard shortcuts:** `Alt+1-4` mode switching, `Cmd/Ctrl+B` toggle sidebar, `Cmd/Ctrl+\` toggle secondary panel, `Cmd/Ctrl+?` shortcuts help.

**Stack:** React 19, Vite, Tailwind CSS v4, shadcn/ui, Zustand, TanStack Query, Radix UI, ReactFlow, tldraw, Monaco Editor.

### Modern UI with Shadcn/UI + 21st.dev

The web portal features a premium glassmorphism design powered by shadcn/ui and community components from [21st.dev](https://21st.dev) and [Magic UI](https://magicui.design):

- **Glassmorphism theme**: `backdrop-blur`, translucent surfaces, glow effects, and micro-interactions across all panels
- **Magic UI components**: NumberTicker (animated metrics), BlurFade (page transitions), BorderBeam (active cards), TypingAnimation ("Thinking..." indicator), SparklesText (brand sparkles), ShimmerButton (send shimmer), CoolMode (confetti easter egg)
- **Sonner notifications**: Toast system with auto-dismiss, severity colors, undo actions + persistent Notification Center sheet
- **Collapsible admin nav**: 11 admin pages accessible from sidebar with route-aware auto-expand
- **Shared primitives**: PageSkeleton, PageError, CopyButton, Sparkline, StatusDot, Badge, Sheet, ScrollArea, Input, Table

---

## Skill Ecosystem

Skills are optional capability bundles you can install, share, and build on top of Strada.Brain. Each skill is a directory with a `SKILL.md` manifest and optional environment configuration.

### Installing skills

```bash
# Install from any public git repository
strada skill install https://github.com/okandemirel/strada-skill-example

# List installed skills and their status
strada skill list

# Update all managed skills
strada skill update

# Search the public registry
strada skill search <query>

# Show details for an installed skill
strada skill info <name>

# Enable or disable a skill
strada skill enable <name>
strada skill disable <name>

# Remove a skill
strada skill remove <name>
```

### Creating a skill

A skill is a directory containing at minimum a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill
version: 1.0.0
description: A short description of what this skill does
author: your-name
requires:
  bins:
    - some-cli-tool        # must exist in PATH
  env:
    - MY_API_KEY           # must be set
  skills:
    - another-skill        # dependency on another skill
capabilities:
  - code-generation
  - analysis
---

The body of SKILL.md is the system prompt or documentation injected into
the agent when this skill is active.
```

### 3-tier loading

Skills are discovered from three locations, in priority order:

| Tier | Location | Purpose |
|------|----------|---------|
| **workspace** | `.strada/skills/` in your project root | Project-specific skills, highest priority |
| **managed** | `~/.strada/skills/` | User-installed skills via `strada skill install` |
| **bundled** | `src/skills/bundled/` inside the Strada.Brain checkout | Shipped with the application, always available |

Skills in a higher-priority tier override those with the same name in lower tiers. A skill whose `requires` conditions are not met is placed in `gated` status and excluded from the active tool surface until its prerequisites are satisfied.

### Registry

The public skill registry is a JSON index of community-maintained skills (11 skills and growing). Run `strada skill search` to browse it. Each entry lists the git repository, description, tags, version, and author. The registry URL is configurable via `SKILL_REGISTRY_URL`.

### Bundled Skills

These skills ship with Strada.Brain and are always available:

| Skill | Description | Requirements |
|-------|-------------|-------------|
| `hello-world` | Test skill that echoes messages | None |
| `github-utils` | PR status, issue list, repo info via `gh` CLI | `gh` binary |
| `unity-helpers` | Find scripts, list scenes, check project structure | None |
| `web-search` | Fetch URLs, search via DuckDuckGo | None |
| `file-utils` | Word count, line count, find duplicates, directory size | None |
| `system-info` | OS uptime, CPU/memory/disk resources, network interfaces | None |
| `json-utils` | Format, query (dot-path), diff/compare JSON objects | None |

### Community Skills

Install from the registry with a single command:

```bash
strada skill install notion
```

| Skill | Description | Requirements |
|-------|-------------|-------------|
| `notion` | Search pages, read content, create pages | `NOTION_API_KEY` |
| `google-calendar` | List events, create events, today's schedule | `GOOGLE_CALENDAR_API_KEY` |
| `spotify` | Now playing, search tracks, playback control | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` |
| `home-assistant` | Entity states, toggle devices, call services | `HA_URL`, `HA_TOKEN` |

### Web Portal Marketplace

The web portal includes a **Marketplace** tab at `/admin/skills` where you can browse, search, and install skills from the community registry with one click. Installed skills appear in the **Installed** tab with enable/disable controls.

---

## Codebase Memory Vault

Persistent, per-project codebase memory that replaces per-request file re-reading with hybrid (BM25 + vector) and symbolic (Personalized PageRank over a call/import graph) retrieval. The vault lets Strada.Brain "know" a Unity project — or its own source — without streaming files into every turn. Massive token savings on large projects.

The vault is opt-in: set `STRADA_VAULT_ENABLED=true`. Once enabled, it boots alongside the agent, indexes Strada.Brain's own source via **SelfVault**, and exposes tools, HTTP APIs, and a portal page.

```bash
# Enable
export STRADA_VAULT_ENABLED=true
npm start

# In any channel
/vault init /path/to/unity/project
/vault sync
/vault status
```

**Two phases shipped:**

- **Phase 1 — Hybrid retrieval**: SQLite per-vault at `<project>/.strada/vault/index.db` (`better-sqlite3`, WAL + foreign_keys). FTS5 BM25 + HNSW vectors fused via Reciprocal Rank Fusion (k=60). Token-budget-aware greedy packing. Three update paths: chokidar watcher (800ms debounce), write-hook (200ms budget), manual `/vault sync`. xxhash64 short-circuit skips unchanged files.
- **Phase 2 — Symbol graph + PPR**: Tree-sitter WASM extractors for TypeScript, C#, and Markdown wikilinks. New tables `vault_symbols`, `vault_edges`, `vault_wikilinks`. Symbol IDs in `<lang>::<relPath>::<qualifiedName>` form. Personalized PageRank re-ranks results when `focusFiles` is set. `graph.canvas` (JSON Canvas 1.0) regenerated atomically on cold start, `/vault sync`, and watcher drain. **SelfVault** indexes Strada.Brain's own source (`src/`, `web-portal/src/`, `tests/`, `docs/`, `AGENTS.md`, `CLAUDE.md`); symlinks are skipped for security.

**Tools** registered with the agent: `vault_init`, `vault_sync`, `vault_status`.

**HTTP surface** at `/api/vaults/*`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vaults/:id/canvas` | Serve `graph.canvas` |
| GET | `/api/vaults/:id/symbols/by-name?q=X` | Find symbols by short name |
| GET | `/api/vaults/:id/symbols/:symbolId/callers` | List incoming call edges |
| POST | `/api/vaults/:id/search` | Hybrid search (request body capped) |

WebSocket `vault:update` broadcasts dirty-set batches.

**Portal**: [`/admin/vaults`](http://localhost:3000/admin/vaults) — Files (tree + markdown/raw preview), Search (hybrid query), Graph (renders `graph.canvas` via `@xyflow/react` + `@dagrejs/dagre`).

**Configuration**: `config.vault.enabled` (env `STRADA_VAULT_ENABLED`), `config.vault.writeHookBudgetMs` (default 200ms), `config.vault.debounceMs` (default 800ms), `config.vault.embeddingFallback` (`'none' | 'local'`), `config.vault.self.enabled` (set to `false` to opt out of SelfVault).

See **[docs/vault.md](docs/vault.md)** for the full reference (architecture, query pipeline, HTTP API shapes, security posture, Phase 3 roadmap).

---

## Architecture

```
+-----------------------------------------------------------------+
|  Chat Channels + Web Portal (4-mode workspace, shadcn/ui + Magic UI) |
|  Web | Telegram | Discord | Slack | WhatsApp | CLI | Matrix     |
|  IRC | Teams                                                     |
+------------------------------+----------------------------------+
                               |
                    IChannelAdapter interface
                               |
+------------------------------v----------------------------------+
|  Orchestrator (PAOR Agent Loop)                                  |
|  Plan -> Act -> Observe -> Reflect state machine                 |
|  Instinct retrieval, failure classification, auto-replan         |
+-------+--------------+-------------+-----------+----------------+
        |              |             |           |
+-------v------+ +-----v------+ +---v--------+ +v-----------------+
| AI Providers | | 30+ Tools  | | Context    | | Learning System  |
| Claude (prim)| | File I/O   | | AgentDB    | | TypedEventBus    |
| OpenAI, Kimi | | Git ops    | | (SQLite +  | | Hybrid weighted  |
| DeepSeek,Qwen| | Shell exec | |  HNSW)     | | Instinct life-   |
| MiniMax, Groq| | .NET build | | RAG vectors| |  cycle           |
| Ollama +more | | Strada gen | | Identity   | | Tool chains      |
+--------------+ +------+-----+ +---+--------+ +--+---------------+
                        |           |              |
                +-------v-----------v--------------v------+
                |  Goal Decomposer + Goal Executor        |
                |  DAG-based decomposition, wave-based    |
                |  parallel execution, failure budgets    |
                +---------+------------------+------------+
                          |                  |
          +---------------v------+  +--------v--------------------+
          | Multi-Agent Manager  |  | Task Delegation             |
          | Per-channel sessions |  | TierRouter (4-tier)         |
          | AgentBudgetTracker   |  | DelegationTool + Manager    |
          | AgentRegistry        |  | Max depth 2, budget-aware   |
          +---------------+------+  +--------+--------------------+
                          |                  |
                +---------v------------------v------------+
                |  Memory Decay & Consolidation           |
                |  Exponential decay, idle consolidation   |
                |  HNSW clustering, soft-delete + undo     |
                +-----------------------------------------+
                               |
            +------------------v-------------------+
            |  Daemon (HeartbeatLoop)              |
            |  Cron, file-watch, checklist,        |
            |  webhook, deploy triggers            |
            |  Circuit breakers, budget tracking,  |
            |  trigger deduplication                |
            |  Notification router + digest reports |
            +------------------+-------------------+
                               |
            +------------------v-------------------+
            |  Deployment Subsystem                |
            |  ReadinessChecker, DeployTrigger      |
            |  DeploymentExecutor                   |
            |  Approval gate + circuit breaker      |
            +--------------------------------------+
```

### How the Agent Loop Works

1. **Message arrives** from a chat channel (text, images, video, audio, or documents)
2. **Memory retrieval** -- AgentDB hybrid search (70% semantic HNSW + 30% TF-IDF) finds the most relevant past conversations
3. **RAG retrieval** -- semantic search over your C# codebase (HNSW vectors, top 6 results)
4. **Instinct retrieval** -- proactively queries learned patterns relevant to the task (semantic + keyword matching)
5. **Identity context** -- injects persistent agent identity (UUID, boot count, uptime, crash recovery state)
6. **Runtime self-improvement layer** -- active runtime artifacts (`skill`, `workflow`, `knowledge_patch`) inject internal guidance; shadow artifacts stay evaluation-only
7. **Execution replay layer** -- prior same-world success/failure branches are injected before planning retries
8. **PLAN phase** -- LLM creates a numbered plan, informed by learned insights and past failures
9. **ACT phase** -- LLM executes tool calls following the plan
10. **OBSERVE** -- results are recorded; error recovery analyzes failures; failure classifier categorizes errors
11. **REFLECT** -- every 3 steps (or on error), LLM decides: **CONTINUE**, **REPLAN**, or **DONE**
12. **Auto-replan** -- if 3+ consecutive same-type failures occur, forces a new approach avoiding failed strategies
13. **Repeat** up to 50 iterations until complete
14. **Learning** -- tool results flow through TypedEventBus to the learning pipeline for immediate pattern storage
15. **Response sent** to the user through the channel (streaming if supported)

**Provider/model selection semantics:** Strada is always the agent talking to the user. Choosing a provider/model does not bypass Strada or send your message directly to that provider. Instead, it sets Strada's primary execution worker. Planning, review, synthesis, routing, and fallback stay inside Strada's current orchestration pool: the configured `PROVIDER_CHAIN`, plus the actively selected worker if you temporarily switch outside that chain.
Strada also keeps ownership of the next step. If a provider returns an incomplete analysis, asks the user what to do next, or makes a broad completion claim without enough evidence, Strada reopens the loop, routes another inspection/review pass, and only returns once the result is verified or a real external blocker remains.

---

## Memory System

The active memory backend is `AgentDBMemory` -- SQLite with HNSW vector indexing and a three-tier auto-tiering architecture.

**Three-tier memory:**
- **Working memory** -- active session context, auto-promoted after sustained use
- **Ephemeral memory** -- short-term storage, auto-evicted when capacity thresholds are reached
- **Persistent memory** -- long-term storage, promoted from ephemeral based on access frequency and importance

**How it works:**
- Session history is trimmed with provider-aware thresholds, and trimmed slices are persisted to memory before they leave the active context window
- Hybrid retrieval combines 70% semantic similarity (HNSW vectors) with 30% TF-IDF keyword matching
- The `strada_analyze_project` tool caches project structure analysis for instant context injection
- Memory persists across restarts in the `MEMORY_DB_PATH` directory (default: `.strada-memory/`)
- The session summarizer updates task execution memory every 10 active messages and again during session cleanup
- Automatic migration from the legacy FileMemoryManager runs on first startup

**Fallback:** If AgentDB initialization fails, the system automatically falls back to `FileMemoryManager` (JSON + TF-IDF).

---

## Learning System

The learning system observes agent behavior and learns from errors through an event-driven pipeline.

**Event-driven pipeline:**
- Tool results flow through `TypedEventBus` to a serial `LearningQueue` for immediate processing
- No timer-based batching -- patterns are detected and stored as they occur
- The `LearningQueue` uses bounded FIFO with error isolation (learning failures never crash the agent)

**Hybrid weighted confidence scoring:**
- Confidence = weighted sum across 5 factors: successRate (0.35), pattern strength (0.25), recency (0.20), context match (0.15), verification (0.05)
- Verdict scores (0.0-1.0) update alpha/beta evidence counters for confidence intervals
- Alpha/beta parameters are maintained for uncertainty estimation but are not used for primary confidence computation

**Instinct lifecycle:**
- **Proposed** (new) -- below 0.7 confidence
- **Active** -- between 0.7 and 0.9 confidence
- **Evolved** -- above 0.9, proposed for promotion to permanent
- **Deprecated** -- below 0.3, marked for removal
- **Cooling period** -- 7-day window with minimum observation requirements before status changes
- **Permanent** -- frozen, no further confidence updates

**Active retrieval:** Instincts are proactively queried at the start of each task using the `InstinctRetriever`. It searches by keyword similarity and HNSW vector embeddings to find relevant learned patterns, which are injected into the PLAN phase prompt.

**Cross-session learning:** Instincts carry provenance metadata (source session, session count) for cross-session knowledge transfer.

---

## Goal Decomposition

Complex multi-step requests are automatically decomposed into a directed acyclic graph (DAG) of sub-goals.

**GoalDecomposer:**
- Heuristic pre-check avoids LLM calls for simple tasks (pattern matching for complexity indicators)
- LLM generates DAG structures with dependency edges and optional recursive depth (up to 3 levels)
- Kahn's algorithm validates cycle-free DAG structure
- Reactive re-decomposition: when a node fails, it can be broken into smaller recovery steps

**Goal Execution (via SupervisorDispatcher):**
- Wave-based parallel execution respects dependency ordering
- Semaphore-based concurrency limiting (`SUPERVISOR_MAX_PARALLEL_NODES`)
- Failure budgets (`SUPERVISOR_MAX_FAILURE_BUDGET`) with configurable thresholds
- Per-node timeout with AbortSignal propagation to fetch layer
- Health-aware provider fallback via ProviderHealthRegistry
- Persistent goal tree state via `GoalStorage` (SQLite) for resume after restart

---

## Tool Chain Synthesis

The agent automatically detects and synthesizes multi-tool chain patterns into reusable composite tools. V2 adds DAG-based parallel execution and saga rollback for complex chains.

**Pipeline:**
1. **ChainDetector** -- analyzes trajectory data to find recurring tool sequences (e.g., `file_read` -> `file_edit` -> `dotnet_build`)
2. **ChainSynthesizer** -- uses LLM to generate a `CompositeTool` with proper input/output mapping and description
3. **ChainValidator** -- post-synthesis validation with runtime feedback; tracks chain execution success via weighted confidence scoring
4. **ChainManager** -- lifecycle orchestrator: loads existing chains on startup, runs periodic detection, auto-invalidates chains when component tools are removed

**V2 enhancements:**
- **DAG execution** -- chains with independent steps run in parallel using dependency-aware scheduling
- **Saga rollback** -- when a chain step fails, previously completed steps are undone in reverse order using registered compensating actions
- **Chain versioning** -- chains track version history; old versions are archived, not deleted

**Security:** Composite tools inherit the most restrictive security flags from their component tools.

**Confidence cascade:** Chain instincts follow the same confidence lifecycle as regular instincts. Chains that drop below the deprecation threshold are automatically unregistered.

---

## Multi-Agent Orchestration

Multiple agent instances can run concurrently with per-channel session isolation.

**AgentManager:**
- Creates and manages agent instances per channel/session
- Session isolation ensures agents on different channels do not interfere with each other
- Enabled by default; set `MULTI_AGENT_ENABLED=false` to keep the legacy single-agent path

**AgentBudgetTracker:**
- Per-agent token and cost tracking with configurable budget limits
- Shared daily/monthly budget caps across all agents
- Budget exhaustion triggers graceful degradation (read-only mode) rather than hard failure

**AgentRegistry:**
- Central registry of all active agent instances
- Supports health checks and graceful shutdown
- When disabled, the system operates identically to the legacy single-agent path

---

## Task Delegation

Agents can delegate sub-tasks to other agents using a tiered routing system.

**TierRouter (4-tier):**
- **Tier 1** -- simple tasks handled by the current agent (no delegation)
- **Tier 2** -- moderate complexity, delegated to a secondary agent
- **Tier 3** -- high complexity, delegated with extended budget
- **Tier 4** -- critical tasks requiring specialized agent capabilities

**DelegationManager:**
- Manages the delegation lifecycle: create, track, complete, cancel
- Enforces maximum delegation depth (default: 2) to prevent infinite delegation loops
- Budget-aware: delegated tasks inherit a portion of the parent's remaining budget

**DelegationTool:**
- Exposed as a tool the agent can invoke to delegate work
- Includes result aggregation from delegated sub-tasks

---

## Memory Decay & Consolidation

Memory entries naturally decay over time using an exponential decay model, while idle consolidation reduces redundancy.

**Exponential decay:**
- Each memory entry has a decay score that decreases over time
- Access frequency and importance boost decay resistance
- Instincts are exempt from decay (never expire)

**Idle consolidation:**
- During low-activity periods, the consolidation engine identifies semantically similar memories using HNSW clustering
- Related memories are merged into consolidated summaries, reducing storage and improving retrieval quality
- Soft-delete with undo: consolidated source memories are marked as consolidated (not physically deleted) and can be restored

**Consolidation engine:**
- Configurable similarity threshold for cluster detection
- Batch processing with configurable chunk sizes
- Full audit trail of consolidation operations

---

## Deployment Subsystem

An opt-in deployment system with human-in-the-loop approval gates and circuit breaker protection.

**ReadinessChecker:**
- Validates system readiness before deployment (build status, test results, resource availability)
- Configurable readiness criteria

**DeployTrigger:**
- Integrates with the daemon's trigger system as a new trigger type
- Fires when deployment conditions are met (e.g., all tests pass, approval granted)
- Includes an approval queue: deployments require explicit human approval before execution

**DeploymentExecutor:**
- Executes deployment steps in sequence with rollback capability
- Environment variable sanitization prevents credential leakage in deployment logs
- Circuit breaker: consecutive deployment failures trigger automatic cooldown to prevent cascading failures

**Security:** Deployment is disabled by default and requires explicit opt-in via configuration. All deployment actions are logged and auditable.

---

### Agent Core (Autonomous OODA Loop)

When daemon mode is active, the Agent Core runs a continuous observe-orient-decide-act loop:

- **Observe**: Collects environment state from the registered observer set. The default daemon wiring currently uses trigger, user-activity, and git-state observers; build/test observers are wired only when those runtime signals are available.
- **Orient**: Scores observations using learning-informed priority (PriorityScorer with instinct integration)
- **Decide**: LLM reasoning with budget-aware throttling (30s minimum interval, priority threshold, budget floor)
- **Act**: Submits goals, notifies user, or waits (agent can decide "nothing to do")

Safety: tickInFlight guard, rate limiting, budget floor (10%), and DaemonSecurityPolicy enforcement.
Authority boundary: Agent Core is a proactive goal generator and notifier, not a parallel replacement for the PAOR executor. Interactive and background task execution still runs through the orchestrator's PAOR loop, verifier pipeline, and shared loop-recovery controls.

### Multi-Provider Intelligent Routing

With 2+ providers configured, Strada.Brain automatically routes tasks to the optimal provider:

| Task Type | Routing Strategy |
|-----------|-----------------|
| Planning | Widest context window (Claude > GPT > Gemini) |
| Code Generation | Strong tool calling (Claude > Kimi > OpenAI) |
| Code Review | Different model than executor (diversity bias) |
| Simple Questions | Fastest/cheapest (Groq > Kimi > Ollama) |
| Debugging | Strong error analysis |

**Presets**: `budget` (cost-optimized), `balanced` (default), `performance` (quality-first)
**PAOR Phase Switching**: Different providers for planning vs execution vs reflection phases.
**Consensus**: Low confidence → automatic second opinion from different provider.

### Strada.MCP Integration

Strada.Brain detects an installed [Strada.MCP](https://github.com/okandemirel/Strada.MCP), verifies the package root, and loads only MCP action tools that are executable in the current Brain runtime into the main toolchain. Detection can be pinned with `STRADA_MCP_PATH`, while missing Strada.Core / Strada.Modules installs use the explicit `STRADA_CORE_REPO_URL` and `STRADA_MODULES_REPO_URL` config values instead of hidden env fallbacks. Installed Strada.Core and Strada.MCP docs/sources remain authoritative knowledge even when bridge or runtime constraints keep some MCP prompts/resources/tools out of the live worker tool surface.

---

## Daemon Mode

The daemon provides 24/7 autonomous operation with a heartbeat-driven trigger system. When daemon mode is active, the **Agent Core OODA loop** runs within daemon ticks, observing the environment and proactively taking action between user interactions. The `/autonomous on` command now propagates to the DaemonSecurityPolicy, enabling fully autonomous operation without per-action approval prompts.

```bash
npm run dev -- start --channel web --daemon
```

**HeartbeatLoop:**
- Configurable tick interval evaluates registered triggers each cycle
- Sequential trigger evaluation prevents budget race conditions
- Persists running state for crash recovery

**Trigger types:**
- **Cron** -- scheduled tasks using cron expressions
- **File watch** -- monitors file system changes in configured paths
- **Checklist** -- fires when checklist items become due
- **Webhook** -- HTTP POST endpoint triggers tasks on incoming requests
- **Deploy** -- proposes deployment after a refreshed readiness check confirms the project is ready (requires approval gate)

**Resilience:**
- **Circuit breakers** -- per-trigger with exponential backoff cooldown, persisted across restarts
- **Budget tracking** -- daily USD spend cap with warning threshold events
- **Trigger deduplication** -- content-based and cooldown-based suppression prevents duplicate fires
- **Overlap suppression** -- skips triggers that already have an active task running

**Security:**
- `DaemonSecurityPolicy` controls which tools require user approval when invoked by daemon triggers
- `ApprovalQueue` with configurable expiration for write operations

**Reporting:**
- `NotificationRouter` routes events to configured channels based on urgency level (silent/low/medium/high/critical)
- Per-urgency rate limiting and quiet hours support (non-critical notifications buffered)
- `DigestReporter` generates periodic summary reports
- All notifications logged to SQLite history

---

## Identity System

The agent maintains a persistent identity across sessions and restarts.

**IdentityStateManager** (SQLite-backed):
- Unique agent UUID generated on first boot
- Boot count, cumulative uptime, last activity timestamps
- Total message and task counters
- Clean shutdown detection for crash recovery
- In-memory counter cache with periodic flush to minimize SQLite writes

**User preferences and web continuity:**
- Natural-language preferences such as assistant name, response format, and ultrathink mode are persisted in the user profile store
- The web channel keeps a stable browser profile via `profileId` + `profileToken`, while reconnects use a rotating `reconnectToken`
- Refreshing `localhost` keeps the same logical web user as long as browser storage remains intact and the user has not explicitly reset the session

**Crash recovery:**
- On startup, if previous session did not shut down cleanly, builds a `CrashRecoveryContext`
- Includes downtime duration, interrupted goal trees, and boot count
- Injected into system prompt so the LLM naturally acknowledges the crash and can resume interrupted work

---

## Configuration Reference

All configuration is via environment variables. See `.env.example` for the full list.

### Minimum Runtime Config

| Variable | Description |
|----------|-------------|
| `UNITY_PROJECT_PATH` | Absolute path to your Unity project root (must contain `Assets/`) |

### AI Providers

Any supported hosted provider works. Configure at least one hosted provider credential, a supported subscription token/session, or include `ollama` in `PROVIDER_CHAIN` for local-only operation.

| Variable | Provider | Default Model |
|----------|----------|---------------|
| `ANTHROPIC_API_KEY` | Claude API key auth | `claude-sonnet-4-20250514` |
| `ANTHROPIC_AUTH_MODE` | Claude auth mode | `api-key` (default) or `claude-subscription` |
| `ANTHROPIC_AUTH_TOKEN` | Claude subscription bearer token | generated via `claude setup-token` when `ANTHROPIC_AUTH_MODE=claude-subscription` |
| `OPENAI_API_KEY` | OpenAI | `gpt-4o` |
| `DEEPSEEK_API_KEY` | DeepSeek | `deepseek-chat` |
| `GROQ_API_KEY` | Groq | `llama-3.3-70b-versatile` |
| `QWEN_API_KEY` | Alibaba Qwen | `qwen-plus` |
| `KIMI_API_KEY` | Moonshot Kimi | `moonshot-v1-8k` |
| `MINIMAX_API_KEY` | MiniMax | `MiniMax-M2.7` |
| `MISTRAL_API_KEY` | Mistral AI | `mistral-large-latest` |
| `TOGETHER_API_KEY` | Together AI | `meta-llama/Llama-3-70b-chat-hf` |
| `FIREWORKS_API_KEY` | Fireworks AI | `accounts/fireworks/models/llama-v3p1-70b-instruct` |
| `GEMINI_API_KEY` | Google Gemini | `gemini-pro` |
| `OLLAMA_BASE_URL` | Ollama (local) | `llama3` |
| `PROVIDER_CHAIN` | Fallback order | e.g. `claude,kimi,deepseek,ollama` |
| `OPENAI_AUTH_MODE` | OpenAI auth mode | `api-key` (default) or `chatgpt-subscription` |
| `OPENAI_CHATGPT_AUTH_FILE` | Optional Codex auth session file | defaults to `~/.codex/auth.json` when `OPENAI_AUTH_MODE=chatgpt-subscription` |

**Provider chain:** Set `PROVIDER_CHAIN` to a comma-separated list of provider names. Strada stays the control plane and uses this chain as the default orchestration pool for the primary execution worker, supervisor routing, and fallback on failure. Example: `PROVIDER_CHAIN=kimi,deepseek,claude` uses Kimi first, DeepSeek if Kimi fails, then Claude. `claude` can be backed by either `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_AUTH_MODE=claude-subscription`; `openai` can be backed by either `OPENAI_API_KEY` or a local ChatGPT/Codex subscription session. All selected response workers must pass startup preflight; setup, doctor, and bootstrap no longer silently drop invalid entries from the configured chain.
Clarification is also part of that control plane. Worker providers may propose a user question, but Strada now runs an internal `clarification-review` phase before any provider draft can become an `ask_user` turn.
Completion now runs through an internal verifier pipeline as well. Build verification, targeted repro / failing-path checks, log review, Strada conformance, and completion review must clear before Strada can finish. `/routing info` and the dashboard now show both runtime execution traces and phase outcomes (`approved`, `continued`, `replanned`, `blocked`).
That completion review now also tracks structured closure state. If a worker says the build is clean but still lists runtime hypotheses, "remaining potential issues", or profiler/debug checks that Strada can continue internally, the task stays open in both interactive and daemon paths until those investigations are either verified or surfaced as a real blocker.
Strada now also keeps plain-text internal plans and intake checklists inside the orchestration loop. If a provider surfaces an execution plan, requirement-gathering checklist, or “what should I act on?” style draft before the work is actually done, Strada reopens the loop instead of sending that draft to the user. The only exception is when the user explicitly asked to review a plan first; in that case Strada preserves the plan-review step instead of auto-approving it internally.
That interaction boundary is now handled by the interaction-policy state machine together with a fail-closed visibility boundary instead of scattered one-off checks. Explicit plan-review requests, clarification gates, write blocking, and user-visible finalization all stay inside Strada's control plane until the relevant approval or verifier condition is satisfied.
Conversation persistence now follows that same boundary. Searchable conversation memory and session summaries ingest only the visible transcript; raw worker drafts, verifier gates, and internal replanning prompts stay in control-plane state and execution journals instead of leaking back through `memory_search`.
Strada now also keeps an internal execution journal and rollback memory for each task. Replans can reuse the last stable checkpoint, remember exhausted branches, carry forward a project/world anchor, and feed adaptive phase scores back into provider routing without hardcoded provider lore. Those adaptive phase scores now factor in verifier clean rate, rollback pressure, retry count, repeated failure fingerprints, repeated world-context failures, phase-local token cost, provider catalog freshness, and official alignment / capability drift from the shared provider catalog.
Memory is now split by role as well: user profile state keeps names/preferences/autonomy, task execution memory keeps session summaries/open items/rollback state, and project/world memory is injected explicitly from the active project root plus cached AgentDB analysis. Task execution memory is only the `latest snapshot` for the active identity, not the `persisted chronology` for an exact task run. That same project/world layer now also feeds recovery memory and adaptive routing, while semantic retrieval still adds live relevant memory separately.
Cross-session `execution replay` now builds on that same path: Strada records project/world-aware recovery summaries into learning trajectories and injects the most relevant prior success/failure branches as an `Execution Replay` context layer before retrying similar work.
That replay context now also persists phase/provider telemetry, so adaptive routing can reuse successful workers for similar tasks instead of relying only on in-memory runtime history.
Terminal replay weighting now also blends the strongest available trajectory verdicts into those persisted signals, preferring trusted judge types before recency, so a branch that looked successful at runtime but was later judged weak carries less routing influence than a cleanly verified one.
Phase-local verdict memory now sits underneath that replay path as well. Runtime phase outcomes persist an explicit `clean` / `retry` / `failure` verdict with a normalized score, so routing and replay can learn from the quality of individual planning / execution / review phases instead of inferring everything from coarse terminal status alone.
Replay correlation is now persisted with chat-scoped `taskRunId` values as well, so same-chat concurrent tasks no longer blend their phase telemetry or recovery history. The `persisted chronology` for an exact task run lives in those learning trajectories and replay contexts keyed by `taskRunId`.
That same learning path now materializes runtime self-improvement artifacts. Repeated high-confidence patterns become `skill`, `workflow`, or `knowledge_patch` artifacts in `shadow` state first; only verifier-backed clean shadow runs can promote them to `active` guidance. `/routing info` exposes the current identity-scoped artifact telemetry for the active project with aggregated samples plus clean/retry/failure/blocker counts, while the dashboard/settings UI shows the split shadow-sample vs active-use counters and the last promotion / rejection / retirement reason.

**Important:** `OPENAI_AUTH_MODE=chatgpt-subscription` only covers OpenAI conversation turns inside Strada. It does not grant OpenAI API billing or embeddings quota. If you choose `EMBEDDING_PROVIDER=openai`, you still need an `OPENAI_API_KEY`.
`ANTHROPIC_AUTH_MODE=claude-subscription` uses a bearer token generated from a local Claude login (`claude auth login --claudeai` then `claude setup-token`). Anthropic documents claude.ai subscription auth as limited to Claude Code and Claude.ai, so this mode is exposed as an advanced, user-assumed-risk option.

### Chat Channels

**Web:**
| Variable | Description |
|----------|-------------|
| `WEB_CHANNEL_PORT` | Port for web dashboard (default: `3000`) |

**Telegram:**
| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `ALLOWED_TELEGRAM_USER_IDS` | Comma-separated Telegram user IDs (required, deny-all if empty) |

**Discord:**
| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_GUILD_ID` | Discord guild ID used for scoped command registration and startup validation |
| `ALLOWED_DISCORD_USER_IDS` | Comma-separated user IDs (deny-all if empty) |
| `ALLOWED_DISCORD_ROLE_IDS` | Comma-separated role IDs for role-based access |

**Slack:**
| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | `xoxb-...` Bot token |
| `SLACK_APP_TOKEN` | `xapp-...` App-level token (for socket mode) |
| `SLACK_SIGNING_SECRET` | Signing secret from Slack app |
| `ALLOWED_SLACK_USER_IDS` | Comma-separated user IDs (**open to all if empty**) |
| `ALLOWED_SLACK_WORKSPACES` | Comma-separated workspace IDs (**open to all if empty**) |

**WhatsApp:**
| Variable | Description |
|----------|-------------|
| `WHATSAPP_SESSION_PATH` | Directory for session files (default: `.whatsapp-session`) |
| `WHATSAPP_ALLOWED_NUMBERS` | Comma-separated phone numbers (optional; empty means open access) |

**Matrix:**
| Variable | Description |
|----------|-------------|
| `MATRIX_HOMESERVER` | Matrix homeserver URL |
| `MATRIX_ACCESS_TOKEN` | Bot access token |
| `MATRIX_USER_ID` | Bot user ID |
| `MATRIX_ALLOWED_USER_IDS` | Comma-separated Matrix user IDs allowed to talk to the bot |
| `MATRIX_ALLOWED_ROOM_IDS` | Comma-separated Matrix room IDs allowed to deliver messages |
| `MATRIX_ALLOW_OPEN_ACCESS` | Set to `true` to allow inbound Matrix traffic without user/room allowlists |

**IRC:**
| Variable | Description |
|----------|-------------|
| `IRC_SERVER` | IRC server hostname |
| `IRC_NICK` | Bot nick |
| `IRC_CHANNELS` | Comma-separated channels to join |
| `IRC_ALLOWED_USERS` | Comma-separated IRC nicknames allowed to trigger the bot |
| `IRC_ALLOW_OPEN_ACCESS` | Set to `true` to allow inbound IRC traffic without a user allowlist |

**Teams:**
| Variable | Description |
|----------|-------------|
| `TEAMS_APP_ID` | Microsoft Teams app ID |
| `TEAMS_APP_PASSWORD` | Microsoft Teams app password |
| `TEAMS_ALLOWED_USER_IDS` | Comma-separated Teams user IDs allowed to message the bot |
| `TEAMS_ALLOW_OPEN_ACCESS` | Set to `true` to allow inbound Teams traffic without a user allowlist |

### Features

| Variable | Default | Description |
|----------|---------|-------------|
| `RAG_ENABLED` | `true` | Enable semantic code search over your C# project |
| `EMBEDDING_PROVIDER` | `auto` | Embedding provider: `auto`, `openai`, `gemini`, `mistral`, `together`, `fireworks`, `qwen`, `ollama` |
| `EMBEDDING_DIMENSIONS` | (provider default) | Output vector dimensions (Matryoshka: 128-3072 for Gemini/OpenAI) |
| `MEMORY_ENABLED` | `true` | Enable persistent conversation memory |
| `MEMORY_DB_PATH` | `.strada-memory` | Directory for memory database files |
| `WEB_CHANNEL_PORT` | `3000` | Web channel UI port |
| `DASHBOARD_ENABLED` | `false` | Enable HTTP monitoring dashboard |
| `DASHBOARD_PORT` | `3100` | Dashboard server port |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | Enable WebSocket real-time dashboard |
| `WEBSOCKET_DASHBOARD_PORT` | `3100` | WebSocket dashboard server port |
| `WEBSOCKET_DASHBOARD_AUTH_TOKEN` | (unset) | Optional bearer token for WebSocket dashboard auth; when present it also protects dashboard APIs, and when absent the embedded same-origin dashboard bootstraps a process-scoped token automatically |
| `WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS` | (unset) | Comma-separated extra allowed origins for the WebSocket dashboard |
| `LLM_STREAM_INITIAL_TIMEOUT_MS` | `600000` | Max time to wait for a streaming response to start before treating it as stalled |
| `LLM_STREAM_STALL_TIMEOUT_MS` | `120000` | Max gap between streaming chunks before treating an in-progress response as stalled |
| `ENABLE_PROMETHEUS` | `false` | Enable Prometheus metrics endpoint (port 9090) |
| `MULTI_AGENT_ENABLED` | `true` | Enable multi-agent orchestration; set to `false` for legacy single-agent mode |
| `TASK_MAX_CONCURRENT` | `3` | Maximum number of background tasks that can run at once across distinct conversations |
| `TASK_MESSAGE_BURST_WINDOW_MS` | `350` | Time window for merging rapid consecutive user messages into one ordered task |
| `TASK_MESSAGE_BURST_MAX_MESSAGES` | `8` | Maximum consecutive messages to merge into a single task burst |
| `TASK_DELEGATION_ENABLED` | `true` | Enable task delegation between agents; delegation only initializes when `MULTI_AGENT_ENABLED=true` |
| `AGENT_MAX_DELEGATION_DEPTH` | `2` | Maximum delegation chain depth |
| `AGENT_MAX_CONCURRENT_DELEGATIONS` | `3` | Maximum concurrent delegations per parent agent |
| `DELEGATION_VERBOSITY` | `normal` | Delegation logging verbosity: `quiet`, `normal`, or `verbose` |
| `DEPLOY_ENABLED` | `false` | Enable deployment subsystem |
| `SOUL_FILE` | `soul.md` | Path to the agent personality file (SOUL.md); hot-reloaded on change |
| `SOUL_FILE_WEB` | (unset) | Per-channel personality override for the web channel |
| `SOUL_FILE_TELEGRAM` | (unset) | Per-channel personality override for Telegram |
| `SOUL_FILE_DISCORD` | (unset) | Per-channel personality override for Discord |
| `SOUL_FILE_SLACK` | (unset) | Per-channel personality override for Slack |
| `SOUL_FILE_WHATSAPP` | (unset) | Per-channel personality override for WhatsApp |
| `READ_ONLY_MODE` | `false` | Block all write operations |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` |

### Routing & Consensus

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTING_PRESET` | `balanced` | Routing preset: `budget`, `balanced`, or `performance` |
| `ROUTING_PHASE_SWITCHING` | `true` | Enable PAOR phase switching across providers |
| `CONSENSUS_MODE` | `auto` | Consensus mode: `auto`, `critical-only`, `always`, or `disabled` |
| `CONSENSUS_THRESHOLD` | `0.5` | Confidence threshold for triggering consensus |
| `CONSENSUS_MAX_PROVIDERS` | `3` | Maximum providers to consult for consensus |
| `MODEL_INTELLIGENCE_ENABLED` | `true` | Enable shared live model/provider catalog refresh |
| `MODEL_INTELLIGENCE_REFRESH_HOURS` | `24` | Refresh cadence for model metadata and official provider-source snapshots |
| `MODEL_INTELLIGENCE_PROVIDER_SOURCES_PATH` | `src/agents/providers/provider-sources.json` | JSON registry of official provider docs/news URLs that feed dynamic provider capabilities and the model selector |
| `STRADA_DAEMON_DAILY_BUDGET` | `1.0` | Daily budget (USD) for daemon mode |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `false` | Enable rate limiting |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | `0` | Per-user message limit (0 = unlimited) |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | `0` | Per-user hourly limit |
| `RATE_LIMIT_TOKENS_PER_DAY` | `0` | Global daily token quota |
| `RATE_LIMIT_DAILY_BUDGET_USD` | `0` | Daily spend cap in USD |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` | `0` | Monthly spend cap in USD |

### Security

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | (unset) | Optional secret for internal system auth and JWT/session flows. Generate with `openssl rand -hex 64` before enabling those features |
| `REQUIRE_MFA` | `false` | Require multi-factor authentication for internal system auth |
| `BROWSER_HEADLESS` | `true` | Run browser automation headless |
| `BROWSER_MAX_CONCURRENT` | `5` | Maximum concurrent browser sessions |

---

## Tools

The agent has 40+ built-in tools organized by category:

### File Operations
| Tool | Description |
|------|-------------|
| `file_read` | Read files with line numbers, offset/limit pagination (512KB limit) |
| `file_write` | Create or overwrite files (256KB limit, auto-creates directories) |
| `file_edit` | Search-and-replace editing with uniqueness enforcement |
| `file_delete` | Delete a single file |
| `file_rename` | Rename or move files within the project |
| `file_delete_directory` | Recursive directory deletion (50-file safety cap) |

### Search
| Tool | Description |
|------|-------------|
| `glob_search` | Find files by glob pattern (max 50 results) |
| `grep_search` | Regex content search across files (max 20 matches) |
| `list_directory` | Directory listing with file sizes |
| `code_search` | Semantic/vector search via RAG -- natural language queries |
| `memory_search` | Search persistent visible conversation memory |

### Strada Code Generation
| Tool | Description |
|------|-------------|
| `strada_analyze_project` | Full C# project scan -- modules, systems, components, services |
| `strada_create_module` | Generate complete module scaffold (`.asmdef`, config, directories) |
| `strada_create_component` | Generate ECS component structs with field definitions |
| `strada_create_mediator` | Generate `EntityMediator<TView>` with component bindings |
| `strada_create_system` | Generate `SystemBase`/`JobSystemBase`/`BurstSystem` scaffolds |

### Git
| Tool | Description |
|------|-------------|
| `git_status` | Working tree status |
| `git_diff` | Show changes |
| `git_log` | Commit history |
| `git_commit` | Stage and commit |
| `git_push` | Push to remote |
| `git_branch` | List, create, or checkout branches |
| `git_stash` | Push, pop, list, or drop stash |

### .NET / Unity
| Tool | Description |
|------|-------------|
| `dotnet_build` | Run `dotnet build`, parse MSBuild errors into structured output |
| `dotnet_test` | Run `dotnet test`, parse pass/fail/skip results |

### Agent Interaction
| Tool | Description |
|------|-------------|
| `ask_user` | Control-plane clarification turn surfaced only after `clarification-review` approves it as truly necessary; workers do not receive it as a normal action tool |
| `show_plan` | Control-plane plan-review turn surfaced only when the user explicitly asked to review a plan first |
| `switch_personality` | Switch agent personality at runtime (casual/formal/minimal/default) |

### Other
| Tool | Description |
|------|-------------|
| `shell_exec` | Execute shell commands (30s timeout, dangerous command blocklist) |
| `code_quality` | Per-file or per-project code quality analysis |
| `rag_index` | Trigger incremental or full project re-indexing |

---

## Chat Commands

Slash commands available in all chat channels:

| Command | Description |
|---------|-------------|
| `/daemon` | Show daemon status |
| `/daemon start` | Start daemon heartbeat loop (when the app was started with `--daemon`) |
| `/daemon stop` | Stop daemon heartbeat loop |
| `/daemon triggers` | Show active triggers |
| `/agent` | Show Agent Core status |
| `/routing` | Show routing status and preset |
| `/routing preset <name>` | Switch routing preset (budget/balanced/performance) |
| `/routing info` | Show recent routing decisions, runtime execution traces, phase outcomes, adaptive phase scores, and current identity-scoped runtime self-improvement telemetry for the active project, including verifier clean rate, rollback pressure, retry count, token-cost telemetry, terminal replay verdict weighting, provider catalog freshness, official alignment / capability drift, and artifact promotion telemetry across planning, execution, clarification-review, review, and synthesis phases |

---

## RAG Pipeline

The RAG (Retrieval-Augmented Generation) pipeline indexes your C# source code for semantic search.

**Indexing flow:**
1. Scans `**/*.cs` files in your Unity project
2. Chunks code structurally -- file headers, classes, methods, constructors
3. Generates embeddings via configured provider -- OpenAI (`text-embedding-3-small`), Gemini (`gemini-embedding-2-preview` with Matryoshka dimensions 128-3072), Mistral, Ollama, or others. Set `EMBEDDING_DIMENSIONS` to control output size.
4. Stores vectors in HNSW index for fast approximate nearest-neighbor search
5. Runs automatically on startup (background, non-blocking)

**Search flow:**
1. Query is embedded using the same provider
2. HNSW search returns `topK * 3` candidates
3. Reranker scores: vector similarity (60%) + keyword overlap (25%) + structural bonus (15%)
4. Top 6 results (above score 0.2) are injected into the LLM context

**Note:** The RAG pipeline currently only supports C# files. The chunker is C#-specific.

---

## Channel Capabilities

| Capability | Web | Telegram | Discord | Slack | WhatsApp | CLI |
|------------|-----|----------|---------|-------|----------|-----|
| Text messaging | Yes | Yes | Yes | Yes | Yes | Yes |
| Media attachments | Yes (base64) | Yes (photo/doc/video/voice) | Yes (any attachment) | Yes (file download) | Yes (image/video/audio/doc) | No |
| Vision (image→LLM) | Yes | Yes | Yes | Yes | Yes | No |
| Streaming (edit-in-place) | Yes | Yes | Yes | Yes | Yes | Yes |
| Typing indicator | Yes | Yes | Yes | No-op | Yes | No |
| Confirmation dialogs | Yes (modal) | Yes (inline keyboard) | Yes (buttons) | Yes (Block Kit) | Yes (numbered reply) | Yes (readline) |
| Thread support | No | No | Yes | Yes | No | No |
| Rate limiter (outbound) | Yes (per-session) | No | Yes (token bucket) | Yes (4-tier sliding window) | Inline throttle | No |

### Streaming

All channels implement edit-in-place streaming. The agent's response appears progressively as the LLM generates it. Updates are throttled per platform to avoid rate limits (WhatsApp/Discord: 1/sec, Slack: 2/sec).

### Authentication

- **Telegram**: Deny-all by default. Must set `ALLOWED_TELEGRAM_USER_IDS`.
- **Discord**: Deny-all by default. Must set `ALLOWED_DISCORD_USER_IDS` or `ALLOWED_DISCORD_ROLE_IDS`.
- **Slack**: **Open by default.** If `ALLOWED_SLACK_USER_IDS` is empty, any Slack user can access the bot. Set the allowlist for production.
- **WhatsApp**: Open by default. If `WHATSAPP_ALLOWED_NUMBERS` is set, the adapter restricts inbound messages to that allowlist.
- **Matrix**: Deny-all by default. Set allowlists or `MATRIX_ALLOW_OPEN_ACCESS=true`.
- **IRC**: Deny-all by default. Set `IRC_ALLOWED_USERS` or `IRC_ALLOW_OPEN_ACCESS=true`.
- **Teams**: Deny-all by default. Set `TEAMS_ALLOWED_USER_IDS` or `TEAMS_ALLOW_OPEN_ACCESS=true`.

---

## Security

### Layer 1: Channel Authentication
Platform-specific allowlists checked at message arrival (before any processing).

### Layer 2: Rate Limiting
Per-user sliding window (minute/hour) + global daily/monthly token and USD budget caps.

### Layer 3: Path Guard
Every file operation resolves symlinks and validates the path stays within the project root. 30+ sensitive patterns are blocked (`.env`, `.git/credentials`, SSH keys, certificates, `node_modules/`).

### Layer 4: Media Security
All media attachments are validated before processing: MIME allowlist (image/video/audio/document), per-type size limits (20MB image, 50MB video, 25MB audio, 10MB document), magic bytes verification (JPEG, PNG, GIF, WebP, MP4, PDF), and SSRF protection on download URLs (blocks private IPs, metadata endpoints, rejects redirects).

### Layer 5: Secret Sanitizer
24 regex patterns detect and mask credentials in all tool outputs before they reach the LLM. Covers: OpenAI keys, GitHub tokens, Slack/Discord/Telegram tokens, AWS keys, JWTs, Bearer auth, PEM keys, database URLs, and generic secret patterns.

### Layer 6: Read-Only Mode
When `READ_ONLY_MODE=true`, 23 write tools are removed from the agent's tool list entirely -- the LLM cannot even attempt to call them.

### Layer 7: Operation Confirmation
Write operations (file writes, git commits, shell execution) can require user confirmation via the channel's interactive UI (buttons, inline keyboards, text prompts).

### Layer 8: Tool Output Sanitization
All tool results are capped at 8192 characters and scrubbed for API key patterns before feeding back to the LLM.

### Layer 9: RBAC (Internal)
5 roles (superadmin, admin, developer, viewer, service) with a permission matrix covering 9 resource types. Policy engine supports time-based, IP-based, and custom conditions.

### Layer 10: Daemon Security
`DaemonSecurityPolicy` enforces tool-level approval requirements for daemon-triggered operations. Write tools require explicit user approval via the `ApprovalQueue` before execution.

---

## Dashboard and Monitoring

### HTTP Dashboard (`DASHBOARD_ENABLED=true`)
Accessible at `http://localhost:3100` (localhost only by default). Shows: uptime, message count, token usage, active sessions, tool usage table, security stats. Auto-refreshes every 3 seconds.

### Health Endpoints
- `GET /health` -- Liveness probe (`{"status":"ok"}`)
- `GET /ready` -- Deep readiness: checks memory and channel health. Returns 200 (ready), 207 (degraded), or 503 (not ready)

### Prometheus (`ENABLE_PROMETHEUS=true`)
Metrics at `http://localhost:9090/metrics`. Counters for messages, tool calls, tokens. Histograms for request duration, tool duration, LLM latency. Default Node.js metrics (CPU, heap, GC, event loop).

### WebSocket Dashboard (`ENABLE_WEBSOCKET_DASHBOARD=true`)
Real-time metrics are pushed every second. Supports authenticated access, heartbeat monitoring, and app-registered command handlers or notifications. If `WEBSOCKET_DASHBOARD_AUTH_TOKEN` is set, use that bearer token. If it is unset, the embedded same-origin dashboard bootstraps a process-scoped token automatically instead of running unauthenticated.

### Metrics System
`MetricsStorage` (SQLite) records task completion rate, iteration counts, tool usage, and pattern reuse. `MetricsRecorder` captures metrics per-session. `metrics` CLI command displays historical metrics.

---

## Deployment

### Docker

```bash
docker-compose up -d
```

The `docker-compose.yml` includes the application, monitoring stack, and nginx reverse proxy.

### Daemon Mode

```bash
# 24/7 autonomous operation with heartbeat loop and proactive triggers
node dist/index.js start --channel web --daemon

# Auto-restarts on crash with exponential backoff (1s to 60s, up to 10 restarts)
node dist/index.js supervise --channel telegram
```

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set `LOG_LEVEL=warn` or `error`
- [ ] Configure `RATE_LIMIT_ENABLED=true` with budget caps
- [ ] Set channel allowlists (especially Slack -- open by default)
- [ ] Set `READ_ONLY_MODE=true` if you want safe exploration only
- [ ] Enable `DASHBOARD_ENABLED=true` for monitoring
- [ ] Enable `ENABLE_PROMETHEUS=true` for metric collection
- [ ] Generate a strong `JWT_SECRET`
- [ ] Configure daemon budget limits (`RATE_LIMIT_DAILY_BUDGET_USD`)

---

## Testing

```bash
npm test                         # Default full suite (batched for stability)
npm run test:watch               # Watch mode
npm test -- --coverage           # With coverage
npm test -- src/agents/tools/file-read.test.ts  # Single file / targeted passthrough
npm test -- src/dashboard/prometheus.test.ts    # Targeted suite under the default runner
LOCAL_SERVER_TESTS=1 npm test -- src/dashboard/prometheus.test.ts src/dashboard/websocket-server.test.ts
npm run sync:check -- --core-path /path/to/Strada.Core  # Validate Strada.Core API drift
npm run test:file-build-flow     # Opt-in local .NET integration flow
npm run test:unity-fixture       # Opt-in local Unity fixture compile/test flow
npm run test:hnsw-perf           # Opt-in HNSW benchmark / recall suite
npm run test:portal              # Web portal smoke tests
npm run typecheck                # TypeScript type checking
npm run lint                     # ESLint
```

Notes:
- `npm test` uses a batched Vitest runner plus forked workers to avoid the previous full-suite OOM path.
- Bind-dependent dashboard tests are skipped by default unless `LOCAL_SERVER_TESTS=1`.
- `sync:check` validates Strada.Brain's Strada.Core knowledge against a real checkout; CI enforces it with `--max-drift-score 0`.
- `test:file-build-flow`, `test:unity-fixture`, and `test:hnsw-perf` are intentionally opt-in because they depend on local build tooling, a licensed Unity editor, or benchmark-heavy workloads.
- `test:unity-fixture` may still fail if the local Unity batchmode / licensing environment is unhealthy, even when the generated code is correct.

---

## Project Structure

```
src/
  index.ts              # CLI entry point (Commander.js)
  core/
    bootstrap.ts              # Full initialization sequence -- delegates to helper modules
    bootstrap-channels.ts     # Channel initialization logic
    bootstrap-memory.ts       # Memory subsystem initialization
    bootstrap-providers.ts    # LLM provider initialization
    bootstrap-wiring.ts       # Service wiring and dependency injection
    bootstrap-stages.ts       # Re-exports from bootstrap-stages/ directory
    bootstrap-stages/
      bootstrap-stages-types.ts # Shared types for bootstrap stages
      stage-agents.ts           # Agent subsystem initialization stage
      stage-daemon.ts           # Daemon subsystem initialization stage
      stage-finalization.ts     # Final startup checks and readiness
      stage-goals.ts            # Goal subsystem initialization stage
      stage-knowledge.ts        # Knowledge/RAG initialization stage
      stage-providers.ts        # Provider initialization stage
      stage-runtime.ts          # Runtime services initialization stage
      index.ts                  # Barrel re-export
    event-bus.ts              # TypedEventBus for decoupled event-driven communication
    tool-registry.ts          # Tool instantiation and registration
  agents/
    orchestrator.ts                    # PAOR agent loop, session management, streaming
    orchestrator-clarification.ts      # Clarification flow handling
    orchestrator-context-builder.ts    # Conversation context assembly
    orchestrator-interaction-policy.ts # Interaction policy enforcement
    orchestrator-phase-telemetry.ts    # Phase-level telemetry and metrics
    orchestrator-runtime-utils.ts      # Runtime helper utilities
    orchestrator-session-persistence.ts # Session save/restore logic
    orchestrator-supervisor-routing.ts  # Supervisor delegation routing
    orchestrator-text-utils.ts          # Text processing helpers
    agent-state.ts      # Phase state machine (Plan/Act/Observe/Reflect)
    paor-prompts.ts     # Phase-aware prompt builders
    instinct-retriever.ts # Proactive learned-pattern retrieval
    failure-classifier.ts # Error categorization and auto-replan triggers
    autonomy/           # Error recovery, task planning, self-verification
    context/            # System prompt (Strada.Core knowledge base)
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq, + more
    tools/              # 30+ tool implementations plus control-plane interaction turns (ask_user, show_plan, switch_personality, ...)
    soul/               # SOUL.md personality loader with hot-reload and per-channel overrides
    plugins/            # External plugin loader
    multi/
      agent-manager.ts         # Multi-agent lifecycle and session isolation
      agent-budget-tracker.ts  # Per-agent budget tracking
      agent-registry.ts        # Central registry of active agents
      delegation/
        delegation-manager.ts  # Delegation lifecycle management
        delegation-tool.ts     # Agent-facing delegation tool
        tier-router.ts         # 4-tier task routing
  profiles/             # Personality profile files: casual.md, formal.md, minimal.md
  channels/
    telegram/           # Grammy-based bot
    discord/            # discord.js bot with slash commands
    slack/              # Slack Bolt (socket mode) with Block Kit
    whatsapp/           # Baileys-based client with session management
    web/                # Local HTTP + WebSocket web channel
    cli/                # Readline REPL
  web-portal/           # React + Vite chat UI (dark/light theme, file upload, streaming, dashboard tab, side panel)
  memory/
    file-memory-manager.ts   # Legacy backend: JSON + TF-IDF (fallback)
    unified/
      agentdb-memory.ts        # Active backend: SQLite + HNSW, 3-tier auto-tiering
      agentdb-sqlite.ts        # SQLite operations and query helpers
      agentdb-vector.ts        # HNSW vector index operations
      agentdb-tiering.ts       # 3-tier auto-tiering logic
      agentdb-retrieval.ts     # Memory retrieval and search
      agentdb-time.ts          # Time-based decay and scoring
      agentdb-adapter.ts       # IMemoryManager adapter for AgentDBMemory
      user-profile-store.ts    # User profile persistence
      session-summarizer.ts    # Session summary generation
      task-execution-store.ts  # Task execution history storage
      hnsw-write-mutex.ts      # HNSW concurrent write protection
      sqlite-pragmas.ts        # SQLite PRAGMA configuration
      migration.ts             # Legacy FileMemoryManager -> AgentDB migration
      consolidation-engine.ts  # Idle memory consolidation with HNSW clustering
      consolidation-types.ts   # Consolidation type definitions and interfaces
    decay/                    # Exponential memory decay system
  rag/
    rag-pipeline.ts     # Index + search + format orchestration
    chunker.ts          # C#-specific structural chunking
    hnsw/               # HNSW vector store (hnswlib-node)
    embeddings/         # OpenAI and Ollama embedding providers
    reranker.ts         # Weighted reranking (vector + keyword + structural)
  learning/
    pipeline/
      learning-pipeline.ts  # Pattern detection, instinct creation, evolution proposals
      learning-queue.ts     # Serial async processor for event-driven learning
      embedding-queue.ts    # Bounded async embedding generation
    scoring/
      confidence-scorer.ts  # Hybrid weighted confidence (5-factor), Elo, Wilson intervals
    matching/
      pattern-matcher.ts    # Keyword + semantic pattern matching
    hooks/
      error-learning-hooks.ts  # Error/resolution capture hooks
    storage/
      learning-storage.ts  # SQLite storage for instincts, trajectories, patterns
      migrations/          # Schema migrations (cross-session provenance)
    chains/
      chain-detector.ts    # Recurring tool sequence detection
      chain-synthesizer.ts # LLM-based composite tool generation
      composite-tool.ts    # Executable composite tool
      chain-validator.ts   # Post-synthesis validation, runtime feedback
      chain-manager.ts     # Full lifecycle orchestrator
  goals/
    goal-decomposer.ts  # DAG-based goal decomposition (proactive + reactive)
    goal-executor.ts    # Wave-based parallel execution with failure budgets
    goal-validator.ts   # Kahn's algorithm DAG cycle detection
    goal-storage.ts     # SQLite persistence for goal trees
    goal-progress.ts    # Progress tracking and reporting
    goal-resume.ts      # Resume interrupted goal trees after restart
    goal-renderer.ts    # Goal tree visualization
  daemon/
    heartbeat-loop.ts   # Core tick-evaluate-fire loop
    trigger-registry.ts # Trigger registration and lifecycle
    daemon-storage.ts   # SQLite persistence for daemon state
    daemon-events.ts    # Typed event definitions for daemon subsystem
    daemon-cli.ts       # CLI commands for daemon management
    budget/
      budget-tracker.ts # Daily USD budget tracking
    resilience/
      circuit-breaker.ts # Per-trigger circuit breaker with exponential backoff
    security/
      daemon-security-policy.ts  # Tool approval requirements for daemon
      approval-queue.ts          # Approval request queue with expiration
    dedup/
      trigger-deduplicator.ts    # Content + cooldown deduplication
    triggers/
      cron-trigger.ts        # Cron expression scheduling
      file-watch-trigger.ts  # File system change monitoring
      checklist-trigger.ts   # Due-date checklist items
      webhook-trigger.ts     # HTTP POST webhook endpoint
      deploy-trigger.ts      # Deployment condition trigger with approval gate
    deployment/
      deployment-executor.ts # Deployment execution with rollback
      readiness-checker.ts   # Pre-deployment readiness validation
    reporting/
      notification-router.ts # Urgency-based notification routing
      digest-reporter.ts     # Periodic summary digest generation
      digest-formatter.ts    # Format digest reports for channels
      quiet-hours.ts         # Non-critical notification buffering
  identity/
    identity-state.ts   # Persistent agent identity (UUID, boot count, uptime)
    crash-recovery.ts   # Crash detection and recovery context
  tasks/
    task-manager.ts     # Task lifecycle management
    task-storage.ts     # SQLite task persistence
    background-executor.ts # Background task execution with goal integration
    message-router.ts   # Message routing to orchestrator
    command-detector.ts # Slash command detection
    command-handler.ts  # Command execution
  metrics/
    metrics-storage.ts  # SQLite metrics storage
    metrics-recorder.ts # Per-session metric capture
    metrics-cli.ts      # CLI metrics display command
  utils/
    media-processor.ts  # Media download, validation (MIME/size/magic bytes), SSRF protection
  skills/
    types.ts                  # SkillManifest, SkillEntry, SkillStatus, RegistryEntry types
    skill-loader.ts           # 3-tier skill discovery (bundled / managed / workspace)
    skill-gating.ts           # Prerequisite gate checks (bins, env, config, skill deps)
    skill-config.ts           # Per-skill enable/disable persistence (skills.json)
    skill-env-injector.ts     # Injects skill env vars into process.env at activation
    skill-manager.ts          # High-level lifecycle: load, enable, disable, install, remove
    skill-cli.ts              # `strada skill` subcommands (install, list, update, search, info, ...)
    skill-registry-client.ts  # Fetches and searches the remote JSON registry index
    frontmatter-parser.ts     # YAML frontmatter extraction from SKILL.md files
  security/             # Auth, RBAC, path guard, rate limiter, secret sanitizer
  intelligence/         # C# parsing, project analysis, code quality
  dashboard/            # HTTP, WebSocket, Prometheus dashboards
  config/               # Zod-validated environment configuration
  validation/           # Input validation schemas
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code conventions, and PR guidelines.

See [AGENTS.md](AGENTS.md) for detailed coding conventions, architecture patterns, and agent-specific guidelines used when working with AI coding assistants inside this repository.

---

## License

MIT License - see [LICENSE](LICENSE) for details.
