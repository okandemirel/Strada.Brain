/**
 * Framework documentation indexing at boot.
 *
 * The DocRAG pipeline was constructed and wrapped into the composite at boot,
 * and then never initialized or populated: only the code pipeline's background
 * indexing ran, so a documentation query returned nothing until someone called
 * the rag_index tool by hand while the log said "DocRAG enabled" (audit 05.F1 /
 * D45, 2026-09-13). This schedules the doc side in the background, the same way
 * the code side already is.
 */
export interface DocIndexingPipeline {
  initialize(): Promise<void>;
  indexPackage(pkg: { name: string }): Promise<unknown>;
}

export interface DocIndexingLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export async function indexFrameworkDocs(
  docPipeline: DocIndexingPipeline,
  packageRoots: ReadonlyArray<{ name: string }>,
  logger: DocIndexingLogger,
): Promise<{ indexed: string[]; failed: string[] }> {
  const indexed: string[] = [];
  const failed: string[] = [];
  try {
    await docPipeline.initialize();
  } catch (err) {
    logger.warn("DocRAG store could not be initialized; framework docs stay unindexed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { indexed, failed: packageRoots.map((p) => p.name) };
  }
  for (const pkg of packageRoots) {
    try {
      await docPipeline.indexPackage(pkg);
      indexed.push(pkg.name);
    } catch (err) {
      failed.push(pkg.name);
      logger.warn("DocRAG indexing failed for a package", {
        package: pkg.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info("Framework documentation indexed", { indexed: indexed.join(", ") || "none", failed: failed.join(", ") || "none" });
  return { indexed, failed };
}
