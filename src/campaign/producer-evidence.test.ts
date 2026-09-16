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
  issueRunId,
  parseProducerEvidence,
  receiveEvidence,
  recordSha256,
  MAX_EVIDENCE_BYTES,
  MAX_SESSIONS_PER_RUN,
  sessionsRequested,
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
    const decision = receiveEvidence(ticket(), bytesOf(r), ok, observed);
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
      expect(receiveEvidence(ticket(), bytesOf(r), ok, observed), refusal).toMatchObject({ admitted: false, refusal });
    }
    const targeted = record({ target: "android" });
    expect(receiveEvidence(ticket({ target: "ios" }), bytesOf(targeted), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "TARGET_MISMATCH",
    });
    // …and with NO ticket at all.
    const r = record();
    expect(receiveEvidence(undefined, bytesOf(r), ok, observed)).toMatchObject({ admitted: false, refusal: "RUN_UNKNOWN" });
  });

  it("refuses a measurement of another tree, of a tree that was moving, or of a tree nobody observed", () => {
    const other = record({ revision: "c".repeat(40) });
    expect(receiveEvidence(ticket(), bytesOf(other), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "REVISION_MISMATCH",
    });
    const r = record();
    expect(receiveEvidence(ticket(), bytesOf(r), ok, { revisionNow: "d".repeat(40), dirtyNow: false })).toMatchObject({
      admitted: false,
      refusal: "REVISION_MISMATCH",
    });
    expect(receiveEvidence(ticket({ dirty: true }), bytesOf(r), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SOURCE_DIRTY",
    });
    expect(receiveEvidence(ticket(), bytesOf(r), ok, { revisionNow: REVISION, dirtyNow: true })).toMatchObject({
      admitted: false,
      refusal: "SOURCE_DIRTY",
    });
    // A RECORD THAT OMITS THE BINDING has not met it, and a tree nobody
    // observed at the end is not an unchanged tree (Codex 2026-09-12 AB).
    const silentAboutRevision = record({ revision: undefined });
    expect(receiveEvidence(ticket(), bytesOf(silentAboutRevision), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "REVISION_MISMATCH",
    });
    expect(receiveEvidence(ticket(), bytesOf(r), ok, {})).toMatchObject({
      admitted: false,
      refusal: "REVISION_MISMATCH",
    });
    const silentAboutTarget = record({ target: undefined });
    expect(receiveEvidence(ticket({ target: "android" }), bytesOf(silentAboutTarget), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "TARGET_MISMATCH",
    });
  });

  it("holds a player run to the artifact the build produced, as someone else measured it", () => {
    const player = ticket({ medium: "player", kind: "playthrough", artifactSha256: ARTIFACT });
    const right = record({ medium: "player", artifactSha256: ARTIFACT });
    const measured = { ...observed, artifactSha256: ARTIFACT };
    expect(receiveEvidence(player, bytesOf(right), ok, measured)).toMatchObject({ admitted: true });
    const wrong = record({ medium: "player", artifactSha256: "e".repeat(64) });
    expect(receiveEvidence(player, bytesOf(wrong), ok, measured)).toMatchObject({
      admitted: false,
      refusal: "ARTIFACT_MISMATCH",
    });
    const silent = record({ medium: "player" });
    expect(receiveEvidence(player, bytesOf(silent), ok, measured)).toMatchObject({
      admitted: false,
      refusal: "ARTIFACT_MISSING",
    });
    // A RECORD THAT ECHOES THE DIGEST IT WAS GIVEN PROVES NOTHING: somebody
    // else has to have measured the bytes that ran (Codex 2026-09-12 AB).
    expect(receiveEvidence(player, bytesOf(right), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "ARTIFACT_MISSING",
    });
    expect(receiveEvidence(player, bytesOf(right), ok, { ...observed, artifactSha256: "f".repeat(64) })).toMatchObject({
      admitted: false,
      refusal: "ARTIFACT_MISMATCH",
    });
  });

  it("refuses a run that did not finish, whichever side says so — or says nothing", () => {
    const r = record();
    expect(receiveEvidence(ticket(), bytesOf(r), { completed: false, exitCode: null, timedOut: false }, observed)).toMatchObject({
      admitted: false,
      refusal: "PROCESS_INCOMPLETE",
    });
    expect(receiveEvidence(ticket(), bytesOf(r), { completed: true, exitCode: 0, timedOut: true }, observed)).toMatchObject({
      admitted: false,
      refusal: "PROCESS_INCOMPLETE",
    });
    expect(receiveEvidence(ticket(), bytesOf(r), { completed: true, exitCode: 42, timedOut: false }, observed)).toMatchObject({
      admitted: false,
      refusal: "PROCESS_FAILED",
    });
    // The producer's own account of a clean exit does not override the
    // transport's (Y#J4.5) — and NEITHER COVERS FOR THE OTHER: an unknown
    // transport code was covered by the producer's zero, and a transport zero
    // covered the producer's 42 (Codex 2026-09-12 AB).
    const lying = record({ execution: { completed: true, exitCode: 0, timedOut: false } });
    expect(receiveEvidence(ticket(), bytesOf(lying), { completed: true, exitCode: 139, timedOut: false }, observed)).toMatchObject({
      admitted: false,
      refusal: "PROCESS_FAILED",
    });
    // A TRANSPORT THAT READ NO CODE IS NOT A TRANSPORT THAT DISAGREES. The
    // coordinator dispatches through a tool and never parents the producer's
    // process, so demanding a code from it refused every real dispatch while
    // making the PRODUCER ownerless was the other way to be wrong (Codex
    // 2026-09-13 AI#10). The producer owns the process and must state its own
    // exit — which this record does, cleanly.
    expect(receiveEvidence(ticket(), bytesOf(lying), { completed: true, exitCode: null, timedOut: false }, observed)).toMatchObject({
      admitted: true,
    });
    const died = record({ execution: { completed: true, exitCode: 42, timedOut: false } });
    expect(receiveEvidence(ticket(), bytesOf(died), ok, observed)).toMatchObject({
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
    expect(receiveEvidence(asked, bytesOf(good), ok, observed)).toMatchObject({ admitted: true });

    const absent = record({ sessions: [played({ requestedIndex: 3, index: 3 })] });
    expect(receiveEvidence(asked, bytesOf(absent), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISSING",
    });
    const unverified = record({ sessions: [played({ identityVerified: false })] });
    expect(receiveEvidence(asked, bytesOf(unverified), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_UNVERIFIED",
    });
    // The game said it was playing something else.
    const contradictory = record({ sessions: [played({ observedIndex: 1 })] });
    expect(receiveEvidence(asked, bytesOf(contradictory), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISMATCH",
    });
    // IT MUST BE THE SESSION THAT WAS ASKED FOR: comparing the record's own
    // two fields to each other admitted "asked for 7, played 1" as long as it
    // was consistent about playing 1 (Codex 2026-09-12 AB).
    const wrongContent = record({ sessions: [played({ index: 1, observedIndex: 1 })] });
    expect(receiveEvidence(asked, bytesOf(wrongContent), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISMATCH",
    });
    // …with or without the game's own word for it.
    const quietlyWrong = record({ sessions: [played({ index: 1 })] });
    expect(receiveEvidence(asked, bytesOf(quietlyWrong), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISMATCH",
    });
    // An explicit zero is NO session running, not "cannot tell".
    const nothingRunning = record({ sessions: [played({ observedIndex: 0 })] });
    expect(receiveEvidence(asked, bytesOf(nothingRunning), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISMATCH",
    });
    // …and a good first observation does not hide a contradictory second one.
    const duplicated = record({ sessions: [played(), played({ index: 1, observedIndex: 1 })] });
    expect(receiveEvidence(asked, bytesOf(duplicated), ok, observed)).toMatchObject({
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
    expect(received).toEqual({ admitted: true, recordSha256: recordSha256(bytes), record: r });
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

/**
 * What Codex round AC got through, and the legitimate runs it showed the
 * contract refusing.
 */
describe("what a receipt may not be admitted on (Codex 2026-09-12 AC)", () => {
  it("refuses an empty string as an artifact digest, on each side separately", () => {
    // Each side is checked on its own: with all three empty, any one of the
    // three refusals covers the other two, so the empty string has to be
    // refused where it appears while the other sides are sound.
    const full = { ...observed, artifactSha256: ARTIFACT };
    expect(
      receiveEvidence(ticket({ medium: "player", artifactSha256: "" }), bytesOf(record({ medium: "player", artifactSha256: ARTIFACT })), ok, full),
    ).toMatchObject({ admitted: false, refusal: "ARTIFACT_MISSING", detail: "the ticket names no artifact digest" });
    expect(
      receiveEvidence(ticket({ medium: "player", artifactSha256: ARTIFACT }), bytesOf(record({ medium: "player", artifactSha256: "" })), ok, full),
    ).toMatchObject({ admitted: false, refusal: "ARTIFACT_MISSING", detail: "the record names no artifact digest" });
    expect(
      receiveEvidence(ticket({ medium: "player", artifactSha256: ARTIFACT }), bytesOf(record({ medium: "player", artifactSha256: ARTIFACT })), ok, {
        ...observed,
        artifactSha256: "",
      }),
    ).toMatchObject({ admitted: false, refusal: "ARTIFACT_MISSING", detail: "nobody measured the artifact that ran" });
    // A 64-CHARACTER STRING IS NOT A DIGEST. A length check alone would
    // admit sixty-four question marks (Codex 2026-09-13 AF#1).
    const notHex = "?".repeat(64);
    expect(
      receiveEvidence(ticket({ medium: "player", artifactSha256: notHex }), bytesOf(record({ medium: "player", artifactSha256: ARTIFACT })), ok, full),
    ).toMatchObject({ admitted: false, refusal: "ARTIFACT_MISSING", detail: "the ticket names no artifact digest" });
    expect(
      receiveEvidence(ticket({ medium: "player", artifactSha256: ARTIFACT }), bytesOf(record({ medium: "player", artifactSha256: notHex })), ok, full),
    ).toMatchObject({ admitted: false, refusal: "ARTIFACT_MISSING", detail: "the record names no artifact digest" });
    expect(
      receiveEvidence(ticket({ medium: "player", artifactSha256: ARTIFACT }), bytesOf(record({ medium: "player", artifactSha256: ARTIFACT })), ok, {
        ...observed,
        artifactSha256: notHex,
      }),
    ).toMatchObject({ admitted: false, refusal: "ARTIFACT_MISSING", detail: "nobody measured the artifact that ran" });
    // …and a digest that is not 64 hex characters at all, on each side.
    const short = "abc";
    expect(
      receiveEvidence(ticket({ medium: "player", artifactSha256: short }), bytesOf(record({ medium: "player", artifactSha256: ARTIFACT })), ok, full),
    ).toMatchObject({ admitted: false, refusal: "ARTIFACT_MISSING", detail: "the ticket names no artifact digest" });
    expect(
      receiveEvidence(ticket({ medium: "player", artifactSha256: ARTIFACT }), bytesOf(record({ medium: "player", artifactSha256: short })), ok, full),
    ).toMatchObject({ admitted: false, refusal: "ARTIFACT_MISSING", detail: "the record names no artifact digest" });
    expect(
      receiveEvidence(ticket({ medium: "player", artifactSha256: ARTIFACT }), bytesOf(record({ medium: "player", artifactSha256: ARTIFACT })), ok, {
        ...observed,
        artifactSha256: short,
      }),
    ).toMatchObject({ admitted: false, refusal: "ARTIFACT_MISSING", detail: "nobody measured the artifact that ran" });
  });

  it("validates EVERY session in the record, not only the ones it asked for", () => {
    // An unverified extra session rode along inside an admitted record, where
    // the rest of the system reads it as evidence.
    const asked = ticket({}, [7]);
    const withStowaway = record({
      sessions: [
        { requestedIndex: 7, index: 7, observedIndex: 7, identityVerified: true, actions: 5, outcome: "Won", reachedOutcome: true, seconds: 30 },
        { requestedIndex: 8, index: 8, observedIndex: 8, identityVerified: false, actions: 5, outcome: "Won", reachedOutcome: true, seconds: 30 },
      ],
    });
    expect(receiveEvidence(asked, bytesOf(withStowaway), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_UNVERIFIED",
    });
    const contradictoryExtra = record({
      sessions: [
        { requestedIndex: 7, index: 7, observedIndex: 7, identityVerified: true, actions: 5, outcome: "Won", reachedOutcome: true, seconds: 30 },
        { requestedIndex: 8, index: 8, observedIndex: 3, identityVerified: true, actions: 5, outcome: "Won", reachedOutcome: true, seconds: 30 },
      ],
    });
    expect(receiveEvidence(asked, bytesOf(contradictoryExtra), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISMATCH",
    });
  });

  it("settles a request for EVERY session against the catalogue the record reports", () => {
    // The tools take "all", and a ticket that could only name indices left
    // the field empty for those runs — so a record with NO sessions answered
    // a request to play the whole game (Codex 2026-09-12 AC J1).
    const all: EvidenceTicket = { ...ticket({}), requestedSessions: "all" };
    const played = (count: number, upTo: number): ProducerEvidence => record({
      sessionCount: count,
      sessions: Array.from({ length: upTo }, (_unused, i) => ({
        requestedIndex: i + 1, index: i + 1, observedIndex: i + 1,
        identityVerified: true, actions: 5, outcome: "Won", reachedOutcome: true, seconds: 30,
      })),
    });
    expect(receiveEvidence(all, bytesOf(record({})), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISSING",
      detail: "every session was asked for and the record does not say how many the game holds",
    });
    // A catalogue of three, two of them played: the third is a missing
    // measurement, not a silent pass.
    expect(receiveEvidence(all, bytesOf(played(3, 2)), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISSING",
      detail: "session 3 was asked for and is not in the record",
    });
    expect(receiveEvidence(all, bytesOf(played(3, 3)), ok, observed)).toMatchObject({ admitted: true });
  });

  it("carries where a session's identity came from, and refuses a value it does not know", () => {
    const asked = ticket({}, [1]);
    const withSource = (identitySource: string): string =>
      bytesOf(record({
        sessions: [{ requestedIndex: 1, index: 1, observedIndex: 1, identityVerified: true, actions: 5, outcome: "Won", reachedOutcome: true, seconds: 30, identitySource } as never],
      }));
    for (const source of ["active-session", "start-acceptance"]) {
      const decision = receiveEvidence(asked, withSource(source), ok, observed);
      expect(decision.admitted, source).toBe(true);
      expect(decision.record?.sessions?.[0]?.identitySource, source).toBe(source);
    }
    // A RECORD THAT DISAGREES WITH ITSELF is refused: "unverified" beside
    // `identityVerified: true` was admitted, and the rest of the system then
    // read that session as identified content (Codex 2026-09-13 AF#1).
    expect(receiveEvidence(asked, withSource("unverified"), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_UNVERIFIED",
    });
    expect(receiveEvidence(asked, withSource("whatever-i-like"), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "EVIDENCE_SCHEMA_INVALID",
    });
  });

  it("refuses an extra session that played something else (Codex 2026-09-13 AF#1)", () => {
    // The extra-session loop compared the record's own two fields to each
    // other, so a session asked for as 8 and played as 9 rode along inside an
    // admitted record.
    const asked = ticket({}, [7]);
    const strayed = record({
      sessions: [
        { requestedIndex: 7, index: 7, observedIndex: 7, identityVerified: true, actions: 5, outcome: "Won", reachedOutcome: true, seconds: 30 },
        { requestedIndex: 8, index: 9, observedIndex: 9, identityVerified: true, actions: 5, outcome: "Won", reachedOutcome: true, seconds: 30 },
      ],
    });
    expect(receiveEvidence(asked, bytesOf(strayed), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISMATCH",
      detail: "the record asked for session 8 and played 9",
    });
  });

  it("says when a catalogue is larger than one record can carry (Codex 2026-09-13 AF#1)", () => {
    // 25 sessions in one record is refused by the schema; the ticket that
    // asked for "all" of a 25-session game gets a reason it can act on.
    const all: EvidenceTicket = { ...ticket({}), requestedSessions: "all" };
    expect(receiveEvidence(all, bytesOf(record({ sessionCount: 25 })), ok, observed)).toMatchObject({
      admitted: false,
      refusal: "SESSION_MISSING",
      detail: expect.stringContaining("in batches"),
    });
  });

  it("judges a run with NO process of its own on completion alone", () => {
    // A compile or a suite through a live editor bridge never exits: the
    // operation's terminal result IS the observation, and demanding an exit
    // code refused those runs outright (Codex 2026-09-12 AC).
    const live = ticket({ kind: "compile", medium: "compiler", processOwned: false });
    const done = record({
      kind: "compile",
      medium: "compiler",
      execution: { completed: true, exitCode: null, timedOut: false },
    });
    expect(receiveEvidence(live, bytesOf(done), { completed: true, exitCode: null, timedOut: false }, observed)).toMatchObject({
      admitted: true,
    });
    // A failure it DOES report still refuses…
    const failed = record({
      kind: "compile",
      medium: "compiler",
      execution: { completed: true, exitCode: 2, timedOut: false },
    });
    expect(receiveEvidence(live, bytesOf(failed), { completed: true, exitCode: null, timedOut: false }, observed)).toMatchObject({
      admitted: false,
      refusal: "PROCESS_FAILED",
    });
    // …and a run that DOES own its process still needs its exit code — named
    // as an absent measurement rather than a failure (Codex 2026-09-13 AI#10).
    const batch = record({ kind: "compile", medium: "compiler", execution: { completed: true, exitCode: null, timedOut: false } });
    expect(
      receiveEvidence(ticket({ kind: "compile", medium: "compiler" }), bytesOf(batch), { completed: true, exitCode: null, timedOut: false }, observed),
    ).toMatchObject({ admitted: false, refusal: "PROCESS_UNMEASURED" });
  });
});

/**
 * WHICH SESSIONS THE TICKET ASKS FOR, read from the spec the producer gets.
 *
 * The ticket left the field empty, which put no session requirement on the
 * record at all: a run asked to play every level settled with a record
 * carrying one session, or none (Codex 2026-09-12 AC J1, 2026-09-13 AH#6).
 */
describe("sessionsRequested", () => {
  it('reads "all", ranges, lists and single indices the way the runner does', () => {
    expect(sessionsRequested("all")).toBe("all");
    expect(sessionsRequested(" ALL ")).toBe("all");
    expect(sessionsRequested("1-3")).toEqual([1, 2, 3]);
    expect(sessionsRequested("2,5")).toEqual([2, 5]);
    expect(sessionsRequested("7")).toEqual([7]);
    expect(sessionsRequested("2-3,6")).toEqual([2, 3, 6]);
  });

  it("asks for the session the run will actually play when the spec says nothing usable", () => {
    // NOT an empty list: an empty request is a ticket nothing has to answer,
    // and the runner still plays its default session.
    expect(sessionsRequested(undefined)).toEqual([1]);
    expect(sessionsRequested("")).toEqual([1]);
    expect(sessionsRequested("   ")).toEqual([1]);
    expect(sessionsRequested("every level")).toEqual([1]);
    expect(sessionsRequested("0")).toEqual([1]);
  });

  it("never asks for more sessions than one run can play", () => {
    // The producer caps a run at MAX_SESSIONS_PER_RUN; a ticket that asked
    // for more could not be settled by any correct run.
    expect(sessionsRequested("1-100")).toHaveLength(MAX_SESSIONS_PER_RUN);
    expect(sessionsRequested("1-100").at(-1)).toBe(MAX_SESSIONS_PER_RUN);
  });

  it("the requirement it produces is the one the receiver enforces", () => {
    const base: EvidenceTicket = {
      issuedAt: 1,
      requestedSessions: sessionsRequested("2"),
      binding: {
        campaignId: "c", generation: 0, milestoneId: "m", attemptId: "a", runId: "r",
        kind: "playthrough", medium: "editor", revision: "", dirty: false,
      },
    };
    const record = (index: number) => JSON.stringify({
      schemaVersion: 1, runId: "r", kind: "playthrough", medium: "editor", revision: "",
      execution: { completed: true, exitCode: 0, timedOut: false },
      sessions: [{
        requestedIndex: index, index, identityVerified: true, actions: 3,
        outcome: "Won", reachedOutcome: true, seconds: 1,
      }],
    });
    const transport: ExecutionObservation = { completed: true, exitCode: 0, timedOut: false };
    const opts = { revisionNow: "", dirtyNow: false };
    expect(receiveEvidence(base, record(2), transport, opts).admitted).toBe(true);
    const wrong = receiveEvidence(base, record(1), transport, opts);
    expect(wrong).toMatchObject({ admitted: false, refusal: "SESSION_MISSING" });
  });
});

/**
 * A GAME LARGER THAN ONE RUN. "Play every session" is a request no single run
 * can answer past the producer's own cap, so the receiver says so as its own
 * refusal — the coordinator is meant to ask in batches, not to read "schema
 * invalid" (Codex 2026-09-13 AF#1), and the number it is told must be the
 * number a run can actually play.
 */
describe('a catalogue larger than one run can play', () => {
  const ticket: EvidenceTicket = {
    issuedAt: 1,
    requestedSessions: "all",
    binding: {
      campaignId: "c", generation: 0, milestoneId: "m", attemptId: "a", runId: "r",
      kind: "playthrough", medium: "editor", revision: "", dirty: false,
    },
  };
  const transport: ExecutionObservation = { completed: true, exitCode: 0, timedOut: false };
  const opts = { revisionNow: "", dirtyNow: false };
  const record = (sessionCount: number, played: number): string => JSON.stringify({
    schemaVersion: 1, runId: "r", kind: "playthrough", medium: "editor", revision: "",
    execution: { completed: true, exitCode: 0, timedOut: false },
    sessionCount,
    sessions: Array.from({ length: played }, (_unused, i) => ({
      requestedIndex: i + 1, index: i + 1, identityVerified: true, actions: 3,
      outcome: "Won", reachedOutcome: true, seconds: 1,
    })),
  });

  it("names the producer's cap, not the record's, and tells the caller to batch", () => {
    const refused = receiveEvidence(ticket, record(13, MAX_SESSIONS_PER_RUN), transport, opts);
    expect(refused).toMatchObject({ admitted: false, refusal: "SESSION_MISSING" });
    // The record could hold 24 observations; no RUN can produce more than 12,
    // so 24 was advice nothing could follow.
    expect((refused as { detail: string }).detail).toContain(`one run plays at most ${MAX_SESSIONS_PER_RUN}`);
    expect((refused as { detail: string }).detail).toContain("13 sessions");
  });

  it("…and a catalogue one run CAN answer is admitted when it answers for all of it", () => {
    expect(receiveEvidence(ticket, record(MAX_SESSIONS_PER_RUN, MAX_SESSIONS_PER_RUN), transport, opts).admitted).toBe(true);
    // One short is still one short.
    expect(receiveEvidence(ticket, record(MAX_SESSIONS_PER_RUN, MAX_SESSIONS_PER_RUN - 1), transport, opts))
      .toMatchObject({ admitted: false, refusal: "SESSION_MISSING" });
  });
});

/**
 * TWO SIDES, EACH JUDGED ON WHAT IT CAN MEASURE.
 *
 * One `processOwned` flag governed the transport and the producer together, so
 * a coordinator that dispatches through a tool — and therefore reads no exit
 * code — made the PLAYER it dispatched ownerless too: a receipt reporting no
 * exit code at all was admitted (Codex 2026-09-13 AI#10).
 */
describe("the producer's process and the transport's are not the same process", () => {
  const ticket = (processOwned?: boolean): EvidenceTicket => ({
    issuedAt: 1,
    requestedSessions: [],
    binding: {
      campaignId: "c", generation: 0, milestoneId: "m", attemptId: "a", runId: "r",
      kind: "compile", medium: "compiler", revision: "", dirty: false,
      ...(processOwned === undefined ? {} : { processOwned }),
    },
  });
  const record = (exitCode: number | null): string => JSON.stringify({
    schemaVersion: 1, runId: "r", kind: "compile", medium: "compiler", revision: "",
    execution: { completed: true, exitCode, timedOut: false },
  });
  const silentTransport: ExecutionObservation = { completed: true, exitCode: null, timedOut: false };
  const opts = { revisionNow: "", dirtyNow: false };

  it("a producer that owns a process and reports no exit code is UNMEASURED, not admitted", () => {
    const decision = receiveEvidence(ticket(), record(null), silentTransport, opts);
    expect(decision).toMatchObject({ admitted: false, refusal: "PROCESS_UNMEASURED" });
    expect((decision as { detail: string }).detail).toContain("owns a process and reported no exit code");
    // …and the same producer reporting zero is admitted, even though the
    // transport read no code of its own.
    expect(receiveEvidence(ticket(), record(0), silentTransport, opts).admitted).toBe(true);
    expect(receiveEvidence(ticket(), record(42), silentTransport, opts))
      .toMatchObject({ admitted: false, refusal: "PROCESS_FAILED" });
  });

  it("a live-bridge operation owns no process, and is admitted on completion alone", () => {
    expect(receiveEvidence(ticket(false), record(null), silentTransport, opts).admitted).toBe(true);
    // Its own non-zero code still speaks.
    expect(receiveEvidence(ticket(false), record(7), silentTransport, opts))
      .toMatchObject({ admitted: false, refusal: "PROCESS_FAILED" });
  });

  it("a code the TRANSPORT read is judged on its own, whoever owns the process", () => {
    const failed: ExecutionObservation = { completed: true, exitCode: 42, timedOut: false };
    for (const owned of [undefined, true, false] as const) {
      const decision = receiveEvidence(ticket(owned), record(0), failed, opts);
      expect(decision).toMatchObject({ admitted: false, refusal: "PROCESS_FAILED" });
      expect((decision as { detail: string }).detail).toContain("the transport reported 42");
    }
  });
});
