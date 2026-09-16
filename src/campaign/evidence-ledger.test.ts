/**
 * The durable half of the producer-evidence slice: what was asked for, and
 * what came back. Round AF found the receiver had no production caller at
 * all, so its refusals constrained nothing (Codex 2026-09-13 AF#1).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_DIGEST_VERSION, EvidenceLedger, artifactDigest, describeLedgerRow } from "./evidence-ledger.js";
import { issueRunId, receiveEvidence, recordSha256, type EvidenceTicket } from "./producer-evidence.js";

const REVISION = "a".repeat(40);

function ticket(over: Partial<EvidenceTicket["binding"]> = {}): EvidenceTicket {
  return {
    issuedAt: Date.now(),
    binding: {
      campaignId: "c1",
      generation: 0,
      milestoneId: "mfinal1",
      attemptId: "attempt_1",
      runId: issueRunId(),
      kind: "player-build",
      medium: "builder",
      revision: REVISION,
      dirty: false,
      ...over,
    },
  };
}

describe("EvidenceLedger", () => {
  let dir: string;
  let ledger: EvidenceLedger;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "evidence-ledger-"));
    ledger = new EvidenceLedger(join(dir, "ledger.db"));
  });
  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records a dispatch BEFORE the producer runs, and a run nobody settled stays visible", () => {
    const t = ticket({ target: "Android" });
    ledger.issue(t);
    const [pending] = ledger.forMilestone("c1", "mfinal1");
    expect(pending).toMatchObject({ state: "pending", kind: "player-build", target: "Android" });
    expect(describeLedgerRow(pending!)).toContain("NOT SETTLED");
    // It survives a reopen: a crash between dispatch and receipt leaves the
    // obligation on disk.
    ledger.close();
    ledger = new EvidenceLedger(join(dir, "ledger.db"));
    expect(ledger.forMilestone("c1", "mfinal1")[0]).toMatchObject({ state: "pending" });
  });

  it("keeps the decision the receiver made on the bytes that came back", () => {
    const t = ticket();
    ledger.issue(t);
    // Today's producers emit no envelope at all: the receipt is missing, and
    // that is what the ledger says.
    const decision = receiveEvidence(t, undefined, { completed: true, exitCode: 0, timedOut: false }, { revisionNow: REVISION, dirtyNow: false });
    expect(decision.admitted).toBe(false);
    expect(ledger.settle(t.binding.runId, undefined, decision)).toBe("recorded");
    const [row] = ledger.forMilestone("c1", "mfinal1");
    expect(row).toMatchObject({ state: "refused", refusal: "EVIDENCE_MISSING" });
    expect(describeLedgerRow(row!)).toContain("REFUSED (EVIDENCE_MISSING)");
  });

  it("is idempotent on the same bytes and refuses to be overwritten by different ones", () => {
    const t = ticket();
    ledger.issue(t);
    const bytes = JSON.stringify({ schemaVersion: 1, runId: t.binding.runId });
    const decision = receiveEvidence(t, bytes, { completed: true, exitCode: 0, timedOut: false }, { revisionNow: REVISION, dirtyNow: false });
    expect(ledger.settle(t.binding.runId, bytes, decision)).toBe("recorded");
    expect(ledger.settle(t.binding.runId, bytes, decision)).toBe("unchanged");
    // A SECOND producer answering the same run id is a conflict, not an
    // update: the first answer stands.
    expect(ledger.settle(t.binding.runId, `${bytes} `, decision)).toBe("conflict");
    expect(ledger.forMilestone("c1", "mfinal1")[0]?.recordSha256).toBe(recordSha256(bytes));
    // …and a run this ledger never issued is not settled by anyone.
    expect(ledger.settle("run-nobody-issued", bytes, decision)).toBe("unknown-run");
  });

  it("keeps each milestone's runs apart, oldest first", () => {
    const first = ticket({ kind: "compile", medium: "compiler" });
    const second = { ...ticket({ kind: "playthrough", medium: "player" }), issuedAt: first.issuedAt + 10 };
    ledger.issue(first);
    ledger.issue(second);
    ledger.issue(ticket({ milestoneId: "m2" }));
    expect(ledger.forMilestone("c1", "mfinal1").map((r) => r.kind)).toEqual(["compile", "playthrough"]);
    expect(ledger.forMilestone("c1", "m2").map((r) => r.kind)).toEqual(["player-build"]);
    expect(ledger.forMilestone("c1", "nothing-here")).toEqual([]);
  });
});

/**
 * Codex round AH#8, reproduced on two real 26 648-byte files: the digest
 * hashed paths and SIZES, so two different artifacts of the same size were the
 * same artifact as far as a ticket was concerned.
 */
