import { readFile, realpath, stat } from "node:fs/promises";
import { relative as pathRelative, resolve as pathResolve, sep as pathSep } from "node:path";
import { isSensitivePath, validatePath } from "../../security/path-guard.js";
import { extractDocumentText, RICH_DOCUMENT_EXTENSIONS } from "./document-text.js";
import { isUserAuthorizedPath } from "../../security/user-authorized-paths.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { FILE_LIMITS } from "../../common/constants.js";
import type { IVault } from "../../vault/vault.interface.js";
import { getLoggerSafe } from "../../utils/logger.js";
import { nearbyNames, sameNameElsewhere } from "./nearby-names.js";

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
    "Read the contents of a file. Returns the file content with line numbers. " +
    "Reads files in the Unity project, and ALSO any file the user named by path in their own " +
    "message — a design document on their desktop, for example — so you never need to ask them to " +
    "move or convert one you were given. " +
    `Documents are decoded to text automatically (${RICH_DOCUMENT_EXTENSIONS.join(", ")}); do not ` +
    "assume a format is unreadable without trying. " +
    "Use this to understand existing code before making changes. " +
    "For code/symbol lookup, prefer `vault_search` or `vault_graph_explore`. " +
    "Only use `file_read` when you need exact byte-level content or the file is not yet indexed in the vault. " +
    "When a Codebase Memory Vault is active, this tool serves from the vault cache whenever possible.";

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
      // One exception, and only for reads: a file the user named in their own
      // message. Confinement is right for every path the agent picks itself,
      // and it also blocked the product's central case — "here is the design
      // document, build the game" — because such a document lives outside the
      // Unity project. The permission comes from the user having typed the
      // path, which is narrower than widening confinement for everything.
      const authorized = context.userAuthorizedPaths;
      if (isUserAuthorizedPath(relPath, authorized)) {
        // Audited 2026-09-02: this branch was taken for EVERY invalid result,
        // including a blocklist refusal — a user pasting an error line that
        // mentioned <project>/.env made that file readable, and an id_rsa
        // path quoted in an ssh warning was read from outside the project.
        // Naming a path relaxes confinement only; the sensitive-file
        // blocklist is a separate guarantee and holds regardless of who
        // named the path. Checked against the real path so a symlink cannot
        // hide the name.
        const namedPath = pathResolve(relPath);
        const realNamedPath = await realpath(namedPath).catch(() => namedPath);
        if (isSensitivePath(namedPath) || isSensitivePath(realNamedPath)) {
          return {
            content: "Error: Access to sensitive files is not permitted (the path was named in your message, but the sensitive-file blocklist is not relaxed by naming a path)",
            isError: true,
          };
        }
        return await readAuthorizedFile(relPath, offset, limit);
      }
      // The same help the ENOENT path gives. Measured 2026-08-21, 15:38: two
      // reads thirty seconds apart, one answered "that name is at: ..." and the
      // other bare — the difference being whether the missing file's PARENT
      // existed, which is nothing the caller did differently.
      const guardMessage = readErrorFor(pathCheck.error, relPath);
      const guardHelp = guardMessage.startsWith("file not found")
        ? await missHelp(context.projectPath, pathResolve(context.projectPath, relPath))
        : "";
      return { content: `Error: ${guardMessage}${guardHelp}`, isError: true };
    }

    // ── Vault-first read path ────────────────────────────────────────────
    if (context.vaultRegistry) {
      const vault = context.vaultRegistry.resolveVaultForPath(
        pathCheck.fullPath,
        context.projectPath,
      );
      // sec-H2: cross-vault containment invariant. Even if a vault owns the
      // resolved path, we must confine file_read to the session's projectPath.
      if (vault && isVaultInsideProject(vault, context.projectPath)) {
        const vaultRel = toVaultRelative(vault, pathCheck.fullPath);
        const vaultResult = await vaultFileRead({
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
      if (!isRichDocument(pathCheck.fullPath) && fileStat.size > MAX_FILE_SIZE) {
        return {
          content: `Error: file too large (${Math.round(fileStat.size / 1024)}KB). Max: ${MAX_FILE_SIZE / 1024}KB. Use offset/limit.`,
          isError: true,
        };
      }

      const decoded = extractDocumentText(pathCheck.fullPath, await readFile(pathCheck.fullPath));
      if (decoded === null) {
        return {
          content: `Error: ${relPath} is not a text document this tool can read`,
          isError: true,
        };
      }
      const content = decoded;
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
        return {
          content: `Error: file not found: ${relPath}${await missHelp(context.projectPath, pathCheck.fullPath)}`,
          isError: true,
        };
      }
      return { content: "Error: could not read file", isError: true };
    }
  }

}

/**
 * Attempt to satisfy a file read from the vault.
 * Returns `null` if the vault has no indexed data for the file, or if the
 * indexed data is stale — callers then fall back to disk.
 *
 * Works for both full-file and range-scoped reads (offset/limit/symbol).
 */
