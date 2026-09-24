/**
 * Let go of a response-body reader when the consumer is done with it.
 *
 * `releaseLock()` alone leaves the body open when the loop exits early (an
 * abort, a throw, a caller that stopped reading). The concurrency permit that
 * fetchWithRetry holds for the response is released only when the body is
 * consumed or cancelled, so an early exit kept it until garbage collection
 * (FND-2). Cancelling a body that was already read to the end is a no-op.
 */
export function releaseStreamReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => {});
  try {
    reader.releaseLock();
  } catch {
    // Already released.
  }
}
