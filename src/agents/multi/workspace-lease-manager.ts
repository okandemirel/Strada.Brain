import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { resolve, join, dirname, sep, relative, basename } from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { runProcess } from "../../utils/process-runner.js";
import { getLoggerSafe } from "../../utils/logger.js";

export type WorkspaceLeaseKind = "git-worktree" | "temp-copy";

export interface WorkspaceLeaseRequest {
  readonly label?: string;
  readonly workerId?: string;
  readonly preferGitWorktree?: boolean;
  readonly forceTempCopy?: boolean;
  readonly sourceRoot?: string;
}

/** What a commit() moved, and what it refused to move. */
export interface WorkspaceCommitResult {
  /** Repo-relative paths copied back into the source root. */
  readonly written: string[];
  /**
   * Paths skipped because the source-root copy changed after the lease was
   * taken. Overwriting them would silently discard the user's own edit, so the
   * caller is told instead.
   */
  readonly conflicts: string[];
  /**
   * Paths the agent deleted inside its workspace that still exist in the
   * project. They are LEFT IN PLACE — removing a user's files is not something a
   * commit should decide — but the divergence is reported so nobody has to
   * discover it later.
   *
   * Measured: a run repaired four malformed .asmdef files, then removed them
   * while restructuring. The project kept the original broken copies and nothing
   * said so; the next run started from a project the previous one believed it
   * had fixed.
   */
  readonly removed: string[];
  /**
   * Paths that could not be processed at all (locked file, permission error,
   * target replaced by a directory mid-run…). The walk continues past them —
   * one unreadable file used to abort the entire commit and every file after
   * it was lost with no trace — but they are reported so nothing disappears
   * silently.
   */
  readonly failed: string[];
  /**
   * Where the agent's side of `conflicts` was preserved, if any of it could be
   * saved: `<sourceRoot>/.strada/lease-conflicts/<lease>/<rel>`. The source
   * copy still wins on disk; this is the agent's version kept for inspection
   * instead of being destroyed together with the released workspace. `null`
   * when there were no conflicts or none could be written.
   */
  readonly conflictsQuarantinedUnder: string | null;
}

export interface WorkspaceLease {
  readonly id: string;
  readonly kind: WorkspaceLeaseKind;
  readonly sourceRoot: string;
  readonly leaseRoot: string;
  readonly path: string;
  readonly label?: string;
  readonly workerId?: string;
  readonly createdAt: number;
  /**
   * Copy work done inside the lease back into the source root.
   *
   * Without this a lease was write-only: createTempCopy() seeded it, the agent
   * wrote into it, and release() deleted the directory. Measured — a task that
   * asked for one C# file called file_write successfully against
   * `<tmp>/strada-workspaces/task-<id>/Assets/Scripts/Board.cs`, read it back,
   * verified it, reported success, and the user's project never received a
   * byte. The agent was doing the work and throwing it away.
   *
   * Deliberately conservative: it adds and updates files, and never deletes
   * anything from the source root. A file whose source copy changed after the
   * lease was taken is reported as a conflict rather than overwritten, and a
   * file the agent deleted is reported in `removed` rather than acted on.
   */
  commit(): Promise<WorkspaceCommitResult>;
  release(): Promise<void>;
}

export interface WorkspaceCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export type WorkspaceCommandRunner = (params: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /**
   * Byte ceiling for captured output. The default runner keeps only the TAIL
   * once output passes its cap, which is the right call for logs and the wrong
   * one for a command whose output IS the data.
   */
  maxOutput?: number;
}) => Promise<WorkspaceCommandResult>;

export interface WorkspaceLeaseManagerOptions {
  readonly projectRoot: string;
  readonly leaseRoot?: string;
  readonly preferGitWorktree?: boolean;
  readonly commandRunner?: WorkspaceCommandRunner;
  readonly worktreeTimeoutMs?: number;
  /**
   * Timeout for checking out submodules into a fresh worktree. Separate from
   * worktreeTimeoutMs because it can involve network fetches, which take far
   * longer than the local `worktree add`.
   */
  readonly submoduleTimeoutMs?: number;
  /** Additional directory names to exclude from fallback temp-copy workspaces */
  readonly additionalExcludes?: readonly string[];
}

const DEFAULT_LEASE_ROOT = join(os.tmpdir(), "strada-workspaces");
const DEFAULT_WORKTREE_TIMEOUT_MS = 30_000;
const DEFAULT_SUBMODULE_TIMEOUT_MS = 300_000;
/** Upper bound on uncommitted paths copied into a workspace, so a repo with a
 *  huge dirty tree cannot turn every lease into a full project copy. */
