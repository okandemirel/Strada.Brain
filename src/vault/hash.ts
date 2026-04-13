import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

interface XXHashH64 {
  update(buf: Buffer): XXHashH64;
  digest(): { toString(radix: number): string };
}

interface XXHashLib {
  h64(seed: number): XXHashH64;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const XXH: XXHashLib = _require('xxhashjs');

const XX_SEED = 0xc0ffee;

export function xxhash64Hex(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return XXH.h64(XX_SEED).update(buf).digest().toString(16).padStart(16, '0');
}

export function chunkIdFor(path: string, offset: number, body: string): string {
  // Truncate sha256 to 32 hex chars (16 bytes) — sufficient identity for chunk PKs, halves SQLite key space.
  return createHash('sha256')
    .update(path)
    .update('\x00')
    .update(String(offset))
    .update('\x00')
    .update(body)
    .digest('hex')
    .slice(0, 32);
}
