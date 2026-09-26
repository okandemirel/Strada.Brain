/**
 * Structured error signatures: the only form of a tool failure that
 * error-pattern learning keeps (LRN-19).
 *
 * Tool output can be attacker-influenced (file contents, web pages, command
 * output), and what error-pattern learning stores is rendered back into
 * prompts through the "recurring error" instinct. So a failure is reduced to
 * fixed-vocabulary fields before anything records it: a category from the
 * closed enum, a code with a strict compiler-diagnostic shape, a
 * project-relative path and a line number. The message is a template built
 * from the category and code, never text taken from the output.
 *
 * Both sides run this: the producer (the orchestrator's `tool:result`) and the
 * consumer (the learning pipeline, before it records a pattern or creates an
 * instinct), so a producer that skips it cannot get free text through.
 */

import path from "node:path";
import type { ErrorCategory, ErrorDetails } from "./types.js";

/** The closed category vocabulary (ErrorDetails.category). */
export const ERROR_SIGNATURE_CATEGORIES: readonly ErrorCategory[] = [
  "syntax",
  "runtime",
  "logic",
  "permission",
  "network",
  "timeout",
  "validation",
  "resource",
  "unknown",
];

/** C#, Unity, MSBuild and NuGet diagnostic codes: CS0246, MSB3073, NU1101. */
const ERROR_CODE_RE = /^[A-Z]{2,5}\d{3,5}$/;
/** Longest path kept, after normalization. */
export const MAX_SIGNATURE_FILE_CHARS = 200;
const MAX_FILE_SEGMENTS = 32;
/**
 * Characters a kept path may contain. No whitespace, so a path cannot carry a
 * sentence, and no regex metacharacters that would make a stored file pattern
 * an invalid expression.
 */
const FILE_CHARS_RE = /^[A-Za-z0-9._@/-]+$/;
const MAX_LINE = 10_000_000;

export interface ErrorSignature {
  readonly category: ErrorCategory;
  readonly code?: string;
  /** Project-relative, forward slashes, no `..` segment. */
  readonly file?: string;
  readonly line?: number;
}

function isSignatureCategory(value: unknown): value is ErrorCategory {
  return typeof value === "string" && (ERROR_SIGNATURE_CATEGORIES as readonly string[]).includes(value);
}

function signatureCode(value: unknown): string | undefined {
  return typeof value === "string" && ERROR_CODE_RE.test(value) ? value : undefined;
}

function signatureLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_LINE
    ? value
    : undefined;
}

/** Absolute on any platform: POSIX root, UNC, drive-absolute or drive-relative. */
function isAbsoluteAnywhere(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || /^[A-Za-z]:/.test(p);
}

/**
 * A project-relative path with forward slashes, or undefined. With
 * `projectRoot`, an absolute path inside the project is made relative first
 * (compilers report absolute paths); every other absolute path is dropped.
 */
export function signatureFile(value: unknown, projectRoot?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  let file = value.trim();
  // Bounded before any path work, so a huge value costs nothing.
  if (file.length === 0 || file.length > MAX_SIGNATURE_FILE_CHARS * 4) return undefined;
  if (projectRoot && path.isAbsolute(file)) {
    const relative = path.relative(projectRoot, file);
    if (relative === "" || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      return undefined;
    }
    file = relative;
  }
  file = file.replace(/\\/g, "/");
  if (isAbsoluteAnywhere(file)) return undefined;
  const segments = file.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.length > MAX_FILE_SEGMENTS) return undefined;
  if (segments.includes("..")) return undefined;
  const normalized = segments.join("/");
  if (normalized.length > MAX_SIGNATURE_FILE_CHARS || !FILE_CHARS_RE.test(normalized)) return undefined;
  return normalized;
}

/**
 * The structured signature of `input`, keeping only the fields that pass the
 * schema: an unknown category reads as "unknown", every other invalid field is
 * dropped. Anything else on `input` (message, stack, suggestions) is ignored.
 */
export function toErrorSignature(
  input: unknown,
  options: { projectRoot?: string } = {},
): ErrorSignature | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const code = signatureCode(raw["code"]);
  const file = signatureFile(raw["file"], options.projectRoot);
  const line = signatureLine(raw["line"]);
  return {
    category: isSignatureCategory(raw["category"]) ? raw["category"] : "unknown",
    ...(code === undefined ? {} : { code }),
    ...(file === undefined ? {} : { file }),
    ...(line === undefined ? {} : { line }),
  };
}

/** The fixed-template message for a signature: "CS0246 validation error". */
export function errorSignatureMessage(signature: ErrorSignature): string {
  return signature.code ? `${signature.code} ${signature.category} error` : `${signature.category} error`;
}

/**
 * ErrorDetails carrying only a structured signature, its message the template.
 * This is the shape `errorDetails` may have on a `tool:result`, in an
 * observation, and in an error pattern.
 */
export function toSignatureErrorDetails(
  input: unknown,
  options: { projectRoot?: string } = {},
): ErrorDetails | undefined {
  const signature = toErrorSignature(input, options);
  if (!signature) return undefined;
  return { ...signature, message: errorSignatureMessage(signature) };
}
