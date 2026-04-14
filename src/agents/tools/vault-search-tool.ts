import type { VaultRegistry } from '../../vault/vault-registry.js';
import type { IVault, VaultHit } from '../../vault/vault.interface.js';
import type { ToolContext, ToolExecutionResult } from './tool.interface.js';

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
  searched: string[];
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
 *   only the project vault. Other registered vaults (e.g. SelfVault) are NOT
 *   queried by default, to keep answers scoped to the current Unity project.
 * - No project vault match → fall back to querying all registered vaults, and
 *   emit a hint so operators can see the project is not indexed.
 */
export class VaultSearchTool {
  readonly name = 'vault_search';
  readonly description =
    'Semantic + FTS search across indexed vaults (Unity project, Strada self). ' +
    'Prefer this over file_read when you only need a snippet or do not know the exact path. ' +
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
          'Omit to search the project vault by default.',
      },
      topK: {
        type: 'number',
        description: `Max hits to return (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}).`,
      },
      mode: {
        type: 'string',
        description: "Retrieval mode: 'semantic' | 'fts' | 'hybrid' (default 'hybrid').",
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

    const modeRaw = typeof input['mode'] === 'string' ? (input['mode'] as string).toLowerCase() : 'hybrid';
    const mode: VaultSearchMode =
      modeRaw === 'semantic' || modeRaw === 'fts' ? modeRaw : 'hybrid';

    const vaultIdRaw = input['vaultId'];
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
      const vault = registry.get(vaultId);
      targetVaults = vault ? [vault] : [];
      if (!vault) {
        explicitMiss = true;
      }
    } else if (context.projectPath) {
      const projectVault = registry.resolveVaultForPath(context.projectPath, context.projectPath);
      if (projectVault) {
        targetVaults = [projectVault];
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
        content: vaultId ? `vault not found: ${vaultId}` : 'no vaults registered',
        isError: explicitMiss,
      };
    }

    const started = Date.now();
    const perVault = await Promise.all(
      targetVaults.map(async (v) => {
        const result = await v.query({ text: query, topK });
        return { vaultId: v.id, result };
      }),
    );

    const merged: VaultSearchHit[] = [];
    for (const { vaultId: vid, result } of perVault) {
      for (const hit of result.hits) {
        const projected = projectHit(hit, vid, mode);
        if (projected) merged.push(projected);
      }
    }
    merged.sort((a, b) => b.score - a.score);
    const capped = merged.slice(0, topK);

    const tokensUsed = capped.reduce((acc, h) => acc + estimateTokens(h.content), 0);
    const truncated = merged.length > capped.length || perVault.some((p) => p.result.truncated);

    const payload: VaultSearchResultPayload = {
      hits: capped,
      tokensUsed,
      truncated,
      searched: targetVaults.map((v) => v.id),
      hint,
    };

    if (!capped.length) {
      const baseMsg = `no vault hits for "${query}" across [${payload.searched.join(', ')}]`;
      return {
        content: hint ? `${baseMsg}\n(${hint})` : baseMsg,
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
    content: hit.chunk.content,
    score,
    source,
    vaultId,
  };
}

/** Cheap token estimate: 4 chars/token heuristic, matches chunker.ts budgeting. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function formatHitsForAgent(payload: VaultSearchResultPayload): string {
  const header =
    `vault_search: ${payload.hits.length} hit(s), ` +
    `~${payload.tokensUsed} tok, ` +
    `searched=[${payload.searched.join(', ')}]` +
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