describe("artifactDigest", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "artifact-digest-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const bundle = (name: string, bytes: Buffer): string => {
    const app = join(dir, name, "Contents", "MacOS");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "Game"), bytes);
    return join(dir, name);
  };

  it("tells two artifacts of the SAME SIZE apart", () => {
    const a = artifactDigest(bundle("A.app", Buffer.alloc(26_648, 1)));
    const b = artifactDigest(bundle("B.app", Buffer.alloc(26_648, 2)));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("is stable for the same bytes and absent for an artifact that is not there", () => {
    const first = artifactDigest(bundle("C.app", Buffer.alloc(1024, 7)));
    expect(artifactDigest(join(dir, "C.app"))).toBe(first);
    expect(artifactDigest(join(dir, "Nothing.app"))).toBeUndefined();
    expect(artifactDigest(undefined)).toBeUndefined();
  });

  it("names its scheme, so a digest written under an older one cannot pass as this", () => {
    // v2 hashed the named file's content; v3 covers the player layout beside
    // it (Codex 2026-09-13 AH#8, AI#9).
    expect(ARTIFACT_DIGEST_VERSION).toBe("strada-artifact-v3-layout");
  });

  /**
   * A Windows or Linux player is an executable PLUS its `<Name>_Data` folder,
   * its runtime library and its plugins. Hashing only the named file left
   * every asset, scene and managed assembly out of the artifact's identity:
   * the whole game could be replaced while the digest stood (Codex 2026-09-13
   * AI#9).
   */
  describe("the game beside the executable", () => {
    const layout = (target: string, level: string): string => {
      const build = join(dir, target);
      mkdirSync(join(build, "Game_Data"), { recursive: true });
      writeFileSync(join(build, "Game.x86_64"), "the executable");
      writeFileSync(join(build, "Game_Data", "level0"), level);
      writeFileSync(join(build, "UnityPlayer.so"), "runtime");
      return join(build, "Game.x86_64");
    };

    it("moves when the data folder changes, with the executable untouched", () => {
      const exe = layout("linux", "level one");
      const before = artifactDigest(exe);
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(join(dir, "linux", "Game_Data", "level0"), "level one, edited");
      expect(artifactDigest(exe)).not.toBe(before);
      // …and when a runtime library beside it is swapped.
      writeFileSync(join(dir, "linux", "Game_Data", "level0"), "level one");
      expect(artifactDigest(exe)).toBe(before);
      writeFileSync(join(dir, "linux", "UnityPlayer.so"), "a different runtime");
      expect(artifactDigest(exe)).not.toBe(before);
    });

    it("adopts only a layout it can recognise", () => {
      // No `*_Data` folder: nothing says these siblings belong to this
      // artifact, so the digest stays the file's own.
      const loose = join(dir, "loose");
      mkdirSync(loose, { recursive: true });
      writeFileSync(join(loose, "tool"), "the executable");
      const before = artifactDigest(join(loose, "tool"));
      writeFileSync(join(loose, "notes.txt"), "unrelated");
      expect(artifactDigest(join(loose, "tool"))).toBe(before);
      // The same bytes inside a player layout are a DIFFERENT artifact.
      expect(before).not.toBe(artifactDigest(layout("linux2", "level one")));
    });

    it("tells two players shipped side by side apart", () => {
      const build = join(dir, "both");
      mkdirSync(join(build, "Game_Data"), { recursive: true });
      writeFileSync(join(build, "Game.x86_64"), "one");
      writeFileSync(join(build, "Other.x86_64"), "two");
      writeFileSync(join(build, "Game_Data", "level0"), "shared");
      expect(artifactDigest(join(build, "Game.x86_64"))).not.toBe(artifactDigest(join(build, "Other.x86_64")));
    });
  });
});

