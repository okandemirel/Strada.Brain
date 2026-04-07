/**
 * Shared tool registry types.
 *
 * Extracted from tool-registry.ts to break the circular dependency
 * between tool-registry.ts and strada-mcp-tool-loader.ts.
 */

export const ToolCategories = {
  FILE: "file",
  CODE: "code",
  SEARCH: "search",
  STRADA: "strada",
  SHELL: "shell",
  GIT: "git",
  DOTNET: "dotnet",
  MEMORY: "memory",
  BROWSER: "browser",
  COMPOSITE: "composite",
  INTROSPECTION: "introspection",
  CUSTOM: "custom",
} as const;

export type ToolCategory = (typeof ToolCategories)[keyof typeof ToolCategories];

export interface ToolMetadata {
  name: string;
  description: string;
  category: ToolCategory;
  dangerous: boolean;
  requiresConfirmation: boolean;
  readOnly: boolean;
  dependencies?: string[];
  controlPlaneOnly?: boolean;
  requiresBridge?: boolean;
  installed?: boolean;
  available?: boolean;
  availabilityReason?: string;
}

export interface ToolInventoryEntry extends ToolMetadata {
  type: string;
}
