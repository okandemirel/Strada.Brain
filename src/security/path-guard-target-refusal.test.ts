/**
 * Which failures are the guard refusing the target a call named.
 *
 * The verifier closes such a failure once a later call of the same tool
 * succeeds (completion-review.ts, refusalRetriedOk): the refused call did
 * nothing, so it has no failing path to re-run. The sentences are matched by
 * their wording, so each case asks the guard for its refusal instead of
 * typing it: a reworded refusal fails here, not silently in a run.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathTargetRefusal, normalizeToolPathInput, validatePath, type ValidatePathOptions } from "./path-guard.js";

const root = mkdtempSync(join(tmpdir(), "guard-target-refusal-"));
mkdirSync(join(root, "Packages", "Submodules", "Strada.Core", "Runtime"), { recursive: true });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function refusalOf(target: string, options?: ValidatePathOptions, projectRoot = root): Promise<string> {
  const result = await validatePath(projectRoot, target, options);
  expect(result.valid, `the guard accepted ${JSON.stringify(target)}`).toBe(false);
  return result.error ?? "";
}

describe("isPathTargetRefusal: the guard refused the target the call named", () => {
  it.each([
    ["a path outside the project", () => refusalOf("../outside/notes.txt")],
    ["an absolute path outside the project", () => refusalOf(join(tmpdir(), "elsewhere", "notes.txt"))],
    ["no path at all", () => refusalOf("")],
    ["a null byte", () => refusalOf("notes\0.txt")],
    ["a parent that is not there", () => refusalOf("missing/dir/notes.txt")],
    ["a sensitive file", () => refusalOf(".env")],
    ["a framework package, on write", () => refusalOf("Packages/Submodules/Strada.Core/Runtime/Patch.cs", { write: true })],
  ])("recognises %s, bare and as a file tool reports it", async (_case, refuse) => {
    const error = await refuse();

    expect(isPathTargetRefusal(error), error).toBe(true);
    expect(isPathTargetRefusal(`Error: ${error}`), error).toBe(true);
  });

  it("recognises the refusal of an absolute path a tool normalises", () => {
    const normalized = normalizeToolPathInput(root, join(tmpdir(), "elsewhere", "notes.txt"));
    expect(normalized.ok).toBe(false);
    const error = normalized.ok ? "" : normalized.error;

    expect(isPathTargetRefusal(`Error: ${error}`), error).toBe(true);
  });

  it("does not count a project root that is not there: no other target would fix it", async () => {
    const error = await refusalOf("notes.txt", undefined, join(root, "gone"));

    expect(error).toBe("Project root does not exist");
    expect(isPathTargetRefusal(`Error: ${error}`)).toBe(false);
  });

  it("does not count a tool that ran and failed, even when its output quotes a refusal", () => {
    expect(isPathTargetRefusal("Error: could not write file (ENOTDIR)")).toBe(false);
    expect(isPathTargetRefusal("FAIL guard.test.ts: expected 'Path resolves outside the project directory'")).toBe(false);
  });
});
