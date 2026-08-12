import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, dirname, sep, relative } from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { runProcess } from "../../utils/process-runner.js";

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
   * lease was taken is reported as a conflict rather than overwritten.
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
}) => Promise<WorkspaceCommandResult>;

export interface WorkspaceLeaseManagerOptions {
  readonly projectRoot: string;
  readonly leaseRoot?: string;
  readonly preferGitWorktree?: boolean;
  readonly commandRunner?: WorkspaceCommandRunner;
  readonly worktreeTimeoutMs?: number;
  /** Additional directory names to exclude from fallback temp-copy workspaces */
  readonly additionalExcludes?: readonly string[];
}

const DEFAULT_LEASE_ROOT = join(os.tmpdir(), "strada-workspaces");
const DEFAULT_WORKTREE_TIMEOUT_MS = 30_000;
const BASE_FALLBACK_COPY_EXCLUDES = new Set([
  ".git",
  "node_modules",
  ".strada-memory",
  "dist",
  "coverage",
  ".cache",
  ".vite",
]);
const DERIVED_COPY_EXCLUDES = new Set([
  ".git",
  "node_modules",
  "coverage",
  ".cache",
  ".vite",
]);

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

    this.leaseRoot = resolve(options.leaseRoot ?? DEFAULT_LEASE_ROOT);
    mkdirSync(this.leaseRoot, { recursive: true });
    this.preferGitWorktree = options.preferGitWorktree ?? true;
    this.commandRunner = options.commandRunner ?? runProcess;
    this.worktreeTimeoutMs = options.worktreeTimeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS;
    this.fallbackExcludes = options.additionalExcludes?.length
      ? new Set([...BASE_FALLBACK_COPY_EXCLUDES, ...options.additionalExcludes])
      : BASE_FALLBACK_COPY_EXCLUDES;
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

    // Two snapshots, both taken after seeding.
    //   leaseSeed  — the workspace as the agent received it. A file whose mtime
    //                is unchanged here was not touched by the agent.
    //   sourceSeed — the project as it stood when the lease was taken, so an
    //                edit the user makes DURING the run is detectable.
    const leaseSeed = this.snapshotMtimes(workspacePath, workspacePath);
    const sourceSeed = this.snapshotMtimes(sourceRoot, sourceRoot);

    let released = false;
    const lease: WorkspaceLease = {
      commit: async () => this.commitLease(sourceRoot, workspacePath, leaseSeed, sourceSeed),
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
  async dispose(): Promise<void> {
    const leases = Array.from(this.activeLeases.values());
    this.activeLeases.clear();
    await Promise.allSettled(leases.map((l) => l.release()));
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
  }

  private async removeGitWorktree(workspacePath: string): Promise<void> {
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
  ): Promise<WorkspaceCommitResult> {
    const written: string[] = [];
    const conflicts: string[] = [];
    if (!existsSync(workspacePath)) return { written, conflicts };

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (!this.shouldCommitEntry(workspacePath, full)) continue;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;

        const rel = relative(workspacePath, full);
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
            continue;
          }
        }

        mkdirSync(dirname(target), { recursive: true });
        cpSync(full, target, { force: true });
        written.push(rel);
      }
    };

    walk(workspacePath);
    return { written, conflicts };
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
