/**
 * Input Validation Module for Strata.Brain
 * 
 * Centralized input validation with Zod schemas and sanitization.
 */

import { ZodError, type ZodSchema } from "zod";
// Note: zod types are re-exported from ./schemas.js, no need to import 'z' here
import { getLogger } from "../utils/logger.js";

// Re-export all schemas
export * from "./schemas.js";

// =============================================================================
// VALIDATION RESULT TYPES
// =============================================================================

export interface ValidationSuccess<T> {
  readonly success: true;
  readonly data: T;
}

export interface ValidationFailure {
  readonly success: false;
  readonly errors: ValidationError[];
  readonly message: string;
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

// =============================================================================
// VALIDATOR CLASS
// =============================================================================

export class InputValidator {
  private readonly logger = getLogger();
  private readonly stats = {
    totalValidations: 0,
    failedValidations: 0,
    lastError: null as ValidationFailure | null,
  };

  /**
   * Validate data against a Zod schema
   */
  validate<T>(schema: ZodSchema<T>, data: unknown, context?: string): ValidationResult<T> {
    this.stats.totalValidations++;
    const startTime = performance.now();

    try {
      const result = schema.safeParse(data);
      const duration = performance.now() - startTime;

      if (result.success) {
        this.logger.debug("Validation passed", {
          context,
          duration: `${duration.toFixed(2)}ms`,
        });
        return { success: true, data: result.data };
      }

      this.stats.failedValidations++;
      const errors = this.formatZodErrors(result.error);
      const failure: ValidationFailure = {
        success: false,
        errors,
        message: errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      };
      this.stats.lastError = failure;

      this.logger.warn("Validation failed", {
        context,
        errors: failure.errors,
        duration: `${duration.toFixed(2)}ms`,
      });

      return failure;
    } catch (error) {
      this.stats.failedValidations++;
      const failure: ValidationFailure = {
        success: false,
        errors: [{ path: "", message: String(error), code: "unknown" }],
        message: String(error),
      };
      this.stats.lastError = failure;
      return failure;
    }
  }

  /**
   * Validate data asynchronously (for async schemas)
   */
  async validateAsync<T>(
    schema: ZodSchema<T>,
    data: unknown,
    context?: string
  ): Promise<ValidationResult<T>> {
    this.stats.totalValidations++;
    const startTime = performance.now();

    try {
      const result = await schema.safeParseAsync(data);
      const duration = performance.now() - startTime;

      if (result.success) {
        this.logger.debug("Async validation passed", {
          context,
          duration: `${duration.toFixed(2)}ms`,
        });
        return { success: true, data: result.data };
      }

      this.stats.failedValidations++;
      const errors = this.formatZodErrors(result.error);
      const failure: ValidationFailure = {
        success: false,
        errors,
        message: errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      };
      this.stats.lastError = failure;

      this.logger.warn("Async validation failed", {
        context,
        errors: failure.errors,
        duration: `${duration.toFixed(2)}ms`,
      });

      return failure;
    } catch (error) {
      this.stats.failedValidations++;
      const failure: ValidationFailure = {
        success: false,
        errors: [{ path: "", message: String(error), code: "unknown" }],
        message: String(error),
      };
      this.stats.lastError = failure;
      return failure;
    }
  }

  /**
   * Validate or throw - throws ValidationError on failure
   */
  validateOrThrow<T>(schema: ZodSchema<T>, data: unknown, context?: string): T {
    const result = this.validate(schema, data, context);
    if (!result.success) {
      const failure = result as ValidationFailure;
      throw new ValidationErrorException(failure.errors, failure.message);
    }
    return result.data;
  }

  /**
   * Check if a value matches a schema (returns boolean)
   */
  matches<T>(schema: ZodSchema<T>, data: unknown): data is T {
    return schema.safeParse(data).success;
  }

