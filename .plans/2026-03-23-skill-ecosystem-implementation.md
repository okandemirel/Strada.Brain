# Skill Ecosystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a complete skill ecosystem for Strada.Brain — SKILL.md manifest parsing, 3-tier loading, lifecycle management, CLI commands (install/remove/list/update/search), git-based registry client, per-skill env injection, and binary/env/config gating.

**Architecture:** 8 new files in `src/skills/` implementing the skill pipeline: frontmatter parser → types → gating → env injection → skill config → loader → manager → CLI. Reuses existing `PluginRegistry` from `src/plugins/registry.ts` for dependency resolution and lifecycle. Integrates into bootstrap via `src/core/bootstrap.ts` and CLI via `src/index.ts`.

**Tech Stack:** TypeScript (strict mode), Vitest, ESM modules, zero new npm dependencies, git CLI for skill install/update

**Spec:** `docs/specs/2026-03-23-skill-ecosystem-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| **Create** | `src/skills/types.ts` | `SkillManifest`, `SkillEntry`, `SkillStatus`, `RegistryEntry` interfaces |
| **Create** | `src/skills/frontmatter-parser.ts` | Zero-dep YAML frontmatter parser (restricted subset) |
| **Create** | `src/skills/skill-gating.ts` | Binary/env/config requirement checks |
| **Create** | `src/skills/skill-env-injector.ts` | Per-skill env injection + restore |
| **Create** | `src/skills/skill-config.ts` | Read/write `~/.strada/skills.json` |
| **Create** | `src/skills/skill-loader.ts` | 3-tier discovery + SKILL.md parsing + tool loading |
| **Create** | `src/skills/skill-manager.ts` | Lifecycle orchestration (wraps PluginRegistry) |
| **Create** | `src/skills/skill-registry-client.ts` | GitHub registry fetch, cache, search |
| **Create** | `src/skills/skill-cli.ts` | Commander subcommands for `strada skill` |
| **Modify** | `src/index.ts` | Wire `registerSkillCommands(program)` |
| **Modify** | `src/core/bootstrap.ts` | Wire `SkillManager.loadAll()` after tool registry init |

---

### Task 1: Types + Frontmatter Parser

**Files:**
- Create: `src/skills/types.ts`
- Create: `src/skills/frontmatter-parser.ts`
- Create: `src/skills/frontmatter-parser.test.ts`

- [ ] **Step 1: Create types.ts with all interfaces**

All types from the spec: `SkillRequirements`, `SkillManifest`, `SkillStatus`, `SkillEntry`, `RegistryEntry`, `SkillRegistry`, `SkillConfig`. See spec "SKILL.md Manifest Format" and "Git-Based Registry" sections.

- [ ] **Step 2: Create frontmatter-parser.ts**

Parse SKILL.md frontmatter (restricted YAML subset per spec):
- Split on `---` delimiters
- Top-level `key: value` pairs
- JSON-style arrays `["a", "b"]`
- 1-level nested objects via 2-space indentation
- Double-quoted strings for values containing colons
- Returns `{ data: Record<string, unknown>, content: string }`

- [ ] **Step 3: Write comprehensive tests for frontmatter parser**

Test: basic key-value, arrays, nested objects, quoted colons, missing frontmatter, empty frontmatter, content preserved, full SKILL.md example from spec.

- [ ] **Step 4: Run tests and TS check**

Run: `npx vitest run src/skills/frontmatter-parser.test.ts && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/skills/types.ts src/skills/frontmatter-parser.ts src/skills/frontmatter-parser.test.ts
git commit -m "feat(skills): add types and frontmatter parser"
```

---

### Task 2: Skill Gating + Env Injector + Config

**Files:**
- Create: `src/skills/skill-gating.ts`
- Create: `src/skills/skill-env-injector.ts`
- Create: `src/skills/skill-config.ts`
- Create: `src/skills/skill-gating.test.ts`
- Create: `src/skills/skill-config.test.ts`

- [ ] **Step 1: Implement skill-gating.ts**

`checkGates(requires, config)` → `{ passed: boolean, reasons: string[] }`. Use `execFileNoThrow` from `src/utils/execFileNoThrow.ts` for binary detection (NOT `execSync` — avoids shell injection). Check `which`/`where` for bins, `process.env` for env vars, dot-path traversal for config keys.

- [ ] **Step 2: Implement skill-env-injector.ts**

`SkillEnvInjector` class with `inject(name, env)` and `restore(name)`. Snapshot-and-restore pattern per spec.

- [ ] **Step 3: Implement skill-config.ts**

`readSkillConfig()`, `writeSkillConfig()`, `setSkillEnabled()`. Reads/writes `~/.strada/skills.json`.

- [ ] **Step 4: Write tests for gating and config**

Mock `execFileNoThrow` for binary detection. Test env injection + restore. Test config read/write with mocked fs.

- [ ] **Step 5: Run tests and TS check**

- [ ] **Step 6: Commit**

```bash
git add src/skills/skill-gating.ts src/skills/skill-env-injector.ts src/skills/skill-config.ts src/skills/skill-gating.test.ts src/skills/skill-config.test.ts
git commit -m "feat(skills): add gating, env injection, and config management"
```

---

### Task 3: Skill Loader (3-tier discovery + tool loading)

**Files:**
- Create: `src/skills/skill-loader.ts`
- Create: `src/skills/skill-loader.test.ts`

- [ ] **Step 1: Implement skill-loader.ts**

`discoverSkills(projectRoot?, extraDirs?)` — scan 3 tiers (`<project>/skills/`, `~/.strada/skills/`, `src/skills/bundled/`), parse SKILL.md from each `*/SKILL.md`, validate required fields, merge by name (higher tier wins).

`loadSkillTools(skill)` — ESM dynamic import with nonce cache busting (copy pattern from `src/agents/plugins/plugin-loader.ts` lines 80-120). Namespace tools as `skill_{name}_{tool}`, set `isPlugin: true`. Collision detection: warn on duplicate tool names instead of crashing.

- [ ] **Step 2: Write tests**

Test: discover from multiple tiers, override precedence, invalid SKILL.md skipped, tool namespacing, collision warning.

- [ ] **Step 3: Run tests and TS check**

- [ ] **Step 4: Commit**

```bash
git add src/skills/skill-loader.ts src/skills/skill-loader.test.ts
git commit -m "feat(skills): add 3-tier skill discovery and tool loading"
```

---

### Task 4: Skill Manager (lifecycle wrapping PluginRegistry)

**Files:**
- Create: `src/skills/skill-manager.ts`
- Create: `src/skills/skill-manager.test.ts`

- [ ] **Step 1: Implement skill-manager.ts**

`SkillManager` class that:
1. Calls `discoverSkills()` and `readSkillConfig()`
2. For each skill: check disabled → check gates → load tools → inject env → register in PluginRegistry
3. Calls `registry.initializeAll()` for ordered initialization
4. Exposes `getEntries()`, `dispose()`
5. `setToolRegistrar(registrar, remover)` for wiring with ToolRegistry

Adapter: `toPluginMetadata(manifest)` and `toPlugin(skill, tools)` per spec section "Reusing PluginRegistry".

- [ ] **Step 2: Write tests**

Test: loadAll with mock discovered skills, disabled skill skipped, gated skill marked, error handling, dispose restores env.

- [ ] **Step 3: Run tests and TS check**

- [ ] **Step 4: Commit**

```bash
git add src/skills/skill-manager.ts src/skills/skill-manager.test.ts
git commit -m "feat(skills): add SkillManager with lifecycle and PluginRegistry integration"
```

---

### Task 5: Registry Client

**Files:**
- Create: `src/skills/skill-registry-client.ts`
- Create: `src/skills/skill-registry-client.test.ts`

- [ ] **Step 1: Implement skill-registry-client.ts**

`fetchRegistry(forceRefresh?)` — fetch `registry.json` from GitHub (use native `fetch`), cache at `~/.strada/skill-registry.json` with 1-hour TTL, fallback to cache on failure.

`searchRegistry(registry, query)` — substring match on name/description/tags.

- [ ] **Step 2: Write tests**

Test: search by name, by tag, cache read/write, fallback on fetch failure, expired cache refresh.

- [ ] **Step 3: Run tests and TS check**

- [ ] **Step 4: Commit**

```bash
git add src/skills/skill-registry-client.ts src/skills/skill-registry-client.test.ts
git commit -m "feat(skills): add git-based registry client with cache and search"
```

---

### Task 6: CLI Commands + Wiring

**Files:**
- Create: `src/skills/skill-cli.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement skill-cli.ts**

