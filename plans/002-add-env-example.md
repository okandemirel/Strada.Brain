# Plan 002: Create the missing `.env.example` referenced by CONTRIBUTING.md

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aea95ad..HEAD -- CONTRIBUTING.md src/config/config.ts .gitignore`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

`CONTRIBUTING.md` line 22 tells every new contributor to run
`cp .env.example .env` — but `.env.example` does not exist anywhere in the
repo, so the documented onboarding flow fails at step 3. The config system
(`src/config/config.ts`, ~3690 lines) reads 282 distinct environment
variables; without a template, contributors have no discoverable list of what
can be configured. This plan generates a complete, grouped, placeholder-only
`.env.example` from the actual env reads in the config code.

## Current state

- `CONTRIBUTING.md:21-23` — the broken instruction:

  ```
  # Copy environment config
  cp .env.example .env
  # Fill in at least ANTHROPIC_API_KEY and JWT_SECRET
  ```

- `.env.example` — **does not exist** (`ls .env.example` → No such file).
- `.gitignore:4` — contains exactly `.env` (not `.env*`), so `.env.example`
  will NOT be ignored. No .gitignore change needed.
- `src/config/config.ts` — the single source of env reads. It does **not**
  use `process.env.FOO` property access; it reads through an env map:
  - `config.ts:3302`: `const defaultEnv = process.env;`
  - All reads look like `env["ANTHROPIC_API_KEY"]` (e.g. lines 2985–3060).
  - There is also an `export type EnvVarName = | "ANTHROPIC_API_KEY" | ...`
    union near the top of the file (starts ~line 38) listing the same names.
  - Verified count: `grep -oE 'env\["[A-Z_0-9]+"\]' src/config/config.ts | sort -u | wc -l` → **282**.
- Required-vs-optional facts (verified in `src/config/config.ts`):
  - `config.ts:1979` — zod refine: `"At least one AI provider API key is
    required (or use Ollama)"`. So no single provider key is individually
    required; at least one of the provider keys (or Ollama config) is.
  - `config.ts:1027` — `jwtSecret: z.string().min(1).optional()` —
    JWT_SECRET is optional in the schema (CONTRIBUTING overstates it).
  - Channel credentials are conditionally required only when that channel is
    enabled (see `config.ts:3544-3592`: `TELEGRAM_BOT_TOKEN is required`,
    `DISCORD_BOT_TOKEN is required`, `SLACK_BOT_TOKEN` /
    `SLACK_SIGNING_SECRET`, `WHATSAPP_SESSION_PATH`,
    `MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, and MATRIX_USER_ID`,
    `IRC_SERVER`, `TEAMS_APP_ID and TEAMS_APP_PASSWORD`).
  - `config.ts:1033` — `unityProjectPath: z.string().min(1, "UNITY_PROJECT_PATH is required")`
    (required within its sub-schema; check its optionality at the parent
    level when writing the comment for it).
- Note on dotenv loading: `config.ts:31` loads dotenv from
  `resolveDotenvPath(...)` (`src/common/runtime-paths.ts:83`), which is
  `<configRoot>/.env` — for a source checkout that is the repo root. The
  `cp .env.example .env` instruction is therefore correct for contributors.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Enumerate env reads | `grep -oE 'env\["[A-Z_0-9]+"\]' src/config/config.ts \| sed 's/env\["//; s/"\]//' \| sort -u` | 282 names, one per line |
| Cross-check vs union type | `awk '/export type EnvVarName =/,/;$/' src/config/config.ts \| grep -oE '"[A-Z_0-9]+"' \| tr -d '"' \| sort -u` | similar list |
| Stragglers outside config.ts | `grep -rhoE 'process\.env\[\"[A-Z_0-9]+\"\]' src --include="*.ts" \| grep -oE '[A-Z_0-9]{2,}' \| sort -u` | small list (e.g. STRADA_AGENT_NAME, LOG_LEVEL) |
| Typecheck (sanity) | `npm run typecheck:src` | exit 0 |
| Not gitignored | `git check-ignore .env.example; echo "exit=$?"` | `exit=1` (not ignored) |

