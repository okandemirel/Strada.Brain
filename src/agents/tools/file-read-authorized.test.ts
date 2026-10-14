/**
 * Reading a file the user named, and refusing everything else.
 *
 * The measured case: the user says "read the design document at /somewhere/gdd.md
 * and build the game", the document sits outside the Unity project, and path
 * confinement refuses it — so the run plans a generic game from one sentence and
 * never sees the design at all.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { FileReadTool } from "./file-read.js";
import { extractUserAuthorizedPaths } from "../../security/user-authorized-paths.js";

const tool = new FileReadTool();

function setup(): { project: string; outside: string } {
  const project = mkdtempSync(join(os.tmpdir(), "authz-project-"));
  mkdirSync(join(project, "Assets"), { recursive: true });
  writeFileSync(join(project, "Assets", "Inside.cs"), "// inside");

  const elsewhere = mkdtempSync(join(os.tmpdir(), "authz-outside-"));
  const outside = join(elsewhere, "gdd.md");
  writeFileSync(outside, "# Fernbrook\nAn 8x8 match-3 board.");
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

/**
 * "~/Desktop/My GDD.md" is how a person writes a path on their own machine.
 * The authorization expanded nothing, so the document stayed unreadable
 * (audit security-config#3); the read has to expand it the same way.
 * os.homedir() follows $HOME on POSIX, which is what the test points.
 */
describe.skipIf(process.platform === "win32")("a document the user named from their home directory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is read when the model passes the path as the user wrote it", async () => {
    const { project } = setup();
    const home = mkdtempSync(join(os.tmpdir(), "authz-home-"));
    mkdirSync(join(home, "Desktop"));
    writeFileSync(join(home, "Desktop", "My GDD.md"), "# Tilde\nA hex board.");
    writeFileSync(join(home, "Desktop", "other.md"), "not named");
    mkdirSync(join(home, ".aws"));
    writeFileSync(join(home, ".aws", "credentials"), "aws_secret_access_key = AWSSECRETBODY\n");
    vi.stubEnv("HOME", home);

    const authorized = extractUserAuthorizedPaths(
      'Build the game in "~/Desktop/My GDD.md", my keys are in ~/.aws/credentials',
    );

    const tilde = await tool.execute({ path: "~/Desktop/My GDD.md" }, ctx(project, authorized));
    expect(tilde.isError).toBeUndefined();
    expect(tilde.content).toContain("A hex board.");
    const absolute = await tool.execute({ path: join(home, "Desktop", "My GDD.md") }, ctx(project, authorized));
    expect(absolute.content).toContain("A hex board.");

    // Expansion widens nothing: a neighbour stays unnamed, a named secret stays blocked.
    expect((await tool.execute({ path: "~/Desktop/other.md" }, ctx(project, authorized))).isError).toBe(true);
    const secret = await tool.execute({ path: "~/.aws/credentials" }, ctx(project, authorized));
    expect(secret.isError).toBe(true);
    expect(secret.content).not.toContain("AWSSECRETBODY");
  });
});