`registerSkillCommands(program: Command)` — adds `strada skill` subcommand group with: install, remove, list, update, search, info.

Key behaviors per spec:
- **install:** Check git in PATH (use `execFileNoThrow`), resolve URL via registry or direct, `git clone`, validate SKILL.md, gate check, enable in config
- **remove:** Check dependents (via PluginRegistry pattern), delete dir, remove from config. `--cascade` flag for force.
- **list:** Discover all skills, print table (name, version, tier, status)
- **update:** `git pull` in skill dir, or `--all` for all managed
- **search:** Fetch registry, filter, print. `--refresh` flag.
- **info:** Read and print SKILL.md + gating status

- [ ] **Step 2: Wire into src/index.ts**

Add `import { registerSkillCommands } from "./skills/skill-cli.js";` and call `registerSkillCommands(program);` after the existing `registerDaemonCommands` call.

- [ ] **Step 3: Verify TS compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/skills/skill-cli.ts src/index.ts
git commit -m "feat(skills): add strada skill CLI commands and wire into main"
```

---

### Task 7: Bootstrap Integration + Bundled Test Skill

**Files:**
- Modify: `src/core/bootstrap.ts`
- Create: `src/skills/bundled/hello-world/SKILL.md`
- Create: `src/skills/bundled/hello-world/index.ts`

- [ ] **Step 1: Read bootstrap.ts** to find ToolRegistry init location

- [ ] **Step 2: Wire SkillManager into bootstrap**

After tool registry initialization, create SkillManager, wire tool registrar/remover, call `loadAll()`.

- [ ] **Step 3: Create hello-world bundled skill**

A minimal test skill with one `echo` tool. SKILL.md with `name: hello-world`, `version: 1.0.0`. index.ts exporting `tools: ITool[]` with a simple echo tool.

- [ ] **Step 4: Run full test suite**

Run: `npm test`

- [ ] **Step 5: Verify TS compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/core/bootstrap.ts src/skills/bundled/
git commit -m "feat(skills): wire into bootstrap and add hello-world bundled skill"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All existing + new skill tests pass

- [ ] **Step 2: Verify TS compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Test CLI**

Run: `npx tsx src/index.ts skill list`
Expected: Shows hello-world as active/bundled

- [ ] **Step 4: Count new files**

Run: `find src/skills -name "*.ts" | wc -l`
Expected: ~16 files (8 source + 8 test)