## Scope

**In scope** (the only files you should modify/create):
- `.env.example` (create, repo root)
- `CONTRIBUTING.md` (one-line wording fix, see Step 3)

**Out of scope** (do NOT touch, even though they look related):
- `src/config/config.ts` — read-only input for this plan.
- `.gitignore` — already correct (`.env` exact match does not cover `.env.example`).
- `web-portal/` — the portal has no env template requirement.
- Multi-language docs under `docs/` — deferred (see Maintenance notes).

## Git workflow

- Branch: `advisor/002-add-env-example`
- One commit, conventional style, e.g.:
  `docs(setup): add .env.example matching the 282 config env vars`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Generate the canonical variable list

Run the three enumeration commands from "Commands you will need". Union the
results (the `env["..."]` read list is authoritative; the `EnvVarName` union
should match it — if a name appears in one but not the other, include it
anyway). From the stragglers list, include only app-config vars (e.g.
`STRADA_AGENT_NAME`); exclude generic runtime vars like `NODE_ENV`, `CI`,
`HOME`, `PATH`, and test-only vars (`LOCAL_DOTNET_TESTS`,
`LOCAL_UNITY_FIXTURE_TESTS`, `HNSW_PERF_TESTS`).

**Verify**: `grep -oE 'env\["[A-Z_0-9]+"\]' src/config/config.ts | sed 's/env\["//; s/"\]//' | sort -u | wc -l` → `282`. Your working list has ≥ 282 entries.

### Step 2: Write `.env.example`

Create `/Users/okanunico/Documents/Strada/Strada.Brain/.env.example` with ALL
variables from Step 1, following these rules exactly:

1. **Placeholders only — NEVER real values.** Every variable line is either
   `VAR=` (empty value) or commented out `# VAR=`. Do not invent example keys
   that look real (no `sk-...`, no `ghp_...`, no token-shaped strings).
2. **Required section first, uncommented.** Open with a header block:

   ```bash
   # =============================================================================
   # Strada.Brain environment configuration
   # Copy to .env and fill in:  cp .env.example .env
   #
   # REQUIRED: at least ONE AI provider API key below (or configure Ollama via
   # OLLAMA_BASE_URL / OLLAMA_MODEL). Everything else is optional or only
   # required when the corresponding feature/channel is enabled.
   # =============================================================================

   # --- AI Providers (at least one required; Ollama needs no key) ---
   ANTHROPIC_API_KEY=
   OPENAI_API_KEY=
   ...
   ```

3. **All optional vars commented out** (`# VAR=`), grouped by section with a
   one-line section comment. Use these groups, in this order (derive
   membership from the variable name prefixes):
   - AI Providers (keys, auth modes, `*_MODEL` overrides, `PROVIDER_CHAIN`,
     `SYSTEM_PRESET`, Ollama, OpenCode)
   - Channels — Telegram, Discord, Slack, WhatsApp, Matrix, IRC, Teams (note
     in the section comment: "required only when this channel is enabled",
     mirroring the validation messages at `config.ts:3544-3592`)
   - Security (`JWT_SECRET`, `REQUIRE_MFA`, `REQUIRE_EDIT_CONFIRMATION`,
     `READ_ONLY_MODE`)
   - Unity / Strada (`UNITY_*`, `STRADA_CORE_REPO_URL`,
     `STRADA_MODULES_REPO_URL`, `STRADA_MCP_PATH`)
   - Obsidian vault (`OBSIDIAN_*`)
   - Dashboard / WebSocket / Prometheus (`DASHBOARD_*`, `WEBSOCKET_*`,
     `ENABLE_*`)
   - Memory / RAG / Embeddings (`MEMORY_*`, `RAG_*`, `EMBEDDING_*`)
   - Rate limits & budget (`RATE_LIMIT_*`)
   - Learning (`BAYESIAN_*`, `STRADA_INSTINCT_*`, `STRADA_CROSS_SESSION_*`)
   - Goals (`GOAL_*`)
   - Daemon (`STRADA_DAEMON_*`)
   - Logging & misc (`LOG_LEVEL`, `LOG_FILE`, `SHELL_ENABLED`,
     `STREAMING_ENABLED`, `PLUGIN_DIRS`, `SCRIPT_EXECUTE_ENABLED`,
     `REFLECTION_INVOKE_ENABLED`, `STRADA_AGENT_NAME`, anything left over)
   Any variable that fits no group goes into the final misc group — every
   name from Step 1 MUST appear exactly once.
