import { readFile, stat } from "node:fs/promises";
import { relative as pathRelative, resolve as pathResolve, sep as pathSep } from "node:path";
import { validatePath } from "../../security/path-guard.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { FILE_LIMITS } from "../../common/constants.js";
import type { IVault, VaultChunk } from "../../vault/vault.interface.js";
import { getLoggerSafe } from "../../utils/logger.js";

const MAX_FILE_SIZE = FILE_LIMITS.MAX_FILE_SIZE;
const MAX_LINES = FILE_LIMITS.MAX_LINES;

/** Filesystem mtime can drift by sub-ms across stat calls on some hosts; treat ≤1ms as "no drift". */
const VAULT_MTIME_TOLERANCE_MS = 1;
/** Upper bound on how many chunks / symbol matches we pull when resolving a range read. */
const VAULT_CHUNK_FETCH_LIMIT = 32;
/** Cap the allowed symbol name length to avoid pathological inputs (sec-M3). */
const MAX_SYMBOL_LEN = 200;

/**
 * Module-level counters — process-global, shared across concurrent sessions.
 * Acceptable for current single-process use. If multi-session attribution is
 * needed, move into VaultRegistry or pass via ToolContext.
 *
 * Exposed via getVaultFileReadStats() for telemetry.
 */
let vaultHitCount = 0;
let vaultMissCount = 0;
let vaultStaleCount = 0;

export function getVaultFileReadStats(): Readonly<{
  hits: number;
  misses: number;
  stale: number;
}> {
  return { hits: vaultHitCount, misses: vaultMissCount, stale: vaultStaleCount };
}

/** Test hook — reset counters between cases. */
export function resetVaultFileReadStats(): void {
  vaultHitCount = 0;
  vaultMissCount = 0;
  vaultStaleCount = 0;
}

export class FileReadTool implements ITool {
  readonly name = "file_read";
  readonly description =
    "Read the contents of a file in the Unity project. Returns the file content with line numbers. " +
    "Use this to understand existing code before making changes. " +
    "When offset/limit or symbol is provided and a Codebase Memory Vault is active, " +
    "this tool serves the requested range from the vault cache without touching disk.";

