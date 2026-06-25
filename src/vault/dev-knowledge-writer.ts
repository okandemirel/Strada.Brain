import { sanitizePromptInjection } from '../agents/orchestrator-text-utils.js';
import { xxhash64Hex } from './hash.js';
import type { VaultRegistry } from './vault-registry.js';
import type { IVault } from './vault.interface.js';

/**
 * Minimal note-writer seam for the LIVING VAULT write-back.
 *
 * Defined here in `src/vault/` (which `src/learning/` may depend on by
 * TYPE only) so the learning pipeline can persist human-readable notes to the
 * dev-knowledge vault WITHOUT importing any concrete vault implementation —
 * no runtime `src/learning -> src/vault` edge, so no import cycle. Bootstrap
 * constructs the concrete {@link DevKnowledgeNoteWriterImpl} (which closes over
 * the {@link VaultRegistry}) and injects it via `LearningPipeline.setNoteWriter`.
 */
export interface DevKnowledgeNoteWriter {
  /**
   * Write a markdown note into the dev-knowledge vault and reindex it.
   * Best-effort — implementations MUST swallow/log failures and never throw
   * onto a caller's hot path. Returns true when the note was written.
   */
  writeNote(relPath: string, content: string): Promise<boolean>;
}

/** A logger surface narrow enough to accept getLogger()/console-like objects. */
export interface DevKnowledgeWriterLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
}

const MAX_GOAL_CHARS = 500;
const MAX_REASON_CHARS = 500;
const MAX_FILES = 20;
const MAX_ERRORS = 3;
const MAX_SLUG_LEN = 60;

