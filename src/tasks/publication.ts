/**
 * What a workspace lease commit actually delivered to the project.
 *
 * A worker edits a temp copy of the project and the lease publishes it back.
 * Both publication paths — the worker envelope and the task's own — judged
 * that result with their own rules, and both accepted a PARTIAL publication:
 * `written: ["Assets/Other.cs"], conflicts: ["Assets/Rules.cs"]` settled the
 * task green while the change the task was about never reached the project,
 * and its dependents then ran against work that was not there (Codex
 * 2026-09-12 AE#4). One adjudicator now answers for both.
 */

// The conflict-severity rule and the lease's copy rule are the SAME contract,
// imported from its own module rather than from either caller.
import { isDerivedBuildOutput } from "../agents/multi/derived-build-output.js";

export interface LeaseCommitResult {
  readonly written?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly removed?: readonly string[];
  readonly failed?: readonly string[];
  /** How many of the conflicted files were preserved outside the lease. */
  readonly quarantined?: number;
}

export interface PublicationVerdict {
  /** Set when work the run made did NOT reach the project: not a success. */
  readonly loss?: string;
  /** Set when something is worth saying and the publication still stands. */
  readonly note?: string;
}

/**
 * What the TOOLCHAIN writes under `Recordings/`: a play-mode result, a
 * play-through verdict, a captured frame.
 *
 * This is a CONFLICT-SEVERITY rule only, and deliberately not part of
 * `isDerivedBuildOutput`: that predicate also decides whether a file travels
 * back from the lease at all, and recordings MUST travel — they are the run's
 * evidence that the game rendered. What they must not do is fail a goal when
 * both copies are the same machine's output.
 *
 * Measured live 2026-10-14 23:17: `Recordings/tests/playmode-last.json`
 * conflicted with the project's own copy, the publication called it work that
 * did not reach the project, and the goal that had written 22 other files
 * FAILED — taking three dependent goals with it, twice, on the same file.
 *
 * Names in their place, never the bare directory: something a person put
 * under Recordings/ by hand is still authored work.
 */
const RECORDING_ARTIFACT = /^(?:playmode-last\.json|playthrough-verdict\.json|frame[-_]?\d+\.(?:png|jpg)|capture-manifest\.json)$/i;

export function isRecordingArtifact(rel: string): boolean {
  const parts = rel.split(/[/\\]/);
  return parts[0] === "Recordings" && parts.length >= 3 && RECORDING_ARTIFACT.test(parts[parts.length - 1] ?? "");
}

/** At most this many file names in a message a person reads. */
const NAMED = 8;

export function judgePublication(raw: LeaseCommitResult): PublicationVerdict {
  const written = raw.written ?? [];
  const conflicts = raw.conflicts ?? [];
  const removed = raw.removed ?? [];
  const failed = raw.failed ?? [];

  // COULD NOT BE WRITTEN AT ALL: the strongest loss, named first.
  if (failed.length > 0) {
    return { loss: `${failed.length} file(s) the run changed could not be written into the project: ${failed.slice(0, NAMED).join(", ")}` };
  }
  // A CONFLICT THAT COULD NOT BE PRESERVED exists only inside the lease, and
  // release() deletes the lease (Codex 2026-09-12 Q#8).
  const unpreserved = conflicts.length - (raw.quarantined ?? conflicts.length);
  if (unpreserved > 0) {
    return { loss: `${unpreserved} of ${conflicts.length} conflicted file(s) exist ONLY in the workspace — they could not be preserved` };
  }
  // ANY CONFLICT IS A CHANGE THAT DID NOT LAND. Quarantine keeps the bytes;
  // it does not put them in the project. Requiring that NOTHING was written
  // let the one file the task was about conflict while an incidental one
  // published, and the task completed (AE#4).
  if (conflicts.length > 0) {
    // …EXCEPT OUTPUT A COMPILER REGENERATES. A NuGet restore graph the project
    // rebuilds for itself conflicted with the lease's copy, and the goal that
    // had done the real work was failed over it — twice, on the same generated
    // file (measured live 2026-09-16 19:03). Derived output is disclosed; it is
    // not work that was lost.
    const lost = conflicts.filter((path) => !isDerivedBuildOutput(path) && !isRecordingArtifact(path));
    if (lost.length === 0) {
      return {
        note:
          `${conflicts.length} generated file(s) conflicted and were kept aside — the project writes these for itself `
          + `(build output, or this run's own recordings), so nothing the run authored was lost: `
          + `${conflicts.slice(0, NAMED).join(", ")}`,
      };
    }
    return {
      loss:
        `${lost.length} file(s) the run changed did not reach the project — they conflicted with changes made outside the ` +
        `workspace and were kept aside: ${lost.slice(0, NAMED).join(", ")}` +
        (written.length > 0 ? ` (${written.length} other file(s) did publish)` : ""),
    };
  }
  // DECLINED DELETIONS are disclosed, not a failure: a commit never deletes
  // files the system did not author, and a run that "removed" a file it does
  // not own has usually lost nothing the project needed.
  if (removed.length > 0) {
    return {
      note:
        `${removed.length} deletion(s) were NOT applied — the project keeps these files: ${removed.slice(0, NAMED).join(", ")}. ` +
        "A commit never deletes files the system did not author; if they must go, say so in your report instead of deleting them again.",
    };
  }
  return {};
}