const MAX_UNCOMMITTED_ENTRIES = 2000;
/** Ceiling for `git status -z` output; a large Unity project runs to hundreds of KB. */
const GIT_STATUS_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

interface PorcelainEntry {
  readonly path: string;
  readonly deleted: boolean;
}

/**
 * Parse `git status --porcelain=v1 -uall -z`.
 *
 * NUL-separated rather than line-based because paths may contain newlines, and
 * the line-based form quotes and escapes them instead. Rename and copy entries
 * carry a second NUL-terminated field (the original path) which must be
 * consumed, and whose file has to go from the workspace.
 */
function parsePorcelainZ(stdout: string): PorcelainEntry[] {
  const fields = stdout.split("\0");
  const entries: PorcelainEntry[] = [];

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field || field.length < 4) continue;
    const x = field[0]!;
    const y = field[1]!;
    const path = field.slice(3);
    if (!path) continue;

    if (x === "R" || x === "C") {
      const original = fields[++i];
      if (original) entries.push({ path: original, deleted: x === "R" });
      entries.push({ path, deleted: false });
      continue;
    }
    entries.push({ path, deleted: x === "D" || y === "D" });
  }

  return entries;
}
const BASE_FALLBACK_COPY_EXCLUDES = new Set([
  ".git",
  "node_modules",
  ".strada-memory",
  // .strada holds lease-conflict quarantines and vault indexes. Without this
  // exclude, quarantined project mirrors counted against the seeding budget,
  // were copied into every subsequent lease, and travelled back on commit.
  ".strada",
  ".strada-lease-owner.json",
  "dist",
  "coverage",
  ".cache",
  ".vite",
]);
const DERIVED_COPY_EXCLUDES = new Set([
  ".git",
  "node_modules",
  ".strada",
  ".strada-lease-owner.json",
  "coverage",
  ".cache",
  ".vite",
]);

/** Ownership sidecar written into every lease dir at acquire — the only
 *  cross-process signal for "this lease belongs to a LIVE process". */
const LEASE_OWNER_FILE = ".strada-lease-owner.json";

/** True when the pid recorded in a lease's owner sidecar is still running.
 *  Missing/corrupt sidecar reads as not-alive (old-style orphan heuristic). */
function leaseOwnerAlive(leasePath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(leasePath, LEASE_OWNER_FILE), "utf8")) as {
      pid?: unknown;
    };
    const pid = Number(raw.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); // throws when the process is gone
    return true;
  } catch {
    return false;
  }
}

/** Lease roots already salvaged by SOME manager in this process. Two managers
 *  are constructed against the same root (stage-runtime and stage-agents);
 *  without this, the second lists the first's LIVE leases as orphans and both
 *  run commitLease + removeDirectory on the same paths concurrently. */
const SALVAGED_LEASE_ROOTS = new Set<string>();

function slugifySegment(value: string): string {
  const normalized = value.trim().toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "workspace";
}

function isInsidePath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

export class WorkspaceLeaseManager {
  private readonly projectRoot: string;
  private readonly leaseRoot: string;
  private readonly preferGitWorktree: boolean;
  private readonly commandRunner: WorkspaceCommandRunner;
  private readonly worktreeTimeoutMs: number;
  private readonly submoduleTimeoutMs: number;
  private readonly fallbackExcludes: Set<string>;
  private readonly activeLeases = new Map<string, WorkspaceLease>();

  constructor(options: WorkspaceLeaseManagerOptions) {
    if (!options.projectRoot.trim()) {
      throw new Error("projectRoot is required");
    }

    this.projectRoot = resolve(options.projectRoot);
    if (!existsSync(this.projectRoot)) {
      throw new Error(`Project root does not exist: ${this.projectRoot}`);
    }

    // The default lease root is MACHINE-GLOBAL (os.tmpdir()). A test that
    // constructs a manager without its own leaseRoot lists the RUNNING
    // daemon's live leases as orphans and deletes them — measured live
    // 2026-08-28 11:41: a vitest worker salvaged and removed the campaign's
    // Sprint-1 worktree mid-task. Tests must always pass an isolated root.
    if (
      options.leaseRoot === undefined &&
      (process.env["VITEST"] !== undefined || process.env["NODE_ENV"] === "test")
    ) {
      throw new Error(
        "WorkspaceLeaseManager: tests must pass an explicit leaseRoot — the default is the " +
          "machine-global production root, and constructing against it salvages (DELETES) live leases.",
      );
    }
    this.leaseRoot = resolve(options.leaseRoot ?? DEFAULT_LEASE_ROOT);
    mkdirSync(this.leaseRoot, { recursive: true });
    this.preferGitWorktree = options.preferGitWorktree ?? true;
    this.commandRunner = options.commandRunner ?? runProcess;
    this.worktreeTimeoutMs = options.worktreeTimeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS;
    this.submoduleTimeoutMs = options.submoduleTimeoutMs ?? DEFAULT_SUBMODULE_TIMEOUT_MS;
    this.fallbackExcludes = options.additionalExcludes?.length
      ? new Set([...BASE_FALLBACK_COPY_EXCLUDES, ...options.additionalExcludes])
      : BASE_FALLBACK_COPY_EXCLUDES;
    // At construction there are by definition zero live leases — every
    // pre-existing entry belongs to a dead process. Snapshot the list now and
    // salvage in the background; anything acquired later creates NEW dirs that
    // are not on this list, so a racing acquire can never be swept.
    if (!SALVAGED_LEASE_ROOTS.has(this.leaseRoot)) {
      SALVAGED_LEASE_ROOTS.add(this.leaseRoot);
      const orphans = this.listOrphanedLeases();
      if (orphans.length > 0) {
        void this.salvageOrphanedLeases(orphans);
      }
    }
  }

