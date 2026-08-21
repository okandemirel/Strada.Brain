import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { validatePath } from "./path-guard.js";

const root = mkdtempSync(join(tmpdir(), "strada-guard-"));
mkdirSync(join(root, "Assets"), { recursive: true });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a refusal names the boundary it is enforcing", () => {
  it("tells the caller where inside is", async () => {
    const result = await validatePath(root, "../../etc");

    expect(result.valid).toBe(false);
    // Without the root, the caller learns only that it guessed wrong.
    expect(result.error).toContain(root);
  });

  it("still allows a path within the project", async () => {
    expect((await validatePath(root, "Assets")).valid).toBe(true);
  });
});
