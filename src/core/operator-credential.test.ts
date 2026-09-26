/**
 * COR-13: the local operator credential file — where it lives, who can read
 * it, and that a run removes only its own.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  generateOperatorToken,
  operatorCredentialPath,
  publishOperatorCredential,
  readOperatorCredential,
  withdrawOperatorCredential,
} from "./operator-credential.js";
import { installLockPath } from "./runtime-lock.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "strada-cred-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const credential = () => ({ baseUrl: "http://127.0.0.1:3100", pid: 4242, token: generateOperatorToken() });

describe("operatorCredentialPath", () => {
  it("sits beside the install's runtime lock under the config root, keyed the same way", () => {
    const file = operatorCredentialPath("/cfg", "/opt/strada");
    const lock = installLockPath("/cfg", "/opt/strada", "runtime");
    expect(dirname(file)).toBe(dirname(lock));
    expect(basename(file)).toBe(basename(lock).replace(".runtime.lock", ".operator.json"));
    expect(operatorCredentialPath("/cfg", "/opt/other")).not.toBe(file);
  });
});

describe("publish / read / withdraw", () => {
  it("writes a credential only this OS user can read, and reads it back", async () => {
    const file = join(dir, ".strada", "locks", "k.operator.json");
    const written = credential();
    await publishOperatorCredential(file, written);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    await expect(readOperatorCredential(file)).resolves.toEqual({ kind: "ok", credential: written });
  });

  it("tells a missing file from an unreadable or a malformed one", async () => {
    await expect(readOperatorCredential(join(dir, "none.json"))).resolves.toEqual({ kind: "missing" });

    const aDirectory = join(dir, "dir.json");
    mkdirSync(aDirectory);
    await expect(readOperatorCredential(aDirectory)).resolves.toMatchObject({ kind: "unreadable" });

    const garbage = join(dir, "garbage.json");
    writeFileSync(garbage, "{not json");
    await expect(readOperatorCredential(garbage)).resolves.toEqual({ kind: "invalid" });

    const wrongShape = join(dir, "shape.json");
    writeFileSync(wrongShape, JSON.stringify({ baseUrl: "file:///etc/passwd", pid: 1, token: "x".repeat(43) }));
    await expect(readOperatorCredential(wrongShape)).resolves.toEqual({ kind: "invalid" });
  });

  it("removes the file this run wrote, and leaves one another run has replaced", async () => {
    const file = join(dir, "k.operator.json");
    const ours = await publishOperatorCredential(file, credential());
    await expect(withdrawOperatorCredential(file, ours)).resolves.toBe(true);
    expect(existsSync(file)).toBe(false);

    const stale = await publishOperatorCredential(file, credential());
    const newer = await publishOperatorCredential(file, credential());
    await expect(withdrawOperatorCredential(file, stale)).resolves.toBe(false);
    expect(readFileSync(file, "utf-8")).toBe(newer);
  });

  it("makes a new random token every run", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateOperatorToken()));
    expect(tokens.size).toBe(20);
    for (const token of tokens) expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });
});
