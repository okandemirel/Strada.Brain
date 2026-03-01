import type { IEmbeddingProvider, EmbeddingResult } from "../rag.interface.js";
import { getLogger } from "../../utils/logger.js";

const KNOWN_MODELS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
};

interface OllamaEmbeddingOptions {
  model?: string;
  baseUrl?: string;
}

// Response shape for the batch endpoint POST /api/embed
interface OllamaEmbedBatchResponse {
  embeddings: number[][];
  prompt_eval_count?: number;
}

// Response shape for the single-text endpoint POST /api/embeddings
interface OllamaEmbeddingsSingleResponse {
  embedding: number[];
}

export class OllamaEmbeddingProvider implements IEmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;

  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: OllamaEmbeddingOptions = {}) {
    this.model = opts.model ?? "nomic-embed-text";
    this.baseUrl = opts.baseUrl ?? "http://localhost:11434";
    this.dimensions = KNOWN_MODELS[this.model] ?? 768;
    this.name = `ollama:${this.model}`;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { embeddings: [], usage: { totalTokens: 0 } };
    }

    const logger = getLogger();
    logger.debug("Ollama embed: starting", {
      texts: texts.length,
      model: this.model,
    });

    try {
      const result = await this.embedViaBatchEndpoint(texts);
      logger.debug("Ollama embed: completed via /api/embed", {
        texts: texts.length,
      });
      return result;
    } catch (err) {
      logger.debug("Ollama embed: /api/embed failed, falling back to /api/embeddings", {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.embedViaSequentialEndpoint(texts);
    }
  }

  private async embedViaBatchEndpoint(texts: string[]): Promise<EmbeddingResult> {
    const url = `${this.baseUrl}/api/embed`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `Ollama /api/embed failed: HTTP ${response.status} — ${body}`
      );
    }

    const data = (await response.json()) as OllamaEmbedBatchResponse;
    const totalTokens = data.prompt_eval_count ?? 0;
    return { embeddings: data.embeddings, usage: { totalTokens } };
  }

  private async embedViaSequentialEndpoint(texts: string[]): Promise<EmbeddingResult> {
    const logger = getLogger();
    const url = `${this.baseUrl}/api/embeddings`;
    const embeddings: number[][] = [];
    let totalTokens = 0;

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      logger.debug("Ollama embed: sequential request", {
        index: i,
        total: texts.length,
      });

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "(unreadable)");
        throw new Error(
          `Ollama /api/embeddings failed for text[${i}]: HTTP ${response.status} — ${body}`
        );
      }

      const data = (await response.json()) as OllamaEmbeddingsSingleResponse;
      embeddings.push(data.embedding);
      // The legacy endpoint does not expose token counts
    }

    return { embeddings, usage: { totalTokens } };
  }
}
