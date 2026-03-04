/**
 * Pattern Matcher
 * 
 * Matches errors and contexts against learned instincts and error patterns.
 * Supports exact, fuzzy, contextual, and error-code based matching.
 */

import type { LearningStorage } from "../storage/learning-storage.js";
import type {
  Instinct,
  ErrorPattern,
  PatternMatch,
  PatternMatchInput,
  InstinctStatus,
} from "../types.js";

// ─── Similarity Algorithms ──────────────────────────────────────────────────────

/**
 * Calculate Levenshtein edit distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1, // substitution
          matrix[i]![j - 1]! + 1,     // insertion
          matrix[i - 1]![j]! + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length]![a.length]!;
}

/**
 * Calculate normalized similarity score (0.0 - 1.0)
 */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);
  
  return 1 - distance / maxLength;
}

/**
 * Calculate cosine similarity between two token sets
 */
function cosineSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/));
  const tokensB = new Set(b.toLowerCase().split(/\s+/));

  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));

  return intersection.size / Math.sqrt(tokensA.size * tokensB.size) || 0;
}

// ─── Vector Cosine Similarity ────────────────────────────────────────────────────

/**
 * Calculate cosine similarity between two numeric vectors.
 * Returns a value between -1 and 1 (1 = identical direction, 0 = orthogonal).
 * Returns 0 if either vector has zero magnitude.
 */
export function vectorCosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Embedder Interface ──────────────────────────────────────────────────────────

/**
 * Minimal interface for an embedding provider.
 * Compatible with IEmbeddingProvider.embedOne() but kept intentionally narrow
 * to avoid coupling PatternMatcher to the RAG module.
 */
export interface EmbedderLike {
  embed(text: string): Promise<{ vector: number[]; dimensions: number }>;
}

/** Options for PatternMatcher constructor */
export interface PatternMatcherOptions {
  /** Optional embedder for semantic instinct search */
  embedder?: EmbedderLike;
}

// ─── Pattern Matcher Class ──────────────────────────────────────────────────────

export class PatternMatcher {
  private storage: LearningStorage;
  private readonly embedder?: EmbedderLike;
  private readonly FUZZY_THRESHOLD = 0.7;
  private readonly CONTEXTUAL_THRESHOLD = 0.5;

  constructor(storage: LearningStorage, options?: PatternMatcherOptions) {
    this.storage = storage;
    this.embedder = options?.embedder;
  }

  /**
   * Find instincts that match a given error pattern
   * 
   * @param input - The error/context to match against
   * @param options - Matching options
   * @returns Array of pattern matches sorted by confidence
   */
  findInstinctsForError(
    input: PatternMatchInput,
    options: {
      minConfidence?: number;
      maxResults?: number;
      statusFilter?: InstinctStatus[];
    } = {}
  ): PatternMatch[] {
    const {
      minConfidence = 0.3,
      maxResults = 10,
      statusFilter = ["active", "proposed"],
    } = options;

    // Get candidate instincts
    const candidates = this.storage.getInstincts()
      .filter(i => statusFilter.includes(i.status));

    const matches: PatternMatch[] = [];

    for (const instinct of candidates) {
      const match = this.matchInstinct(instinct, input);
      
      if (match.confidence >= minConfidence) {
        matches.push(match);
      }
    }

    // Sort by confidence descending, then by relevance
    matches.sort((a, b) => {
      const scoreA = a.confidence * 0.7 + a.relevance * 0.3;
      const scoreB = b.confidence * 0.7 + b.relevance * 0.3;
      return scoreB - scoreA;
    });

    return matches.slice(0, maxResults);
  }

