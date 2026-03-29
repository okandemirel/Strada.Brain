import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";
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

export interface WorkspaceLease {
  readonly id: string;
  readonly kind: WorkspaceLeaseKind;
  readonly sourceRoot: string;
  readonly leaseRoot: string;
  readonly path: string;
  readonly label?: string;
  readonly workerId?: string;
  readonly createdAt: number;
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

    let released = false;
    return {
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
        await releaseImpl();
      },
    };
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