  readonly inputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Relative path from the project root (e.g., 'Assets/Scripts/PlayerController.cs')",
      },
      offset: {
        type: "number",
        description: "Starting line number (1-based). Optional.",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to return. Default: 2000.",
      },
      symbol: {
        type: "string",
        description:
          "Optional symbol name (class / method / function). When provided with an active vault, " +
          "the vault resolves the line range instead of a numeric offset/limit.",
      },
    },
    required: ["path"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const relPath = String(input["path"] ?? "");
    const offsetProvided = input["offset"] !== undefined;
    const limitProvided = input["limit"] !== undefined;
    const rawSymbol = input["symbol"];
    // sec-M3: cap symbol length up-front so a pathological input can never
    // reach the vault's symbol resolver.
    if (typeof rawSymbol === "string" && rawSymbol.length > MAX_SYMBOL_LEN) {
      return {
        content: `Error: 'symbol' exceeds ${MAX_SYMBOL_LEN} characters`,
        isError: true,
      };
    }
    const symbol = typeof rawSymbol === "string" && rawSymbol.length > 0
      ? rawSymbol
      : undefined;
    const offset = Math.max(1, Number(input["offset"] ?? 1));
    const limit = Math.min(MAX_LINES, Math.max(1, Number(input["limit"] ?? MAX_LINES)));

    if (!relPath) {
      return { content: "Error: 'path' is required", isError: true };
    }

    const pathCheck = await validatePath(context.projectPath, relPath);
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }

    const rangeScoped = offsetProvided || limitProvided || !!symbol;

    // ── Vault-first read path (range-scoped only) ────────────────────────
    // Full-file reads still go to disk — vault chunks would fragment output.
    if (rangeScoped && context.vaultRegistry) {
      const vault = context.vaultRegistry.resolveVaultForPath(
        pathCheck.fullPath,
        context.projectPath,
      );
      // sec-H2: cross-vault containment invariant. Even if a vault owns the
      // resolved path, we must confine file_read to the session's projectPath.
      // If the matched vault's root is outside projectPath, fall through to
      // disk (path-guard already validated fullPath against projectPath above).
      if (vault && isVaultInsideProject(vault, context.projectPath)) {
        const vaultRel = toVaultRelative(vault, pathCheck.fullPath);
        const vaultResult = await this.tryVaultRead({
          vault,
          vaultRelPath: vaultRel,
          absPath: pathCheck.fullPath,
          displayPath: relPath,
          offset: offsetProvided ? offset : undefined,
          limit: limitProvided ? limit : undefined,
          symbol,
        });
        if (vaultResult) {
          vaultHitCount += 1;
          return vaultResult;
        }
      }
    }

    // ── Fallback: disk read (unchanged behaviour) ────────────────────────
    try {
      const fileStat = await stat(pathCheck.fullPath);
      if (!fileStat.isFile()) {
        return { content: "Error: target is not a file", isError: true };
      }
      if (fileStat.size > MAX_FILE_SIZE) {
        return {
          content: `Error: file too large (${Math.round(fileStat.size / 1024)}KB). Max: ${MAX_FILE_SIZE / 1024}KB. Use offset/limit.`,
          isError: true,
        };
      }

      const content = await readFile(pathCheck.fullPath, "utf-8");
      const lines = content.split("\n");
      const totalLines = lines.length;
      const selectedLines = lines.slice(offset - 1, offset - 1 + limit);

      const numbered = selectedLines
        .map((line, i) => `${String(offset + i).padStart(5)} | ${line}`)
        .join("\n");

      const header = `File: ${relPath} (${totalLines} lines total, showing ${offset}-${Math.min(offset + limit - 1, totalLines)})`;

      // Count disk path + fire-and-forget reindex if vault is out of sync.
      if (context.vaultRegistry) {
        vaultMissCount += 1;
        const vault = context.vaultRegistry.resolveVaultForPath(
          pathCheck.fullPath,
          context.projectPath,
        );
        if (vault) {
          void scheduleReindexIfStale(vault, pathCheck.fullPath, fileStat.mtimeMs, fileStat.size);
        }
      }

      return { content: `${header}\n${numbered}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { content: "Error: file not found", isError: true };
      }
      return { content: "Error: could not read file", isError: true };
    }
  }

  /**
   * Attempt to satisfy a range-scoped read from the vault.
   * Returns `null` if the vault has no indexed data for the file, or if the
   * indexed data is stale — callers then fall back to disk.
   */
  private async tryVaultRead(params: {
    vault: IVault;
    vaultRelPath: string;
    absPath: string;
    displayPath: string;
    offset?: number;
    limit?: number;
    symbol?: string;
  }): Promise<ToolExecutionResult | null> {
    const { vault, vaultRelPath, absPath, displayPath, offset, limit, symbol } = params;

    const indexed = vault.listFiles().find((f) => f.path === vaultRelPath);
    if (!indexed) return null;

    // Staleness check: mtime or size drift → bail to disk, kick off reindex.
    let diskStat: { mtimeMs: number; size: number };
    try {
      const st = await stat(absPath);
      if (!st.isFile()) return null;
      diskStat = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }

    // Staleness is recounted by the disk-fallback path via scheduleReindexIfStale —
    // we only bail here and mark the stale counter; reindex scheduling is single-sourced below.
    const mtimeDelta = Math.abs(diskStat.mtimeMs - indexed.mtimeMs);
    const stale = mtimeDelta > VAULT_MTIME_TOLERANCE_MS || diskStat.size !== indexed.size;
    if (stale) {
      vaultStaleCount += 1;
      return null;
    }

    // Resolve the desired [startLine, endLine] range.
    let wantedStart: number | null = null;
    let wantedEnd: number | null = null;

    if (symbol && typeof vault.findSymbolsByName === "function") {
      const matches = await vault.findSymbolsByName(symbol, VAULT_CHUNK_FETCH_LIMIT);
      const sameFile = matches.find((s) => s.path === vaultRelPath);
      if (sameFile) {
        wantedStart = sameFile.startLine;
        wantedEnd = sameFile.endLine;
      }
    }
    if (wantedStart === null || wantedEnd === null) {
      if (offset !== undefined) {
        wantedStart = offset;
        const lim = limit ?? MAX_LINES;
        wantedEnd = offset + lim - 1;
      } else {
        return null;
      }
    }

    // Pull chunks covering the range. VaultRegistry.query handles merge/rank
    // across all vaults; we target a single vault by id for precision.
    const queryText = symbol ?? `${vaultRelPath}:${wantedStart}-${wantedEnd}`;
    const qr = await vault.query({
      text: queryText,
      topK: VAULT_CHUNK_FETCH_LIMIT,
      pathGlob: vaultRelPath,
    });

    const coveringChunks = qr.hits
      .map((h) => h.chunk)
      .filter((c) => c.path === vaultRelPath)
      .filter((c) => c.endLine >= (wantedStart as number) && c.startLine <= (wantedEnd as number))
      .sort((a, b) => a.startLine - b.startLine);

    if (!coveringChunks.length) {
      // Indexed but no chunks overlap — treat as miss.
      return null;
    }

    const merged = mergeChunkContent(coveringChunks, wantedStart as number, wantedEnd as number);
    if (!merged) return null;

    const header =
      `File: ${displayPath} (vault-cached, ${merged.startLine}-${merged.endLine}` +
      (symbol ? `, symbol="${symbol}"` : "") +
      `, source=vault:${vault.id})`;

    const numbered = merged.lines
      .map((line, i) => `${String(merged.startLine + i).padStart(5)} | ${line}`)
      .join("\n");

    return {
      content: `${header}\n${numbered}`,
      metadata: {
        executionTimeMs: 0,
        source: `vault:${vault.id}`,
      },
    };
  }
}

/** Convert absolute disk path to vault-relative (POSIX-style), using the vault's rootPath. */
function toVaultRelative(vault: IVault, absPath: string): string {
  return pathRelative(vault.rootPath, absPath).replaceAll("\\", "/");
}

/**
 * sec-H2: true iff the vault's rootPath is contained within (or equal to)
 * the session's projectPath. Keeps file_read strictly confined to the
 * current project, even when the VaultRegistry also owns a sibling vault
 * (e.g. the SelfVault pointing at the Brain source tree).
 */
function isVaultInsideProject(vault: IVault, projectPath: string): boolean {
  const root = pathResolve(vault.rootPath);
  const project = pathResolve(projectPath);
  if (root === project) return true;
  const projectWithSep = project.endsWith(pathSep) ? project : project + pathSep;
  return root.startsWith(projectWithSep);
}

/**
 * Merge ordered chunks into a single contiguous line slice clipped to
 * [wantedStart, wantedEnd]. Returns null if the chunks do not cover the
 * wanted start line (partial-coverage case).
 */
function mergeChunkContent(
  chunks: VaultChunk[],
  wantedStart: number,
  wantedEnd: number,
): { lines: string[]; startLine: number; endLine: number } | null {
  if (!chunks.length) return null;

  // Collapse overlapping chunks into a line map keyed by 1-based line number.
  const lineMap = new Map<number, string>();
  for (const c of chunks) {
    const chunkLines = c.content.split("\n");
    for (let i = 0; i < chunkLines.length; i++) {
      const ln = c.startLine + i;
      if (!lineMap.has(ln)) lineMap.set(ln, chunkLines[i] ?? "");
    }
  }

  const effectiveStart = Math.max(wantedStart, chunks[0]!.startLine);
  const effectiveEnd = Math.min(wantedEnd, chunks[chunks.length - 1]!.endLine);
  if (effectiveEnd < effectiveStart) return null;
  if (!lineMap.has(effectiveStart)) return null;
  // review-F3: if the vault only partially covers the caller's requested
  // range, fall back to disk rather than silently truncating. The model
  // expects the full wantedStart..wantedEnd slice or a clear miss.
  if (effectiveStart > wantedStart || effectiveEnd < wantedEnd) return null;

  const out: string[] = [];
  for (let ln = effectiveStart; ln <= effectiveEnd; ln++) {
    out.push(lineMap.get(ln) ?? "");
  }
  return { lines: out, startLine: effectiveStart, endLine: effectiveEnd };
}

/** Fire-and-forget reindex when a file drifts from the vault snapshot. */
function scheduleReindexIfStale(
  vault: IVault,
  absPath: string,
  mtimeMs: number,
  size: number,
): void {
  const rel = toVaultRelative(vault, absPath);
  const indexed = vault.listFiles().find((f) => f.path === rel);
  if (!indexed) return;
  const mtimeDelta = Math.abs(indexed.mtimeMs - mtimeMs);
  if (mtimeDelta <= VAULT_MTIME_TOLERANCE_MS && indexed.size === size) return;
  void scheduleReindex(vault, rel);
}

function scheduleReindex(vault: IVault, vaultRelPath: string): void {
  const maybe = vault as IVault & { reindexFile?: (p: string) => Promise<boolean> };
  if (typeof maybe.reindexFile !== "function") return;
  maybe.reindexFile(vaultRelPath).catch((err: unknown) => {
    // sec-L3: previously swallowed silently. Staleness is recoverable on the
    // next watcher tick, but we still want operators to see the failure.
    const msg = err instanceof Error ? err.message : String(err);
    getLoggerSafe().warn(`[vault] reindex failed for ${vaultRelPath} (vault=${vault.id}): ${msg}`);
  });
}

