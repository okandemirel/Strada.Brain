# Plan 015: Make /api/settings/voice persist and hydrate the portal's actual voice preferences

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aea95ad..HEAD -- src/dashboard/server-settings-routes.ts web-portal/src/pages/settings/VoiceSection.tsx web-portal/src/hooks/use-voice-settings.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

The portal's Voice settings section (Voice Input / Voice Output / Browser STT toggles) saves to `localStorage` and "best-effort" POSTs to `/api/settings/voice`. A backend handler for that route **already exists** and persists to SQLite — but it reads fields named `enabled` / `language` / `speed`, while the portal sends `inputEnabled` / `outputEnabled` / `browserSttEnabled`. The POST therefore returns `{"success": true}` while persisting **nothing**, and the portal never calls GET, so nothing is ever hydrated back. The user's voice preference silently fails to survive a browser change or a `localStorage` wipe. This plan aligns the contract: the backend persists the fields the portal actually sends, GET returns them, and the portal hydrates from GET on mount.

## Current state

Relevant files:

- `src/dashboard/server-settings-routes.ts` — settings/budget routes for the dashboard HTTP server; the voice handler is at lines 115–162. It IS registered and reachable (dispatched from `src/dashboard/server.ts:676` via `handleSettingsRoutes`).
- `web-portal/src/pages/settings/VoiceSection.tsx` — the portal settings section with three toggles; POSTs on toggle (lines 50–60), never GETs, and the Browser STT toggle (lines 92–97) doesn't sync at all.
- `web-portal/src/hooks/use-voice-settings.ts` — `VoiceSettings` shape + localStorage persistence (`loadVoiceSettings` / `saveVoiceSettings` / `useVoiceSettings` hook).
- `src/daemon/daemon-storage.ts` — SQLite-backed settings overrides used by the handler (lines 579–588): `getSettingsOverride(key, scope = "global"): string | undefined` and `setSettingsOverride(key, value, scope = "global"): void`.
- `src/dashboard/server-types.ts:477` — `readJsonBody: <T>(req, res, maxBytes?) => Promise<T | null>` on `RouteContext` (sends the error response itself and resolves `null` on bad input).

The portal's settings shape (`web-portal/src/hooks/use-voice-settings.ts:3-7`):

```ts
export interface VoiceSettings {
  inputEnabled: boolean
  outputEnabled: boolean
  browserSttEnabled: boolean
}
```

What the portal POSTs (`web-portal/src/pages/settings/VoiceSection.tsx:50-60`). Note the parameter type annotation is narrower than what is actually passed — callers pass the full `VoiceSettings` object (`{ ...prev, inputEnabled: next }`), so `browserSttEnabled` rides along in the body:

```ts
const syncToBackend = useCallback(async (next: { inputEnabled: boolean; outputEnabled: boolean }) => {
  try {
    await fetch('/api/settings/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    })
  } catch {
    // Best-effort backend sync; local state already saved.
  }
}, [])
```

The Browser STT toggle does NOT sync (`VoiceSection.tsx:92-97`):

```ts
const handleBrowserSttToggle = useCallback(
  (next: boolean) => {
    updateVoiceSettings((prev) => ({ ...prev, browserSttEnabled: next }))
  },
  [updateVoiceSettings],
)
```

What the backend reads/writes today (`src/dashboard/server-settings-routes.ts:124-158`) — none of these field names match what the portal sends:

```ts
if (method === "GET" || method === "HEAD") {
  const storage = ctx.daemonStorage;
  const enabled = storage.getSettingsOverride("voice_enabled", chatId);
  const language = storage.getSettingsOverride("voice_language", chatId);
  const speed = storage.getSettingsOverride("voice_speed", chatId);
  sendJson(res, {
    enabled: enabled !== undefined ? enabled === "true" : null,
    language: language ?? null,
    speed: speed !== undefined ? parseFloat(speed) : null,
    chatId,
  });
  return true;
}

if (method === "POST") {
  void ctx.readJsonBody<Record<string, unknown>>(req, res).then((parsed) => {
    if (!parsed) return;
    try {
      const storage = ctx.daemonStorage!;
      if (parsed.enabled !== undefined) {
        storage.setSettingsOverride("voice_enabled", String(Boolean(parsed.enabled)), chatId);
      }
      if (parsed.language !== undefined) { /* voice_language */ }
      if (parsed.speed !== undefined) { /* voice_speed */ }
      sendJson(res, { success: true });
    } catch (err) { /* 400 */ }
  });
  return true;
}
```

