---
id: esm-no-require
status: active
scope: "Loading modules from Brain's own TypeScript source. The package is ESM (\"type\": \"module\"), so `require` does not exist at run time."
read_trigger: "Before writing require(; before adding a lazy or optional import; before wrapping an import in try/catch; when a capability reads 'unavailable' or a gate answers false/null and no error was logged."
keywords: ["require", "ESM", "CommonJS", "createRequire", "dynamic import", "optional dependency", "try/catch", "ReferenceError", "silent false", "gate liveness"]
related: ["gate-needs-an-asker"]
rules:
  [{"id": "no-bare-require", "severity": "error", "text": "Never call a bare require( in src; use import, await import(), or createRequire(import.meta.url).", "detector": {"kind": "vitest", "file": "src/no-require-in-esm.test.ts"}}]
---
# ESM: no bare `require`

In an ESM package a bare `require(...)` throws `ReferenceError` at run time.
Inside a try/catch that error becomes a silent "no".

This went unseen for a whole campaign. On 2026-09-07 two gates were found
dead: the local-model availability check reported no local model
(136d6c8e), and the scheduled-elements gate never found the design document
(9ca26d9b, whose message says "require() in ESM, again"). Both called
`require()` inside a try/catch. Every test still passed, because the test
runner provides `require` and the real runtime does not. The boot-time
liveness probe in `src/core/gate-liveness.ts` was added because of this.

## Single producer

The only ways to load a module are:

- a static `import`;
- `await import(...)` for a lazy or optional load;
- `createRequire(import.meta.url)`, when a synchronous CommonJS load is
  genuinely needed.

## Caller rules

- If a try/catch surrounds a load, it must log what it caught. An
  "unavailable" with no reason is exactly how this defect hid.
- If a capability check fails closed, give it a liveness probe in
  `src/core/gate-liveness.ts`. The test suite cannot show that the check
  is dead.

## Don't

- Call a bare `require(` anywhere in `src/**/*.ts`. {#no-bare-require}
- Treat a green test as proof that a load works. Vitest provides `require` and the daemon does not.
