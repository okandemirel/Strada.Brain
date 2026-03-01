/**
 * Lightweight TF-IDF text index for semantic retrieval.
 *
 * No external dependencies — pure TypeScript implementation.
 * Supports:
 *  - Term extraction with stop-word filtering
 *  - TF-IDF vector computation
 *  - Cosine similarity scoring
 *  - Incremental document addition
 */

/** Stop words to filter out (common English + C# keywords) */
const STOP_WORDS = new Set([
  // English
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "can", "could", "must", "need", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "out", "off",
  "over", "under", "again", "further", "then", "once", "here", "there",
  "when", "where", "why", "how", "all", "both", "each", "few", "more",
  "most", "other", "some", "such", "no", "nor", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "because", "but", "and",
  "or", "if", "while", "about", "up", "it", "its", "this", "that",
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "they", "them", "their", "what", "which", "who", "whom",
  // C# noise words
  "using", "namespace", "class", "struct", "public", "private",
  "protected", "internal", "static", "void", "return", "new", "var",
  "get", "set", "value", "true", "false", "null",
]);

/**
 * Extract terms from text: lowercase, split on non-alphanumeric, filter stop words.
 */
export function extractTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Compute term frequency (TF) — normalized count of each term.
 */
export function computeTF(terms: string[]): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const term of terms) {
    freq[term] = (freq[term] ?? 0) + 1;
  }
  // Normalize by max frequency
  const maxFreq = Math.max(...Object.values(freq), 1);
  const tf: Record<string, number> = {};
  for (const [term, count] of Object.entries(freq)) {
    tf[term] = count / maxFreq;
  }
  return tf;
}

/**
 * Cosine similarity between two term vectors.
 */
export function cosineSimilarity(
  a: Record<string, number>,
  b: Record<string, number>
): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  // Iterate over the smaller vector for efficiency
  const [smaller, larger] =
    Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];

  for (const [term, weight] of Object.entries(smaller)) {
    const otherWeight = larger[term];
    if (otherWeight !== undefined) {
      dotProduct += weight * otherWeight;
    }
  }

  for (const w of Object.values(a)) {
    normA += w * w;
  }
  for (const w of Object.values(b)) {
    normB += w * w;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

/**
 * Manages a TF-IDF index over a corpus of documents.
 */
export class TextIndex {
  /** Document frequency: how many documents contain each term */
  private df: Record<string, number> = {};
  /** Total number of documents */
  private docCount = 0;

  /**
   * Register a document's terms to update the document frequency table.
   * Call this when adding a new document to the corpus.
   */
  addDocument(terms: string[]): void {
    const uniqueTerms = new Set(terms);
    for (const term of uniqueTerms) {
      this.df[term] = (this.df[term] ?? 0) + 1;
    }
    this.docCount++;
  }

  /**
   * Remove a document's terms from the frequency table.
   */
  removeDocument(terms: string[]): void {
    const uniqueTerms = new Set(terms);
    for (const term of uniqueTerms) {
      const count = this.df[term];
      if (count !== undefined) {
        if (count <= 1) {
          delete this.df[term];
        } else {
          this.df[term] = count - 1;
        }
      }
    }
    this.docCount = Math.max(0, this.docCount - 1);
  }

  /**
   * Compute a TF-IDF vector for a set of terms.
   * The TF component is term-local; the IDF component uses the corpus stats.
   */
  computeTFIDF(terms: string[]): Record<string, number> {
    const tf = computeTF(terms);
    const tfidf: Record<string, number> = {};

    for (const [term, tfValue] of Object.entries(tf)) {
      const docFreq = this.df[term] ?? 0;
      // IDF: log(N / (df + 1)) + 1 to avoid division by zero and boost rare terms
      const idf = Math.log((this.docCount + 1) / (docFreq + 1)) + 1;
      tfidf[term] = tfValue * idf;
    }

    return tfidf;
  }

  /**
   * Rebuild the index from a complete set of term arrays.
   * Useful when loading from disk.
   */
  rebuild(documents: string[][]): void {
    this.df = {};
    this.docCount = 0;
    for (const terms of documents) {
      this.addDocument(terms);
    }
  }

  /** Get the current document count */
  getDocumentCount(): number {
    return this.docCount;
  }

  /** Serialize for persistence */
  serialize(): { df: Record<string, number>; docCount: number } {
    return { df: { ...this.df }, docCount: this.docCount };
  }

  /** Deserialize from persisted data */
  static deserialize(data: {
    df: Record<string, number>;
    docCount: number;
  }): TextIndex {
    const index = new TextIndex();
    index.df = { ...data.df };
    index.docCount = data.docCount;
    return index;
  }
}
