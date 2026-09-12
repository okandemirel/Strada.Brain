/**
 * EVIDENCE THE COORDINATOR ASKED FOR, BOUND TO WHAT IT ASKED ABOUT.
 *
 * Every delivery proof today is a file a worker could have written: a verdict
 * JSON beside some frames, a suite record, a build report. Nothing ties one of
 * those to the invocation that produced it, to the source tree it measured, or
 * to the artifact it ran — so a stale file, a replayed record or a hand-made
 * one reads exactly like a measurement (Codex 2026-09-12 X#3, Y Job 2, AA Job
 * 2). The fix is a ticket the coordinator issues before the work and a receipt
 * it validates afterwards.
 *
 * This module is the receiver: the shapes, the refusal vocabulary and the
 * decision. It creates no evidence of its own and trusts nothing a producer
 * says about its own identity beyond what the ticket already fixed.
 */

import { createHash, randomUUID } from "node:crypto";

/** What kind of measurement a run was asked for. */
export type EvidenceKind = "compile" | "playmode-suite" | "player-build" | "playthrough";

/** Which producer medium made it — a compiler, the editor, a builder, the shipped player. */
export type EvidenceMedium = "compiler" | "editor" | "builder" | "player";

/**
 * What the coordinator fixed BEFORE the work ran. A producer cannot choose any
 * of it; a record that disagrees with the ticket is refused rather than
 * believed.
 */
export interface EvidenceBinding {
  readonly campaignId: string;
  readonly generation: number;
  readonly milestoneId: string;
  readonly attemptId: string;
  /** Issued per invocation, never per milestone: a replay is a different run. */
  readonly runId: string;
  readonly kind: EvidenceKind;
  readonly medium: EvidenceMedium;
  /** The project revision the work is about, or "" when the tree has none. */
  readonly revision: string;
  /** Whether that tree carried uncommitted build inputs when the ticket was issued. */
  readonly dirty: boolean;
  /** The platform this run is about, when it is about one. */
  readonly target?: string;
  /**
   * Whether this run owns a process whose exit means something.
   *
   * A compile or a suite driven through a LIVE editor bridge has no process
   * of its own — the editor stays alive, and the operation's terminal result
   * IS the observation. Demanding an exit code refused those runs outright
   * (Codex 2026-09-12 AC). Default true: a batch Unity run owns its process.
   */
  readonly processOwned?: boolean;
  /** sha256 of the artifact a player run must have played. */
  readonly artifactSha256?: string;
}

/** A ticket the coordinator persists before dispatching the work. */
export interface EvidenceTicket {
  readonly binding: EvidenceBinding;
  readonly issuedAt: number;
  /** Sessions a play-through was asked to play, when it was asked for any. */
  readonly requestedSessions?: readonly number[];
}

