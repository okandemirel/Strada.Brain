import { vaultNotFound } from './vault-not-found.js';
import { resolve as pathResolve, sep as pathSep } from 'node:path';
import type { VaultRegistry } from '../../vault/vault-registry.js';
import type { IVault, VaultFile, VaultHit, VaultQuery } from '../../vault/vault.interface.js';
import type { ToolContext, ToolExecutionResult } from './tool.interface.js';
import { sanitizeRetrievalContent } from '../orchestrator-text-utils.js';
import { estimateTextTokens } from "../../common/token-estimator.js";
import { getLoggerSafe } from "../../utils/logger.js";

type VaultSearchMode = 'semantic' | 'fts' | 'hybrid';

interface VaultSearchHit {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  source: 'semantic' | 'fts' | 'hybrid';
  vaultId: string;
}

interface VaultSearchResultPayload {
  hits: VaultSearchHit[];
  tokensUsed: number;
  truncated: boolean;
  /** Vault ids whose query completed — the only ones the hits can speak for. */
  searched: string[];
  /** Vault ids whose query threw, with the reason; they were NOT searched. */
  failed: Array<{ id: string; reason: string }>;
  hint?: string;
}

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 32;
const MIN_QUERY_LEN = 2;
/** sec-M5: hard cap on user-supplied query text. Matches dashboard route. */
const MAX_QUERY_LEN = 4096;

/**
 * Semantic / FTS / hybrid retrieval against registered vaults.
 * Degrades gracefully when no vault registry is attached to the ToolContext.
 *
 * Vault targeting rules:
 * - Explicit `vaultId` → query only that vault (any registered id, including 'self').
 * - No `vaultId` + `context.projectPath` resolves to a registered vault → query
 *   the project CODE vault PLUS any registered dev-knowledge vault(s)
 *   (kind === 'knowledge'), deduped by id. Other registered vaults (e.g.
 *   SelfVault) are NOT queried by default, to keep answers scoped to the
 *   current Unity project and its accumulated knowledge notes.
 * - No project vault match → fall back to querying all registered vaults, and
 *   emit a hint so operators can see the project is not indexed.
 */
