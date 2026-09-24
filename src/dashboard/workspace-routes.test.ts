/**
 * CHN-3: the file explorer decides on every segment, case-insensitively, with
 * path-guard's sensitive-file list, and again on the symlink-resolved path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWorkspaceRoute, isPathSafe } from "./workspace-routes.js";

interface CapturedResponse {
  status: number;
  body: string;
}

function capture(): { res: ServerResponse; out: CapturedResponse } {
  const out: CapturedResponse = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(data?: string) {
      out.body = data ?? "";
    },
  } as unknown as ServerResponse;
  return { res, out };
}

const req = { method: "GET", headers: {} } as unknown as IncomingMessage;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workspace-routes-chn3-"));
  mkdirSync(join(root, "Assets", "Scripts"), { recursive: true });
  mkdirSync(join(root, "server"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(root, "server", ".env"), "SECRET=2");
  writeFileSync(join(root, "Assets", "Scripts", "Game.cs"), "class Game {}");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function get(url: string): Promise<CapturedResponse> {
  const { res, out } = capture();
  handleWorkspaceRoute(url, "GET", req, res, root);
  await vi.waitFor(() => expect(out.status).not.toBe(0));
  return out;
}

describe("isPathSafe — secret files anywhere in the tree (CHN-3)", () => {
  it.each([
    "server/.env",
    "Assets/.env.local",
    ".env.test",
    ".git/config",
    ".ENV",
    ".Env.Production",
    ".env.",
    ".env ",
    ".env::$DATA",
    "Assets/Keys/release.pem",
    "home/.ssh/id_rsa",
    ".npmrc",
    "Assets/Plugins/node_modules/x.js",
    "NODE_MODULES/pkg/index.js",
  ])("refuses %s", (path) => {
    const result = isPathSafe(path, root);
    expect(result.safe).toBe(false);
    expect(result.error).toContain("denied");
  });

  it.each(["Assets/Scripts/Game.cs", ".envrc", "Assets/Scripts/Env.cs", "."])("still serves %s", (path) => {
    expect(isPathSafe(path, root).safe).toBe(true);
  });
});

describe("workspace endpoints decide on the resolved path (CHN-3)", () => {
  it("refuses a file whose symlink lands on a secret inside the project", async () => {
    symlinkSync(join(root, ".env"), join(root, "Assets", "notes.txt"));
    const out = await get("/api/workspace/file?path=Assets/notes.txt");
    expect(out.status).toBe(403);
    expect(out.body).not.toContain("SECRET");
  });

  it("refuses a directory whose symlink lands on an excluded directory", async () => {
    symlinkSync(join(root, "node_modules"), join(root, "Assets", "deps"), "dir");
    const out = await get("/api/workspace/files?path=Assets/deps");
    expect(out.status).toBe(403);
  });

  it("refuses a nested secret file", async () => {
    const out = await get("/api/workspace/file?path=server/.env");
    expect(out.status).toBe(403);
    expect(out.body).not.toContain("SECRET");
  });

  it("still serves an ordinary project file", async () => {
    const out = await get("/api/workspace/file?path=Assets/Scripts/Game.cs");
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).content).toContain("class Game");
  });
});
