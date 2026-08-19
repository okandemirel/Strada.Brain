import { vaultNotFound } from './vault-not-found.js';
import type { IVault } from '../../vault/vault.interface.js';
import type { ToolContext, ToolExecutionResult } from './tool.interface.js';

interface CanvasNode {
  id: string;
  type: string;
  text?: string;
  file?: string;
  kind?: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
}

interface CanvasJson {
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
}

interface SubgraphResult {
  vaultId: string;
  seedNodes: string[];
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const DEFAULT_TOP_K = 5;
const MAX_QUERY_LEN = 4096;

export class VaultGraphExploreTool {
  readonly name = 'vault_graph_explore';
  readonly description =
    'Explore the vault knowledge graph around a natural-language query. ' +
    'Performs semantic search, locates the matching nodes in the vault graph, ' +
    'and returns a 1-degree neighbourhood subgraph (nodes + edges). ' +
    'Use this when the user asks about relationships, dependencies, or wants to ' +
    '"show everything related to X". Prefer this over `file_read` for discovery tasks.';

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Natural language query (e.g. "Player movement logic").',
      },
      vaultId: {
        type: 'string',
        description: "Restrict to a single vault id. Omit to search the project vault.",
      },
    },
    required: ['query'],
  };

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
    if (!rawQuery) {
      return { content: "Error: 'query' is required", isError: true };
    }
    const query = rawQuery.slice(0, MAX_QUERY_LEN);

    const vaultIdRaw = input['vaultId'];
    const vaultId = typeof vaultIdRaw === 'string' && vaultIdRaw.length > 0 ? vaultIdRaw : undefined;

    let targetVaults: IVault[];
    if (vaultId) {
      const vault = registry.get(vaultId);
      targetVaults = vault ? [vault] : [];
    } else if (context.projectPath) {
      const projectVault = registry.resolveVaultForPath(context.projectPath, context.projectPath);
      targetVaults = projectVault ? [projectVault] : registry.list();
    } else {
      targetVaults = registry.list();
    }

    if (!targetVaults.length) {
      return { content: vaultId ? vaultNotFound(vaultId, registry.ids()) : 'no vaults registered', isError: true };
    }

    const started = Date.now();
    const results: SubgraphResult[] = [];

    for (const vault of targetVaults) {
      const searchResult = await vault.query({ text: query, topK: DEFAULT_TOP_K });
      if (!searchResult.hits.length) continue;

      const canvas = (await vault.readCanvas?.()) as CanvasJson | undefined;
      if (!canvas?.nodes?.length) continue;

      const focusPaths = new Set(searchResult.hits.map((h) => h.chunk.path));

      // Find seed nodes whose id or file matches any focus path
      const seedIds = new Set<string>();
      for (const node of canvas.nodes) {
        if (node.file && focusPaths.has(node.file)) {
          seedIds.add(node.id);
        } else if (node.id && focusPaths.has(node.id)) {
          seedIds.add(node.id);
        }
      }

      if (!seedIds.size) continue;

      // 1-degree BFS
      const visited = new Set<string>(seedIds);
      const frontier = new Set<string>(seedIds);
      const next = new Set<string>();

      for (const edge of canvas.edges ?? []) {
        if (frontier.has(edge.fromNode) && !visited.has(edge.toNode)) {
          next.add(edge.toNode);
          visited.add(edge.toNode);
        }
        if (frontier.has(edge.toNode) && !visited.has(edge.fromNode)) {
          next.add(edge.fromNode);
          visited.add(edge.fromNode);
        }
      }

      const filteredNodes = (canvas.nodes ?? []).filter((n) => visited.has(n.id));
      const filteredEdges = (canvas.edges ?? []).filter(
        (e) => visited.has(e.fromNode) && visited.has(e.toNode),
      );

      results.push({
        vaultId: vault.id,
        seedNodes: [...seedIds],
        nodes: filteredNodes,
        edges: filteredEdges,
      });
    }

    if (!results.length) {
      return {
        content: `no graph context found for "${query}"`,
        metadata: { executionTimeMs: Date.now() - started },
      };
    }

    return {
      content: JSON.stringify({ query, results }, null, 2),
      metadata: { executionTimeMs: Date.now() - started, vaultsExplored: results.length },
    };
  }
}
