/**
 * Input Validation Schemas for Strada.Brain
 * 
 * Provides Zod schemas for all inputs with strict type checking,
 * sanitization, and security-focused validation.
 */

import { z } from "zod";
import { validateUrlWithConfig } from "../security/browser-security.js";

// =============================================================================
// COMMON VALIDATORS
// =============================================================================

/** UUID v4 validator */
export const uuidSchema = z.string().uuid();

/** Email validator with strict checking */
export const emailSchema = z.string()
  .email()
  .max(254)
  .transform((email) => email.toLowerCase().trim());

/** URL validator with protocol enforcement */
export const urlSchema = z.string()
  .url()
  .refine(
    (url) => url.startsWith("https://") || url.startsWith("wss://"),
    { message: "URL must use HTTPS or WSS protocol" }
  );

/** Safe string - prevents common injection characters */
export const safeStringSchema = z.string()
  .min(1)
  .max(10000)
  .refine(
    (s) => !/[<>\"'&;`|$(){}[\]\n\r\x00]/g.test(s),
    { message: "String contains potentially dangerous characters" }
  );

/** Alphanumeric identifier */
export const identifierSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, {
    message: "Identifier must start with letter or underscore, contain only alphanumeric, underscore, or hyphen"
  });

/** Namespace path (e.g., "Game.Modules.Combat") */
export const namespaceSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/, {
    message: "Invalid namespace format"
  });

/** File path - prevents path traversal */
export const safePathSchema = z.string()
  .min(1)
  .max(4096)
  .refine(
    (path) => !path.includes("\0"),
    { message: "Path contains null bytes" }
  )
  .refine(
    (path) => !/(\.\.|~\/|\/\.\.\/|^\/)/.test(path),
    { message: "Path traversal detected" }
  );

/** Port number validator */
export const portSchema = z.number().int().min(1024).max(65535);

/** IP address validator (IPv4 or IPv6) */
export const ipAddressSchema = z.string()
  .refine(
    (ip) => {
      // IPv4 regex
      const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
      // IPv6 regex (simplified)
      const ipv6Regex = /^(?:[0-9a-fA-F:]{2,39})$/;
      return ipv4Regex.test(ip) || ipv6Regex.test(ip);
    },
    { message: "Invalid IP address format" }
  );

/** CIDR block validator */
export const cidrSchema = z.string()
  .refine(
    (cidr) => {
      const parts = cidr.split("/");
      if (parts.length !== 2) return false;
      const [ip, mask] = parts;
      if (!mask) return false;
      const maskNum = parseInt(mask, 10);
      if (isNaN(maskNum) || maskNum < 0 || maskNum > 32) return false;
      return ipAddressSchema.safeParse(ip).success;
    },
    { message: "Invalid CIDR notation" }
  );

// =============================================================================
// SANITIZATION FUNCTIONS
// =============================================================================

/**
 * Sanitize user input by removing dangerous characters
 */
