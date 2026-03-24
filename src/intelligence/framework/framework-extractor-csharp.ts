/**
 * C# Framework Extractor
 *
 * Parses C# source files to extract API snapshots.
 * Generalized from StradaCoreExtractor to work with any Strada C# package.
 */

import { readFile, realpath } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import { glob } from "glob";
import {
  parseDeep,
  getClasses,
  getStructs,
  getInterfaces,
  getEnums,
  getMethods,
  type CSharpAST,
} from "../csharp-deep-parser.js";
import { FrameworkExtractor } from "./framework-extractor.js";
import type { FrameworkAPISnapshot, FrameworkPackageConfig } from "./framework-types.js";
import { getLoggerSafe } from "../../utils/logger.js";

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

// ---- Extractor --------------------------------------------------------------

export class CSharpFrameworkExtractor extends FrameworkExtractor {
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
    const baseClassMap = new Map<string, Set<string>>();
    const attributeMap = new Map<string, string[]>();
    const ifaceList: Array<{ name: string; namespace: string; methods: string[] }> = [];
    const enumList: Array<{ name: string; namespace: string; values: string[] }> = [];
    const classList: Array<{ name: string; namespace: string; baseTypes: string[]; isAbstract: boolean }> = [];
    const structList: Array<{ name: string; namespace: string; baseTypes: string[] }> = [];

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
      packageId: this.packageConfig.packageId,
      packageName: this.packageConfig.displayName,
      version,
      gitHash,
      namespaces: [...namespaceSet].sort(),
      baseClasses,
      attributes: attributeMap,
      interfaces: ifaceList,
      enums: enumList,
      classes: classList,
      structs: structList,
      exportedFunctions: [],
      tools: [],
      resources: [],
      prompts: [],
      extractedAt: new Date(),
      sourcePath: this.sourcePath,
      sourceOrigin: "local",
      sourceLanguage: "csharp",
      fileCount: parsed,
    };
  }

  protected async detectVersion(): Promise<string | null> {
    // Unity Package Manager format: package.json with "version" field
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
