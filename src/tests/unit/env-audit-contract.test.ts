/**
 * `npm run audit:env` measures what the code reads, and .env.example keeps up (OPS-26).
 *
 * The audit compared .env.example against the `EnvVarName` type union rather
 * than actual reads: variables read via `process.env[...]` outside the union
 * (WEB_TRUSTED_ORIGINS, PROVIDER_CHAIN_STRICT, the OPENCODE2/3 accounts, …)
 * were invisible to it, ~30 documented variables were falsely "unused", the
 * deploy files were never checked, and it always exited 0.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "audit-env-coverage.mjs");

interface AuditResult {
  reads: Set<string>;
  undocumented: string[];
  unread: string[];
  deployUnread: string[];
  knownUnread: string[];
}

async function loadAudit(): Promise<(root?: string) => AuditResult> {
  const mod = (await import(pathToFileURL(scriptPath).href)) as { audit: (root?: string) => AuditResult };
  return mod.audit;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("audit:env", () => {
  it("finds no drift between the code, .env.example and the deploy files", async () => {
    const audit = await loadAudit();
    const result = audit();
    expect(result.undocumented, "read by the code, missing from .env.example").toEqual([]);
    expect(result.unread, "in .env.example, read by nothing").toEqual([]);
    expect(result.deployUnread, "set by a Dockerfile/compose file, read by nothing").toEqual([]);
  });

  it("counts reads outside the EnvVarName union (the ones the old audit could not see)", async () => {
    const audit = await loadAudit();
    const { reads } = audit();
    for (const name of ["WEB_TRUSTED_ORIGINS", "PROVIDER_CHAIN_STRICT", "OPENCODE2_API_KEY", "HTTP_ALLOWED_HOSTS", "SYSTEM_PRESET"]) {
      expect(reads.has(name), name).toBe(true);
    }
  });

  it("reports drift in a tree that has it, and the CLI fails on it", async () => {
    const audit = await loadAudit();
    const root = mkdtempSync(path.join(os.tmpdir(), "strada-env-audit-"));
    roots.push(root);
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "a.ts"), 'export const x = process.env["NEW_KNOB"];\n');
    writeFileSync(path.join(root, ".env.example"), "# STALE_KNOB=\n");
    writeFileSync(path.join(root, "Dockerfile"), "FROM node:22-alpine AS production\nENV UNREAD_PORT=1\n");
    const result = audit(root);
    expect(result.undocumented).toEqual(["NEW_KNOB"]);
    expect(result.unread).toEqual(["STALE_KNOB"]);
    expect(result.deployUnread).toEqual(["UNREAD_PORT (Dockerfile)"]);

    const drifted = spawnSync(process.execPath, [scriptPath, "--root", root], { encoding: "utf8", timeout: 60_000 });
    expect(drifted.status, drifted.stdout).toBe(1);
    const clean = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
    expect(clean.status, clean.stdout).toBe(0);
  });
});
