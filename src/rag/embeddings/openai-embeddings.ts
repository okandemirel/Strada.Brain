import type { IEmbeddingProvider, EmbeddingBatch } from "../rag.interface.js";
import { getLogger } from "../../utils/logger.js";

const KNOWN_MODELS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

const DEFAULT_BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

interface OpenAIEmbeddingOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
  label?: string;
  batchSize?: number;
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly batchSize: number;

  constructor(opts: OpenAIEmbeddingOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "text-embedding-3-small";
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.dimensions = opts.dimensions ?? KNOWN_MODELS[this.model] ?? 1536;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    const providerLabel = opts.label ?? "OpenAI";
    this.name = `${providerLabel}:${this.model}`;
  }

  async embed(texts: string[]): Promise<EmbeddingBatch> {
    if (texts.length === 0) {
      return { embeddings: [], usage: { totalTokens: 0 } };
    }

    const logger = getLogger();
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push(texts.slice(i, i + this.batchSize));
    }

    logger.debug("OpenAI embed: starting", {
      texts: texts.length,
      batches: batches.length,
      model: this.model,
    });

    const allEmbeddings: number[][] = [];
    let totalTokens = 0;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx]!;
      const response = await this.embedBatchWithRetry(batch, batchIdx);
      // Re-sort by index to preserve original order within the batch
      const sorted = response.data.slice().sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        allEmbeddings.push(item.embedding);
      }
      totalTokens += response.usage?.total_tokens ?? 0;
    }

    logger.debug("OpenAI embed: done", { totalTokens });

    return { embeddings: allEmbeddings, usage: { totalTokens } };
  }

  private async embedBatchWithRetry(
    texts: string[],
    batchIdx: number,
  ): Promise<OpenAIEmbeddingResponse> {
    const logger = getLogger();
    const url = `${this.baseUrl}/embeddings`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.debug("OpenAI embed: retrying batch", {
          batchIdx,
          attempt,
          delayMs: delay,
        });
        await sleep(delay);
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            input: texts,
            model: this.model,
          }),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.debug("OpenAI embed: network error", {
          batchIdx,
          attempt,
          error: lastError.message,
        });
        continue;
      }

      if (response.ok) {
        const data = (await response.json()) as OpenAIEmbeddingResponse;
        return data;
      }

      const status = response.status;
      const body = (await response.text().catch(() => "(unreadable)")).slice(0, 200);
      lastError = new Error(
        `${this.name} embedding request failed: HTTP ${status} at ${this.baseUrl} — ${body}`,
      );

      if (status === 429 || status >= 500) {
        logger.debug("OpenAI embed: retryable error", {
          batchIdx,
          attempt,
          status,
        });
        continue;
      }

      // Non-retryable client error
      throw lastError;
    }

    throw lastError ?? new Error(`${this.name} embed: unknown error after retries`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
