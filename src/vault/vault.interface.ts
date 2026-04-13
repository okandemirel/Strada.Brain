export type VaultId = string;
export type VaultKind = 'framework' | 'unity-project' | 'self';

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
}
