/**
 * Core Type Definitions for Strada.Brain
 * 
 * Provides type-safe foundations:
 * - Brand types for type-safe IDs
 * - Functional programming types (Result, Option)
 * - Validation types
 * - Utility types
 */

import type { z } from "zod";

// =============================================================================
// BRAND TYPES - Type-safe identifiers
// =============================================================================

/**
 * Brand type helper - creates nominal types from structural types
 * Prevents accidental mixing of different ID types
 */
export type Brand<K, T> = K & { __brand: T };

/** Unique user identifier */
export type UserId = Brand<string, "UserId">;

/** Unique chat/conversation identifier */
export type ChatId = Brand<string, "ChatId">;

/** Unique message identifier */
export type MessageId = Brand<string, "MessageId">;

/** File path with validation */
export type FilePath = string;

/** Absolute file path */
export type AbsolutePath = Brand<string, "AbsolutePath">;

/** Tool name - must match registered tool */
export type ToolName = Brand<string, "ToolName">;

/** Session identifier */
export type SessionId = Brand<string, "SessionId">;

/** Memory entry identifier */
export type MemoryId = Brand<string, "MemoryId">;

/** Vector identifier */
export type VectorId = Brand<string, "VectorId">;

/** Provider name */
export type ProviderName = Brand<string, "ProviderName">;

/**
 * Create a branded type with runtime validation
 */
export function createBrand<T, B>(value: T, _brand: B): Brand<T, B> {
  return value as Brand<T, B>;
}

// Brand validators
export function isValidUserId(value: string): value is UserId {
  return value.length > 0 && !value.includes("\n");
}

export function isValidChatId(value: string): value is ChatId {
  return value.length > 0;
}

export function isValidFilePath(value: string): value is FilePath {
  // Prevent path traversal
  return !value.includes("..") && !value.startsWith("/");
}

export function toUserId(value: string): UserId {
  if (!isValidUserId(value)) {
    throw new Error(`Invalid UserId: ${value}`);
  }
  return createBrand(value, "UserId" as const);
}

export function toChatId(value: string): ChatId {
  if (!isValidChatId(value)) {
    throw new Error(`Invalid ChatId: ${value}`);
  }
  return createBrand(value, "ChatId" as const);
}

export function toFilePath(value: string): FilePath {
  if (!isValidFilePath(value)) {
    throw new Error(`Invalid FilePath: ${value}`);
  }
  return createBrand(value, "FilePath" as const);
}

// =============================================================================
// RESULT TYPE - Explicit error handling
// =============================================================================

/**
 * Result type for explicit error handling
 * Use instead of throwing exceptions
 */
export type Result<T, E = Error> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "err"; readonly error: E };

/** Create an Ok result */
export function ok<T>(value: T): Result<T, never> {
  return { kind: "ok", value };
}

/** Create an Err result */
export function err<E>(error: E): Result<never, E> {
  return { kind: "err", error };
}

/** Check if result is Ok */
export function isOk<T, E>(result: Result<T, E>): result is { kind: "ok"; value: T } {
  return result.kind === "ok";
}

/** Check if result is Err */
export function isErr<T, E>(result: Result<T, E>): result is { kind: "err"; error: E } {
  return result.kind === "err";
}

/** Unwrap result value or throw */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (isErr(result)) {
    throw result.error instanceof Error 
      ? result.error 
      : new Error(String(result.error));
  }
  return (result as Extract<Result<T, E>, { kind: "ok" }>).value;
}

/** Unwrap result value or return default */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return isOk(result) ? result.value : defaultValue;
}

/** Map result value */
export function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> {
  if (isOk(result)) {
    return ok(fn(result.value));
  }
  return result as unknown as Result<U, E>;
}

/** Map result error */
export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F
): Result<T, F> {
  if (isErr(result)) {
    return err(fn(result.error));
  }
  return result as unknown as Result<T, F>;
}

/** Flat map (bind) for results */
export function flatMapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  if (isOk(result)) {
    return fn(result.value);
  }
  return result as unknown as Result<U, E>;
}

// =============================================================================
// OPTION TYPE - Nullable handling
// =============================================================================

/**
 * Option type for explicit null/undefined handling
 * Use instead of nullable types
 */
export type Option<T> =
  | { readonly kind: "some"; readonly value: T }
  | { readonly kind: "none" };

/** Create a Some option */
export function some<T>(value: T): Option<T> {
  return { kind: "some", value };
}

/** Create a None option */
export function none<T>(): Option<T> {
  return { kind: "none" };
}

/** Create Option from nullable value */
export function fromNullable<T>(value: T | null | undefined): Option<T> {
  return value != null ? some(value) : none();
}