/**
 * THE FILES A BUILD SAID IT SHIPPED (Codex 2026-09-13 AJ#4).
 *
 * The coordinator hashes the artifact for its ticket, and hashing the whole
 * layout pulled in whatever was written beside the executable afterwards — the
 * log the game writes on its first run — so an artifact nobody touched hashed
 * differently before and after it ran. Strada.MCP's build writes the manifest;
 * this side must read it the same way.
 */
describe("artifactDigest over a build manifest", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "brain-manifest-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const layout = (): string => {
    const build = join(dir, "linux");
    mkdirSync(join(build, "Game_Data"), { recursive: true });
    writeFileSync(join(build, "Game.x86_64"), "the executable");
    writeFileSync(join(build, "Game_Data", "level0"), "level one");
    // What the producer writes beside the artifact.
    writeFileSync(
      join(build, "Game.x86_64.strada-artifact.json"),
      JSON.stringify({ version: "strada-manifest-v1", files: ["Game.x86_64", "Game_Data/level0"] }, null, 2),
    );
    return join(build, "Game.x86_64");
  };

  it("measures the listed files, and ignores runtime output beside them", () => {
    const exe = layout();
    const built = artifactDigest(exe);
    expect(built).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(dir, "linux", "player.log"), "started\n");
    expect(artifactDigest(exe)).toBe(built);
    writeFileSync(join(dir, "linux", "Game_Data", "level0"), "level one, edited");
    expect(artifactDigest(exe)).not.toBe(built);
  });

  it("a REFORMATTED manifest is the same artifact, and a dropped file is not", () => {
    const exe = layout();
    const built = artifactDigest(exe);
    const manifestAt = join(dir, "linux", "Game.x86_64.strada-artifact.json");
    // Same files, different bytes: the game did not change.
    writeFileSync(manifestAt, JSON.stringify({ version: "strada-manifest-v1", files: ["Game_Data/level0", "Game.x86_64"], note: "reordered" }));
    expect(artifactDigest(exe)).toBe(built);
  });

  it("a manifest that drops a file is a different manifest", () => {
    const exe = layout();
    const built = artifactDigest(exe);
    writeFileSync(
      join(dir, "linux", "Game.x86_64.strada-artifact.json"),
      JSON.stringify({ version: "strada-manifest-v1", files: ["Game.x86_64"] }, null, 2),
    );
    expect(artifactDigest(exe)).not.toBe(built);
  });

  it("a manifest it cannot use is no manifest: the layout answers instead", () => {
    const exe = layout();
    const manifestAt = join(dir, "linux", "Game.x86_64.strada-artifact.json");
    for (const bad of [
      '{not json',
      JSON.stringify({ version: "strada-manifest-v1", files: ["../x"] }),
      // A SCHEME IS PART OF THE ANSWER: a manifest written under another
      // version is not one this digest can read.
      JSON.stringify({ version: "strada-manifest-v0", files: ["Game.x86_64"] }),
      JSON.stringify({ files: ["Game.x86_64"] }),
      JSON.stringify({ version: "strada-manifest-v1", files: [] }),
      JSON.stringify({ version: "strada-manifest-v1", files: "Game.x86_64" }),
    ]) {
      writeFileSync(manifestAt, bad);
      const fromLayout = artifactDigest(exe);
      expect(fromLayout).toMatch(/^[0-9a-f]{64}$/);
      // …and it IS the layout's answer: runtime output moves it again.
      writeFileSync(join(dir, "linux", "player.log"), `started ${bad.length}\n`);
      expect(artifactDigest(exe)).not.toBe(fromLayout);
    }
  });

  it("a file the manifest names and the tree does not have has no digest", () => {
    const exe = layout();
    writeFileSync(
      join(dir, "linux", "Game.x86_64.strada-artifact.json"),
      JSON.stringify({ version: "strada-manifest-v1", files: ["Game.x86_64", "Game_Data/absent"] }),
    );
    expect(artifactDigest(exe)).toBeUndefined();
  });
});
