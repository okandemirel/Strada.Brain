/**
 * MCP Framework Extractor
 *
 * Parses Strada.MCP TypeScript source to extract tool, resource, and prompt definitions.
 * Uses regex-based extraction since MCP follows well-structured patterns.
 */

import { readFile, realpath } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import { glob } from "glob";
import { FrameworkExtractor } from "./framework-extractor.js";
import type { FrameworkAPISnapshot, FrameworkPackageConfig } from "./framework-types.js";
import { getLoggerSafe } from "../../utils/logger.js";

// ---- Regex patterns for MCP TypeScript extraction ---------------------------

const EXPORT_CLASS_RE = /export\s+class\s+(\w+)/g;
const EXPORT_FUNCTION_RE = /export\s+(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))/g;
const EXPORT_INTERFACE_RE = /export\s+interface\s+(\w+)/g;

// Tool / resource / prompt definition patterns
const TOOL_NAME_RE = /name\s*[:=]\s*["']([^"']+)["']/;
const TOOL_DESC_RE = /description\s*[:=]\s*["']([^"']+)["']/;
const RESOURCE_URI_RE = /uri\s*[:=]\s*["']([^"']+)["']/;

// ---- Schema key extraction --------------------------------------------------

/** Extract input schema property keys from tool definitions */
function extractInputSchemaKeys(content: string): string[] {
  const propsMatch = /properties\s*:\s*\{([^}]+)\}/s.exec(content);
  if (!propsMatch) return [];

  const keys: string[] = [];
  const keyRe = /(\w+)\s*:/g;
  for (const match of propsMatch[1]!.matchAll(keyRe)) {
    keys.push(match[1]!);
  }
  return keys;
}

// ---- Extractor --------------------------------------------------------------

export class MCPFrameworkExtractor extends FrameworkExtractor {
  constructor(sourcePath: string, packageConfig: FrameworkPackageConfig) {
    super(sourcePath, packageConfig);
  }

  async extract(): Promise<FrameworkAPISnapshot> {
    const logger = getLoggerSafe();
    const resolvedPath = await realpath(resolve(this.sourcePath));
    const version = await this.detectVersion();
    const gitHash = this.detectGitHash();

    const files = await glob(this.packageConfig.fileGlob, {
      cwd: resolvedPath,
      absolute: true,
      ignore: this.packageConfig.ignoreGlobs,
    });

    const namespaceSet = new Set<string>();
    const classList: Array<{ name: string; namespace: string; baseTypes: string[]; isAbstract: boolean }> = [];
    const ifaceList: Array<{ name: string; namespace: string; methods: string[] }> = [];
    const exportedFunctions: Array<{ name: string; module: string; signature: string }> = [];
    const tools: Array<{ name: string; description: string; inputSchemaKeys: string[] }> = [];
    const resources: Array<{ name: string; uri: string; description: string }> = [];
    const prompts: Array<{ name: string; description: string }> = [];

    let parsed = 0;

    for (const filePath of files) {
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch (err) {
        logger?.debug(`Skipping ${relative(resolvedPath, filePath)}: ${(err as Error).message}`);
        continue;
      }
      parsed++;

      const relPath = relative(resolvedPath, filePath);
      const modulePath = relPath.replace(/\.ts$/, "").replace(/\\/g, "/");

      // Track module paths as "namespaces"
      const dirParts = modulePath.split("/");
      if (dirParts.length > 1) {
        namespaceSet.add(dirParts.slice(0, -1).join("/"));
      }

      // Extract exported classes
      for (const match of content.matchAll(EXPORT_CLASS_RE)) {
        classList.push({
          name: match[1]!,
          namespace: modulePath,
          baseTypes: [],
          isAbstract: false,
        });
      }

      // Extract exported interfaces
      for (const match of content.matchAll(EXPORT_INTERFACE_RE)) {
        ifaceList.push({
          name: match[1]!,
          namespace: modulePath,
          methods: [],
        });
      }

      // Extract exported functions
      for (const match of content.matchAll(EXPORT_FUNCTION_RE)) {
        exportedFunctions.push({
          name: match[1]!,
          module: modulePath,
          signature: `${match[1]}${match[2]}`,
        });
      }

      // Detect tool definitions (files in tools/ directory or with "tool" in path)
      if (relPath.includes("tools/") || relPath.includes("tool")) {
        const toolName = TOOL_NAME_RE.exec(content);
        const toolDesc = TOOL_DESC_RE.exec(content);
        if (toolName) {
          tools.push({
            name: toolName[1]!,
            description: toolDesc?.[1] ?? "",
            inputSchemaKeys: extractInputSchemaKeys(content),
          });
        }
      }

      // Detect resource definitions
      if (relPath.includes("resources/") || relPath.includes("resource")) {
        const resName = TOOL_NAME_RE.exec(content);
        const resUri = RESOURCE_URI_RE.exec(content);
        const resDesc = TOOL_DESC_RE.exec(content);
        if (resName && resUri) {
          resources.push({
            name: resName[1]!,
            uri: resUri[1]!,
            description: resDesc?.[1] ?? "",
          });
        }
      }

      // Detect prompt definitions
      if (relPath.includes("prompts/") || relPath.includes("prompt")) {
        const promptName = TOOL_NAME_RE.exec(content);
        const promptDesc = TOOL_DESC_RE.exec(content);
        if (promptName) {
          prompts.push({
            name: promptName[1]!,
            description: promptDesc?.[1] ?? "",
          });
        }
      }
    }

    return {
      packageId: this.packageConfig.packageId,
      packageName: this.packageConfig.displayName,
      version,
      gitHash,
      namespaces: [...namespaceSet].sort(),
      baseClasses: new Map(),
      attributes: new Map(),
      interfaces: ifaceList,
      enums: [],
      classes: classList,
      structs: [],
      exportedFunctions,
      tools,
      resources,
      prompts,
      extractedAt: new Date(),
      sourcePath: this.sourcePath,
      sourceOrigin: "local",
      sourceLanguage: "typescript",
      fileCount: parsed,
    };
  }

  protected async detectVersion(): Promise<string | null> {
    const packageJsonPath = join(this.sourcePath, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const content = readFileSync(packageJsonPath, "utf-8");
        const pkg = JSON.parse(content) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        /* ignore parse errors */
      }
    }
    return null;
  }
}
