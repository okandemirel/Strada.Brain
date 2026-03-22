import type * as winston from "winston";
import type { Config } from "../../config/config.js";
import type { CachedEmbeddingProvider } from "../../rag/embeddings/embedding-cache.js";
import type {
  BootstrapEmbeddingStatus,
  ProviderRuntimeStageDeps,
  ProviderRuntimeStageResult,
} from "./bootstrap-stages-types.js";

export async function verifyEmbeddingProviderConnection(
  cachedEmbeddingProvider: CachedEmbeddingProvider | undefined,
  embeddingStatus: BootstrapEmbeddingStatus,
  logger: winston.Logger,
  isTransientEmbeddingVerificationError: (error: unknown) => boolean,
): Promise<{
  cachedEmbeddingProvider?: CachedEmbeddingProvider;
  embeddingStatus: BootstrapEmbeddingStatus;
}> {
  if (!cachedEmbeddingProvider) {
    return { cachedEmbeddingProvider, embeddingStatus };
  }

  try {
    await cachedEmbeddingProvider.embed(["test"]);
    logger.info("Embedding provider verified");
    return {
      cachedEmbeddingProvider,
      embeddingStatus: {
        ...embeddingStatus,
        verified: true,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isTransientEmbeddingVerificationError(error)) {
      const notice =
        `Embedding provider could not be verified at startup (${errorMessage}). ` +
        "Keeping live embeddings enabled and retrying on demand.";
      logger.warn(notice);
      return {
        cachedEmbeddingProvider,
        embeddingStatus: {
          ...embeddingStatus,
          verified: false,
          usingHashFallback: false,
          notice,
        },
      };
    }

    const notice = `Embedding provider unreachable, falling back to hash embeddings: ${errorMessage}`;
    logger.warn(notice);
    return {
      cachedEmbeddingProvider: undefined,
      embeddingStatus: {
        ...embeddingStatus,
        state: "degraded",
        verified: false,
        usingHashFallback: true,
        notice,
      },
    };
  }
}

export async function initializeProviderRuntimeStage(
  params: {
    channelType: string;
    config: Config;
    logger: winston.Logger;
  },
  deps: ProviderRuntimeStageDeps,
): Promise<ProviderRuntimeStageResult> {
  const auth = deps.initializeAuth(params.config, params.channelType, params.logger);
  const embeddingResult = await deps.resolveAndCacheEmbeddings(params.config, params.logger);
  const verifiedEmbedding = await verifyEmbeddingProviderConnection(
    embeddingResult.cachedProvider,
    embeddingResult.status,
    params.logger,
    deps.isTransientEmbeddingVerificationError,
  );

  const [providerInit, memoryManager, channel] = await Promise.all([
    deps.initializeAIProvider(params.config, params.logger),
    deps.initializeMemory(
      params.config,
      params.logger,
      verifiedEmbedding.cachedEmbeddingProvider,
    ),
    deps.initializeChannel(params.channelType, params.config, auth, params.logger),
  ]);

  const startupNotices = [...providerInit.notices];
  if (embeddingResult.notice) {
    startupNotices.push(embeddingResult.notice);
  }

  return {
    providerInit,
    memoryManager,
    channel,
    cachedEmbeddingProvider: verifiedEmbedding.cachedEmbeddingProvider,
    embeddingStatus: verifiedEmbedding.embeddingStatus,
    startupNotices,
  };
}
