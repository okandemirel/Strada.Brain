/**
 * The receiver for evidence a producer was ASKED for.
 *
 * Every delivery proof today is a file a worker could have written, with
 * nothing tying it to the invocation that made it, the tree it measured or the
 * artifact it ran — so a stale, replayed or hand-made record reads exactly
 * like a measurement (Codex 2026-09-12 X#3, Y Job 2, AA Job 2). These tests
 * are the refusals, one per way in.
 */
import { describe, expect, it } from "vitest";
import {
  admitEvidence,
  issueRunId,
  parseProducerEvidence,
  receiveEvidence,
  recordSha256,
  MAX_EVIDENCE_BYTES,
  type EvidenceTicket,
  type ExecutionObservation,
  type ProducerEvidence,
} from "./producer-evidence.js";

const REVISION = "a".repeat(40);
const ARTIFACT = "b".repeat(64);
const ok: ExecutionObservation = { completed: true, exitCode: 0, timedOut: false };
/** What the caller observed when the run ended — mandatory now (Codex AB). */
const observed = { revisionNow: REVISION, dirtyNow: false };

function ticket(over: Partial<EvidenceTicket["binding"]> = {}, requestedSessions?: number[]): EvidenceTicket {
  return {
    issuedAt: Date.now(),
    ...(requestedSessions ? { requestedSessions } : {}),
    binding: {
      campaignId: "camp_1",
      generation: 0,
      milestoneId: "mfinal1",
      attemptId: "attempt_1",
      runId: "run-1",
      kind: "playthrough",
      medium: "editor",
      revision: REVISION,
      dirty: false,
      ...over,
    },
  };
}

function record(over: Partial<ProducerEvidence> = {}): ProducerEvidence {
  return {
    schemaVersion: 1,
    runId: "run-1",
    kind: "playthrough",
    medium: "editor",
    revision: REVISION,
    execution: { completed: true, exitCode: 0, timedOut: false },
    ...over,
  };
}

const bytesOf = (r: ProducerEvidence): string => JSON.stringify(r);

describe("reading a producer's bytes", () => {
  it("refuses nothing, too much, malformed and the wrong version", () => {
    expect(parseProducerEvidence(undefined)).toBe("EVIDENCE_MISSING");
    expect(parseProducerEvidence("   ")).toBe("EVIDENCE_MISSING");
    expect(parseProducerEvidence("x".repeat(MAX_EVIDENCE_BYTES + 1))).toBe("EVIDENCE_TOO_LARGE");
    expect(parseProducerEvidence("{not json")).toBe("EVIDENCE_SCHEMA_INVALID");
    expect(parseProducerEvidence("[]")).toBe("EVIDENCE_SCHEMA_INVALID");
    expect(parseProducerEvidence(JSON.stringify({ ...record(), schemaVersion: 2 }))).toBe("EVIDENCE_VERSION_UNSUPPORTED");
  });

  it("refuses a record with no run, an unknown kind or no execution account", () => {
    expect(parseProducerEvidence(JSON.stringify({ ...record(), runId: "" }))).toBe("EVIDENCE_SCHEMA_INVALID");
    expect(parseProducerEvidence(JSON.stringify({ ...record(), kind: "vibes" }))).toBe("EVIDENCE_SCHEMA_INVALID");
    expect(parseProducerEvidence(JSON.stringify({ ...record(), medium: "oracle" }))).toBe("EVIDENCE_SCHEMA_INVALID");
    const noExec = { ...record() } as Record<string, unknown>;
    delete noExec.execution;
    expect(parseProducerEvidence(JSON.stringify(noExec))).toBe("EVIDENCE_SCHEMA_INVALID");
    // `typeof null === "object"`, so a null execution used to THROW here
    // instead of being refused (Codex 2026-09-12 AB).
    expect(parseProducerEvidence(JSON.stringify({ ...record(), execution: null }))).toBe("EVIDENCE_SCHEMA_INVALID");
    expect(parseProducerEvidence(JSON.stringify({ ...record(), execution: [] }))).toBe("EVIDENCE_SCHEMA_INVALID");
  });

  it("refuses a session whose identity is a STRING, a null or a fraction", () => {
    const session = { requestedIndex: 1, index: 1, identityVerified: true, actions: 5, outcome: "Won", reachedOutcome: true, seconds: 30 };
    expect(parseProducerEvidence(bytesOf(record({ sessions: [session] })))).toMatchObject({ runId: "run-1" });
    for (const bad of [
      { ...session, identityVerified: "true" },
      { ...session, identityVerified: null },
      { ...session, actions: 1.5 },
      { ...session, seconds: Number.POSITIVE_INFINITY },
      { ...session, outcome: 7 },
    ]) {
      expect(parseProducerEvidence(JSON.stringify({ ...record(), sessions: [bad] })), JSON.stringify(bad)).toBe(
        "EVIDENCE_SCHEMA_INVALID",
      );
    }
    // …and more sessions than one run may report.
    expect(
      parseProducerEvidence(JSON.stringify({ ...record(), sessions: Array.from({ length: 25 }, () => session) })),
    ).toBe("EVIDENCE_SCHEMA_INVALID");
  });

  it("issues a run id nothing can guess, and hashes the bytes it received", () => {
    expect(issueRunId()).not.toBe(issueRunId());
    expect(recordSha256("a")).toBe(recordSha256("a"));
    expect(recordSha256("a")).not.toBe(recordSha256("b"));
  });
});