  /**
   * Find similar instincts based on trigger pattern
   * 
   * @param triggerPattern - The pattern to compare against
   * @param options - Matching options
   * @returns Array of similar instincts with similarity scores
   */
  findSimilarInstincts(
    triggerPattern: string,
    options: {
      minSimilarity?: number;
      maxResults?: number;
      typeFilter?: string;
    } = {}
  ): PatternMatch[] {
    const {
      minSimilarity = 0.6,
      maxResults = 5,
      typeFilter,
    } = options;

    let candidates = this.storage.getInstincts();
    
    if (typeFilter) {
      candidates = candidates.filter(i => i.type === typeFilter);
    }

    const matches: PatternMatch[] = [];

    for (const instinct of candidates) {
      // Calculate multiple similarity metrics
      const exactMatch = instinct.triggerPattern === triggerPattern;
      const fuzzySim = stringSimilarity(instinct.triggerPattern, triggerPattern);
      const cosineSim = cosineSimilarity(instinct.triggerPattern, triggerPattern);

      // Combined similarity score
      const similarity = exactMatch ? 1.0 : (fuzzySim * 0.6 + cosineSim * 0.4);

      if (similarity >= minSimilarity) {
        matches.push({
          id: instinct.id,
          type: exactMatch ? "exact" : (fuzzySim > 0.8 ? "fuzzy" : "contextual"),
          confidence: similarity * instinct.confidence, // Weight by instinct confidence
          relevance: similarity,
          instinct,
          matchReason: exactMatch 
            ? "Exact pattern match" 
            : `Similarity: ${(similarity * 100).toFixed(1)}%`,
          matchedFields: ["triggerPattern"],
          priority: Math.round(similarity * 100),
        });
      }
    }

    // Sort by combined score
    matches.sort((a, b) => b.confidence - a.confidence);
    return matches.slice(0, maxResults);
  }

  /**
   * Find similar instincts using vector embedding cosine similarity.
   * Requires an embedder to be configured; returns empty array otherwise.
   *
   * @param query - The text to embed and search for
   * @param options - Matching options
   * @returns Array of semantically similar instincts sorted by score
   */
  async findSimilarInstinctsSemantic(
    query: string,
    options: {
      maxResults?: number;
      minScore?: number;
    } = {}
  ): Promise<PatternMatch[]> {
    if (!this.embedder) {
      return [];
    }

    const {
      maxResults = 10,
      minScore = 0.6,
    } = options;

    // Embed the query
    const { vector: queryVector } = await this.embedder.embed(query);

    // Get all instincts
    const candidates = this.storage.getInstincts();

    const matches: PatternMatch[] = [];

    for (const instinct of candidates) {
      // Skip instincts without pre-computed embeddings
      if (!instinct.embedding || instinct.embedding.length === 0) {
        continue;
      }

      const similarity = vectorCosineSimilarity(queryVector, instinct.embedding);

      if (similarity >= minScore) {
        matches.push({
          id: instinct.id,
          type: "semantic",
          confidence: similarity * instinct.confidence,
          relevance: similarity,
          instinct,
          matchReason: `Semantic similarity: ${(similarity * 100).toFixed(1)}%`,
          matchedFields: ["embedding"],
          priority: Math.round(similarity * 100),
        });
      }
    }

    matches.sort((a, b) => b.confidence - a.confidence);
    return matches.slice(0, maxResults);
  }

  /**
   * Find error patterns matching the given error details
   * 
   * @param input - Error details to match
   * @returns Array of matching error patterns
   */
  findMatchingErrorPatterns(
    input: PatternMatchInput
  ): Array<{ pattern: ErrorPattern; score: number; matchType: string }> {
    const patterns = this.storage.getErrorPatterns(input.errorCategory);
    const matches: Array<{ pattern: ErrorPattern; score: number; matchType: string }> = [];

    for (const pattern of patterns) {
      let score = 0;
      const matchTypes: string[] = [];

      // Match error code
      if (input.errorCode && pattern.codePattern) {
        const codeRegex = new RegExp(pattern.codePattern, "i");
        if (codeRegex.test(input.errorCode)) {
          score += 0.4;
          matchTypes.push("error_code");
        }
      }

      // Match error message
      if (input.errorMessage) {
        const messageRegex = new RegExp(pattern.messagePattern, "i");
        const similarity = stringSimilarity(input.errorMessage, pattern.messagePattern);
        
        if (messageRegex.test(input.errorMessage) || similarity > this.FUZZY_THRESHOLD) {
          score += 0.5 * similarity;
          matchTypes.push("message_pattern");
        }
      }

      // Match file pattern
      if (input.filePath && pattern.filePatterns.length > 0) {
        const fileMatch = pattern.filePatterns.some(fp => 
          input.filePath?.includes(fp) || 
          new RegExp(fp, "i").test(input.filePath!)
        );
        if (fileMatch) {
          score += 0.1;
          matchTypes.push("file_pattern");
        }
      }

      if (score > 0) {
        matches.push({
          pattern,
          score,
          matchType: matchTypes.join("+"),
        });
      }
    }

    // Sort by score
    matches.sort((a, b) => b.score - a.score);
    return matches;
  }