  /**
   * Get validation statistics
   */
  getStats(): {
    totalValidations: number;
    failedValidations: number;
    successRate: number;
    lastError: ValidationFailure | null;
  } {
    return {
      totalValidations: this.stats.totalValidations,
      failedValidations: this.stats.failedValidations,
      successRate: this.stats.totalValidations > 0
        ? (this.stats.totalValidations - this.stats.failedValidations) / this.stats.totalValidations
        : 1,
      lastError: this.stats.lastError,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats.totalValidations = 0;
    this.stats.failedValidations = 0;
    this.stats.lastError = null;
  }

  private formatZodErrors(error: ZodError): ValidationError[] {
    return error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    }));
  }
}

// =============================================================================
// CUSTOM EXCEPTION
// =============================================================================

export class ValidationErrorException extends Error {
  readonly errors: ValidationError[];
  readonly code = "VALIDATION_ERROR";

  constructor(errors: ValidationError[], message: string) {
    super(message);
    this.name = "ValidationErrorException";
    this.errors = errors;
    Error.captureStackTrace?.(this, ValidationErrorException);
  }
}

// =============================================================================
// GLOBAL VALIDATOR INSTANCE
// =============================================================================

const globalValidator = new InputValidator();

export function validate<T>(
  schema: ZodSchema<T>,
  data: unknown,
  context?: string
): ValidationResult<T> {
  return globalValidator.validate(schema, data, context);
}

export function validateOrThrow<T>(
  schema: ZodSchema<T>,
  data: unknown,
  context?: string
): T {
  return globalValidator.validateOrThrow(schema, data, context);
}

export function validateAsync<T>(
  schema: ZodSchema<T>,
  data: unknown,
  context?: string
): Promise<ValidationResult<T>> {
  return globalValidator.validateAsync(schema, data, context);
}

export function getValidator(): InputValidator {
  return globalValidator;
}

// =============================================================================
// SECURITY VALIDATORS
// =============================================================================

/**
 * Validate and sanitize a string input for security
 */
export function sanitizeString(
  input: string,
  options: {
    maxLength?: number;
    allowNewlines?: boolean;
    allowHtml?: boolean;
  } = {}
): string {
  const { maxLength = 10000, allowNewlines = false, allowHtml = false } = options;

  let sanitized = input.slice(0, maxLength);

  if (!allowHtml) {
    sanitized = sanitized
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  if (!allowNewlines) {
    sanitized = sanitized.replace(/[\n\r]/g, " ");
  }

  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, "");

  return sanitized.trim();
}

/**
 * Validate a file path for path traversal attacks
 */
export function validateFilePath(
  path: string,
  allowedBasePaths: string[] = []
): { valid: boolean; error?: string; normalizedPath?: string } {
  // Check for null bytes
  if (path.includes("\0")) {
    return { valid: false, error: "Path contains null bytes" };
  }

  // Normalize the path
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/");

  // Check for path traversal
  if (normalized.includes("../") || normalized.includes("..\\")) {
    return { valid: false, error: "Path traversal detected" };
  }

  // Check absolute path
  if (normalized.startsWith("/") && !allowedBasePaths.some((base) => normalized.startsWith(base))) {
    return { valid: false, error: "Absolute path not allowed" };
  }

  // Check if within allowed base paths
  if (allowedBasePaths.length > 0) {
    const withinAllowed = allowedBasePaths.some((base) => {
      const baseNormalized = base.replace(/\\/g, "/").replace(/\/+$/, "");
      return normalized.startsWith(baseNormalized + "/") || normalized === baseNormalized;
    });

    if (!withinAllowed) {
      return { valid: false, error: "Path outside allowed directories" };
    }
  }

  return { valid: true, normalizedPath: normalized };
}

/**
 * Rate limit validation attempts
 */
export class ValidationRateLimiter {
  private attempts = new Map<string, { count: number; resetTime: number }>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(maxAttempts = 100, windowMs = 60000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  canValidate(key: string): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    const record = this.attempts.get(key);

    if (!record || now > record.resetTime) {
      this.attempts.set(key, { count: 1, resetTime: now + this.windowMs });
      return { allowed: true };
    }

    if (record.count >= this.maxAttempts) {
      return { allowed: false, retryAfter: Math.ceil((record.resetTime - now) / 1000) };
    }

    record.count++;
    return { allowed: true };
  }

  reset(key?: string): void {
    if (key) {
      this.attempts.delete(key);
    } else {
      this.attempts.clear();
    }
  }
}
