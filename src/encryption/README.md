# src/encryption/

AES-256-GCM encryption, key lifecycle management, data masking, and tokenization.

## Key Manager (`data-protection.ts` — `KeyManager`)

Manages data encryption keys (DEKs) with rotation policy support.

- `Map<string, DataEncryptionKey>` stores keys by ID (format `dek-{timestamp}-{hex8}`)
- Key states: `active`, `rotating`, `retired`
- Default rotation policy: 90-day rotation interval, 7-day pre-rotation notification, 30-day post-rotation retirement
- Rotation timer checks every hour via `setInterval`
- Master key initialization derives a key using `scryptSync` with N=100,000 iterations
- `generateKey()` creates a random 32-byte key via `randomBytes`
- `rotateKeys()` marks current key as `rotating`, schedules retirement via `setTimeout`, generates new active key
- `exportKey()` / `importKey()` for base64 key backup and restore
- `destroy()` zero-fills all key buffers before clearing the map

## Encryption Service (`data-protection.ts` — `EncryptionService`)

Symmetric encryption using AES-256-GCM with authenticated encryption.

- Config: 32-byte key, 16-byte IV, 16-byte auth tag, 32-byte salt, version 1
- `encrypt()` accepts `Buffer | string`, returns `EncryptedData` with ciphertext, IV, auth tag, salt, version
- `decrypt()` verifies auth tag; throws on tampering detection
- `encryptToString()` / `decryptFromString()` — base64-encoded string format for storage
- `encryptObject()` / `decryptObject()` — selectively encrypt/decrypt specified fields of an object
- `isEncryptedString()` type guard checks for `data`, `iv`, `authTag`, `version` fields

## Data Masking (`data-protection.ts` — `DataMasking`)

Static utility class for PII masking with 6 preset strategies.

- `full` — replaces entire string with mask character
- `partial` — shows configurable first/last N characters
- `email` — masks local part (preserves first/last char and domain)
- `credit_card` — shows last 4 digits only
- `ssn` — shows last 4 digits in `***-**-NNNN` format
- `phone` — shows last 4 digits only
- Default mask character: `*`

## Tokenization Service (`data-protection.ts` — `TokenizationService`)

Reversible tokenization with optional expiration.

- `Map<string, TokenMapping>` for token-to-original lookup; `Map<string, string>` reverse map for deduplication
- Tokens formatted as `tok_{hex32}` via `randomBytes(16)`
- `tokenize()` returns existing token if data already tokenized (idempotent)
- `detokenize()` checks expiration; expired tokens auto-deleted on access
- `cleanup()` batch-removes all expired tokens

## Environment Encryption

- `encryptEnvValue()` / `decryptEnvValue()` — convenience functions using `ENCRYPTION_KEY` env var

## Module Singletons

Three pre-instantiated singletons: `keyManager` (initialized from `process.env.ENCRYPTION_KEY`), `encryptionService`, `tokenizationService`.

## Key Files

| File | Purpose |
|------|---------|
| `data-protection.ts` | Key management, AES-256-GCM encryption/decryption, data masking, tokenization, env var encryption |