  /**
   * Check if an instinct is applicable in the given context
   */
  isApplicable(instinct: Instinct, context: Record<string, unknown>): boolean {
    for (const condition of instinct.contextConditions) {
      const contextValue = context[condition.type];
      
      if (contextValue === undefined) {
        // Condition not applicable, skip
        continue;
      }

      const matches = String(contextValue).toLowerCase() === condition.value.toLowerCase();
      
      if (condition.match === "include" && !matches) {
        return false;
      }
      if (condition.match === "exclude" && matches) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get the best matching instinct for a given error
   * 
   * @param input - Error/context to match
   * @returns Best match or null if no good match found
   */
  getBestMatch(
    input: PatternMatchInput,
    minConfidence: number = 0.6
  ): PatternMatch | null {
    const matches = this.findInstinctsForError(input, { minConfidence, maxResults: 1 });
    return matches[0] ?? null;
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  private matchInstinct(
    instinct: Instinct,
    input: PatternMatchInput
  ): PatternMatch {
    const scores: { type: PatternMatch["type"]; confidence: number; relevance: number; fields: string[] }[] = [];

    // Error code match (highest priority)
    if (input.errorCode && this.matchesErrorCode(instinct, input.errorCode)) {
      scores.push({
        type: "error_code",
        confidence: 0.95 * instinct.confidence,
        relevance: 1.0,
        fields: ["errorCode"],
      });
    }

    // Exact message match
    if (input.errorMessage && this.matchesMessage(instinct, input.errorMessage)) {
      scores.push({
        type: "exact",
        confidence: 0.9 * instinct.confidence,
        relevance: 0.95,
        fields: ["errorMessage"],
      });
    }

    // Fuzzy message match
    if (input.errorMessage) {
      const similarity = stringSimilarity(instinct.triggerPattern, input.errorMessage);
      if (similarity >= this.FUZZY_THRESHOLD) {
        scores.push({
          type: "fuzzy",
          confidence: similarity * 0.8 * instinct.confidence,
          relevance: similarity,
          fields: ["errorMessage"],
        });
      }
    }

    // Contextual match (tool, file type, etc.)
    const contextScore = this.calculateContextScore(instinct, input);
    if (contextScore >= this.CONTEXTUAL_THRESHOLD) {
      scores.push({
        type: "contextual",
        confidence: contextScore * 0.6 * instinct.confidence,
        relevance: contextScore,
        fields: ["context"],
      });
    }

    // Select best score
    const bestScore = scores.length > 0 
      ? scores.reduce((best, current) => current.confidence > best.confidence ? current : best)
      : { type: "contextual" as const, confidence: 0, relevance: 0, fields: [] };

    return {
      id: instinct.id,
      type: bestScore.type,
      confidence: bestScore.confidence,
      relevance: bestScore.relevance,
      instinct,
      matchReason: this.generateMatchReason(bestScore.type, bestScore.fields),
      matchedFields: bestScore.fields,
      priority: Math.round(bestScore.confidence * 100),
    };
  }

  private matchesErrorCode(instinct: Instinct, errorCode: string): boolean {
    return instinct.triggerPattern.includes(errorCode) ||
           instinct.contextConditions.some(c => 
             c.type === "error_code" && 
             c.value.toLowerCase() === errorCode.toLowerCase()
           );
  }

  private matchesMessage(instinct: Instinct, message: string): boolean {
    // Normalize and compare
    const normalizedPattern = this.normalize(instinct.triggerPattern);
    const normalizedMessage = this.normalize(message);
    
    return normalizedMessage.includes(normalizedPattern) ||
           normalizedPattern.includes(normalizedMessage);
  }

  private calculateContextScore(instinct: Instinct, input: PatternMatchInput): number {
    let score = 0;
    let conditions = 0;

    for (const condition of instinct.contextConditions) {
      conditions++;
      
      switch (condition.type) {
        case "tool_name":
          if (input.toolName && this.matchesCondition(input.toolName, condition.value)) {
            score += condition.match === "include" ? 1 : -0.5;
          }
          break;
        case "file_type":
          if (input.filePath) {
            const ext = input.filePath.split(".").pop() ?? "";
            if (this.matchesCondition(ext, condition.value)) {
              score += condition.match === "include" ? 1 : -0.5;
            }
          }
          break;
        case "error_code":
          if (input.errorCode && this.matchesCondition(input.errorCode, condition.value)) {
            score += condition.match === "include" ? 1 : -0.5;
          }
          break;
        case "custom":
          if (input.context && this.matchesCondition(String(input.context[condition.type] ?? ""), condition.value)) {
            score += condition.match === "include" ? 0.5 : -0.25;
          }
          break;
      }
    }

    return conditions > 0 ? Math.max(0, score / conditions) : 0.5;
  }

  private matchesCondition(value: string, pattern: string): boolean {
    if (pattern === "any" || pattern === "*") return true;
    return value.toLowerCase().includes(pattern.toLowerCase()) ||
           pattern.toLowerCase().includes(value.toLowerCase());
  }

  private normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/['"]/g, "")
      .trim();
  }

  private generateMatchReason(type: PatternMatch["type"], fields: string[]): string {
    const fieldStr = fields.join(", ");
    switch (type) {
      case "exact":
        return `Exact match on ${fieldStr}`;
      case "fuzzy":
        return `Fuzzy match on ${fieldStr}`;
      case "contextual":
        return `Contextual match on ${fieldStr}`;
      case "error_code":
        return `Error code match on ${fieldStr}`;
      default:
        return `Match on ${fieldStr}`;
    }
  }
}

// ─── Utility Functions ──────────────────────────────────────────────────────────

/**
 * Extract keywords from a text for indexing
 */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(word => word.length > 2)
    .filter(word => !STOP_WORDS.has(word));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was",
  "one", "our", "out", "day", "get", "has", "him", "his", "how", "its", "may", "new",
  "now", "old", "see", "two", "who", "boy", "did", "she", "use", "her", "way", "many",
  "oil", "sit", "set", "run", "eat", "far", "sea", "eye", "ask", "own", "say", "too",
  "any", "try", "let", "put", "say", "she", "try", "way", "own", "say", "too", "old",
  "tell", "very", "when", "much", "would", "there", "their", "what", "said", "each",
  "which", "will", "about", "if", "up", "out", "many", "then", "them", "these", "so",
  "some", "her", "would", "make", "like", "into", "him", "has", "two", "more", "very",
  "after", "words", "just", "where", "most", "get", "through", "back", "much", "go",
  "good", "new", "write", "our", "me", "man", "too", "any", "day", "same", "right",
  "look", "think", "also", "around", "another", "came", "come", "work", "three",
  "must", "because", "does", "part", "even", "place", "well", "such", "here", "take",
  "why", "things", "help", "put", "years", "different", "away", "again", "off", "went",
  "old", "number", "great", "tell", "men", "say", "small", "every", "found", "still",
  "between", "name", "should", "home", "big", "give", "air", "line", "set", "world",
  "own", "under", "last", "read", "never", "us", "left", "end", "along", "while",
  "might", "next", "sound", "below", "saw", "something", "thought", "both", "few",
  "those", "always", "show", "large", "often", "together", "asked", "house", "dont",
  "around", "going", "dont", "school", "important", "until", "form", "food", "keep",
  "children", "feet", "land", "side", "without", "boy", "once", "animal", "life",
  "enough", "took", "four", "head", "above", "kind", "began", "almost", "live",
  "page", "got", "build", "grow", "cut", "knew", "earth", "father", "head", "stand",
  "own", "page", "should", "country", "found", "answer", "school", "grow", "study",
  "still", "learn", "plant", "cover", "food", "sun", "four", "between", "state",
  "keep", "eye", "never", "last", "let", "thought", "city", "tree", "cross", "farm",
  "hard", "start", "might", "story", "saw", "far", "sea", "draw", "left", "late",
  "run", "dont", "while", "press", "close", "night", "real", "several", "north",
]);

/**
 * Calculate Jaccard similarity between two sets
 */
export function jaccardSimilarity<T>(a: Set<T>, b: Set<T>): number {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}