4. Where the validation code states a conditional requirement, say so in a
   trailing comment on the section header, not per-line prose.

**Verify** (all three):
- Every enumerated var present:
  `grep -oE 'env\["[A-Z_0-9]+"\]' src/config/config.ts | sed 's/env\["//; s/"\]//' | sort -u | while read v; do grep -qE "^#? ?$v=" .env.example || echo "MISSING: $v"; done`
  → no output.
- No real-looking secrets:
  `grep -nE '(sk-[A-Za-z0-9]|ghp_|gho_|xox[bap]-|AKIA[0-9A-Z]|-----BEGIN)' .env.example; echo "exit=$?"` → `exit=1` (no matches).
- All values empty:
  `grep -vE '^(#|$|[A-Z_0-9]+=$)' .env.example | head` → no output (every
  non-comment, non-blank line is `VAR=` with empty value).

### Step 3: Fix the CONTRIBUTING.md wording

In `CONTRIBUTING.md` line 23, the comment says
`# Fill in at least ANTHROPIC_API_KEY and JWT_SECRET`. The schema says JWT_SECRET
is optional (`config.ts:1027`) and any one provider key suffices
(`config.ts:1979`). Change that single line to:

```
# Fill in at least one AI provider key (e.g. ANTHROPIC_API_KEY); see .env.example comments
```

Do not change anything else in CONTRIBUTING.md.

**Verify**: `grep -n "Fill in at least" CONTRIBUTING.md` → shows the new
wording on one line; `git diff --stat CONTRIBUTING.md` → 1 file changed,
1 insertion, 1 deletion.

### Step 4: Confirm the documented flow now works

```bash
git check-ignore .env.example; echo "exit=$?"     # expect exit=1
cp .env.example /tmp/strada-env-test && rm /tmp/strada-env-test
npm run typecheck:src
```

**Verify**: check-ignore exits 1 (not ignored); cp succeeds; typecheck exits 0
(nothing in src/ changed, this is a sanity gate).

## Test plan

No unit tests — `.env.example` is documentation, and `src/config/config.test.ts`
already covers config parsing. The machine-checkable gates in Step 2's Verify
(completeness, no secrets, empty values) are the test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.env.example` exists at repo root and `git check-ignore .env.example` exits 1
- [ ] Completeness loop from Step 2 prints no `MISSING:` lines
- [ ] Secret-pattern grep from Step 2 finds no matches
- [ ] Empty-value grep from Step 2 prints no output
- [ ] `CONTRIBUTING.md` no longer claims JWT_SECRET is required
- [ ] `npm run typecheck:src` exits 0
- [ ] `git status --porcelain` shows only `.env.example` (new) and `CONTRIBUTING.md` (modified)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The enumeration command returns a count wildly different from 282 (±10 is
  fine — the file may have drifted; ±100 means the read pattern changed).
- You find yourself wanting to write any value that isn't empty or an
  obviously fake placeholder — don't; report instead.
- `.env.example` turns out to be gitignored (`.gitignore` drifted to `.env*`).
- A `.env` file with real values exists in the repo root — do NOT read it,
  do NOT copy from it, and mention it in your report.

## Maintenance notes

- When a new env var is added to `EnvVarName` / the `env["..."]` reads in
  `config.ts`, `.env.example` must be updated by hand. A future follow-up
  could add a drift test that runs the Step 2 completeness loop in CI
  (deliberately out of scope here).
- The 8-language docs under `docs/` reference setup flows; updating them is
  tracked separately in the project backlog ("Multi-language docs update").
- Reviewer should scrutinize: zero non-empty values, and that grouping didn't
  drop any variable (the completeness loop is the authority, not eyeballs).