/** Check if option is Some */
export function isSome<T>(option: Option<T>): option is { kind: "some"; value: T } {
  return option.kind === "some";
}

/** Check if option is None */
export function isNone<T>(option: Option<T>): option is { kind: "none" } {
  return option.kind === "none";
}

/** Unwrap option value or throw */
export function unwrapOption<T>(option: Option<T>): T {
  if (isNone(option)) {
    throw new Error("Cannot unwrap None");
  }
  return (option as Extract<Option<T>, { kind: "some" }>).value;
}

/** Unwrap option value or return default */
export function unwrapOrOption<T>(option: Option<T>, defaultValue: T): T {
  return isSome(option) ? option.value : defaultValue;
}

/** Map option value */
export function mapOption<T, U>(option: Option<T>, fn: (value: T) => U): Option<U> {
  return isSome(option) ? some(fn(option.value)) : none();
}

/** Filter option based on predicate */
export function filterOption<T>(
  option: Option<T>,
  predicate: (value: T) => boolean
): Option<T> {
  return isSome(option) && predicate(option.value) ? option : none();
}

// =============================================================================
// VALIDATION TYPES
// =============================================================================

/**
 * Validation result with detailed error information
 */
export type ValidationResult<T> =
  | { readonly kind: "valid"; readonly value: T }
  | { readonly kind: "invalid"; readonly errors: ValidationError[] };

/** Single validation error */
export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

/** Create a valid result */
export function valid<T>(value: T): ValidationResult<T> {
  return { kind: "valid", value };
}

/** Create an invalid result */
export function invalid(errors: ValidationError[]): ValidationResult<never> {
  return { kind: "invalid", errors };
}

/** Create a single error invalid result */
export function invalidOne(path: string, message: string, code = "validation_error"): ValidationResult<never> {
  return invalid([{ path, message, code }]);
}

/** Check if validation is valid */
export function isValid<T>(result: ValidationResult<T>): result is { kind: "valid"; value: T } {
  return result.kind === "valid";
}

/** Convert Zod result to ValidationResult */
export function fromZodResult<T>(result: z.SafeParseReturnType<unknown, T>): ValidationResult<T> {
  if (result.success) {
    return valid(result.data);
  }
  return invalid(
    result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    }))
  );
}

// =============================================================================
// VECTOR TYPES - Type-safe vector operations
// =============================================================================

/**
 * Vector type with dimension constraint
 * @template D - Vector dimension (e.g., 1536 for OpenAI embeddings)
 */
export type Vector<_D extends number = number> = number[];

/**
 * Create a vector with runtime dimension check
 */
export function createVector<D extends number>(
  values: number[],
  expectedDimension: D
): Result<Vector<D>, string> {
  if (values.length !== expectedDimension) {
    return err(
      `Vector dimension mismatch: expected ${expectedDimension}, got ${values.length}`
    );
  }
  return ok(createBrand(values, `Vector${expectedDimension}` as const));
}

/**
 * Embedding vector - semantic representation
 */
export type Embedding<_D extends number = number> = number[];

/** Create an embedding from a vector */
export function createEmbedding<D extends number>(
  vector: Vector<D>
): Embedding<D> {
  return createBrand(vector, "Embedding" as const);
}

