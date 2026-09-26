import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WEIGHTS_LOCK_FILE, pinFor, readWeightsLock, recordWeightsPin } from "./weights-lock.js";

describe("weights lock (CMP-13)", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "weights-lock-"));
    path = join(dir, WEIGHTS_LOCK_FILE);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("no lock file is nothing pinned yet", () => {
    expect(readWeightsLock(path)).toEqual({ ok: true, pins: {} });
  });

  it("records a pin next to the others, and leaves no temp file behind", () => {
    recordWeightsPin(path, "sd15", { weightsRef: "org/sd15", revision: SHA_A, recordedAt: "t1" });
    recordWeightsPin(path, "sdxl", { weightsRef: "org/sdxl", revision: SHA_B, recordedAt: "t2" });
    const lock = readWeightsLock(path);
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;
    expect(pinFor(lock.pins, "sd15", "org/sd15")?.revision).toBe(SHA_A);
    expect(pinFor(lock.pins, "sdxl", "org/sdxl")?.revision).toBe(SHA_B);
    expect(readdirSync(dir)).toEqual([WEIGHTS_LOCK_FILE]);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  it("a pin applies only to the weights repo it was recorded for", () => {
    recordWeightsPin(path, "sd15", { weightsRef: "org/sd15", revision: SHA_A, recordedAt: "t" });
    const lock = readWeightsLock(path);
    if (!lock.ok) throw new Error(lock.detail);
    expect(pinFor(lock.pins, "sd15", "org/other")).toBeUndefined();
    expect(pinFor(lock.pins, "toString", "org/sd15")).toBeUndefined();
  });

  it("a lock that is not valid pins is an error, never 'nothing pinned', and is not overwritten", () => {
    for (const body of [
      "{ torn",
      "[]",
      JSON.stringify({ version: 2, models: {} }),
      JSON.stringify({ version: 1, models: { sd15: { weightsRef: "org/sd15", revision: "main", recordedAt: "t" } } }),
    ]) {
      writeFileSync(path, body);
      const lock = readWeightsLock(path);
      expect(lock.ok, body).toBe(false);
      expect(() => recordWeightsPin(path, "sdxl", { weightsRef: "org/sdxl", revision: SHA_B, recordedAt: "t" }), body).toThrow(WEIGHTS_LOCK_FILE);
      expect(readFileSync(path, "utf8"), body).toBe(body);
    }
  });

  it("reads a lock written before pins had an origin, and keeps each pin's origin as written", () => {
    const old = { version: 1, models: { sd15: { weightsRef: "org/sd15", revision: SHA_A, recordedAt: "t1" } } };
    writeFileSync(path, JSON.stringify(old));
    expect(readWeightsLock(path)).toEqual({ ok: true, pins: old.models });
    recordWeightsPin(path, "sdxl", { weightsRef: "org/sdxl", revision: SHA_B, recordedAt: "t2", origin: "disk" });
    const lock = readWeightsLock(path);
    if (!lock.ok) throw new Error(lock.detail);
    expect(lock.pins["sdxl"]!.origin).toBe("disk");
    expect(lock.pins["sd15"]).toEqual(old.models.sd15);
    expect(JSON.parse(readFileSync(path, "utf8")).models.sd15).not.toHaveProperty("origin");
    writeFileSync(path, JSON.stringify({ version: 1, models: { sd15: { ...old.models.sd15, origin: "elsewhere" } } }));
    expect(readWeightsLock(path).ok).toBe(false);
  });

  it("keepExisting never replaces an entry, not even one recorded for another repo", () => {
    recordWeightsPin(path, "sd15", { weightsRef: "org/old-repo", revision: SHA_A, recordedAt: "t" });
    const before = readFileSync(path, "utf8");
    const again = recordWeightsPin(path, "sd15", { weightsRef: "org/sd15", revision: SHA_B, recordedAt: "t", origin: "disk" }, { keepExisting: true });
    expect(again).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(recordWeightsPin(path, "sdxl", { weightsRef: "org/sdxl", revision: SHA_B, recordedAt: "t", origin: "disk" }, { keepExisting: true })).toBe(true);
    expect(readdirSync(dir)).toEqual([WEIGHTS_LOCK_FILE]);
  });

  it("only a full commit sha can be pinned", () => {
    expect(() => recordWeightsPin(path, "sd15", { weightsRef: "org/sd15", revision: "main", recordedAt: "t" })).toThrow(/not a commit/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