export function sanitizeInput(input: string): string {
  return input
    .replace(/[<>\"'&;`|$(){}[\]\x00]/g, "") // Remove dangerous chars
    .replace(/[\n\r]/g, " ") // Normalize newlines
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

/**
 * Sanitize HTML content (basic XSS protection)
 */
export function sanitizeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");
}

/**
 * Sanitize file path - removes null bytes and normalizes
 */
export function sanitizePath(path: string): string {
  return path
    .replace(/\0/g, "") // Remove null bytes
    .replace(/\/+/g, "/") // Normalize slashes
    .replace(/\\+/g, "\\") // Normalize backslashes
    .trim();
}

/**
 * Escape regex special characters
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =============================================================================
// FILE OPERATION SCHEMAS
// =============================================================================

export const fileReadSchema = z.object({
  path: safePathSchema,
  encoding: z.enum(["utf-8", "base64", "binary"]).default("utf-8"),
  maxSize: z.number().int().min(1).max(100 * 1024 * 1024).optional(), // Max 100MB
});

export const fileWriteSchema = z.object({
  path: safePathSchema,
  content: z.string().max(50 * 1024 * 1024), // Max 50MB
  encoding: z.enum(["utf-8", "base64", "binary"]).default("utf-8"),
  createBackup: z.boolean().default(true),
});

export const fileEditSchema = z.object({
  path: safePathSchema,
  oldString: z.string().min(1).max(10000),
  newString: z.string().max(10000),
  expectedOccurrences: z.number().int().min(1).max(100).optional(),
});

export const fileDeleteSchema = z.object({
  path: safePathSchema,
  confirmDelete: z.boolean().default(false),
});

export const fileMoveSchema = z.object({
  sourcePath: safePathSchema,
  destinationPath: safePathSchema,
  overwrite: z.boolean().default(false),
});

export const fileSearchSchema = z.object({
  pattern: z.string().min(1).max(1000),
  path: safePathSchema.optional(),
  filePattern: z.string().max(100).optional(),
  caseSensitive: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(10000).default(1000),
});

// =============================================================================
// SHELL COMMAND SCHEMAS
// =============================================================================

/** Whitelist of allowed shell commands */
const ALLOWED_SHELL_COMMANDS = [
  "ls", "cat", "head", "tail", "grep", "find", "wc",
  "git", "dotnet", "npm", "node", "npx",
  "mkdir", "touch", "cp", "mv", "rm", "chmod",
  "echo", "printf", "which", "pwd",
  "curl", "wget",
];

/** Dangerous shell patterns - using strings to avoid regex parsing issues */
const DANGEROUS_PATTERNS = [
  ";", "|", "&", "`", "$", "(", ")", "{", "}", "[", "]",
];

export const shellCommandSchema = z.object({
  command: z.string()
    .min(1)
    .max(4096)
    .refine(
      (cmd) => {
        const baseCmd = cmd.trim().split(/\s+/)[0];
        if (!baseCmd) return false;
        return ALLOWED_SHELL_COMMANDS.includes(baseCmd);
      },
      { message: "Command not in whitelist" }
    )
    .refine(
      (cmd) => !DANGEROUS_PATTERNS.some((pattern) => cmd.includes(pattern)),
      { message: "Command contains dangerous patterns" }
    ),
  args: z.array(z.string().max(4096)).max(100).default([]),
  timeout: z.number().int().min(1000).max(300000).default(60000), // 1s to 5min
  cwd: safePathSchema.optional(),
  env: z.record(z.string().max(4096)).optional(),
  captureOutput: z.boolean().default(true),
});

// =============================================================================
// API INPUT SCHEMAS
// =============================================================================

export const apiKeySchema = z.string()
  .min(16)
  .max(512)
  .regex(/^[a-zA-Z0-9_-]+$/, {
    message: "API key contains invalid characters"
  });

export const webhookUrlSchema = z.string()
  .url()
  .refine(
    (url) => url.startsWith("https://"),
    { message: "Webhook must use HTTPS" }
  )
  .refine(
    (url) => validateUrlWithConfig(url, {
      allowedUrlPatterns: [],
      blockedUrlPatterns: [],
      blockLocalhost: true,
      blockFileProtocol: true,
      blockDataProtocol: true,
      blockJavascriptProtocol: true,
    }).valid,
    { message: "Webhook URL cannot point to private/internal addresses" }
  );

export const jwtTokenSchema = z.string()
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, {
    message: "Invalid JWT format"
  });

// =============================================================================
// STRADA-SPECIFIC SCHEMAS
// =============================================================================

export const csharpIdentifierSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
    message: "Invalid C# identifier"
  });

export const csharpNamespaceSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/, {
    message: "Invalid C# namespace"
  });

export const csharpTypeSchema = z.string()
  .min(1)
  .max(256)
  .refine(
    (type) => !/[;{}()=\n\r]/.test(type),
    { message: "Type name contains invalid characters" }
  );

export const unityComponentSchema = z.object({
  name: csharpIdentifierSchema,
  namespace: csharpNamespaceSchema.optional(),
  baseClass: z.string().max(256).optional(),
  interfaces: z.array(csharpIdentifierSchema).max(20).default([]),
  fields: z.array(z.object({
    name: csharpIdentifierSchema,
    type: csharpTypeSchema,
    access: z.enum(["public", "private", "protected", "internal"]).default("public"),
    attributes: z.array(z.string().max(256)).max(10).default([]),
  })).max(50),
  methods: z.array(z.object({
    name: csharpIdentifierSchema,
    returnType: csharpTypeSchema.default("void"),
    parameters: z.array(z.object({
      name: csharpIdentifierSchema,
      type: csharpTypeSchema,
    })).max(20),
    access: z.enum(["public", "private", "protected", "internal"]).default("public"),
  })).max(50),
});

export const moduleCreateSchema = z.object({
  name: csharpIdentifierSchema,
  namespace: csharpNamespaceSchema,
  systems: z.array(csharpIdentifierSchema).max(20).default([]),
  components: z.array(csharpIdentifierSchema).max(50).default([]),
  features: z.array(z.string().max(100)).max(10).default([]),
});

