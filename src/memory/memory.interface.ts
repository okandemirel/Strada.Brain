import type { StrataProjectAnalysis } from "../intelligence/strata-analyzer.js";

/**
 * A single stored memory entry.
 */
export interface MemoryEntry {
  /** Unique identifier */
  id: string;
  /** Type of memory */
  type: "conversation" | "analysis" | "note";
  /** Associated chat ID (if conversation-related) */
  chatId?: string;
  /** The text content */
  content: string;
  /** Timestamp of creation */
  createdAt: Date;
  /** TF-IDF term vector (term → weight) */
  termVector: Record<string, number>;
  /** Optional tags for filtering */
  tags: string[];
}

/**
 * Options for memory retrieval.
 */
export interface RetrievalOptions {
  /** Filter by chat ID */
  chatId?: string;
  /** Filter by memory type */
  type?: MemoryEntry["type"];
  /** Maximum number of results */
  limit?: number;
  /** Minimum similarity score (0-1) */
  minScore?: number;
}

/**
 * A retrieval result with its relevance score.
 */
export interface RetrievalResult {
  entry: MemoryEntry;
  score: number;
}

/**
 * The Memory Manager interface — persistent project knowledge and conversation memory.
 *
 * Provides three capabilities:
 *  1. **Project Cache**: Cached StrataProjectAnalysis with timestamp-based invalidation
 *  2. **Conversation Memory**: Stores conversation summaries from trimmed sessions
 *  3. **Semantic Retrieval**: TF-IDF-based text search across all stored memories
 */
export interface IMemoryManager {
  /** Initialize the memory store (load from disk) */
  initialize(): Promise<void>;

  /** Shut down and flush pending writes */
  shutdown(): Promise<void>;

  // --- Project Analysis Cache ---

  /** Cache a project analysis result */
  cacheAnalysis(analysis: StrataProjectAnalysis, projectPath: string): Promise<void>;

  /** Get cached analysis if still valid (not older than maxAgeMs) */
  getCachedAnalysis(projectPath: string, maxAgeMs?: number): Promise<StrataProjectAnalysis | null>;

  // --- Conversation Memory ---

  /** Store a conversation summary from trimmed messages */
  storeConversation(chatId: string, summary: string, tags?: string[]): Promise<void>;

  /** Store a general note or insight */
  storeNote(content: string, tags?: string[]): Promise<void>;

  // --- Retrieval ---

  /** Search memory using a text query (TF-IDF cosine similarity) */
  retrieve(query: string, options?: RetrievalOptions): Promise<RetrievalResult[]>;

  /** Get all entries for a chat (chronological) */
  getChatHistory(chatId: string, limit?: number): Promise<MemoryEntry[]>;

  // --- Stats ---

  /** Get memory usage statistics */
  getStats(): { totalEntries: number; conversationCount: number; noteCount: number; hasAnalysisCache: boolean };
}
