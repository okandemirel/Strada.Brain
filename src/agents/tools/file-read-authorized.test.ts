/**
 * Reading a file the user named, and refusing everything else.
 *
 * The measured case: the user says "read the design document at /somewhere/gdd.md
 * and build the game", the document sits outside the Unity project, and path
 * confinement refuses it — so the run plans a generic game from one sentence and
 * never sees the design at all.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { FileReadTool } from "./file-read.js";

const tool = new FileReadTool();

function setup(): { project: string; outside: string } {
  const project = mkdtempSync(join(os.tmpdir(), "authz-project-"));
  mkdirSync(join(project, "Assets"), { recursive: true });
  writeFileSync(join(project, "Assets", "Inside.cs"), "// inside");

  const elsewhere = mkdtempSync(join(os.tmpdir(), "authz-outside-"));
  const outside = join(elsewhere, "gdd.md");
  writeFileSync(outside, "# PixelFlow\nAn 8x8 match-3 board.");
  writeFileSync(join(elsewhere, "secrets.txt"), "do not read me");
  return { project, outside };
}

const ctx = (project: string, authorized?: string[]) =>
  ({ projectPath: project, readOnly: false, userAuthorizedPaths: authorized }) as never;

describe("a document the user named", () => {
  it("is read even though it sits outside the project", async () => {
    const { project, outside } = setup();

    const result = await tool.execute({ path: outside }, ctx(project, [outside]));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("match-3 board");
    expect(result.content).toContain("you named this path");
  });

  it("is refused when the user named nothing", async () => {
    const { project, outside } = setup();

    const result = await tool.execute({ path: outside }, ctx(project));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the project");
  });

  it("does not authorize its neighbours", async () => {
    // Naming one file is not naming its folder.
    const { project, outside } = setup();
    const sibling = join(outside, "..", "secrets.txt");

    const result = await tool.execute({ path: sibling }, ctx(project, [outside]));

    expect(result.isError).toBe(true);
  });

  it("does not authorize a traversal out of the named file", async () => {
    const { project, outside } = setup();

    const result = await tool.execute(
      { path: join(outside, "..", "..", "..", "etc", "passwd") },
      ctx(project, [outside]),
    );

    expect(result.isError).toBe(true);
  });

  it("leaves ordinary in-project reads exactly as they were", async () => {
    const { project, outside } = setup();

    const result = await tool.execute({ path: "Assets/Inside.cs" }, ctx(project, [outside]));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("// inside");
    expect(result.content).not.toContain("you named this path");
  });
});

/**
 * Naming a path relaxes CONFINEMENT, never the sensitive-file blocklist.
 *
 * Audited 2026-09-02: a user pasting an error line that mentioned
 * <project>/.env turned that path into an authorized read, and the tool
 * returned the file body under "Read on your authority". The blocklist is a
 * separate guarantee from confinement and must hold regardless of who named
 * the path.
 */
describe("a sensitive file the user happened to name", () => {
  it("stays refused inside the project even when its path was pasted", async () => {
    const { project } = setup();
    const envPath = join(project, ".env");
    writeFileSync(envPath, "ANTHROPIC_API_KEY=sk-ant-TOTALLY-SECRET\nDB_PASSWORD=hunter2\n");

    const result = await tool.execute({ path: envPath }, ctx(project, [envPath]));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("sensitive");
    expect(result.content).not.toContain("TOTALLY-SECRET");
    expect(result.content).not.toContain("hunter2");
  });

  it("stays refused outside the project even when its path was pasted", async () => {
    const { project } = setup();
    const sshDir = mkdtempSync(join(os.tmpdir(), "authz-ssh-"));
    const keyPath = join(sshDir, "id_rsa");
    writeFileSync(keyPath, "-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATEKEYBODY\n");

    const result = await tool.execute({ path: keyPath }, ctx(project, [keyPath]));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("sensitive");
    expect(result.content).not.toContain("PRIVATEKEYBODY");
  });
});
