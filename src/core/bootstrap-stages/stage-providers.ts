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

  // Each of these acquires real OS/SQLite/socket resources in its constructor
  // (provider preferences DB, AgentDBMemory SQLite + HNSW + tiering timer,
  // channel sockets). With a bare Promise.all a single rejection would leave the
  // other two resolved resources leaked, because no failure disposer is wired up
  // yet at this stage. Use allSettled and, on any rejection, dispose whatever
  // managed to come online before re-throwing.
  const settled = await Promise.allSettled([
    deps.initializeAIProvider(params.config, params.logger),
    deps.initializeMemory(
      params.config,
      params.logger,
      verifiedEmbedding.cachedEmbeddingProvider,
    ),
    deps.initializeChannel(params.channelType, params.config, auth, params.logger),
  ] as const);

  const [providerSettled, memorySettled, channelSettled] = settled;

  if (settled.some((result) => result.status === "rejected")) {
    const providerInitValue =
      providerSettled.status === "fulfilled" ? providerSettled.value : undefined;
    const memoryManagerValue =
      memorySettled.status === "fulfilled" ? memorySettled.value : undefined;
    const channelValue =
      channelSettled.status === "fulfilled" ? channelSettled.value : undefined;

    if (memoryManagerValue) {
      try {
        await memoryManagerValue.shutdown();
      } catch (disposeError) {
        params.logger.warn("Failed to dispose memory after provider-runtime stage error", {
          error: disposeError instanceof Error ? disposeError.message : String(disposeError),
        });
      }
    }
    if (channelValue) {
      try {
        await channelValue.disconnect();
      } catch (disposeError) {
        params.logger.warn("Failed to disconnect channel after provider-runtime stage error", {
          error: disposeError instanceof Error ? disposeError.message : String(disposeError),
        });
      }
    }
    if (providerInitValue) {
      try {
        providerInitValue.manager.shutdown();
      } catch (disposeError) {
        params.logger.warn("Failed to shut down provider manager after provider-runtime stage error", {
          error: disposeError instanceof Error ? disposeError.message : String(disposeError),
        });
      }
    }

    const firstRejection = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw firstRejection?.reason ?? new Error("Provider runtime stage initialization failed");
  }

  const providerInit = (providerSettled as PromiseFulfilledResult<ProviderRuntimeStageResult["providerInit"]>).value;
  const memoryManager = (memorySettled as PromiseFulfilledResult<ProviderRuntimeStageResult["memoryManager"]>).value;
  const channel = (channelSettled as PromiseFulfilledResult<ProviderRuntimeStageResult["channel"]>).value;

  const startupNotices = [...providerInit.notices];
  if (embeddingResult.notice) {
    startupNotices.push(embeddingResult.notice);
  }
  // Surface the transient embedding-verification notice (live embeddings kept
  // enabled, retrying on demand) at startup so the unverified-but-not-degraded
  // state is visible instead of silently passing as plain "wired".
  if (
    verifiedEmbedding.embeddingStatus.notice
    && verifiedEmbedding.embeddingStatus.notice !== embeddingResult.notice
  ) {
    startupNotices.push(verifiedEmbedding.embeddingStatus.notice);
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
