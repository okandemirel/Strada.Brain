# src/types/

Core type definitions providing branded IDs, functional programming primitives, and utility types used across Strada.Brain.

## Brand Types

`Brand<K, T>` creates nominal types from structural types, preventing accidental mixing of IDs.

| Type | Underlying | Purpose |
|------|-----------|---------|
| `UserId` | `Brand<string, "UserId">` | Unique user identifier |
| `ChatId` | `Brand<string, "ChatId">` | Conversation identifier |
| `MessageId` | `Brand<string, "MessageId">` | Message identifier |
| `SessionId` | `Brand<string, "SessionId">` | Session identifier |
| `MemoryId` | `Brand<string, "MemoryId">` | Memory entry identifier |
| `VectorId` | `Brand<string, "VectorId">` | Vector identifier |
| `ToolName` | `Brand<string, "ToolName">` | Registered tool name |
| `ProviderName` | `Brand<string, "ProviderName">` | Provider name |
| `AbsolutePath` | `Brand<string, "AbsolutePath">` | Absolute file path |
| `FilePath` | `string` | File path (validated against traversal) |

Constructors `toUserId()`, `toChatId()`, `toFilePath()` validate input and return branded values. Validators `isValidUserId()`, `isValidChatId()`, `isValidFilePath()` serve as type guards.

## Result Type

`Result<T, E = Error>` -- discriminated union for explicit error handling instead of exceptions.

| Variant | Shape | Description |
|---------|-------|-------------|
| `ok` | `{ kind: "ok"; value: T }` | Success with value |
| `err` | `{ kind: "err"; error: E }` | Failure with error |

Helpers: `ok()`, `err()`, `isOk()`, `isErr()`, `unwrap()`, `unwrapOr()`, `mapResult()`, `mapErr()`, `flatMapResult()`.

`AsyncResult<T, E>` is `Promise<Result<T, E>>`.

## Option Type

`Option<T>` -- discriminated union for explicit null/undefined handling.

| Variant | Shape | Description |
|---------|-------|-------------|
| `some` | `{ kind: "some"; value: T }` | Present value |
| `none` | `{ kind: "none" }` | Absent value |

Helpers: `some()`, `none()`, `fromNullable()`, `isSome()`, `isNone()`, `unwrapOption()`, `unwrapOrOption()`, `mapOption()`, `filterOption()`.

## Validation Types

`ValidationResult<T>` -- discriminated union with structured error details.

- `{ kind: "valid"; value: T }` or `{ kind: "invalid"; errors: ValidationError[] }`
- `ValidationError` has fields: `path: string`, `message: string`, `code: string`
- `fromZodResult()` converts `z.SafeParseReturnType` to `ValidationResult`

## Vector Types

| Type | Definition | Purpose |
|------|-----------|---------|
| `Vector<D>` | `number[]` (dimension-parameterized) | Generic vector with runtime dimension check |
| `Embedding<D>` | `number[]` (dimension-parameterized) | Semantic embedding vector |

- `createVector(values, expectedDimension)` returns `Result<Vector<D>, string>` -- fails on dimension mismatch
- `createEmbedding(vector)` wraps a `Vector<D>` as `Embedding<D>`
- `cosineSimilarity(a, b)` computes cosine similarity, returns `Result<number, string>`

## Chunk Types

`Chunk<T extends ChunkType>` represents document chunks with type-discriminated metadata.

`ChunkType` = `"code" | "documentation" | "conversation" | "analysis" | "note"`

| Metadata Interface | Extends | Extra Fields |
|-------------------|---------|--------------|
| `ChunkMetadata<T>` | -- | `source`, `createdAt`, `chunkType` |
| `CodeChunkMetadata` | `ChunkMetadata<"code">` | `filePath`, `startLine`, `endLine`, `language`, `symbol?`, `parentSymbol?` |
| `DocumentationChunkMetadata` | `ChunkMetadata<"documentation">` | `title?`, `section?` |
| `ConversationChunkMetadata` | `ChunkMetadata<"conversation">` | `chatId: ChatId`, `userId: UserId`, `messageId: MessageId` |

## Utility Types

| Type | Definition | Purpose |
|------|-----------|---------|
| `DeepPartial<T>` | Recursive `Partial` | All nested properties optional |
| `DeepReadonly<T>` | Recursive `Readonly` | All nested properties readonly |
| `NonEmptyArray<T>` | `[T, ...T[]]` | Array guaranteed to have at least one element |
| `JsonValue` | Union of primitives, arrays, objects | JSON-compatible value |
| `JsonObject` | `Record<string, JsonValue>` | JSON-compatible object |
| `JsonArray` | `JsonValue[]` | JSON-compatible array |
| `Dictionary<T>` | `Record<string, T>` | Typed string-keyed map |
| `StringDictionary` | `Record<string, string>` | String-to-string map |
| `TimestampMs` | `number` | Timestamp in milliseconds |
| `DurationMs` | `Brand<number, "DurationMs">` | Duration in milliseconds |
| `Percentage` | `Brand<number, "Percentage">` | Constrained 0-100 |
| `NormalizedScore` | `number` | Constrained 0-1 |

## Async Types

| Type/Interface | Purpose |
|---------------|---------|
| `CancellationToken` | `{ isCancelled: boolean; onCancel(cb) }` for cooperative cancellation |
| `Disposable` | `dispose(): void \| Promise<void>` resource cleanup |
| `AsyncDisposable` | `dispose(): Promise<void>` async resource cleanup |
| `using(resource, fn)` | Try-with-resources pattern for `AsyncDisposable` |

## Type Guards

Runtime type checks returning TypeScript type predicates:

`isString`, `isNumber`, `isBoolean`, `isObject`, `isArray`, `isNonNull`, `isError`, `isDate`, `isFunction`, `isNonEmptyArray`

Assertion helpers: `assertDefined(value, msg?)`, `assertType(value, guard, msg?)`.

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | All type definitions, brand constructors, FP primitives, type guards |