export class VaultSearchTool {
  readonly name = 'vault_search';
  readonly description =
    'PRIMARY retrieval tool — semantic + FTS search across indexed vaults (Unity project, Strada self). ' +
    'Always use this BEFORE `file_read` when looking for code, symbols, or documentation. ' +
    'Only fall back to `file_read` when you need exact byte-level content or the vault has no results. ' +
    'Returns ranked code chunks with file path and line range for precise citation.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Free-text query (min 2 chars). Natural language or code tokens both work.',
      },
      vaultId: {
        type: 'string',
        description:
          "Restrict to a single vault id (e.g. 'self' for Strada's own source). " +
          "Omit — or pass 'project' — to search this project's vault. A bare id without its kind prefix is accepted.",
      },
      topK: {
        type: 'number',
        description: `Max hits to return (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}).`,
      },
      mode: {
        type: 'string',
        description: "Retrieval mode: 'semantic' | 'fts' | 'hybrid' (default 'hybrid').",
      },
      budgetTokens: {
        type: 'number',
        description: 'Maximum chunk token budget to return from each vault query.',
      },
      langFilter: {
        type: 'array',
        items: { type: 'string' },
        description: "Restrict results by language, e.g. ['typescript', 'markdown'].",
      },
      pathGlob: {
        type: 'string',
        description: "Restrict results to a vault-relative glob, e.g. 'src/**/*.ts'.",
      },
      focusFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Vault-relative files whose symbols seed graph/PPR reranking.',
      },
    },
    required: ['query'],
  };

  /**
   * review-F4: VaultSearchTool now relies solely on ToolContext.vaultRegistry.
   * The previous constructor-bound fallback registry has been removed to
   * guarantee per-session isolation.
   */
  constructor() {}

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const registry = context.vaultRegistry;
    if (!registry) {
      return {
        content: 'vault unavailable: no vault registry attached to this session',
        metadata: { executionTimeMs: 0 },
      };
    }

    const rawQuery = typeof input['query'] === 'string' ? input['query'].trim() : '';
    if (rawQuery.length < MIN_QUERY_LEN) {
      return {
        content: `Error: 'query' must be at least ${MIN_QUERY_LEN} characters`,
        isError: true,
      };
    }
    // sec-M5: silently truncate oversized queries to match dashboard behavior.
    const query = rawQuery.slice(0, MAX_QUERY_LEN);

    const rawTopK = Number(input['topK'] ?? DEFAULT_TOP_K);
    const topK = Math.max(1, Math.min(MAX_TOP_K, Number.isFinite(rawTopK) ? rawTopK : DEFAULT_TOP_K));
    const budgetTokens = coercePositiveInteger(input['budgetTokens']);
    const langFilter = coerceStringArray(input['langFilter']);
    const pathGlob = typeof input['pathGlob'] === 'string' && input['pathGlob'].trim().length > 0
      ? input['pathGlob'].trim()
      : undefined;
    const focusFiles = coerceStringArray(input['focusFiles']);

    const modeRaw = typeof input['mode'] === 'string' ? (input['mode'] as string).toLowerCase() : 'hybrid';
    const mode: VaultSearchMode =
      modeRaw === 'semantic' || modeRaw === 'fts' ? modeRaw : 'hybrid';

    // 'project' is what an agent reaches for when it means "this game's vault";
    // measured 2026-09-06 as a failed call ("vault not found: project"). It is
    // the omitted-id default by another name, so it is treated as omitted.
    const vaultIdRaw =
      typeof input['vaultId'] === 'string' && input['vaultId'].trim().toLowerCase() === 'project'
        ? undefined
        : input['vaultId'];
    const vaultId = typeof vaultIdRaw === 'string' && vaultIdRaw.length > 0 ? vaultIdRaw : undefined;

    // sec-H3: target selection.
    // - Explicit vaultId wins.
    // - Otherwise default to the project vault if we can resolve one.
    // - Otherwise fall back to all registered vaults, but annotate the result
    //   so the operator can see the project has no indexed vault.
    let targetVaults: IVault[];
    let hint: string | undefined;
    let explicitMiss = false;

    if (vaultId) {
      const vault = registry.resolve(vaultId);
      targetVaults = vault ? [vault] : [];
      if (!vault) {
        explicitMiss = true;
      }
    } else if (context.sourceProjectPath || context.projectPath) {
      // sourceProjectPath first: under a workspace lease `projectPath` is the
      // lease directory, which no vault is registered against, so resolving on
      // it missed every time and silently downgraded the search to "all vaults"
      // — including Strada.Brain's own source.
      const lookupPath = context.sourceProjectPath ?? context.projectPath;
      const projectVault = registry.resolveVaultForPath(lookupPath, lookupPath);
      if (projectVault) {
        // Default target set: the project CODE vault PLUS any registered
        // dev-knowledge vault(s), so vault_search consciously reaches the
        // accumulated knowledge notes — not just code. Dedupe by id so the
        // project vault is never searched twice (e.g. if it is itself a
        // knowledge vault).
        //
        // sec-H2 (mirror of file-read.ts): confine the knowledge-vault union to
        // vaults rooted INSIDE the current projectPath. Today bootstrap registers
        // exactly one knowledge vault under <unityProjectPath>/.strada/knowledge,
        // but if a second project's knowledge vault is ever co-registered in the
        // same process, this guard prevents an unscoped vault_search from leaking
        // that other project's notes.
        const knowledgeVaults = registry
          .list()
          .filter((v) => v.kind === 'knowledge' && isVaultInsideProject(v, lookupPath));
        const byId = new Map<string, IVault>();
        byId.set(projectVault.id, projectVault);
        for (const kv of knowledgeVaults) byId.set(kv.id, kv);
        targetVaults = [...byId.values()];
      } else {
        targetVaults = registry.list();
        if (targetVaults.length > 0) {
          hint =
            "No vault indexed for projectPath — querying all registered vaults. " +
            "Pass vaultId to scope the search explicitly.";
        }
      }
    } else {
      targetVaults = registry.list();
    }

    if (!targetVaults.length) {
      return {
        content: vaultId ? vaultNotFound(vaultId, registry.ids()) : 'no vaults registered',
        isError: explicitMiss,
      };
    }

    const searchQuery: VaultQuery = {
      text: query,
      topK,
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
      ...(langFilter !== undefined ? { langFilter: langFilter as VaultFile['lang'][] } : {}),
      ...(pathGlob !== undefined ? { pathGlob } : {}),
      ...(focusFiles !== undefined ? { focusFiles } : {}),
    };

    const started = Date.now();
    const perVault = await Promise.allSettled(
      targetVaults.map(async (v) => {
        const result = await v.query(searchQuery);
        return { vaultId: v.id, result };
      }),
    );

    // Audited 2026-09-02: a rejected vault query was dropped with a bare
    // `continue` while `searched` still listed every target, so a vault whose
    // query threw (escapeFtsQuery on a query like "()" rejects every vault at
    // once; a store closed mid-query rejects one) was reported as searched and
    // "no vault hits ... across [...]" read as a genuine empty index. A vault
    // that was not searched is named as failed, never as searched.
    const merged: VaultSearchHit[] = [];
    const searched: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    let rawHits = 0;
    let semanticScored = 0;
    perVault.forEach((s, index) => {
      if (s.status === "rejected") {
        const id = targetVaults[index]?.id ?? `#${index}`;
        const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
        failed.push({ id, reason });
        getLoggerSafe().warn('[vault_search] vault query failed', { vaultId: id, reason, query });
        return;
      }
      const { vaultId: vid, result } = s.value;
      searched.push(vid);
      for (const hit of result.hits) {
        rawHits++;
        if (hit.scores.hnsw !== null && hit.scores.hnsw !== undefined) semanticScored++;
        const projected = projectHit(hit, vid, mode);
        if (projected) merged.push(projected);
      }
    });
    merged.sort((a, b) => b.score - a.score);
    const capped = merged.slice(0, topK);

    const tokensUsed = capped.reduce((acc, h) => acc + estimateTextTokens(h.content), 0);
    const truncated = merged.length > capped.length || perVault.some((p) => p.status === "fulfilled" && p.value.result.truncated);

    const payload: VaultSearchResultPayload = {
      hits: capped,
      tokensUsed,
      truncated,
      searched,
      failed,
      hint,
    };

    if (failed.length === targetVaults.length) {
      return {
        content:
          `vault_search failed: no vault was searched for "${query}" — every target rejected the query: ` +
          formatFailed(failed),
        isError: true,
        metadata: { executionTimeMs: Date.now() - started, itemsAffected: 0 },
      };
    }

    // Audited 2026-09-02: every shipped vault store is `semantic: false`, so no
    // hit ever carries an hnsw score and mode='semantic' dropped all of them,
    // answering "no vault hits" for a corpus that hybrid/fts found. A channel
    // that is switched off must say so instead of reporting an empty index.
    if (mode === 'semantic' && semanticScored === 0) {
      const evidence = rawHits > 0
        ? `${rawHits} hit(s) came back from [${searched.join(', ')}] and none carried a semantic (hnsw) score, so the vector backend is not wired in this build`
        : `no hit from [${searched.join(', ')}] carried a semantic (hnsw) score, which cannot be told apart from a disabled vector backend`;
      const lines = [
        `semantic retrieval unavailable for "${query}": ${evidence}. Re-run with mode='hybrid' or 'fts'.`,
      ];
      if (failed.length) lines.push(`(not searched — query failed: ${formatFailed(failed)})`);
      if (hint) lines.push(`(${hint})`);
      return {
        content: lines.join('\n'),
        metadata: { executionTimeMs: Date.now() - started, itemsAffected: 0 },
      };
    }

    if (!capped.length) {
      const lines = [`no vault hits for "${query}" across [${searched.join(', ')}]`];
      if (failed.length) lines.push(`(not searched — query failed: ${formatFailed(failed)})`);
      if (hint) lines.push(`(${hint})`);
      return {
        content: lines.join('\n'),
        metadata: { executionTimeMs: Date.now() - started, itemsAffected: 0 },
      };
    }

    return {
      content: formatHitsForAgent(payload),
      metadata: {
        executionTimeMs: Date.now() - started,
        itemsAffected: capped.length,
        truncated,
        tokensUsed,
      },
    };
  }
}