/** YYYY-MM-DD in UTC for the date-bucketed note directory. */
function dateBucket(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Narrow a vault to one that exposes the optional `reindexFile` method. Kept
 * local (mirrors the guard in vault-write-note-tool.ts) so this module stays
 * import-cycle-free — it must not reach into src/agents to reuse that copy.
 */
function hasReindexFile(vault: unknown): vault is { reindexFile(path: string): Promise<boolean> } {
  return typeof (vault as { reindexFile?: unknown }).reindexFile === 'function';
}

/** Filesystem-safe, lowercase, hyphenated slug derived from arbitrary text. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, '');
  return slug || 'task';
}

/** Short, stable id suffix (8 hex) for filename dedup keying. */
function shortId(seed: string): string {
  return xxhash64Hex(seed).slice(0, 8);
}

export interface CompletionNoteInput {
  goal: string;
  success: boolean;
  /** routeError.message or finalOutput — the outcome reason / blocking cause. */
  reason?: string;
  taskRunId?: string;
  filesTouched: readonly string[];
  iterationsUsed: number;
  mutationsSinceVerify: number;
  errorCount: number;
  errorHistory: readonly string[];
  /** ISO timestamp; defaults to now. */
  isoDate?: string;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Compose the structured, prompt-injection-sanitized task-completion note.
 *
 * User goal text + error messages are persisted into a re-read, indexed corpus,
 * so EVERY free-text field is run through {@link sanitizePromptInjection}.
 * Field caps keep the note well under a few KB (and far under the 2MB vault
 * write-path backstop).
 */
export function composeCompletionNote(input: CompletionNoteInput): { relPath: string; content: string } {
  const iso = input.isoDate ?? new Date().toISOString();
  const goal = sanitizePromptInjection(cap(input.goal.trim(), MAX_GOAL_CHARS));
  const reason = input.reason ? sanitizePromptInjection(cap(input.reason.trim(), MAX_REASON_CHARS)) : '';
  const title = cap(goal.replace(/\s+/g, ' ').trim(), 80) || 'Task';
  const outcome = input.success ? 'success' : 'failure';

  const files = input.filesTouched.slice(0, MAX_FILES).map((f) => sanitizePromptInjection(f));
  const filesBlock = files.length
    ? files.map((f) => `- ${f}`).join('\n')
    : '- (none)';

  const errors = input.errorHistory.slice(-MAX_ERRORS).map((e) => sanitizePromptInjection(cap(e.trim(), 200)));
  const errorsBlock = errors.length ? errors.map((e) => `- ${e}`).join('\n') : '- (none)';

  const learning = input.success
    ? (reason ? `Approach that worked: ${cap(reason, 200)}` : 'Completed successfully.')
    : `Blocked by: ${reason ? cap(reason, 200) : 'unknown reason'}`;

  // Frontmatter title is quoted + inner quotes stripped so a goal containing a
  // colon/quote cannot break the YAML.
  const fmTitle = title.replace(/["\n]/g, ' ').trim();

  const content = [
    '---',
    `title: "${fmTitle}"`,
    `date: ${iso}`,
    `outcome: ${outcome}`,
    `taskRunId: ${input.taskRunId ?? 'unknown'}`,
    '---',
    '',
    '## Goal',
    goal || '(empty)',
    '',
    '## Outcome',
    `${input.success ? 'Completed' : 'Failed'}${reason ? ` — ${reason}` : ''}`,
    '',
    '## Files Touched',
    filesBlock,
    '',
    '## Tools / Steps',
    `${input.iterationsUsed} steps; mutations=${input.mutationsSinceVerify}; errors=${input.errorCount}`,
    '',
    '## Errors / Recovery',
    errorsBlock,
    '',
    '## Key Learning',
    learning,
    '',
  ].join('\n');

  const runSuffix = shortId(input.taskRunId || `${iso}:${title}`);
  const relPath = `knowledge/${dateBucket(new Date(iso))}/${slugify(title)}-${runSuffix}.md`;
  return { relPath, content };
}

/** Structural shape of a TaskPlanner trajectory step — kept local to avoid a
 *  src/vault -> src/learning import. Only the fields the file-derivation needs. */
export interface CompletionTrajectoryStep {
  toolName: string;
  input?: Record<string, unknown> | undefined;
}

/** Structural shape of the TaskPlanner state fields the note needs. */
export interface CompletionTaskState {
  iterationsUsed: number;
  mutationsSinceVerify: number;
  errorHistory: readonly string[];
}

const FILE_MUTATION_TOOL_RE = /^(Edit|Write|MultiEdit|file_edit|file_write|file_delete|file_rename)$/i;

/**
 * Derive the set of touched file paths from trajectory steps (mutation tools
 * only). Pulls the path from the common input key names.
 */
export function deriveFilesTouched(steps: readonly CompletionTrajectoryStep[]): string[] {
  const out = new Set<string>();
  for (const step of steps) {
    const name = String(step.toolName);
    if (!FILE_MUTATION_TOOL_RE.test(name)) continue;
    const input = step.input ?? {};
    for (const key of ['file_path', 'path', 'filePath', 'filename'] as const) {
      const v = input[key];
      if (typeof v === 'string' && v.length > 0) {
        out.add(v);
        break;
      }
    }
  }
  return [...out];
}

export interface CompletionWriteParams {
  goal: string;
  success: boolean;
  reason?: string;
  taskRunId?: string;
  state: CompletionTaskState;
  steps: readonly CompletionTrajectoryStep[];
  errorCount: number;
  logger?: DevKnowledgeWriterLogger;
}

/**
 * LIVING VAULT (B) — the route completion-hook write-back, fully self-contained
 * and best-effort. Applies the REAL-WORK gate (decomposed/ran tools/touched
 * files, INCLUDING failures; skips trivial chat), composes the structured note,
 * and fires the fire-and-forget vault write. NEVER awaited on the request path,
 * NEVER throws onto it.
 *
 * Gate: `realWork = iterationsUsed > 0 || filesTouched.size > 0`. A task that
 * errored before any tool ran (iterationsUsed === 0, no files) is trivial → skip.
 * Failures with iterationsUsed > 0 STILL write (failures are valuable learnings).
 */
export function fireDevKnowledgeCompletionNote(
  writer: DevKnowledgeNoteWriter | undefined,
  params: CompletionWriteParams,
): void {
  if (!writer) return;
  void (async () => {
    try {
      const filesTouched = deriveFilesTouched(params.steps);
      const realWork = params.state.iterationsUsed > 0 || filesTouched.length > 0;
      if (!realWork) return; // trivial chat — write nothing
      const { relPath, content } = composeCompletionNote({
        goal: params.goal,
        success: params.success,
        reason: params.reason,
        taskRunId: params.taskRunId,
        filesTouched,
        iterationsUsed: params.state.iterationsUsed,
        mutationsSinceVerify: params.state.mutationsSinceVerify,
        errorCount: params.errorCount,
        errorHistory: params.state.errorHistory,
      });
      await writer.writeNote(relPath, content);
    } catch (err) {
      params.logger?.debug('[dev-knowledge] completion note failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

/**
 * Concrete writer over the {@link VaultRegistry}. Resolves the dev-knowledge
 * vault by `kind === 'knowledge'` (the dedicated, write-hook-disjoint kind),
 * writes via the hardened `writeFile` (path-sanitized) and reindexes so the
 * note is immediately searchable. Fully best-effort: any failure (no vault,
 * write error, reindex error) is swallowed and debug-logged.
 */
export class DevKnowledgeNoteWriterImpl implements DevKnowledgeNoteWriter {
  constructor(
    private readonly registry: VaultRegistry,
    private readonly logger?: DevKnowledgeWriterLogger,
  ) {}

  private resolveKnowledgeVault(): IVault | undefined {
    return this.registry.list().find((v) => v.kind === 'knowledge');
  }

  async writeNote(relPath: string, content: string): Promise<boolean> {
    try {
      const vault = this.resolveKnowledgeVault();
      if (!vault || !vault.writeFile) return false;
      await vault.writeFile(relPath, content);
      // Reindex so the note is immediately searchable. Best-effort: the watcher
      // also picks it up on its debounce tick as a backstop.
      if (hasReindexFile(vault)) {
        await vault.reindexFile(relPath);
      }
      return true;
    } catch (err) {
      this.logger?.debug('[dev-knowledge] note write failed', {
        relPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
