export type VaultId = string;
export type VaultKind = 'framework' | 'unity-project' | 'self' | 'obsidian';

export interface VaultFile {
  path: string;
  blobHash: string;
  mtimeMs: number;
  size: number;
  lang: 'csharp' | 'typescript' | 'markdown' | 'json' | 'hlsl' | 'unknown';
  kind: 'source' | 'test' | 'doc' | 'config';
  indexedAt: number;
}

export interface VaultChunk {
  chunkId: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  tokenCount: number;
}

export interface VaultHit {
  chunk: VaultChunk;
  scores: { fts: number | null; hnsw: number | null; rrf: number };
}

export interface VaultQuery {
  text: string;
  topK?: number;
  langFilter?: VaultFile['lang'][];
  pathGlob?: string;
  budgetTokens?: number;
  /** Vault-relative paths whose symbols seed Personalized PageRank re-ranking. */
  focusFiles?: string[];
  /** Include only notes that have ALL of these tags (e.g. ['#architecture']). */
  tagFilter?: string[];
  /** Include only notes whose frontmatter contains ALL key/value pairs. */
  frontmatterFilter?: Record<string, string>;
  /** If set, return only the center note and its 1-degree neighbours (local graph). */
  localGraphCenter?: string;
}

export interface VaultQueryResult {
  hits: VaultHit[];
  budgetUsed: number;
  truncated: boolean;
}

export interface VaultStats {
  fileCount: number;
  chunkCount: number;
  lastIndexedAt: number | null;
  dbBytes: number;
}

export type EdgeKind = 'calls' | 'references' | 'inherits' | 'implements' | 'imports' | 'embeds';
export type SymbolKind = 'class' | 'method' | 'field' | 'namespace' | 'function' | 'interface' | 'note';

export interface VaultSymbol {
  symbolId: string;
  path: string;
  kind: SymbolKind;
  name: string;
  display: string;
  startLine: number;
  endLine: number;
  doc: string | null;
}

export interface VaultEdge {
  fromSymbol: string;
  toSymbol: string;
  kind: EdgeKind;
  atLine: number;
}

export interface VaultWikilink {
  fromNote: string;
  target: string;
  resolved: boolean;
  /** Populated after wikilink resolution — the actual vault-relative path the target resolves to. */
  resolvedTarget?: string;
}

export interface IVault {
  readonly id: VaultId;
  readonly kind: VaultKind;
  readonly rootPath: string;
  init(): Promise<void>;
  sync(): Promise<{ changed: number; durationMs: number }>;
  rebuild(): Promise<void>;
  query(q: VaultQuery): Promise<VaultQueryResult>;
  stats(): Promise<VaultStats>;
  dispose(): Promise<void>;
  listFiles(): VaultFile[];
  readFile(path: string): Promise<string>;
  onUpdate(listener: (p: { vaultId: VaultId; changedPaths: string[] }) => void): () => void;
  findCallers?(symbolId: string): Promise<VaultEdge[]>;
  findSymbolsByName?(name: string, limit?: number): Promise<VaultSymbol[]>;
  /** Return wikilinks that point TO the given note path (bidirectional linking). */
  findBacklinks?(path: string): Promise<VaultWikilink[]>;
  /** Return bidirectional links: wikilinks pointing to path + code callers of its symbols. */
  listBacklinks?(path: string): Promise<{ wikilinks: VaultWikilink[]; callers: VaultEdge[] }>;
  readCanvas?(): Promise<unknown>;
  regenerateCanvas?(): Promise<void>;
}