/**
 * sec-H2 (mirror of file-read.ts): true iff the vault's rootPath is contained
 * within (or equal to) the session's projectPath. Keeps the default knowledge
 * vault union strictly confined to the current project, even when the
 * VaultRegistry also owns a sibling project's knowledge vault.
 */
function isVaultInsideProject(vault: IVault, projectPath: string): boolean {
  const root = pathResolve(vault.rootPath);
  const project = pathResolve(projectPath);
  if (root === project) return true;
  const projectWithSep = project.endsWith(pathSep) ? project : project + pathSep;
  return root.startsWith(projectWithSep);
}

function projectHit(hit: VaultHit, vaultId: string, mode: VaultSearchMode): VaultSearchHit | null {
  const { fts, hnsw, rrf } = hit.scores;

  // Mode filtering: drop hits that have no score in the requested channel.
  if (mode === 'fts' && (fts === null || fts === undefined)) return null;
  if (mode === 'semantic' && (hnsw === null || hnsw === undefined)) return null;

  let score: number;
  let source: VaultSearchHit['source'];
  if (mode === 'fts') {
    score = fts ?? 0;
    source = 'fts';
  } else if (mode === 'semantic') {
    score = hnsw ?? 0;
    source = 'semantic';
  } else {
    score = rrf;
    source = 'hybrid';
  }

  return {
    filePath: hit.chunk.path,
    startLine: hit.chunk.startLine,
    endLine: hit.chunk.endLine,
    // sec-H1: vault chunks feed directly into the LLM context, so strip
    // prompt-injection carriers (envelopes, zero-width, "ignore previous",
    // base64 smuggles) before the agent ever sees them.
    content: sanitizeRetrievalContent(hit.chunk.content, "vault-search-tool"),
    score,
    source,
    vaultId,
  };
}