/** Cosine similarity between two vectors */
export function cosineSimilarity<D extends number>(
  a: Vector<D>,
  b: Vector<D>
): Result<number, string> {
  if (a.length !== b.length) {
    return err(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  if (normA === 0 || normB === 0) {
    return err("Cannot compute similarity for zero vector");
  }

  return ok(dotProduct / (Math.sqrt(normA) * Math.sqrt(normB)));
}

// =============================================================================
// CHUNK TYPES - Type-safe document chunks
// =============================================================================

/** Types of document chunks */
export type ChunkType = 
  | "code"
  | "documentation"
  | "conversation"
  | "analysis"
  | "note";

/**
 * Generic chunk type with type discriminator
 * @template T - The chunk type
 */
export interface Chunk<T extends ChunkType = ChunkType> {
  readonly id: string;
  readonly type: T;
  readonly content: string;
  readonly metadata: ChunkMetadata<T>;
  readonly embedding?: Embedding<number>;
}

/** Type-specific metadata for chunks */
export interface ChunkMetadata<T extends ChunkType> {
  readonly source: string;
  readonly createdAt: Date;
  readonly chunkType: T;
}

/** Code chunk metadata */
export interface CodeChunkMetadata extends ChunkMetadata<"code"> {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly language: string;
  readonly symbol?: string;
  readonly parentSymbol?: string;
}

/** Documentation chunk metadata */
export interface DocumentationChunkMetadata extends ChunkMetadata<"documentation"> {
  readonly title?: string;
  readonly section?: string;
}

/** Conversation chunk metadata */
export interface ConversationChunkMetadata extends ChunkMetadata<"conversation"> {
  readonly chatId: ChatId;
  readonly userId: UserId;
  readonly messageId: MessageId;
}

// =============================================================================
// UTILITY TYPES
// =============================================================================

/** Deep partial type - makes all properties optional recursively */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/** Deep readonly type - makes all properties readonly recursively */
export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

/** Non-empty array type */
export type NonEmptyArray<T> = [T, ...T[]];

/** Type guard for non-empty arrays */
export function isNonEmptyArray<T>(arr: T[]): arr is NonEmptyArray<T> {
  return arr.length > 0;
}

/** JSON-compatible value */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** JSON-compatible object */
export type JsonObject = { [key: string]: JsonValue };

/** JSON-compatible array */
export type JsonArray = JsonValue[];

/** Strict dictionary type - preferred over Record<string, unknown> */
export type Dictionary<T = unknown> = Record<string, T>;

/** Strict string dictionary */
export type StringDictionary = Record<string, string>;

/** Number dictionary */
export type NumberDictionary = Record<string, number>;

/** Boolean dictionary */
export type BooleanDictionary = Record<string, boolean>;

/** Timestamp in milliseconds */
export type TimestampMs = number;

/** Create timestamp */
export function now(): TimestampMs {
  return createBrand(Date.now(), "TimestampMs" as const);
}

/** Duration in milliseconds */
export type DurationMs = Brand<number, "DurationMs">;

/** Create duration */
export function durationMs(ms: number): DurationMs {
  return createBrand(ms, "DurationMs" as const);
}

/** Percentage value (0-100) */
export type Percentage = Brand<number, "Percentage">;

/** Create percentage with validation */
export function percentage(value: number): Result<Percentage, string> {
  if (value < 0 || value > 100) {
    return err(`Percentage must be between 0 and 100, got ${value}`);
  }
  return ok(createBrand(value, "Percentage" as const));
}

/** Normalized score (0-1) */
export type NormalizedScore = number;

/** Create normalized score with validation */
export function normalizedScore(value: number): Result<NormalizedScore, string> {
  if (value < 0 || value > 1) {
    return err(`Normalized score must be between 0 and 1, got ${value}`);
  }
  return ok(createBrand(value, "NormalizedScore" as const));
}

// =============================================================================
// ASYNC TYPES
// =============================================================================

/** Async result type */
export type AsyncResult<T, E = Error> = Promise<Result<T, E>>;

/** Cancellation token for async operations */
export interface CancellationToken {
  readonly isCancelled: boolean;
  readonly onCancel: (callback: () => void) => void;
}

/** Create a cancellation token */
export function createCancellationToken(): {
  token: CancellationToken;
  cancel: () => void;
} {
  let cancelled = false;
  const callbacks: (() => void)[] = [];

  return {
    token: {
      get isCancelled() {
        return cancelled;
      },
      onCancel(callback: () => void) {
        callbacks.push(callback);
      },
    },
    cancel() {
      cancelled = true;
      callbacks.forEach((cb) => cb());
    },
  };
}

/** Disposal interface for resource cleanup */
export interface Disposable {
  dispose(): void | Promise<void>;
}

/** Async disposable */
export interface AsyncDisposable {
  dispose(): Promise<void>;
}

/** Try-with-resources pattern */
export async function using<T extends AsyncDisposable, R>(
  resource: T,
  fn: (resource: T) => Promise<R>
): Promise<R> {
  try {
    return await fn(resource);
  } finally {
    await resource.dispose();
  }
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/** Type guard for strings */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Type guard for numbers */
export function isNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

/** Type guard for booleans */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Type guard for objects (not null, not array) */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Type guard for arrays */
export function isArray<T>(value: unknown, itemGuard?: (item: unknown) => item is T): value is T[] {
  if (!Array.isArray(value)) return false;
  if (itemGuard) {
    return value.every(itemGuard);
  }
  return true;
}

/** Type guard for non-null values */
export function isNonNull<T>(value: T | null | undefined): value is T {
  return value != null;
}

/** Type guard for Error objects */
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/** Type guard for Date objects */
export function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/** Type guard for functions */
export function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

/** Assert that value is defined */
export function assertDefined<T>(value: T | null | undefined, message?: string): T {
  if (value == null) {
    throw new Error(message ?? "Expected value to be defined");
  }
  return value;
}

/** Assert type at runtime */
export function assertType<T>(
  value: unknown,
  guard: (v: unknown) => v is T,
  message?: string
): T {
  if (!guard(value)) {
    throw new Error(message ?? `Type assertion failed`);
  }
  return value;
}
