# Plan 022: Remove `unsafe-inline` from the web-channel CSP via a hashed inline script

> **Executor instructions**: Follow step by step. Run every verification command.
> On any "STOP condition", stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat cc8f814..HEAD -- src/channels/web/channel.ts web-portal/index.html`
> If changed, compare excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

The web channel — which serves the actual user-facing React portal — sends a CSP
with `script-src … 'unsafe-inline'`, defeating CSP's core XSS protection. The
dashboard server already proves the strict alternative works: it ships
`script-src 'sha256-<hash>'` (no `unsafe-inline`) by hashing its single inline
script. This plan brings the web channel to the same posture.

The reason `unsafe-inline` is there: the portal's `index.html` contains **one
inline pre-paint theme script**. Hashing it (CSP `'sha256-…'`) lets us drop
`unsafe-inline` without a flash-of-wrong-theme regression.

## Current state

- Web-channel CSP, `src/channels/web/channel.ts:737–747` (in `SECURITY_HEADERS`):
  ```ts
  "Content-Security-Policy":
    "default-src 'self'; " +
    "script-src 'self' https://cdn.jsdelivr.net blob: 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data: https://cdn.jsdelivr.net; " +
    "worker-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none';",
  ```
- The **only** inline script (portal entry `web-portal/index.html`):
  ```html
  <script>document.documentElement.setAttribute('data-theme',localStorage.getItem('strada-theme')||'dark')</script>
  ```
  Everything else is a module script with a hashed `/assets/*.js` src (self-origin) — those don't need `unsafe-inline`.
- **`cdn.jsdelivr.net` is a real runtime dependency**, not removable here: the STT
  worker `src/channels/web/static/assets/whisper-worker-*.js` sets
  `wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@.../dist/"`.
  So jsdelivr must remain reachable for the WASM the worker fetches.
- Reference pattern (dashboard), `src/dashboard/server.ts:1923` + `:609`:
  ```ts
  const SCRIPT_HASH = createHash("sha256").update(SCRIPT_CONTENT).digest("base64");
  // … `script-src 'sha256-${SCRIPT_HASH}'` …
  ```

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Compute the inline-script hash | `printf %s "document.documentElement.setAttribute('data-theme',localStorage.getItem('strada-theme')||'dark')" \| openssl dgst -sha256 -binary \| openssl base64` | a base64 string |
| Find every inline script in the entry | `grep -nE "<script>(.*)</script>" web-portal/index.html` | exactly one match (the theme setter) |
| Typecheck | `npm run typecheck:src` | exit 0 |
| Targeted test | `npx vitest run src/channels/web/channel.test.ts` | all pass |
| Build portal (manual visual check) | `npm run build:portal` | exit 0 |

## Scope

**In scope**:
- `src/channels/web/channel.ts` (the CSP string)
- `src/channels/web/channel.test.ts` (assert the new CSP + hash-drift guard; create if absent)

**Out of scope** (do NOT touch):
- `cdn.jsdelivr.net` allowances — keep them; the STT WASM worker needs them. (Self-hosting the transformers WASM to drop the CDN entirely is a separate, larger plan — note it in Maintenance, do not attempt here.)
- `style-src 'unsafe-inline'` — React/Tailwind inject runtime styles; tightening styles is a separate effort with higher regression risk. Leave it.
- `web-portal/index.html` content — do NOT change the inline script (its hash is the contract). If it must change, the hash changes with it.

## Git workflow

- Branch: `fix/022-web-csp-hash`
- Commit: `fix(web): drop script-src unsafe-inline via hashed inline theme script`

## Steps

### Step 1: Confirm there is exactly one inline script

Run the grep above on `web-portal/index.html`. If there is more than one inline
`<script>` (without `src`), every one must be hashed; if a module script has
inline content, STOP and report (the approach assumes one classic inline script).

### Step 2: Compute the hash and update the CSP

Compute the sha256 (Commands table). Replace the `script-src` directive:
```
script-src 'self' https://cdn.jsdelivr.net blob: 'sha256-<HASH>';
```
i.e. **remove `'unsafe-inline'`**, **add `'sha256-<HASH>'`**, keep `'self'`,
`https://cdn.jsdelivr.net` (WASM), and `blob:` (workers).

> If the browser console later reports the WASM compile is blocked, add
> `'wasm-unsafe-eval'` to `script-src` (modern browsers require it for
> `WebAssembly.compile`); note it in the PR. Do not add `'unsafe-eval'`.

**Verify**: `npm run typecheck:src` → 0; the CSP string contains `'sha256-` and no `'unsafe-inline'` in `script-src`.

### Step 3: Add a drift-guard test

In `channel.test.ts`, add a test that:
- reads `web-portal/index.html`, extracts the inline `<script>` inner text,
- computes its sha256/base64,
- asserts the CSP's `script-src` contains exactly that `'sha256-…'` and does NOT contain `'unsafe-inline'`.

This fails loudly if someone edits the theme script without updating the CSP.

**Verify**: `npx vitest run src/channels/web/channel.test.ts` → all pass.

### Step 4: Manual smoke (record result in PR)

Build the portal (`npm run build:portal`), serve the web channel, load it in a
browser, and confirm: no CSP violations in DevTools console, theme applies with
no flash, and (if STT is enabled) the Whisper worker still loads. If you cannot
run a browser in this environment, state that explicitly and leave the test from
Step 3 as the automated guarantee.

## Test plan

- New `channel.test.ts` test: CSP `script-src` has the correct inline-script hash and no `unsafe-inline`.
- Manual: DevTools shows zero CSP errors; theme + STT worker still function.

## Done criteria

ALL must hold:

- [ ] `script-src` in `channel.ts` has `'sha256-…'` and no `'unsafe-inline'`
- [ ] `grep -c "unsafe-inline" src/channels/web/channel.ts` shows it remains ONLY in `style-src` (count 1)
- [ ] `npx vitest run src/channels/web/channel.test.ts` passes incl. the hash-drift test
- [ ] `npm run typecheck:src` exits 0
- [ ] `cdn.jsdelivr.net` still present in `script-src`/`font-src`; only `unsafe-inline` removed from scripts
- [ ] `plans/README.md` row updated

## STOP conditions

- More than one inline script exists, or a module script carries inline content — report; the single-hash approach won't cover it (may need a nonce strategy).
- The built `index.html` transforms the inline script so its text differs from the source (the hash wouldn't match what's served) — STOP; the hash must be computed from the **served/built** inline content, not just the source.
- Removing `unsafe-inline` breaks portal load in the smoke test for a reason other than the theme script — report before forcing.

## Maintenance notes

- The inline theme script's text is now a CSP contract; the Step-3 test enforces it. If the script changes, regenerate the hash.
- Follow-up deferred (separate plan): self-host the `@huggingface/transformers` WASM under `/assets` to drop `cdn.jsdelivr.net` from the CSP entirely, and tighten `style-src` off `unsafe-inline`.
- Reviewer should verify the dashboard and web-channel CSPs are now consistent in posture (hash-based scripts).