describe("admitting a record against the ticket that was issued", () => {
  it("admits the record the ticket asked for", () => {
    const r = record();
    const decision = admitEvidence(ticket(), r, bytesOf(r), ok, observed);
    expect(decision.admitted).toBe(true);
  });

  it("refuses a record for another run, another kind, another medium or another target", () => {
    const cases: Array<[Partial<ProducerEvidence>, string]> = [
      [{ runId: "run-2" }, "RUN_UNKNOWN"],
      [{ kind: "compile" }, "KIND_MISMATCH"],
      [{ medium: "player" }, "MEDIUM_MISMATCH"],
    ];
    for (const [over, refusal] of cases) {
      const r = record(over);
      expect(admitEvidence(ticket(), r, bytesOf(r), ok, observed), refusal).toMatchObject({ admitted: false, refusal });
    }
    const targeted = record({ target: "android" });
    expect(admitEvidence(ticket({ target: "ios" }), targeted, bytesOf(targeted), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "TARGET_MISMATCH",
    });
    // …and with NO ticket at all.
    const r = record();
    expect(admitEvidence(undefined, r, bytesOf(r), ok, observed)).toMatchObject({ admitted: false, refusal: "RUN_UNKNOWN" });
  });

  it("refuses a measurement of another tree, of a tree that was moving, or of a tree nobody observed", () => {
    const other = record({ revision: "c".repeat(40) });
    expect(admitEvidence(ticket(), other, bytesOf(other), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "REVISION_MISMATCH",
    });
    const r = record();
    expect(admitEvidence(ticket(), r, bytesOf(r), ok, { revisionNow: "d".repeat(40), dirtyNow: false })).toMatchObject({
      admitted: false,
      refusal: "REVISION_MISMATCH",
    });
    expect(admitEvidence(ticket({ dirty: true }), r, bytesOf(r), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SOURCE_DIRTY",
    });
    expect(admitEvidence(ticket(), r, bytesOf(r), ok, { revisionNow: REVISION, dirtyNow: true })).toMatchObject({
      admitted: false,
      refusal: "SOURCE_DIRTY",
    });
    // A RECORD THAT OMITS THE BINDING has not met it, and a tree nobody
    // observed at the end is not an unchanged tree (Codex 2026-09-12 AB).
    const silentAboutRevision = record({ revision: undefined });
    expect(admitEvidence(ticket(), silentAboutRevision, bytesOf(silentAboutRevision), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "REVISION_MISMATCH",
    });
    expect(admitEvidence(ticket(), r, bytesOf(r), ok, {})).toMatchObject({
      admitted: false,
      refusal: "REVISION_MISMATCH",
    });
    const silentAboutTarget = record({ target: undefined });
    expect(admitEvidence(ticket({ target: "android" }), silentAboutTarget, bytesOf(silentAboutTarget), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "TARGET_MISMATCH",
    });
  });

  it("holds a player run to the artifact the build produced, as someone else measured it", () => {
    const player = ticket({ medium: "player", kind: "playthrough", artifactSha256: ARTIFACT });
    const right = record({ medium: "player", artifactSha256: ARTIFACT });
    const measured = { ...observed, artifactSha256: ARTIFACT };
    expect(admitEvidence(player, right, bytesOf(right), ok, measured)).toMatchObject({ admitted: true });
    const wrong = record({ medium: "player", artifactSha256: "e".repeat(64) });
    expect(admitEvidence(player, wrong, bytesOf(wrong), ok, measured)).toMatchObject({
      admitted: false,
      refusal: "ARTIFACT_MISMATCH",
    });
    const silent = record({ medium: "player" });
    expect(admitEvidence(player, silent, bytesOf(silent), ok, measured)).toMatchObject({
      admitted: false,
      refusal: "ARTIFACT_MISSING",
    });
    // A RECORD THAT ECHOES THE DIGEST IT WAS GIVEN PROVES NOTHING: somebody
    // else has to have measured the bytes that ran (Codex 2026-09-12 AB).
    expect(admitEvidence(player, right, bytesOf(right), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "ARTIFACT_MISSING",
    });
    expect(admitEvidence(player, right, bytesOf(right), ok, { ...observed, artifactSha256: "f".repeat(64) })).toMatchObject({
      admitted: false,
      refusal: "ARTIFACT_MISMATCH",
    });
  });

  it("refuses a run that did not finish, whichever side says so — or says nothing", () => {
    const r = record();
    expect(admitEvidence(ticket(), r, bytesOf(r), { completed: false, exitCode: null, timedOut: false }, observed)).toMatchObject({
      admitted: false,
      refusal: "PROCESS_INCOMPLETE",
    });
    expect(admitEvidence(ticket(), r, bytesOf(r), { completed: true, exitCode: 0, timedOut: true }, observed)).toMatchObject({
      admitted: false,
      refusal: "PROCESS_INCOMPLETE",
    });
    expect(admitEvidence(ticket(), r, bytesOf(r), { completed: true, exitCode: 42, timedOut: false }, observed)).toMatchObject({
      admitted: false,
      refusal: "PROCESS_FAILED",
    });
    // The producer's own account of a clean exit does not override the
    // transport's (Y#J4.5) — and NEITHER COVERS FOR THE OTHER: an unknown
    // transport code was covered by the producer's zero, and a transport zero
    // covered the producer's 42 (Codex 2026-09-12 AB).
    const lying = record({ execution: { completed: true, exitCode: 0, timedOut: false } });
    expect(admitEvidence(ticket(), lying, bytesOf(lying), { completed: true, exitCode: 139, timedOut: false }, observed)).toMatchObject({
      admitted: false,
      refusal: "PROCESS_FAILED",
    });
    expect(admitEvidence(ticket(), lying, bytesOf(lying), { completed: true, exitCode: null, timedOut: false }, observed)).toMatchObject({
      admitted: false,
      refusal: "PROCESS_FAILED",
    });
    const died = record({ execution: { completed: true, exitCode: 42, timedOut: false } });
    expect(admitEvidence(ticket(), died, bytesOf(died), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "PROCESS_FAILED",
    });
  });

  it("requires every session it asked for, identified and self-consistent", () => {
    const played = (over: Record<string, unknown> = {}) => ({
      requestedIndex: 7, index: 7, identityVerified: true, actions: 5, outcome: "Won", reachedOutcome: true, seconds: 30, ...over,
    });
    const asked = ticket({}, [7]);
    const good = record({ sessions: [played()] });
    expect(admitEvidence(asked, good, bytesOf(good), ok, observed)).toMatchObject({ admitted: true });

    const absent = record({ sessions: [played({ requestedIndex: 3, index: 3 })] });
    expect(admitEvidence(asked, absent, bytesOf(absent), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISSING",
    });
    const unverified = record({ sessions: [played({ identityVerified: false })] });
    expect(admitEvidence(asked, unverified, bytesOf(unverified), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_UNVERIFIED",
    });
    // The game said it was playing something else.
    const contradictory = record({ sessions: [played({ observedIndex: 1 })] });
    expect(admitEvidence(asked, contradictory, bytesOf(contradictory), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISMATCH",
    });
    // IT MUST BE THE SESSION THAT WAS ASKED FOR: comparing the record's own
    // two fields to each other admitted "asked for 7, played 1" as long as it
    // was consistent about playing 1 (Codex 2026-09-12 AB).
    const wrongContent = record({ sessions: [played({ index: 1, observedIndex: 1 })] });
    expect(admitEvidence(asked, wrongContent, bytesOf(wrongContent), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISMATCH",
    });
    // …with or without the game's own word for it.
    const quietlyWrong = record({ sessions: [played({ index: 1 })] });
    expect(admitEvidence(asked, quietlyWrong, bytesOf(quietlyWrong), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISMATCH",
    });
    // An explicit zero is NO session running, not "cannot tell".
    const nothingRunning = record({ sessions: [played({ observedIndex: 0 })] });
    expect(admitEvidence(asked, nothingRunning, bytesOf(nothingRunning), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISMATCH",
    });
    // …and a good first observation does not hide a contradictory second one.
    const duplicated = record({ sessions: [played(), played({ index: 1, observedIndex: 1 })] });
    expect(admitEvidence(asked, duplicated, bytesOf(duplicated), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISMATCH",
    });
  });

  it("parses, validates and hashes THE SAME bytes", () => {
    // Taking a parsed record and its bytes separately let a caller hand over
    // a valid object beside unrelated bytes, and the receipt was the hash of
    // the bytes nobody had validated (Codex 2026-09-12 AB).
    const r = record();
    const bytes = bytesOf(r);
    const received = receiveEvidence(ticket(), bytes, ok, observed);
    expect(received).toEqual({ admitted: true, recordSha256: recordSha256(bytes) });
    expect(receiveEvidence(ticket(), "null", ok, observed)).toMatchObject({
      admitted: false,
      refusal: "EVIDENCE_SCHEMA_INVALID",
    });
    expect(receiveEvidence(ticket(), undefined, ok, observed)).toMatchObject({
      admitted: false,
      refusal: "EVIDENCE_MISSING",
    });
  });
});