/** How the producer's process ended, as the transport observed it. */
export interface ExecutionObservation {
  readonly completed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/** One session a play-through says it played. */
export interface SessionObservation {
  readonly requestedIndex: number;
  readonly index: number;
  readonly observedIndex?: number;
  readonly identityVerified: boolean;
  readonly actions: number;
  readonly outcome: string;
  readonly reachedOutcome: boolean;
  readonly seconds: number;
}

/** The record a producer returns for the run it was given. */
export interface ProducerEvidence {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly kind: EvidenceKind;
  readonly medium: EvidenceMedium;
  readonly revision?: string;
  readonly target?: string;
  readonly artifactSha256?: string;
  readonly execution: ExecutionObservation;
  readonly sessions?: readonly SessionObservation[];
  /** Whatever the measurement itself is — counts, timings, paths. Judged elsewhere. */
  readonly payload?: Record<string, unknown>;
}

/** Why a record was not admitted. Persisted as a code, never as prose. */
export type EvidenceRefusal =
  | "EVIDENCE_MISSING"
  | "EVIDENCE_TOO_LARGE"
  | "EVIDENCE_SCHEMA_INVALID"
  | "EVIDENCE_VERSION_UNSUPPORTED"
  | "RUN_UNKNOWN"
  | "RUN_CONFLICT"
  | "KIND_MISMATCH"
  | "MEDIUM_MISMATCH"
  | "TARGET_MISMATCH"
  | "REVISION_MISMATCH"
  | "SOURCE_DIRTY"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_MISMATCH"
  | "PROCESS_INCOMPLETE"
  | "PROCESS_FAILED"
  | "SESSION_MISSING"
  | "SESSION_UNVERIFIED"
  | "SESSION_MISMATCH";

/** The receiver's answer: admitted, or refused with the first reason in order. */
export type EvidenceDecision =
  | { readonly admitted: true; readonly recordSha256: string }
  | { readonly admitted: false; readonly refusal: EvidenceRefusal; readonly detail: string };

/** A record larger than this is refused whole, never truncated into a pass. */
export const MAX_EVIDENCE_BYTES = 1024 * 1024;
/** At most this many sessions in one record. */
export const MAX_SESSION_OBSERVATIONS = 24;

/** A run id nothing but the coordinator can guess. */
export function issueRunId(): string {
  return randomUUID();
}

/** The bytes' own identity, so a second delivery of the same record is idempotent. */
export function recordSha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A sha256 is 64 hexadecimal characters; an empty string is not a measurement. */
export function isSha256(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

const isSafeCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e9;
const isFiniteSeconds = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Read a producer's bytes into a record, or say why they are not one.
 *
 * Nothing here trusts a field's meaning; it establishes that the fields exist
 * and have the right shape. Everything about WHAT was measured is judged
 * against the ticket in `admitEvidence`.
 */
export function parseProducerEvidence(bytes: string | undefined): ProducerEvidence | EvidenceRefusal {
  if (bytes === undefined || bytes.trim() === "") return "EVIDENCE_MISSING";
  if (Buffer.byteLength(bytes, "utf8") > MAX_EVIDENCE_BYTES) return "EVIDENCE_TOO_LARGE";
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return "EVIDENCE_SCHEMA_INVALID";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "EVIDENCE_SCHEMA_INVALID";
  const r = parsed as Record<string, unknown>;
  if (r.schemaVersion !== 1) return "EVIDENCE_VERSION_UNSUPPORTED";
  if (typeof r.runId !== "string" || r.runId.trim() === "" || r.runId.length > 200) return "EVIDENCE_SCHEMA_INVALID";
  const kinds: readonly string[] = ["compile", "playmode-suite", "player-build", "playthrough"];
  const media: readonly string[] = ["compiler", "editor", "builder", "player"];
  if (typeof r.kind !== "string" || !kinds.includes(r.kind)) return "EVIDENCE_SCHEMA_INVALID";
  if (typeof r.medium !== "string" || !media.includes(r.medium)) return "EVIDENCE_SCHEMA_INVALID";
  // NOT NULL, NOT AN ARRAY: `typeof null === "object"`, so an envelope with
  // `execution: null` threw instead of being refused (Codex 2026-09-12 AB).
  const exec = r.execution as Record<string, unknown> | undefined;
  if (
    exec === undefined
    || exec === null
    || typeof exec !== "object"
    || Array.isArray(exec)
    || typeof exec.completed !== "boolean"
    || typeof exec.timedOut !== "boolean"
    || !(exec.exitCode === null || isSafeCount(exec.exitCode) || (typeof exec.exitCode === "number" && Number.isInteger(exec.exitCode)))
  ) {
    return "EVIDENCE_SCHEMA_INVALID";
  }
  let sessions: SessionObservation[] | undefined;
  if (r.sessions !== undefined) {
    if (!Array.isArray(r.sessions) || r.sessions.length > MAX_SESSION_OBSERVATIONS) return "EVIDENCE_SCHEMA_INVALID";
    sessions = [];
    for (const raw of r.sessions) {
      if (raw === null || typeof raw !== "object") return "EVIDENCE_SCHEMA_INVALID";
      const x = raw as Record<string, unknown>;
      if (
        !isSafeCount(x.requestedIndex)
        || !isSafeCount(x.index)
        || (x.observedIndex !== undefined && !isSafeCount(x.observedIndex))
        // A STRING IS NOT A BOOLEAN: "false" and null read as absence, and
        // absence used to be permission (Codex 2026-09-12 Z#5).
        || typeof x.identityVerified !== "boolean"
        || !isSafeCount(x.actions)
        || typeof x.outcome !== "string"
        || typeof x.reachedOutcome !== "boolean"
        || !isFiniteSeconds(x.seconds)
      ) {
        return "EVIDENCE_SCHEMA_INVALID";
      }
      sessions.push({
        requestedIndex: x.requestedIndex,
        index: x.index,
        ...(x.observedIndex !== undefined ? { observedIndex: x.observedIndex } : {}),
        identityVerified: x.identityVerified,
        actions: x.actions,
        outcome: x.outcome,
        reachedOutcome: x.reachedOutcome,
        seconds: x.seconds,
      });
    }
  }
  return {
    schemaVersion: 1,
    runId: r.runId,
    kind: r.kind as EvidenceKind,
    medium: r.medium as EvidenceMedium,
    ...(typeof r.revision === "string" ? { revision: r.revision } : {}),
    ...(typeof r.target === "string" ? { target: r.target } : {}),
    ...(typeof r.artifactSha256 === "string" ? { artifactSha256: r.artifactSha256 } : {}),
    execution: {
      completed: exec.completed,
      exitCode: exec.exitCode === null ? null : (exec.exitCode as number),
      timedOut: exec.timedOut,
    },
    ...(sessions ? { sessions } : {}),
    ...(r.payload !== null && typeof r.payload === "object" && !Array.isArray(r.payload)
      ? { payload: r.payload as Record<string, unknown> }
      : {}),
  };
}

/**
 * Does this record answer the ticket that was issued — and does it describe a
 * run that actually finished?
 *
 * The phases are ordered so the FIRST thing wrong is the thing reported: a
 * record for another run is not judged on its measurements, and a process that
 * died is not judged on its numbers.
 */
/**
 * Receive a producer's bytes against the ticket that was issued: parse,
 * validate and hash THE SAME BYTES in one operation.
 *
 * Taking a parsed record and its bytes as separate arguments let a caller
 * hand over a valid object beside unrelated bytes, and the receipt was the
 * hash of the bytes nobody had validated (Codex 2026-09-12 AB). This is the
 * only entry point a caller should use.
 */
export function receiveEvidence(
  ticket: EvidenceTicket | undefined,
  bytes: string | undefined,
  transport: ExecutionObservation,
  opts: { readonly revisionNow?: string; readonly dirtyNow?: boolean; readonly artifactSha256?: string } = {},
): EvidenceDecision {
  const parsed = parseProducerEvidence(bytes);
  if (typeof parsed === "string") return { admitted: false, refusal: parsed, detail: "the producer's record was not usable" };
  return admitEvidence(ticket, parsed, bytes as string, transport, opts);
}

function admitEvidence(
  ticket: EvidenceTicket | undefined,
  record: ProducerEvidence,
  bytes: string,
  transport: ExecutionObservation,
  opts: { readonly revisionNow?: string; readonly dirtyNow?: boolean; readonly artifactSha256?: string } = {},
): EvidenceDecision {
  if (!ticket) return { admitted: false, refusal: "RUN_UNKNOWN", detail: `no ticket was issued for run ${record.runId}` };
  const b = ticket.binding;
  if (record.runId !== b.runId) {
    return { admitted: false, refusal: "RUN_UNKNOWN", detail: `the record names run ${record.runId}, not ${b.runId}` };
  }
  if (record.kind !== b.kind) {
    return { admitted: false, refusal: "KIND_MISMATCH", detail: `asked for ${b.kind}, got ${record.kind}` };
  }
  if (record.medium !== b.medium) {
    return { admitted: false, refusal: "MEDIUM_MISMATCH", detail: `asked for ${b.medium}, got ${record.medium}` };
  }
  // A BINDING THE RECORD DOES NOT ANSWER IS NOT A BINDING IT MET. Omitting
  // the field was an escape from every check (Codex 2026-09-12 AB): unknown
  // is not "unchanged".
  if (b.target !== undefined && record.target !== b.target) {
    return { admitted: false, refusal: "TARGET_MISMATCH", detail: `asked for ${b.target}, got ${record.target ?? "no target"}` };
  }
  // THE TREE THE TICKET WAS ABOUT. A measurement of another revision is
  // another game's measurement, and one taken while the tree was moving
  // describes neither (Codex 2026-09-12 V#4, Y#3, Z#1).
  if (b.dirty || opts.dirtyNow === true) {
    return { admitted: false, refusal: "SOURCE_DIRTY", detail: "the project had uncommitted build inputs" };
  }
  if (record.revision !== b.revision) {
    return {
      admitted: false,
      refusal: "REVISION_MISMATCH",
      detail: `the record names ${record.revision === undefined ? "no revision" : record.revision.slice(0, 8)}, the ticket ${b.revision.slice(0, 8)}`,
    };
  }
  // …AND THE CALLER MUST SAY WHAT THE TREE WAS WHEN THE RUN ENDED. Without
  // that observation the record's own word is all there is, which is what
  // this receiver exists to stop.
  if (opts.revisionNow === undefined || opts.dirtyNow === undefined) {
    return { admitted: false, refusal: "REVISION_MISMATCH", detail: "the tree was not observed when the run ended" };
  }
  if (opts.revisionNow !== b.revision) {
    return { admitted: false, refusal: "REVISION_MISMATCH", detail: `the project moved to ${opts.revisionNow.slice(0, 8)} during the run` };
  }
  // A PLAYER RUN IS ABOUT ONE ARTIFACT. Paths and sizes are not identity: the
  // bytes that ran must be the bytes the build produced.
  if (b.medium === "player") {
    // A DIGEST, not any string: the empty one equalled itself on all three
    // sides and was admitted (Codex 2026-09-12 AC).
    if (!isSha256(b.artifactSha256)) {
      return { admitted: false, refusal: "ARTIFACT_MISSING", detail: "the ticket names no artifact digest" };
    }
    if (!isSha256(record.artifactSha256)) {
      return { admitted: false, refusal: "ARTIFACT_MISSING", detail: "the record names no artifact digest" };
    }
    // MEASURED BY THE CALLER, not echoed by the producer: a record that
    // repeats the digest it was given proves nothing (Codex 2026-09-12 AB).
    if (!isSha256(opts.artifactSha256)) {
      return { admitted: false, refusal: "ARTIFACT_MISSING", detail: "nobody measured the artifact that ran" };
    }
    if (record.artifactSha256 !== b.artifactSha256 || opts.artifactSha256 !== b.artifactSha256) {
      return { admitted: false, refusal: "ARTIFACT_MISMATCH", detail: "the artifact played is not the artifact built" };
    }
  }
  // HOW IT ENDED, from the TRANSPORT as well as the record: a producer's own
  // account of its exit is not the one that counts (Codex 2026-09-12 Y#J4.5).
  if (!transport.completed || transport.timedOut || !record.execution.completed || record.execution.timedOut) {
    return { admitted: false, refusal: "PROCESS_INCOMPLETE", detail: "the producer's process did not run to a normal end" };
  }
  // BOTH ACCOUNTS, AGREEING. Falling back from one to the other let a null
  // transport code be covered by the producer's own "0", and a transport 0
  // cover the producer's own 42 (Codex 2026-09-12 AB).
  // A RUN WITH NO PROCESS OF ITS OWN is judged on completion alone: a compile
  // or a suite through a live editor bridge never exits, and demanding a code
  // refused those runs outright (Codex 2026-09-12 AC).
  const processOwned = b.processOwned !== false;
  if (!processOwned) {
    if (transport.exitCode !== null && transport.exitCode !== 0) {
      return { admitted: false, refusal: "PROCESS_FAILED", detail: `the transport reported ${transport.exitCode}` };
    }
    if (record.execution.exitCode !== null && record.execution.exitCode !== 0) {
      return { admitted: false, refusal: "PROCESS_FAILED", detail: `the producer reported ${record.execution.exitCode}` };
    }
  } else if (transport.exitCode !== 0 || record.execution.exitCode !== 0) {
    return {
      admitted: false,
      refusal: "PROCESS_FAILED",
      detail:
        `the run did not end cleanly (transport ${transport.exitCode ?? "unknown"}, ` +
        `producer ${record.execution.exitCode ?? "unknown"})`,
    };
  }
  // THE SESSIONS THAT WERE ASKED FOR, each identified. An absent session is a
  // missing measurement, and an unverified or contradictory identity certifies
  // no content (Codex 2026-09-12 X, Z#5).
  // EVERY SESSION THE RECORD CARRIES. Validating only the requested ones let
  // an unverified extra session ride along inside an admitted record, where
  // the rest of the system reads it as evidence (Codex 2026-09-12 AC).
  for (const s of record.sessions ?? []) {
    if (!s.identityVerified) {
      return {
        admitted: false,
        refusal: "SESSION_UNVERIFIED",
        detail: `the record carries session ${s.index} with no identity the game confirmed`,
      };
    }
    if (s.observedIndex !== undefined && s.observedIndex !== s.index) {
      return {
        admitted: false,
        refusal: "SESSION_MISMATCH",
        detail:
          `the record says session ${s.index} while the game reported ` +
          `${s.observedIndex === 0 ? "no session running" : s.observedIndex}`,
      };
    }
  }
  for (const wanted of ticket.requestedSessions ?? []) {
    // ONE observation per requested session: a good first entry hid a
    // contradictory second one (Codex 2026-09-12 AB).
    const played = (record.sessions ?? []).filter((s) => s.requestedIndex === wanted);
    if (played.length === 0) {
      return { admitted: false, refusal: "SESSION_MISSING", detail: `session ${wanted} was asked for and is not in the record` };
    }
    if (played.length > 1) {
      return {
        admitted: false,
        refusal: "SESSION_MISMATCH",
        detail: `session ${wanted} has ${played.length} observations in one record`,
      };
    }
    const one = played[0]!;
    if (!one.identityVerified) {
      return { admitted: false, refusal: "SESSION_UNVERIFIED", detail: `session ${wanted} could not be identified by the game` };
    }
    // …AND IT MUST BE THE SESSION THAT WAS ASKED FOR. Comparing the record's
    // own two fields to each other admitted "asked for 7, played 1" as long
    // as it was consistent about playing 1 (Codex 2026-09-12 AB), and an
    // explicit zero — no session running — passed as well.
    if (one.index !== wanted) {
      return {
        admitted: false,
        refusal: "SESSION_MISMATCH",
        detail: `session ${wanted} was asked for and the record played ${one.index}`,
      };
    }
    if (one.observedIndex !== undefined && one.observedIndex !== wanted) {
      return {
        admitted: false,
        refusal: "SESSION_MISMATCH",
        detail: `session ${wanted} was asked for and the game reported ${one.observedIndex === 0 ? "no session running" : one.observedIndex}`,
      };
    }
  }
  return { admitted: true, recordSha256: recordSha256(bytes) };
}