export const systemCreateSchema = z.object({
  name: csharpIdentifierSchema,
  namespace: csharpNamespaceSchema,
  updateType: z.enum(["Update", "FixedUpdate", "LateUpdate"]).default("Update"),
  components: z.array(csharpIdentifierSchema).max(20).default([]),
  dependencies: z.array(csharpIdentifierSchema).max(20).default([]),
});

// =============================================================================
// MESSAGE/CHANNEL SCHEMAS
// =============================================================================

export const telegramMessageSchema = z.object({
  userId: z.number().int().positive(),
  chatId: z.number().int(),
  messageId: z.number().int().positive(),
  text: z.string().max(4096),
  timestamp: z.number().int().positive(),
});

export const discordMessageSchema = z.object({
  userId: z.string().regex(/^\d{17,20}$/),
  guildId: z.string().regex(/^\d{17,20}$/).optional(),
  channelId: z.string().regex(/^\d{17,20}$/),
  messageId: z.string().regex(/^\d{17,20}$/),
  content: z.string().max(2000),
  timestamp: z.string().datetime(),
  roles: z.array(z.string()).default([]),
});

export const slackMessageSchema = z.object({
  userId: z.string().max(50),
  workspaceId: z.string().max(50),
  channelId: z.string().max(50),
  messageTs: z.string().max(50),
  text: z.string().max(40000),
  timestamp: z.number().int().positive(),
});

// =============================================================================
// SEARCH & QUERY SCHEMAS
// =============================================================================

export const searchQuerySchema = z.object({
  query: z.string().min(1).max(1000),
  filters: z.object({
    fileTypes: z.array(z.string().max(20)).max(10).optional(),
    path: safePathSchema.optional(),
    excludePatterns: z.array(z.string().max(100)).max(10).optional(),
  }).optional(),
  options: z.object({
    caseSensitive: z.boolean().default(false),
    wholeWord: z.boolean().default(false),
    regex: z.boolean().default(false),
    maxResults: z.number().int().min(1).max(10000).default(100),
  }).default({}),
});

export const ragQuerySchema = z.object({
  query: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(50).default(5),
  threshold: z.number().min(0).max(1).default(0.7),
  filters: z.record(z.string()).optional(),
});

// =============================================================================
// CONFIGURATION SCHEMAS
// =============================================================================

export const rateLimitConfigSchema = z.object({
  enabled: z.boolean().default(true),
  messagesPerMinute: z.number().int().min(0).default(30),
  messagesPerHour: z.number().int().min(0).default(500),
  tokensPerDay: z.number().int().min(0).default(1_000_000),
  dailyBudgetUsd: z.number().min(0).default(50),
  monthlyBudgetUsd: z.number().min(0).default(1000),
});

export const securityConfigSchema = z.object({
  requireEditConfirmation: z.boolean().default(true),
  readOnlyMode: z.boolean().default(false),
  shellEnabled: z.boolean().default(false),
  allowedCommands: z.array(z.string()).max(100).default([]),
  maxFileSize: z.number().int().min(1).default(50 * 1024 * 1024), // 50MB
  maxRequestSize: z.number().int().min(1).default(10 * 1024 * 1024), // 10MB
});

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type FileReadInput = z.infer<typeof fileReadSchema>;
export type FileWriteInput = z.infer<typeof fileWriteSchema>;
export type FileEditInput = z.infer<typeof fileEditSchema>;
export type FileDeleteInput = z.infer<typeof fileDeleteSchema>;
export type FileMoveInput = z.infer<typeof fileMoveSchema>;
export type ShellCommandInput = z.infer<typeof shellCommandSchema>;
export type ApiKeyInput = z.infer<typeof apiKeySchema>;
export type WebhookUrlInput = z.infer<typeof webhookUrlSchema>;
export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
export type RagQueryInput = z.infer<typeof ragQuerySchema>;
export type UnityComponentInput = z.infer<typeof unityComponentSchema>;
export type ModuleCreateInput = z.infer<typeof moduleCreateSchema>;
export type SystemCreateInput = z.infer<typeof systemCreateSchema>;
export type TelegramMessageInput = z.infer<typeof telegramMessageSchema>;
export type DiscordMessageInput = z.infer<typeof discordMessageSchema>;
export type SlackMessageInput = z.infer<typeof slackMessageSchema>;
export type RateLimitConfigInput = z.infer<typeof rateLimitConfigSchema>;
export type SecurityConfigInput = z.infer<typeof securityConfigSchema>;