Verified facts (recon, 2026-06-11):

- `grep -rn "settings/voice" web-portal/src/` → exactly one hit: the POST in `VoiceSection.tsx:52`. The portal never GETs this route.
- `grep -rn "voice_enabled\|voice_language\|voice_speed" src/ --include="*.ts" | grep -v test` → only `server-settings-routes.ts` itself. No other consumer of these keys exists, so the legacy `enabled`/`language`/`speed` fields are dead weight but harmless — keep them for compatibility, do not remove.
- There is no test file for `server-settings-routes.ts` (`ls src/dashboard/ | grep test` shows no `server-settings-routes.test.ts`).

Conventions:

- Dashboard route tests mock raw `IncomingMessage`/`ServerResponse` with `EventEmitter` — see `src/dashboard/canvas-routes.test.ts` (top of file) as the structural pattern.
- Portal component tests use vitest + `@testing-library/react` — see `web-portal/src/pages/settings/BudgetSection.test.tsx` as the structural pattern.
- Commit style: conventional commits (e.g. `feat(openai): auto-refresh expired ChatGPT/Codex subscription tokens`, `fix(setup): restore a placeholder index.html ...`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck (backend) | `npm run typecheck:src` | exit 0 |
| Lint (backend) | `npm run lint:src` | exit 0 |
| Single backend test | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-settings-routes.test.ts` | all pass |
| Portal typecheck | `npm --prefix web-portal run typecheck` | exit 0 |
| Portal lint | `npm --prefix web-portal run lint` | exit 0 |
| Portal tests | `npm --prefix web-portal run test` | all pass |
| Portal build | `npm --prefix web-portal run build` | exit 0 |

All commands run from `/Users/okanunico/Documents/Strada/Strada.Brain`.

## Scope

**In scope** (the only files you should modify/create):

- `src/dashboard/server-settings-routes.ts` (modify — voice handler only, lines 115–162)
- `src/dashboard/server-settings-routes.test.ts` (create)
- `web-portal/src/pages/settings/VoiceSection.tsx` (modify)
- `web-portal/src/pages/settings/VoiceSection.test.tsx` (create)

**Out of scope** (do NOT touch, even though they look related):

- Agent-initiated TTS announcements / a `tts_announce` tool — deferred follow-up (see Maintenance notes).
- `src/core/incoming-audio-transcription.ts`, `src/core/local-stt-engine.ts`, `web-portal/src/components/VoiceRecorder.tsx`, `web-portal/src/hooks/use-browser-stt.ts` — the STT input pipeline is complete and working; do not modify it.
- `web-portal/src/hooks/use-voice-settings.ts` — localStorage persistence stays as-is; hydration happens inside `VoiceSection.tsx` via `updateVoiceSettings`.
- `web-portal/src/components/ChatInput.tsx` and `VoiceOutput.tsx` — they consume `useVoiceSettings` and need no change.
- The legacy `enabled`/`language`/`speed` fields and their `voice_enabled`/`voice_language`/`voice_speed` storage keys — keep them working unchanged.
- `src/daemon/daemon-storage.ts` — the override API already does everything needed.

## Git workflow

- Branch: `advisor/015-voice-settings-persistence`
- Commit per step or per logical unit; conventional commits, e.g. `feat(dashboard): persist portal voice settings fields in /api/settings/voice`.
- Do NOT push or open a PR.

## Steps

### Step 1: Investigate and confirm current state

Run these and confirm each expected result before changing anything:

1. `grep -n "inputEnabled\|outputEnabled\|browserSttEnabled" src/dashboard/server-settings-routes.ts`
   → **no output** (backend doesn't know these fields yet). If there IS output, the gap may already be fixed — STOP and report.
2. `grep -rn "settings/voice" web-portal/src/`
   → exactly one hit, the POST in `web-portal/src/pages/settings/VoiceSection.tsx` (around line 52). If a GET appears, STOP and report.
3. `grep -rn "voice_input_enabled\|voice_output_enabled\|voice_browser_stt" src/ --include="*.ts"`
   → no output (new storage keys unused).
4. `ls src/dashboard/server-settings-routes.test.ts 2>&1`
   → "No such file or directory".
5. `git log --oneline -1` → note the SHA; run the drift check from the header.

**Verify**: all four greps/ls match the expectations above.

### Step 2: Extend the backend voice handler (GET + POST)

In `src/dashboard/server-settings-routes.ts`, inside the existing `/api/settings/voice` block (lines 115–162), keep everything that exists and add the three portal fields. Storage keys: `voice_input_enabled`, `voice_output_enabled`, `voice_browser_stt_enabled`, scoped by the existing `chatId` variable (defaults to `"global"`).

GET — add three fields to the existing `sendJson` payload (same null-when-unset pattern as `enabled`):

```ts
const inputEnabled = storage.getSettingsOverride("voice_input_enabled", chatId);
const outputEnabled = storage.getSettingsOverride("voice_output_enabled", chatId);
const browserSttEnabled = storage.getSettingsOverride("voice_browser_stt_enabled", chatId);
sendJson(res, {
  enabled: enabled !== undefined ? enabled === "true" : null,
  language: language ?? null,
  speed: speed !== undefined ? parseFloat(speed) : null,
  inputEnabled: inputEnabled !== undefined ? inputEnabled === "true" : null,
  outputEnabled: outputEnabled !== undefined ? outputEnabled === "true" : null,
  browserSttEnabled: browserSttEnabled !== undefined ? browserSttEnabled === "true" : null,
  chatId,
});
```

POST — inside the existing `.then((parsed) => { ... })` `try` block, after the `speed` branch, add (only persist booleans; ignore non-boolean values rather than coercing truthy strings):

```ts
if (typeof parsed.inputEnabled === "boolean") {
  storage.setSettingsOverride("voice_input_enabled", String(parsed.inputEnabled), chatId);
}
if (typeof parsed.outputEnabled === "boolean") {
  storage.setSettingsOverride("voice_output_enabled", String(parsed.outputEnabled), chatId);
}
if (typeof parsed.browserSttEnabled === "boolean") {
  storage.setSettingsOverride("voice_browser_stt_enabled", String(parsed.browserSttEnabled), chatId);
}
```

Also update the doc comment block at the top of the file only if it enumerates fields (currently it only lists routes — then no change needed).

**Verify**: `npm run typecheck:src` → exit 0. `npm run lint:src` → exit 0.

### Step 3: Add backend route tests

Create `src/dashboard/server-settings-routes.test.ts`, modeled structurally on `src/dashboard/canvas-routes.test.ts` (vitest, `EventEmitter`-based req/res fakes, mocked logger). Build a minimal `RouteContext` stub:

- `daemonStorage`: in-memory `Map<string, string>` keyed by `` `${key}::${scope}` `` exposing `getSettingsOverride(key, scope = "global")` and `setSettingsOverride(key, value, scope = "global")`.
- `readJsonBody`: `vi.fn()` returning a `Promise` that resolves to the parsed body object (or `null` for the bad-body case).
- A fake `res` capturing `writeHead`/`end` so the test can parse the JSON written.

Cases to cover (see Test plan). Cast the stub via `as unknown as RouteContext` if the full type is too wide — match how `canvas-routes.test.ts` handles typing.

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-settings-routes.test.ts` → all tests pass.

### Step 4: Hydrate and fully sync VoiceSection in the portal

In `web-portal/src/pages/settings/VoiceSection.tsx`:

1. Widen `syncToBackend`'s parameter type from `{ inputEnabled: boolean; outputEnabled: boolean }` to `VoiceSettings` (import the type from `../../hooks/use-voice-settings`).
2. Make `handleBrowserSttToggle` call `void syncToBackend(updated)` exactly like the other two toggles (build `updated` inside `updateVoiceSettings` and return it).
3. Add a mount-time hydration effect: GET `/api/settings/voice`; if the response is ok and any of `inputEnabled` / `outputEnabled` / `browserSttEnabled` is a boolean (not `null`), merge those non-null values into local settings via `updateVoiceSettings((prev) => ({ ...prev, ...serverValues }))`. Wrap in `try/catch` and ignore failures (offline backend must not break the page — same best-effort spirit as the existing POST). Use an `useEffect` with `[]`-style deps (`updateVoiceSettings` is a stable `useCallback`; include it in deps to satisfy lint). Guard against state updates after unmount with a `cancelled` flag, matching the common pattern in `web-portal/src/pages/settings/RateLimitsSection.tsx:52-66` (its mount-time `fetch(...).then(...).finally(...)` hydration).

**Verify**: `npm --prefix web-portal run typecheck` → exit 0; `npm --prefix web-portal run lint` → exit 0.

### Step 5: Add portal component test

Create `web-portal/src/pages/settings/VoiceSection.test.tsx`, modeled on `web-portal/src/pages/settings/BudgetSection.test.tsx` (vitest + `@testing-library/react`). Stub `fetch` with `vi.stubGlobal('fetch', vi.fn(...))`. Cover the cases in the Test plan. Clear `localStorage` between tests (`localStorage.removeItem('strada-voice-settings')` in `beforeEach`) so hydration assertions are deterministic. Use `waitFor` from testing-library for the async hydration assertion.

**Verify**: `npm --prefix web-portal run test` → all pass, including the new file.

### Step 6: Full verification sweep

Run the complete command table: backend typecheck, backend lint, the new backend test, portal typecheck, portal lint, portal tests, portal build.

**Verify**: every command in "Commands you will need" exits 0 / all tests pass. `git status` shows only the four in-scope files changed/created.

## Test plan

Backend — `src/dashboard/server-settings-routes.test.ts` (pattern: `src/dashboard/canvas-routes.test.ts`):

1. GET `/api/settings/voice` with empty storage → `{ inputEnabled: null, outputEnabled: null, browserSttEnabled: null, chatId: "global", ... }`.
2. POST `{ inputEnabled: false, outputEnabled: true, browserSttEnabled: true }` → `{ success: true }`; storage now holds `voice_input_enabled = "false"`, `voice_output_enabled = "true"`, `voice_browser_stt_enabled = "true"` under scope `global`.
3. GET after that POST → `{ inputEnabled: false, outputEnabled: true, browserSttEnabled: true, ... }` (round-trip).
4. POST with `?chatId=abc` persists under scope `abc`, and GET with `?chatId=abc` reads it back while plain GET (global) still returns nulls.
5. Legacy regression: POST `{ enabled: true, language: "tr", speed: 1.25 }` still persists `voice_enabled`/`voice_language`/`voice_speed` and GET returns them — proves the old contract is intact.
6. Non-boolean junk (`{ inputEnabled: "yes" }`) is ignored: response `{ success: true }`, storage unchanged for that key.
7. Unsupported method (e.g. PUT) → 405.

Portal — `web-portal/src/pages/settings/VoiceSection.test.tsx` (pattern: `web-portal/src/pages/settings/BudgetSection.test.tsx`):

1. On mount, the component GETs `/api/settings/voice`; when the stubbed response returns `{ inputEnabled: false, outputEnabled: false, browserSttEnabled: true }`, the toggles reflect those values (query the `role="switch"` buttons' `aria-checked`).
2. Clicking the Browser STT toggle issues a POST to `/api/settings/voice` whose body includes `browserSttEnabled` (this is the regression the plan fixes — it previously never synced).
3. GET failure (fetch rejects) leaves defaults intact and renders without crashing.

Verification: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-settings-routes.test.ts` and `npm --prefix web-portal run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck:src` exits 0
- [ ] `npm run lint:src` exits 0
- [ ] `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-settings-routes.test.ts` → all pass (≥ 7 tests)
- [ ] `npm --prefix web-portal run typecheck`, `lint`, `test`, `build` all exit 0
- [ ] `grep -n "voice_browser_stt_enabled" src/dashboard/server-settings-routes.ts` returns ≥ 2 matches (GET + POST)
- [ ] `grep -c "syncToBackend" web-portal/src/pages/settings/VoiceSection.tsx` ≥ 4 (definition + three toggle call sites)
- [ ] `git status` shows changes only in the four in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `/api/settings/voice` block in `server-settings-routes.ts` no longer matches the excerpt in "Current state" (someone already reworked the contract).
- Step 1's grep finds `inputEnabled` already handled in the backend, or a GET call to `settings/voice` already in the portal.
- `grep -rn "voice_enabled" src/ --include="*.ts" | grep -v test | grep -v server-settings-routes` returns matches — a consumer of the legacy keys exists that recon didn't find; changing this handler could affect it.
- The portal test harness cannot render `VoiceSection` (e.g. missing jsdom/i18n setup that `BudgetSection.test.tsx` doesn't reveal) after one reasonable fix attempt.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Deferred follow-up (out of scope here)**: agent-initiated TTS announcements (a `tts_announce` tool that lets the agent speak proactively through `VoiceOutput.tsx`). The server-side persisted `outputEnabled` value added by this plan is the preference such a feature would consult.
- The legacy `enabled`/`language`/`speed` fields have no consumer anywhere in `src/` — a future cleanup could remove them, but only after confirming no external client uses them.
- Reviewer should scrutinize: the POST handler must not coerce non-boolean values (test 6), and hydration must not clobber local settings when the server returns `null` fields (fresh install).
- `web-portal/src/components/ChatInput.tsx:375` already gates the mic button on `voice.inputEnabled` — server hydration now makes that gate consistent across browsers.
