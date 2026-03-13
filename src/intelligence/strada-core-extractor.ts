/**
 * Strada.Core API Extractor
 *
 * Parses Strada.Core C# source files and extracts a structured API snapshot.
 * Reuses csharp-deep-parser.ts for parsing.
 */

import { readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { glob } from "glob";
import {
  parseDeep,
  getClasses,
  getStructs,
  getInterfaces,
  getEnums,
  getMethods,
  type CSharpAST,
} from "./csharp-deep-parser.js";
import { getLogger } from "../utils/logger.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CoreAPISnapshot {
  /** All discovered namespaces */
  namespaces: string[];
  /** Base classes with their generic variants */
  baseClasses: Map<string, string[]>;
  /** Attributes found (class name -> attribute names) */
  attributes: Map<string, string[]>;
  /** Interfaces */
  interfaces: Array<{ name: string; namespace: string; methods: string[] }>;
  /** Enums */
  enums: Array<{ name: string; namespace: string; values: string[] }>;
  /** Public classes with their base types */
  classes: Array<{ name: string; namespace: string; baseTypes: string[]; isAbstract: boolean }>;
  /** Public structs */
  structs: Array<{ name: string; namespace: string; baseTypes: string[] }>;
  /** Extracted at timestamp */
  extractedAt: Date;
  /** Source path */
  sourcePath: string;
  /** File count */
  fileCount: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Build a generic-aware display name: "Foo<T1, T2>" */
function displayName(name: string, genericParams: string[]): string {
  return genericParams.length > 0 ? `${name}<${genericParams.join(", ")}>` : name;
}

/** Resolve the namespace a type lives in from the AST. */
function resolveNamespace(ast: CSharpAST, typeName: string): string {
  for (const ns of ast.namespaces) {
    if (ns.members.some((m) => m.name === typeName)) return ns.name;
  }
  return "";
}

function getOptionalLogger() {
  try {
    return getLogger();
  } catch {
    return null;
  }
}

// ─── Extractor ─────────────────────────────────────────────────────────────

export class StradaCoreExtractor {
  private readonly corePath: string;

  constructor(corePath: string) {
    this.corePath = corePath;
  }

  /**
   * Extract a full API snapshot from Strada.Core source.
   */
  async extract(): Promise<CoreAPISnapshot> {
    const logger = getOptionalLogger();
    // Resolve to real path to prevent symlink escapes
    const resolvedPath = await realpath(resolve(this.corePath));

    const files = await glob("**/*.cs", {
      cwd: resolvedPath,
      absolute: true,
      ignore: ["**/Tests/**", "**/bin/**", "**/obj/**"],
    });

    const namespaceSet = new Set<string>();
    const baseClassMap = new Map<string, Set<string>>();
    const attributeMap = new Map<string, string[]>();
    const ifaceList: CoreAPISnapshot["interfaces"] = [];
    const enumList: CoreAPISnapshot["enums"] = [];
    const classList: CoreAPISnapshot["classes"] = [];
    const structList: CoreAPISnapshot["structs"] = [];

    let parsed = 0;

    for (const filePath of files) {
      let ast: CSharpAST;
      try {
        const content = await readFile(filePath, "utf-8");
        ast = parseDeep(content, relative(resolvedPath, filePath));
      } catch (err) {
        logger?.debug(`Skipping ${relative(resolvedPath, filePath)}: ${(err as Error).message}`);
        continue;
      }
      parsed++;

      // Collect namespaces
      for (const ns of ast.namespaces) {
        if (ns.name) namespaceSet.add(ns.name);
      }

      // Classes
      for (const cls of getClasses(ast)) {
        const ns = resolveNamespace(ast, cls.name);
        const isAbstract = cls.modifiers.includes("abstract");

        classList.push({
          name: displayName(cls.name, cls.genericParams),
          namespace: ns,
          baseTypes: cls.baseTypes,
          isAbstract,
        });

        // Track base class variants
        if (cls.baseTypes.length > 0) {
          const baseName = cls.baseTypes[0]!.replace(/<[^>]+>/g, "");
          if (!baseClassMap.has(baseName)) baseClassMap.set(baseName, new Set());
          baseClassMap.get(baseName)!.add(cls.baseTypes[0]!);
        }

        // Attributes
        if (cls.attributes.length > 0) {
          attributeMap.set(cls.name, cls.attributes.map((a) => a.name));
        }
      }

      // Structs
      for (const st of getStructs(ast)) {
        structList.push({
          name: displayName(st.name, st.genericParams),
          namespace: resolveNamespace(ast, st.name),
          baseTypes: st.baseTypes,
        });
      }

      // Interfaces
      for (const iface of getInterfaces(ast)) {
        ifaceList.push({
          name: displayName(iface.name, iface.genericParams),
          namespace: resolveNamespace(ast, iface.name),
          methods: getMethods(iface).map((m) => m.name),
        });
      }

      // Enums
      for (const en of getEnums(ast)) {
        enumList.push({
          name: en.name,
          namespace: resolveNamespace(ast, en.name),
          values: en.values,
        });
      }
    }

    // Convert base class sets to arrays
    const baseClasses = new Map<string, string[]>();
    for (const [key, variants] of baseClassMap) {
      baseClasses.set(key, [key, ...([...variants].filter((v) => v !== key))]);
    }

    return {
      namespaces: [...namespaceSet].sort(),
      baseClasses,
      attributes: attributeMap,
      interfaces: ifaceList,
      enums: enumList,
      classes: classList,
      structs: structList,
      extractedAt: new Date(),
      sourcePath: this.corePath,
      fileCount: parsed,
    };
  }
}