  /** Directories under the lease root at construction time (all orphans).
   *  Only this manager's own `<slug>-<uuid>` naming matches — the lease root
   *  may also hold workspace roots created by other flows, which must never
   *  be swept. */
  private listOrphanedLeases(): string[] {
    const leaseNamePattern = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    try {
      return readdirSync(this.leaseRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && leaseNamePattern.test(e.name))
        // The name pattern matches LIVE leases exactly as well as dead ones —
        // "orphan" is decided by owner liveness, never by naming.
        .filter((e) => !leaseOwnerAlive(join(this.leaseRoot, e.name)))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Recover work stranded by a crashed predecessor.
   *
   * SIGKILL / OOM / panic skip release() entirely: measured in production, a
   * run whose runtime died mid-task left full project copies under the lease
   * root with hours of agent work inside, recoverable only by hand (an
   * external watchdog script did the salvage until this existed).
   *
   * Without the original seed maps we cannot tell agent edits from seed
   * content, so every file is treated as candidate work and the commit's own
   * safety rules decide: missing targets are restored, differing targets are
   * quarantined rather than overwritten, deletions stay unapplied. Stale git
   * worktree registrations are pruned once afterwards.
   */
  private async salvageOrphanedLeases(orphanNames: readonly string[]): Promise<void> {
    const logger = getLoggerSafe();
    let salvaged = 0;
    let writtenTotal = 0;
    let conflictsTotal = 0;
    for (const name of orphanNames) {
      const orphanPath = join(this.leaseRoot, name);
      if (!existsSync(orphanPath)) continue; // released concurrently somehow
      // Re-verify ownership at the moment of action, not just at snapshot
      // time: a lease acquired (or a crashed owner restarted) between the
      // constructor snapshot and this iteration must not be swept.
      if (leaseOwnerAlive(orphanPath)) continue;
      try {
        // Without the original seed maps, "missing from the project" cannot be
        // told apart from "deleted by the user after the crash" — restoring
        // such files resurrected deliberate deletions. Salvage therefore never
        // writes into the project: everything non-identical goes to quarantine
        // for a person to review.
        const result = await this.commitLease(
          this.projectRoot,
          orphanPath,
          new Map<string, number>(),
          new Map<string, number>(),
          join(this.projectRoot, ".strada", "lease-conflicts", `orphan-${name.slice(0, 8)}`),
          { quarantineOnly: true },
        );
        writtenTotal += result.written.length;
        conflictsTotal += result.conflicts.length;
        this.removeDirectory(orphanPath);
        salvaged += 1;
      } catch (err) {
        logger.warn("Orphaned workspace could not be salvaged — left in place", {
          orphan: name,
          err,
        });
      }
    }
    try {
      await this.commandRunner({
        command: "git",
        args: ["worktree", "prune"],
        cwd: this.projectRoot,
        timeoutMs: 30_000,
      });
    } catch {
      // Non-git projects have nothing to prune.
    }
    if (salvaged > 0 || writtenTotal > 0 || conflictsTotal > 0) {
      logger.info("Salvaged orphaned workspaces from a previous process", {
        salvaged,
        filesWritten: writtenTotal,
        conflictsQuarantined: conflictsTotal,
      });
    }
  }

  async acquireLease(request: WorkspaceLeaseRequest = {}): Promise<WorkspaceLease> {
    const id = randomUUID();
    const createdAt = Date.now();
    const label = request.label?.trim() || undefined;
    const workerId = request.workerId?.trim() || undefined;
    const sourceRoot = resolve(request.sourceRoot ?? this.projectRoot);
    if (!existsSync(sourceRoot)) {
      throw new Error(`Workspace source root does not exist: ${sourceRoot}`);
    }
    if (
      sourceRoot !== this.projectRoot &&
      !isInsidePath(this.projectRoot, sourceRoot) &&
      !isInsidePath(this.leaseRoot, sourceRoot)
    ) {
      throw new Error(
        `Workspace source root must be inside the project root or lease root: ${sourceRoot}`,
      );
    }
    const baseName = slugifySegment(workerId ?? label ?? "worker");
    const workspacePath = join(this.leaseRoot, `${baseName}-${id}`);
    const useWorktree =
      sourceRoot === this.projectRoot &&
      this.preferGitWorktree &&
      !request.forceTempCopy &&
      (await this.canUseGitWorktree());

    let kind: WorkspaceLeaseKind;
    let releaseImpl: () => Promise<void>;

    if (useWorktree) {
      try {
        await this.createGitWorktree(workspacePath);
        kind = "git-worktree";
        releaseImpl = async () => {
          await this.removeGitWorktree(workspacePath);
        };
      } catch {
        kind = "temp-copy";
        await this.createTempCopy(sourceRoot, workspacePath);
        releaseImpl = async () => {
          this.removeDirectory(workspacePath);
        };
      }
    } else {
      kind = "temp-copy";
      await this.createTempCopy(sourceRoot, workspacePath);
      releaseImpl = async () => {
        this.removeDirectory(workspacePath);
      };
    }

    // Ownership sidecar: the lease root is machine-global, so "orphan" can
    // only be decided by whether the OWNING PROCESS is alive — not by which
    // process happens to construct a manager. Salvage skips any lease whose
    // recorded pid still runs.
    try {
      writeFileSync(
        join(workspacePath, LEASE_OWNER_FILE),
        JSON.stringify({ pid: process.pid, startedAt: createdAt }),
        "utf8",
      );
    } catch {
      // Best-effort; an unownable lease degrades to the old orphan heuristic.
    }

    // Two snapshots, both taken after seeding.
    //   leaseSeed  — the workspace as the agent received it. A file whose mtime
    //                is unchanged here was not touched by the agent.
    //   sourceSeed — the project as it stood when the lease was taken, so an
    //                edit the user makes DURING the run is detectable.
    const leaseSeed = this.snapshotMtimes(workspacePath, workspacePath);
    const sourceSeed = this.snapshotMtimes(sourceRoot, sourceRoot);

    let released = false;
    const lease: WorkspaceLease = {
      commit: async () =>
        this.commitLease(sourceRoot, workspacePath, leaseSeed, sourceSeed, join(
          sourceRoot,
          ".strada",
          "lease-conflicts",
          id.slice(0, 8),
        )),
      id,
      kind,
      sourceRoot,
      leaseRoot: this.leaseRoot,
      path: workspacePath,
      label,
      workerId,
      createdAt,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        this.activeLeases.delete(id);
        await releaseImpl();
      },
    };
    this.activeLeases.set(id, lease);
    return lease;
  }

  /** Release all active leases (call on shutdown). */
  /**
   * Release every outstanding lease, keeping the work in it.
   *
   * Shutdown used to release without committing, so a task interrupted mid-run
   * had its files deleted along with the workspace. Measured: a run stopped by
   * SIGINT had written Modules/PixelFlow/Tests/Runtime/DomainModelTests.cs into
   * its lease; after "Shutdown complete" the file existed neither in the project
   * nor anywhere under the lease root. The agent's work for that run was gone.
   *
   * The asymmetry decides it: publishing work the user did not end up wanting is
   * recoverable — the files are in their project and git shows them — while
   * discarding it is not. Interrupting a task is not a request to throw away
   * what it already produced.
   *
   * A commit that fails must not block the release; the workspace still has to
   * go, and a lease that cannot be committed is exactly the case where leaking
   * the directory would be worst.
   */
  async dispose(): Promise<void> {
    const leases = Array.from(this.activeLeases.values());
    this.activeLeases.clear();
    await Promise.allSettled(
      leases.map(async (lease) => {
        try {
          const result = await lease.commit();
          if (
            result.written.length > 0 ||
            result.conflicts.length > 0 ||
            result.failed.length > 0
          ) {
            getLoggerSafe().info("Workspace committed during shutdown", {
              leaseId: lease.id,
              written: result.written.length,
              conflicts: result.conflicts.length,
              failed: result.failed.length,
            });
          }
        } catch (err) {
          getLoggerSafe().warn("Workspace could not be committed during shutdown", {
            leaseId: lease.id,
            err,
          });
        }
        await lease.release();
      }),
    );
  }

  getActiveLeaseCount(): number {
    return this.activeLeases.size;
  }

  private async canUseGitWorktree(): Promise<boolean> {
    const result = await this.commandRunner({
      command: "git",
      args: ["-C", this.projectRoot, "rev-parse", "--is-inside-work-tree"],
      cwd: this.projectRoot,
      timeoutMs: this.worktreeTimeoutMs,
    });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  private async createGitWorktree(workspacePath: string): Promise<void> {
    mkdirSync(dirname(workspacePath), { recursive: true });
    const result = await this.commandRunner({
      command: "git",
      args: ["-C", this.projectRoot, "worktree", "add", "--detach", workspacePath, "HEAD"],
      cwd: this.projectRoot,
      timeoutMs: this.worktreeTimeoutMs,
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "git worktree add failed");
    }

    await this.initSubmodules(workspacePath);
    await this.syncUncommittedState(workspacePath);
  }

  /**
   * Carry the project's uncommitted state into the fresh worktree.
   *
   * `git worktree add ... HEAD` seeds from the last commit, so everything the
   * user has not committed — edits in progress, new files, deletions — is absent
   * from the workspace the agent works in. Asked to fix a bug in a file the user
   * just edited, the agent reads the committed version instead and fixes
   * something that is no longer there.
   *
   * Measured: the supported setup flow runs `git submodule add` for Strada.Core
   * and Strada.MCP and does not commit, so a task started right after setup got
   * a workspace with no .gitmodules and no framework at all — even with the
   * submodule checkout above, which has nothing to check out from a HEAD that
   * predates the install.
   *
   * commit() is unaffected: both seed snapshots are taken after this runs, so a
   * file copied in here and never written to reads as "present at seed time,
   * not agent work" and does not travel back.
   */
  private async syncUncommittedState(workspacePath: string): Promise<void> {
    const result = await this.commandRunner({
      command: "git",
      args: ["-C", this.projectRoot, "status", "--porcelain=v1", "-uall", "-z"],
      cwd: this.projectRoot,
      timeoutMs: this.worktreeTimeoutMs,
      // This output is data, not a log. The default runner keeps the TAIL when
      // output grows past its cap, and a Unity project's `git status -uall` runs
      // to hundreds of kilobytes because Library/ is untracked.
      //
      // Measured: a project with 9002 uncommitted paths had the first ~180
      // entries cut away — .gitmodules, both submodules and every
      // Assets/Modules file — leaving only Library/. The workspace was seeded
      // with Unity's cache and none of the project's code, git exited 0, and
      // nothing reported a thing.
      maxOutput: GIT_STATUS_MAX_OUTPUT_BYTES,
    });

    if (result.exitCode !== 0) {
      getLoggerSafe().warn("Could not read uncommitted project state for the workspace", {
        stderr: result.stderr.trim().slice(0, 300),
        consequence: "the agent sees the last commit, not the user's working tree",
      });
      return;
    }

    // A complete -z listing ends with a NUL. Anything else means the output was
    // cut, and a truncated list would seed a workspace that looks whole.
    if (result.stdout.length > 0 && !result.stdout.endsWith("\0")) {
      getLoggerSafe().warn("Uncommitted project state was truncated; workspace seeded from HEAD only", {
        bytes: result.stdout.length,
        consequence: "the agent may not see files the user has not committed",
      });
      return;
    }

    // Filter through the SAME excludes the seed/commit walks use, BEFORE the
    // budget is applied. Unfiltered, an untracked Unity Library/ (thousands of
    // cache paths, byte-sorted ahead of Packages/) spent the whole budget and
    // the truncation dropped .gitmodules, both submodules and ProjectSettings —
    // the workspace was seeded with cache and none of the project's code.
    const entries = parsePorcelainZ(result.stdout).filter(({ path: rel }) => {
      const firstSegment = rel.split(/[/\\]/, 1)[0];
      if (!firstSegment) return true;
      return !this.fallbackExcludes.has(firstSegment) && !DERIVED_COPY_EXCLUDES.has(firstSegment);
    });
    // When the budget still bites, code seeds first: git's byte order is not an
    // importance order. (Stable sort — within a tier, git's order is kept.)
    const seedPriority = (rel: string): number =>
      // style.json is tier 0: the GDD-derived style profile is written to the
      // project root untracked, and every generator reads it from the lease —
      // dropped past the budget, generation silently falls back to stock.
      /^(?:\.gitmodules$|style\.json$|Assets[/\\]|Packages[/\\]|ProjectSettings[/\\]|src[/\\])/.test(rel) ? 0 : 1;
    const ordered = entries.length > MAX_UNCOMMITTED_ENTRIES
      ? [...entries].sort((a, b) => seedPriority(a.path) - seedPriority(b.path))
      : entries;
    const applied = ordered.slice(0, MAX_UNCOMMITTED_ENTRIES);
    if (entries.length > applied.length) {
      // Never silently truncate: a partially seeded workspace that looks whole
      // is worse than one the log says is partial.
      getLoggerSafe().warn("Project has more uncommitted paths than the workspace seeds", {
        total: entries.length,
        seeded: applied.length,
        skipped: entries.length - applied.length,
      });
    }

    for (const { path: rel, deleted } of applied) {
      // The lease root can sit inside the project; seeding a workspace with the
      // contents of other workspaces would recurse.
      const source = join(this.projectRoot, rel);
      const target = join(workspacePath, rel);
      if (isInsidePath(this.leaseRoot, source)) continue;

      if (deleted || !existsSync(source)) {
        rmSync(target, { recursive: true, force: true });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, force: true });
    }
  }

  /**
   * Check out the project's submodules inside the fresh worktree.
   *
   * `git worktree add` leaves submodule paths as empty directories, and the
   * product's own installer puts Strada.Core and Strada.MCP there — it runs
   * `git submodule add`. So without this the agent's workspace contains zero of
   * the framework it is supposed to conform to, while the project it was seeded
   * from has all of it.
   *
   * Measured on a full Pixel Flow build: the project held 295 Strada.Core .cs
   * files and the workspace held none. `list_directory Packages/Submodules/
   * Strada.Core` answered "directory not found", the glob for its sources found
   * nothing, and the agent — having looked and found no framework — invented its
   * own: a GameModuleConfig deriving from ScriptableObject and an .asmdef
   * referencing Unity.ugui instead of Strada.Core.
   *
   * Failure here is logged, not thrown: a submodule that cannot be fetched
   * should degrade the workspace, not kill the task.
   */
  private async initSubmodules(workspacePath: string): Promise<void> {
    if (!existsSync(join(this.projectRoot, ".gitmodules"))) {
      return;
    }

    const result = await this.commandRunner({
      command: "git",
      args: [
        "-C",
        workspacePath,
        // Strada.Core and Strada.MCP are developed beside the game, so the
        // supported setup wires them as submodules on local paths. Since the
        // CVE-2022-39253 mitigation git refuses to clone those over the `file`
        // transport, and it ignores the setting when it comes from repository
        // config — there is nothing a user can put in their own project to
        // allow it. It has to be given on the command line.
        //
        // Measured: with the submodules committed (so syncUncommittedState has
        // nothing to copy in), the clone was the only path left and it failed
        // with "transport 'file' not allowed". The agent got an empty
        // Packages/Submodules and wrote modules against a framework that was
        // not there.
        //
        // Scope: this one internal operation, on the project the user
        // configured and the agent is already about to read and write.
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "--recursive",
      ],
      cwd: workspacePath,
      timeoutMs: this.submoduleTimeoutMs,
    });

    if (result.exitCode !== 0) {
      getLoggerSafe().warn("Workspace submodules could not be checked out", {
        workspacePath,
        stderr: result.stderr.trim().slice(0, 500),
        consequence:
          "the agent's workspace is missing submodule content (e.g. Strada.Core), so framework-conformant output cannot be expected",
      });
    }
  }

  /**
   * Keep commits the agent made inside the worktree reachable.
   *
   * A worktree is created --detach, so "commit per logical unit" prompts
   * produce commits on a detached HEAD that become unreachable the moment the
   * worktree is removed — a sprint's whole commit history silently garbage-
   * collectable. The objects already live in the shared store; a branch in the
   * source repo is all it takes to keep them. Best-effort, never blocks removal.
   */
  private async preserveLeaseCommits(workspacePath: string): Promise<void> {
    try {
      const unique = await this.commandRunner({
        command: "git",
        args: ["-C", workspacePath, "rev-list", "--count", "HEAD", "--not", "--all"],
        cwd: workspacePath,
        timeoutMs: this.worktreeTimeoutMs,
      });
      if (unique.exitCode !== 0 || Number(unique.stdout.trim() || "0") === 0) return;
      const head = await this.commandRunner({
        command: "git",
        args: ["-C", workspacePath, "rev-parse", "HEAD"],
        cwd: workspacePath,
        timeoutMs: this.worktreeTimeoutMs,
      });
      const sha = head.stdout.trim();
      if (head.exitCode !== 0 || !sha) return;
      const branch = `lease-salvage/${basename(workspacePath)}`;
      const result = await this.commandRunner({
        command: "git",
        args: ["-C", this.projectRoot, "branch", "--force", branch, sha],
        cwd: this.projectRoot,
        timeoutMs: this.worktreeTimeoutMs,
      });
      if (result.exitCode === 0) {
        getLoggerSafe().info("Preserved lease commits on a salvage branch", {
          branch,
          commits: unique.stdout.trim(),
        });
      }
    } catch {
      // Preservation is best-effort; removal proceeds regardless.
    }
  }

  private async removeGitWorktree(workspacePath: string): Promise<void> {
    await this.preserveLeaseCommits(workspacePath);
    const result = await this.commandRunner({
      command: "git",
      args: ["-C", this.projectRoot, "worktree", "remove", "--force", workspacePath],
      cwd: this.projectRoot,
      timeoutMs: this.worktreeTimeoutMs,
    });

    if (result.exitCode !== 0) {
      this.removeDirectory(workspacePath);
      return;
    }

    this.removeDirectory(workspacePath);
  }

  /**
   * Walks the lease and copies changed/new files back into the source root.
   *
   * Only regular files under the same filter used to seed the lease are
   * considered, so build output and ignored directories never travel back.
   * Content is compared byte-for-byte rather than by mtime: cpSync preserves
   * timestamps, so an unchanged file must not read as modified.
   */
  private async commitLease(
    sourceRoot: string,
    workspacePath: string,
    leaseSeed: ReadonlyMap<string, number>,
    sourceSeed: ReadonlyMap<string, number>,
    quarantineRoot: string | null,
    opts?: { quarantineOnly?: boolean },
  ): Promise<WorkspaceCommitResult> {
    const written: string[] = [];
    const conflicts: string[] = [];
    const removed: string[] = [];
    const failed: string[] = [];
    let conflictsQuarantinedUnder: string | null = null;
    if (!existsSync(workspacePath)) {
      return { written, conflicts, removed, failed, conflictsQuarantinedUnder };
    }

    // Bulk write into the REAL project: serialize against the other bulk
    // writer (the campaign envelope commit), including one in another
    // process. Derived leases (sourceRoot inside the lease root) skip — they
    // are private scratch space.
    const lock = sourceRoot === this.projectRoot
      ? await (await import("../../common/project-write-lock.js")).acquireProjectWriteLock(
          this.projectRoot,
          { timeoutMs: 30_000 },
        )
      : null;
    try {

    const walk = (dir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        // A directory that cannot be listed must not abort the walk — the
        // remaining files still deserve their chance to travel home.
        const relDir = relative(workspacePath, dir) || ".";
        failed.push(`${relDir} (unreadable: ${err instanceof Error ? err.message : String(err)})`);
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (!this.shouldCommitEntry(workspacePath, full)) continue;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;

        const rel = relative(workspacePath, full);

        try {
          const target = join(sourceRoot, rel);

          // FIRST question: did the AGENT touch this file? Only its own work may
          // travel back.
          //
          // Comparing the lease against the project instead is the mistake that
          // made the first version of this destroy user data. A git-worktree
          // lease — the DEFAULT kind — is seeded from HEAD, not from the working
          // tree, so every file the user had modified-but-uncommitted differs
          // from the lease. That read as "the agent changed it" and copied HEAD
          // over the user's edit. Reproduced: a task whose agent only created an
          // unrelated Board.cs reported written:[Board.cs, Player.cs] and
          // reverted Player.cs to its committed contents.
          const leaseSeeded = leaseSeed.get(rel);
          if (leaseSeeded !== undefined && statSync(full).mtimeMs === leaseSeeded) {
            continue; // present at seed time and never written to — not agent work
          }

          // Quarantine-only mode (orphan salvage): nothing is written into the
          // project — non-identical files land in quarantine for review.
          if (opts?.quarantineOnly) {
            const salvageTarget = join(sourceRoot, rel);
            if (existsSync(salvageTarget) && readFileSync(salvageTarget).equals(readFileSync(full))) {
              continue;
            }
            conflicts.push(rel);
            if (quarantineRoot) {
              try {
                const quarantined = join(quarantineRoot, rel);
                mkdirSync(dirname(quarantined), { recursive: true });
                cpSync(full, quarantined, { force: true });
                conflictsQuarantinedUnder ??= quarantineRoot;
              } catch {
                // Quarantine failed; the conflict report still stands.
              }
            }
            continue;
          }

          // SECOND question: did the USER change it while the agent ran? Their
          // copy wins, and they are told rather than silently overwritten.
          if (existsSync(target)) {
            if (readFileSync(target).equals(readFileSync(full))) continue; // already identical
            // Compared against the mtime recorded when the lease was taken, not a
            // wall clock: Date.now() is whole milliseconds while mtimeMs carries
            // a fraction, so a file written in the same millisecond as the lease
            // reads as "modified after" — measured at +0.63 ms.
            const sourceSeeded = sourceSeed.get(rel);
            if (sourceSeeded === undefined || statSync(target).mtimeMs !== sourceSeeded) {
              conflicts.push(rel);
              // The agent's version used to be destroyed together with the
              // released workspace — hours of autonomous work lost to a single
              // .meta touch by the editor. Preserve it under the project's
              // .strada namespace; best-effort, never blocks the commit.
              if (quarantineRoot) {
                try {
                  const quarantined = join(quarantineRoot, rel);
                  mkdirSync(dirname(quarantined), { recursive: true });
                  cpSync(full, quarantined, { force: true });
                  conflictsQuarantinedUnder ??= quarantineRoot;
                } catch {
                  // Quarantine failed; the conflict report still stands.
                }
              }
              continue;
            }
          }

          mkdirSync(dirname(target), { recursive: true });
          cpSync(full, target, { force: true });
          written.push(rel);
        } catch (err) {
          // One locked or half-deleted file must not cost the rest of the
          // commit — measured in production: a walk that threw on an
          // editor-locked asset silently dropped every file after it.
          failed.push(`${rel} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    };

    walk(workspacePath);
    // A file the agent removed is a decision it made about the project. We do not
    // act on it — deleting a user's files is not a commit's call — but leaving it
    // unsaid means the project silently diverges from what the agent believes it
    // produced, and the next run inherits that gap.
    for (const [rel] of leaseSeed) {
      try {
        if (existsSync(join(workspacePath, rel))) continue;
        if (!existsSync(join(sourceRoot, rel))) continue;
        removed.push(rel);
      } catch {
        // A seed entry we can no longer stat says nothing useful about the
        // project — skip it rather than lose the rest of the report.
      }
    }
    if (removed.length > 0) {
      getLoggerSafe().info("Workspace deletions left in place", {
        count: removed.length,
        sample: removed.slice(0, 5),
      });
    }
    if (failed.length > 0) {
      getLoggerSafe().warn("Workspace commit skipped files it could not process", {
        count: failed.length,
        sample: failed.slice(0, 5),
      });
    }

    return { written, conflicts, removed, failed, conflictsQuarantinedUnder };
    } finally {
      lock?.release();
    }
  }

  private async createTempCopy(sourceRoot: string, workspacePath: string): Promise<void> {
    mkdirSync(dirname(workspacePath), { recursive: true });
    cpSync(sourceRoot, workspacePath, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      dereference: false,
      filter: (source) => this.shouldCopyEntry(sourceRoot, source),
    });
  }

  /** Records every seeded file's mtime, so commit() can tell an edit the user
   *  made during the run from a file that merely shares the lease's timestamp. */
  private snapshotMtimes(root: string, excludeRoot: string): Map<string, number> {
    const seeded = new Map<string, number>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (!this.shouldCommitEntry(excludeRoot, full)) continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) seeded.set(relative(root, full), statSync(full).mtimeMs);
      }
    };
    if (existsSync(root)) walk(root);
    return seeded;
  }

  /**
   * Exclusions for the write-back walk.
   *
   * shouldCopyEntry keys off `sourceRoot !== this.projectRoot` to pick between
   * the derived-copy list and the configured one. Walking a LEASE always takes
   * the first branch, because a lease path is never the project root — so the
   * configured excludes (Library, Temp, Logs, Builds, obj on a Unity project)
   * were not applied and those directories could be pushed INTO the user's
   * project. The write-back must use exactly the list the seed used.
   */
  private shouldCommitEntry(root: string, path: string): boolean {
    if (path === root) return true;
    const rel = path.slice(root.length).replace(/^[/\\]/, "");
    if (!rel) return true;
    const firstSegment = rel.split(/[/\\]/, 1)[0];
    if (!firstSegment) return true;
    return !this.fallbackExcludes.has(firstSegment) && !DERIVED_COPY_EXCLUDES.has(firstSegment);
  }

  private shouldCopyEntry(sourceRoot: string, sourcePath: string): boolean {
    if (sourcePath === sourceRoot) {
      return true;
    }

    const relative = sourcePath.slice(sourceRoot.length).replace(/^[/\\]/, "");
    if (!relative) {
      return true;
    }

    const firstSegment = relative.split(/[/\\]/, 1)[0];
    if (!firstSegment) {
      return true;
    }

    if (sourceRoot !== this.projectRoot) {
      return !DERIVED_COPY_EXCLUDES.has(firstSegment);
    }

    return !this.fallbackExcludes.has(firstSegment);
  }

  private removeDirectory(workspacePath: string): void {
    const normalized = resolve(workspacePath);
    if (!isInsidePath(this.leaseRoot, normalized)) {
      throw new Error(`Refusing to clean up outside lease root: ${normalized}`);
    }
    rmSync(normalized, { recursive: true, force: true });
  }
}
