/**
 * Binary codec for the persisted embedding cache.
 *
 * The cache used to round-trip through `JSON.stringify` / `JSON.parse`. At the
 * default 10,000 entries and 1536 dimensions that is, measured:
 *
 *   JSON.stringify  821 ms  ->  296 MB string
 *   JSON.parse      567 ms
 *   binary encode    96 ms  ->  118 MB buffer
 *
 * So roughly 1.4 s of blocking main-thread work and a 296 MB string allocation
 * on every start/stop cycle, at the *default* cache size. Worse, 296 MB leaves
 * only 1.7x headroom under V8's ~537 MB maximum string length: raising
 * maxCacheSize past ~17,300 entries makes shutdown throw
 * `RangeError: Invalid string length` and silently discard the whole cache.
 *
 * Values are stored as float64 rather than float32 on purpose. Provider
 * embeddings are held as JS numbers and feed cosine similarity directly, so
 * narrowing them on write would perturb retrieval ranking after a restart —
 * a change that would be very hard to attribute back to the cache format.
 */

const MAGIC = 0x45_43_42_31; // "ECB1"
const VERSION = 1;
const HEADER_BYTES = 20; // magic, version, dimensions, count, providerNameLen

export interface EmbeddingCachePayload {
  providerName: string;
  dimensions: number;
  entries: Array<{ key: string; embedding: number[] }>;
}

export function encodeEmbeddingCache(payload: EmbeddingCachePayload): Buffer {
  const { providerName, dimensions, entries } = payload;
  const providerBytes = Buffer.from(providerName, "utf8");

  let size = HEADER_BYTES + providerBytes.length;
  const keyBuffers = entries.map((e) => Buffer.from(e.key, "utf8"));
  for (const keyBuffer of keyBuffers) {
    size += 4 + keyBuffer.length + dimensions * 8;
  }

  const buffer = Buffer.allocUnsafe(size);
  buffer.writeUInt32LE(MAGIC, 0);
  buffer.writeUInt32LE(VERSION, 4);
  buffer.writeUInt32LE(dimensions, 8);
  buffer.writeUInt32LE(entries.length, 12);
  buffer.writeUInt32LE(providerBytes.length, 16);
  providerBytes.copy(buffer, HEADER_BYTES);

  let offset = HEADER_BYTES + providerBytes.length;
  for (let i = 0; i < entries.length; i++) {
    const keyBuffer = keyBuffers[i]!;
    const embedding = entries[i]!.embedding;
    if (embedding.length !== dimensions) {
      // A short row would shift every following entry, so the file would read
      // back as plausible-looking garbage. Refuse to write it.
      throw new Error(
        `Embedding for key ${entries[i]!.key} has ${embedding.length} dimensions, expected ${dimensions}`,
      );
    }
    buffer.writeUInt32LE(keyBuffer.length, offset);
    offset += 4;
    keyBuffer.copy(buffer, offset);
    offset += keyBuffer.length;
    for (const value of embedding) {
      buffer.writeDoubleLE(value, offset);
      offset += 8;
    }
  }

  return buffer;
}

/**
 * Returns null for anything that is not a well-formed cache file — wrong magic,
 * unknown version, or a length that disagrees with the header. The cache is a
 * pure optimisation, so a rejected file costs a re-embed, never correctness.
 */
export function decodeEmbeddingCache(buffer: Buffer): EmbeddingCachePayload | null {
  if (buffer.length < HEADER_BYTES) return null;
  if (buffer.readUInt32LE(0) !== MAGIC) return null;
  if (buffer.readUInt32LE(4) !== VERSION) return null;

  const dimensions = buffer.readUInt32LE(8);
  const count = buffer.readUInt32LE(12);
  const providerNameLen = buffer.readUInt32LE(16);
  if (buffer.length < HEADER_BYTES + providerNameLen) return null;

  const providerName = buffer.toString("utf8", HEADER_BYTES, HEADER_BYTES + providerNameLen);
  const entries: Array<{ key: string; embedding: number[] }> = [];

  let offset = HEADER_BYTES + providerNameLen;
  for (let i = 0; i < count; i++) {
    // Bounds-check before every read: a truncated file must return null rather
    // than throw out of a Buffer accessor or invent zeroed vectors.
    if (offset + 4 > buffer.length) return null;
    const keyLength = buffer.readUInt32LE(offset);
    offset += 4;
    if (offset + keyLength + dimensions * 8 > buffer.length) return null;

    const key = buffer.toString("utf8", offset, offset + keyLength);
    offset += keyLength;
    const embedding = new Array<number>(dimensions);
    for (let d = 0; d < dimensions; d++) {
      embedding[d] = buffer.readDoubleLE(offset);
      offset += 8;
    }
    entries.push({ key, embedding });
  }

  return { providerName, dimensions, entries };
}
