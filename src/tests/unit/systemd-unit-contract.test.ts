/**
 * strada-brain.service must be able to run the app inside its own sandbox (OPS-15).
 *
 * ProtectSystem=strict makes /opt read-only and ProtectHome=true hides /home,
 * and the only writable paths were /opt/strada-brain/.strada-memory and
 * /opt/strada-brain/logs. The config root — the checkout itself, or
 * ~strada/.strada for an install without .git — was therefore read-only or
 * invisible: startup creates it before anything else runs, so the service
 * crash-looped, and a checkout's .env, logs and lock files hit EROFS.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const unitPath = path.join(repoRoot, "strada-brain.service");
const unit = readFileSync(unitPath, "utf8");

/** `[Section]` → key → every value, in file order. */
function parseUnit(source: string): Map<string, Map<string, string[]>> {
  const sections = new Map<string, Map<string, string[]>>();
  let current = new Map<string, string[]>();
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = sections.get(header[1]!) ?? new Map();
      sections.set(header[1]!, current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    current.set(key, [...(current.get(key) ?? []), line.slice(eq + 1).trim()]);
  }
  return sections;
}

const service = parseUnit(unit).get("Service") ?? new Map<string, string[]>();
const unitSection = parseUnit(unit).get("Unit") ?? new Map<string, string[]>();

/** `Environment=K=V` lines as a map (last assignment wins, as in systemd). */
const environment = new Map(
  (service.get("Environment") ?? []).flatMap((entry) => {
    const eq = entry.indexOf("=");
    return eq > 0 ? [[entry.slice(0, eq), entry.slice(eq + 1)] as [string, string]] : [];
  }),
);

/** Every directory the sandbox leaves writable. */
function writableRoots(): string[] {
  const roots: string[] = [];
  const perKey: Record<string, string> = {
    StateDirectory: "/var/lib",
    LogsDirectory: "/var/log",
    CacheDirectory: "/var/cache",
    RuntimeDirectory: "/run",
  };
  for (const [key, base] of Object.entries(perKey)) {
    for (const value of service.get(key) ?? []) {
      for (const dir of value.split(/\s+/).filter(Boolean)) roots.push(path.posix.join(base, dir));
    }
  }
  for (const value of service.get("ReadWritePaths") ?? []) {
    for (const entry of value.split(/\s+/).filter(Boolean)) roots.push(entry.replace(/^-/, ""));
  }
  return roots;
}

const isWritable = (target: string) =>
  writableRoots().some((root) => target === root || target.startsWith(`${root}/`));

describe("strada-brain.service sandbox (OPS-15)", () => {
  it("runs with the sandbox this contract is about", () => {
    expect(service.get("ProtectSystem")).toEqual(["strict"]);
    expect(service.get("ProtectHome")).toEqual(["true"]);
  });

  it("puts the config root (STRADA_HOME) and HOME on a writable path", () => {
    for (const key of ["STRADA_HOME", "HOME"]) {
      const value = environment.get(key);
      expect(value, `${key} is not set`).toMatch(/^\//);
      expect(isWritable(value!), `${key}=${value} is read-only under the sandbox`).toBe(true);
    }
  });

  it("uses STRADA_HOME even when the working directory is a git checkout", () => {
    // A checkout is its own config root unless told otherwise, and /opt is read-only.
    expect(environment.get("STRADA_SOURCE_CHECKOUT")).toBe("false");
  });

  it("writes LOG_FILE to a writable directory", () => {
    const logFile = environment.get("LOG_FILE");
    expect(logFile, "LOG_FILE is not set (the default is relative to the config root)").toMatch(/^\//);
    expect(isWritable(path.posix.dirname(logFile!))).toBe(true);
  });

  it("marks ReadWritePaths that may not exist as optional, so a missing one cannot fail the namespace setup", () => {
    for (const value of service.get("ReadWritePaths") ?? []) {
      for (const entry of value.split(/\s+/).filter(Boolean)) {
        if (entry.startsWith("-")) continue;
        expect(writableRoots().filter((root) => root !== entry).some((root) => entry.startsWith(`${root}/`)), entry).toBe(true);
      }
    }
  });

  it("keeps the start-limit keys in [Unit], where systemd reads them", () => {
    expect(service.has("StartLimitIntervalSec")).toBe(false);
    expect(service.has("StartLimitBurst")).toBe(false);
    expect(unitSection.get("StartLimitIntervalSec")).toBeDefined();
  });

  const analyze = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
  it.skipIf(analyze.error !== undefined || analyze.status !== 0)("passes systemd-analyze verify", () => {
    const result = spawnSync("systemd-analyze", ["verify", unitPath], { encoding: "utf8", timeout: 30_000 });
    const complaints = `${result.stdout}${result.stderr}`
      .split("\n")
      .filter(Boolean)
      // The runner may not have Node at /usr/bin/node; that is the host, not the unit.
      .filter((line) => !/Command \/usr\/bin\/node is not executable/.test(line));
    expect(complaints).toEqual([]);
  });
});
