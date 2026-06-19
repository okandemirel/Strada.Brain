# Plan 029: Remove the dashboard → learning-internals layering violation

> **Executor instructions**: Behavior-preserving. Follow step by step, run every
> verification command, and on any "STOP condition" stop and report. Update
> `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat cc8f814..HEAD -- src/dashboard/server-provider-routes.ts src/learning/runtime-artifact-manager.ts`
> If changed, re-locate `projectScopeMatches` before proceeding.

## Status

- **Priority**: P4
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

The dashboard (API surface) reaches into a learning-layer module's body to borrow
a helper: `server-provider-routes.ts` imports the **value** `projectScopeMatches`
from `../learning/runtime-artifact-manager.js`. That couples the dashboard to a
heavy learning-internals module (and pulls its transitive imports into the
dashboard's module graph). Moving the shared helper to a small leaf module breaks
the coupling without changing behavior.

## Current state (verified)

- `src/dashboard/server-provider-routes.ts:17` — `import { projectScopeMatches } from "../learning/runtime-artifact-manager.js";`
- used at `server-provider-routes.ts:345` — `.filter((artifact) => projectScopeMatches(artifact.projectWorldFingerprint, ctx.projectScopeFingerprint))`
- `src/dashboard/server.ts:12` and `src/dashboard/server-types.ts:36` import the **type** `RuntimeArtifactManager` from the same module — type-only imports are erased at runtime and are acceptable; **do not** churn those unless trivially co-located.

`projectScopeMatches` is (by its call shape) a pure comparison of two scope
fingerprints. **Confirm** that by reading its definition in
`src/learning/runtime-artifact-manager.ts` before moving it.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Locate the helper | `grep -n "projectScopeMatches" src/learning/runtime-artifact-manager.ts` | its definition + any internal uses |
| Typecheck | `npm run typecheck:src` | exit 0 |
| Lint | `npm run lint:src` | exit 0 |
| Tests | `npx vitest run src/dashboard/server-provider-routes.test.ts` | pass (if present) |

## Scope

**In scope**:
- New: `src/learning/project-scope.ts` (the moved pure helper + its types)
- `src/learning/runtime-artifact-manager.ts` (import the helper from the new leaf, re-export for back-compat)
- `src/dashboard/server-provider-routes.ts` (import from the new leaf module)

**Out of scope** (do NOT touch):
- The type-only `RuntimeArtifactManager` imports (server.ts:12, server-types.ts:36) — type imports don't create the runtime coupling this plan targets.
- `projectScopeMatches`'s logic — move it verbatim.

## Git workflow

- Branch: `refactor/029-scope-helper-leaf`
- Commit: `refactor(learning): extract projectScopeMatches to a leaf module`

## Steps

### Step 1: Confirm purity

Read `projectScopeMatches` in `runtime-artifact-manager.ts`. It must be a free
function depending only on its arguments (no closure over artifact-manager
state/instance). If it is NOT pure, STOP — moving it would change semantics.

### Step 2: Move it to a leaf

Create `src/learning/project-scope.ts` containing `projectScopeMatches` (and any
small type it needs, e.g. the fingerprint type). In `runtime-artifact-manager.ts`,
import it from `./project-scope.js` and `export { projectScopeMatches } from "./project-scope.js";`
(back-compat for any other importer).

### Step 3: Repoint the dashboard import

In `server-provider-routes.ts:17`, change the import to
`import { projectScopeMatches } from "../learning/project-scope.js";`.

**Verify**: `npm run typecheck:src` → 0; `npm run lint:src` → 0; `grep -rn "projectScopeMatches" src/dashboard` shows it imported from `project-scope.js`, not `runtime-artifact-manager.js`.

### Step 4: Tests

Run the dashboard provider-routes test if present; add a tiny unit test for
`project-scope.ts` (pure function: matching + non-matching fingerprints).

**Verify**: `npx vitest run src/learning/project-scope.test.ts src/dashboard/server-provider-routes.test.ts` → pass.

## Test plan

- New `project-scope.test.ts`: matching fingerprints → true; differing → false; edge (undefined/empty) → current behavior.
- Existing provider-routes test must still pass (behavior unchanged).

## Done criteria

ALL must hold:

- [ ] `src/learning/project-scope.ts` holds `projectScopeMatches`; re-exported from `runtime-artifact-manager.ts`
- [ ] `server-provider-routes.ts` imports it from `project-scope.js`
- [ ] `npm run typecheck:src` + `npm run lint:src` exit 0; tests pass
- [ ] `plans/README.md` row updated

## STOP conditions

- `projectScopeMatches` is not pure (depends on artifact-manager instance state) — STOP and report; a different seam is needed.
- Another module deep-imports it in a way the re-export doesn't cover — report.

## Maintenance notes

- Keep purely-shared helpers in leaf modules; the dashboard should depend on small utilities, not on learning-pipeline module bodies.
- Reviewer: confirm no new import cycle (`src/learning/project-scope.ts` must not import back into `runtime-artifact-manager.ts`).