/** Cheap token estimate: 4 chars/token heuristic, matches chunker.ts budgeting. */

function coercePositiveInteger(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(1, Math.floor(v));
}

function coerceStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const values = v
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
  return values.length > 0 ? values : undefined;
}

/** `[id: reason; id: reason]` — the vaults whose query threw, so the agent can see what the hits do not cover. */
function formatFailed(failed: ReadonlyArray<{ id: string; reason: string }>): string {
  return `[${failed.map((f) => `${f.id}: ${f.reason}`).join('; ')}]`;
}

function formatHitsForAgent(payload: VaultSearchResultPayload): string {
  const header =
    `vault_search: ${payload.hits.length} hit(s), ` +
    `~${payload.tokensUsed} tok, ` +
    `searched=[${payload.searched.join(', ')}]` +
    (payload.failed.length ? ` failed=${formatFailed(payload.failed)}` : '') +
    (payload.truncated ? ' (truncated)' : '') +
    (payload.hint ? `\n(hint: ${payload.hint})` : '');
  const body = payload.hits
    .map((h, i) => {
      const cite = `${h.filePath}:${h.startLine}-${h.endLine}`;
      const scoreStr = h.score.toFixed(4);
      return `--- [${i + 1}] ${cite} (vault=${h.vaultId} source=${h.source} score=${scoreStr}) ---\n${h.content}`;
    })
    .join('\n\n');
  return `${header}\n\n${body}`;
}

export type { VaultSearchHit, VaultSearchResultPayload, VaultSearchMode };

// VaultRegistry is re-exported only for consumers that previously imported it
// alongside VaultSearchTool. The tool itself no longer takes a fallback.
export type { VaultRegistry };