export async function vaultFileRead(params: {
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

  // Staleness check: mtime or size drift → bail to disk.
  let diskStat: { mtimeMs: number; size: number };
  try {
    const st = await stat(absPath);
    if (!st.isFile()) return null;
    diskStat = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }

  const mtimeDelta = Math.abs(diskStat.mtimeMs - indexed.mtimeMs);
  const stale = mtimeDelta > VAULT_MTIME_TOLERANCE_MS || diskStat.size !== indexed.size;
  if (stale) {
    vaultStaleCount += 1;
    return null;
  }

  // Resolve the desired [startLine, endLine] range.
  let wantedStart = offset ?? 1;
  let wantedEnd: number | null = null;

  if (symbol && typeof vault.findSymbolsByName === "function") {
    try {
      const matches = await vault.findSymbolsByName(symbol, VAULT_CHUNK_FETCH_LIMIT);
      const sameFile = matches.find((s) => s.path === vaultRelPath);
      if (sameFile) {
        wantedStart = sameFile.startLine;
        wantedEnd = sameFile.endLine;
      }
    } catch {
      // Symbol resolution failed — fall back to offset/limit or full file.
    }
  }

  // Read file from vault (uses vault's readFile which may be FS-backed or API-backed).
  let content: string;
  try {
    content = await vault.readFile(vaultRelPath);
  } catch {
    return null;
  }
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (wantedEnd === null) {
    const lim = limit ?? MAX_LINES;
    wantedEnd = Math.min(wantedStart + lim - 1, totalLines);
  }

  const selectedLines = lines.slice(wantedStart - 1, wantedEnd);
  const numbered = selectedLines
    .map((line, i) => `${String(wantedStart + i).padStart(5)} | ${line}`)
    .join("\n");

  const header =
    `File: ${displayPath} (vault-cached, ${totalLines} lines total, showing ${wantedStart}-${Math.min(wantedEnd, totalLines)}` +
    (symbol ? `, symbol="${symbol}"` : "") +
    `, source=vault:${vault.id})`;

  return {
    content: `${header}\n${numbered}`,
    metadata: {
      executionTimeMs: 0,
      source: `vault:${vault.id}`,
    },
  };
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
    getLoggerSafe().warn('[vault] reindex failed', {
      path: vaultRelPath,
      vaultId: vault.id,
      error: msg,
    });
  });
}

/**
 * Read a file the user named themselves.
 *
 * Deliberately plain: no vault lookup, no reindexing, no write path. It exists
 * to let the run see an input document that lives outside the project, and
 * nothing more.
 */
async function readAuthorizedFile(
  path: string,
  offset: number,
  limit: number,
): Promise<{ content: string; isError?: boolean }> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return { content: `Error: ${path} is not a file`, isError: true };
    }
    if (!isRichDocument(path) && fileStat.size > MAX_FILE_SIZE) {
      return {
        content: `Error: file too large (${Math.round(fileStat.size / 1024)}KB). Max: ${MAX_FILE_SIZE / 1024}KB. Use offset/limit.`,
        isError: true,
      };
    }

    const raw = await readFile(path);
    const text = extractDocumentText(path, raw);
    if (text === null) {
      return {
        content: `Error: ${path} is not a text document this tool can read`,
        isError: true,
      };
    }
    const lines = text.split("\n");
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = selected
      .map((line, i) => `${String(offset + i).padStart(5)} | ${line}`)
      .join("\n");

    return {
      content:
        `File: ${path} (${lines.length} lines total, showing ${offset}-` +
        `${Math.min(offset + limit - 1, lines.length)})\n` +
        "Read on your authority: you named this path.\n\n" +
        numbered,
    };
  } catch (error) {
    return { content: `Error: could not read ${path}: ${String(error)}`, isError: true };
  }
}

/**
 * Is the size gate meaningful for this file?
 *
 * The gate exists to bound how much text reaches the model. A .docx or .pdf is a
 * compressed container: measured, a 1.26 MB Word file holds 77 KB of text, so
 * checking the archive against a text budget refuses a document that is well
 * within it. Containers are judged on what comes out of them instead.
 */
function isRichDocument(path: string): boolean {
  return RICH_DOCUMENT_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
}

/**
 * The guard speaks for writers.
 *
 * A path with no parent directory is, to a reader, simply a file that is not
 * there — and "Parent directory does not exist" sends the agent looking for a
 * directory problem it does not have. Measured across two live runs: five
 * reads answered that way, none of them about a directory. Confinement keeps
 * its own wording, because that one means what it says.
 */
/**
 * What to add to a miss: the name it asked for, wherever that name actually is,
 * before the names beside where it looked.
 *
 * Measured 2026-08-21: six of seven misses in one run named a file that existed
 * under exactly that name in a different directory, and the neighbouring names
 * described a directory the file had never been in.
 */
async function missHelp(projectRoot: string, fullPath: string): Promise<string> {
  const elsewhere = await sameNameElsewhere(projectRoot, fullPath);
  return elsewhere.length > 0
    ? ` — that name is at: ${elsewhere.join(", ")}`
    : await nearbyNames(fullPath);
}

function readErrorFor(guardError: string | undefined, relPath: string): string {
  if (guardError === "Parent directory does not exist") return `file not found: ${relPath}`;
  return guardError ?? "path rejected";
}


