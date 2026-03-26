import { readFile } from "node:fs/promises";
import { relative, basename } from "node:path";
import { glob } from "glob";
import {
  parseDeep,
  getClasses,
  getStructs,
  getDependencies,
  getInjectedDependencies,
  deepInheritsFrom,
  deepImplements,
  stripGenericArgs,
  type CSharpAST,
  type TypeDecl,
  type ClassDecl,
  type StructDecl,
} from "./csharp-deep-parser.js";
import { STRADA_API } from "../agents/context/strada-api-reference.js";
import { getFrameworkSchemaProvider } from "./framework/framework-schema-provider.js";
import { getLogger } from "../utils/logger.js";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB per file

/** Known base class names that start with 'I' but are NOT interfaces */
function getKnownBaseClasses(): Set<string> {
  const provider = getFrameworkSchemaProvider();
  return new Set([
    ...(provider?.getSystemBaseClasses() ?? STRADA_API.baseClasses.systems),
    "EntityMediator",
    "Controller",
    "ModuleConfig",
  ]);
}

/** Pre-computed cache per parsed file to avoid re-traversing AST */
interface ParsedFileCache {
  ast: CSharpAST;
  classes: ClassDecl[];
  structs: StructDecl[];
  nsLookup: Map<TypeDecl, string>;
}

export interface ModuleInfo {
  name: string;
  className: string;
  filePath: string;
  namespace: string;
  systems: string[];
  services: string[];
  dependencies: string[];
  lineNumber: number;
}

export interface SystemInfo {
  name: string;
  filePath: string;
  namespace: string;
  baseClass: string;
  lineNumber: number;
}

export interface ComponentInfo {
  name: string;
  filePath: string;
  namespace: string;
  isReadonly: boolean;
  lineNumber: number;
}

export interface ServiceInfo {
  interfaceName: string;
  implementationName: string;
  interfaceFile: string;
  implementationFile: string;
  namespace: string;
}

export interface MediatorInfo {
  name: string;
  viewType: string;
  filePath: string;
  namespace: string;
  lineNumber: number;
}

export interface ControllerInfo {
  name: string;
  modelType: string;
  filePath: string;
  namespace: string;
  lineNumber: number;
}

export interface EventUsage {
  eventType: string;
  action: "publish" | "subscribe";
  filePath: string;
  lineNumber: number;
  className: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: "inherits" | "implements" | "injects" | "uses_event";
}

export interface AsmdefInfo {
  name: string;
  filePath: string;
  rootNamespace: string;
  references: string[];
}

export interface PrefabInfo {
  name: string;
  filePath: string;
  scriptGuids: string[]; // GUIDs of referenced scripts
}

export interface SceneInfo {
  name: string;
  filePath: string;
  rootObjectCount: number;
}

export interface StradaProjectAnalysis {
  modules: ModuleInfo[];
  systems: SystemInfo[];
  components: ComponentInfo[];
  services: ServiceInfo[];
  mediators: MediatorInfo[];
  controllers: ControllerInfo[];
  events: EventUsage[];
  dependencies: DependencyEdge[];
  asmdefs: AsmdefInfo[];
  prefabs: PrefabInfo[];
  scenes: SceneInfo[];
  csFileCount: number;
  analyzedAt: Date;
}

/**
 * Analyzes a Unity project using Strada.Core framework.
 * Scans C# files and extracts framework-specific information.
 */
export class StradaAnalyzer {
  private readonly projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * Build a namespace lookup map for O(1) type-to-namespace resolution.
   */
  private static buildNamespaceLookup(ast: CSharpAST): Map<TypeDecl, string> {
    const lookup = new Map<TypeDecl, string>();
    for (const ns of ast.namespaces) {
      for (const m of ns.members) {
        lookup.set(m, ns.name);
        if ((m.kind === "class" || m.kind === "struct") && m.nestedTypes) {
          for (const n of m.nestedTypes) {
            lookup.set(n, ns.name);
          }
        }
      }
    }
    return lookup;
  }

  /**
   * Run a full project analysis.
   */
  async analyze(): Promise<StradaProjectAnalysis> {
    const logger = getLogger();
    logger.info("Starting Strada project analysis", {
      projectPath: this.projectPath,
    });

    const csFiles = await this.findCSharpFiles();
    logger.info(`Found ${csFiles.length} C# files`);

    // Pre-compute classes, structs, and namespace lookups once per file
    const cached: ParsedFileCache[] = [];
    const events: EventUsage[] = [];
    for (const filePath of csFiles) {
      try {
        const content = await readFile(filePath, "utf-8");
        if (content.length > MAX_FILE_SIZE) continue;

        const relPath = relative(this.projectPath, filePath);
        const ast = parseDeep(content, relPath);
        const classes = getClasses(ast);
        const structs = getStructs(ast);
        const nsLookup = StradaAnalyzer.buildNamespaceLookup(ast);

        cached.push({ ast, classes, structs, nsLookup });

        // Scan for event usage (regex on raw content -- method bodies not in AST)
        const className = classes[0]?.name ?? "unknown";
        this.scanEventUsageFromContent(content, relPath, className, events);
      } catch {
        logger.debug(`Failed to parse: ${filePath}`);
      }
    }

    const modules = this.findModules(cached);
    const systems = this.findSystems(cached);
    const components = this.findComponents(cached);
    const services = this.findServices(cached);
    const mediators = this.findMediators(cached);
    const controllers = this.findControllers(cached);
    const dependencies = this.buildDependencyGraph(cached, events);

    const [asmdefs, prefabs, scenes] = await Promise.all([
      this.findAsmdefFiles(),
      this.findPrefabFiles(),
      this.findSceneFiles(),
    ]);

    const result: StradaProjectAnalysis = {
      modules,
      systems,
      components,
      services,
      mediators,
      controllers,
      events,
      dependencies,
      asmdefs,
      prefabs,
      scenes,
      csFileCount: csFiles.length,
      analyzedAt: new Date(),
    };

    logger.info("Analysis complete", {
      modules: modules.length,
      systems: systems.length,
      components: components.length,
      services: services.length,
      mediators: mediators.length,
      controllers: controllers.length,
      asmdefs: asmdefs.length,
      prefabs: prefabs.length,
      scenes: scenes.length,
    });

    return result;
  }

  private findModules(cached: ParsedFileCache[]): ModuleInfo[] {
    const modules: ModuleInfo[] = [];
    for (const { ast, classes, nsLookup } of cached) {
      for (const cls of classes) {
        if (deepInheritsFrom(cls, "ModuleConfig")) {
          modules.push({
            name: cls.name.replace(/ModuleConfig$|Module$/, ""),
            className: cls.name,
            filePath: ast.filePath,
            namespace: nsLookup.get(cls) ?? "",
            systems: [],
            services: [],
            dependencies: [],
            lineNumber: cls.line,
          });
        }
      }
    }
    return modules;
  }

  private findSystems(cached: ParsedFileCache[]): SystemInfo[] {
    const systems: SystemInfo[] = [];
    const provider = getFrameworkSchemaProvider();
    const systemBases = [
      ...(provider?.getSystemBaseClasses() ?? STRADA_API.baseClasses.systems),
      ...new Set((provider?.getBurstSystemVariants() ?? STRADA_API.baseClasses.burstSystemVariants).map((base) => stripGenericArgs(base))),
    ];
    for (const { ast, classes, nsLookup } of cached) {
      for (const cls of classes) {
        if (!cls.modifiers.includes("abstract")) {
          for (const base of systemBases) {
            if (deepInheritsFrom(cls, base)) {
              const baseType = cls.baseTypes.find((bt) =>
                systemBases.includes(stripGenericArgs(bt))
              ) ?? base;
              systems.push({
                name: cls.name,
                filePath: ast.filePath,
                namespace: nsLookup.get(cls) ?? "",
                baseClass: baseType,
                lineNumber: cls.line,
              });
              break;
            }
          }
        }
      }
    }
    return systems;
  }

  private findComponents(cached: ParsedFileCache[]): ComponentInfo[] {
    const components: ComponentInfo[] = [];
    for (const { ast, structs, nsLookup } of cached) {
      for (const struct of structs) {
        if (deepImplements(struct, "IComponent")) {
          components.push({
            name: struct.name,
            filePath: ast.filePath,
            namespace: nsLookup.get(struct) ?? "",
            isReadonly: struct.modifiers.includes("readonly"),
            lineNumber: struct.line,
          });
        }
      }
    }
    return components;
  }

  private findServices(cached: ParsedFileCache[]): ServiceInfo[] {
    const services: ServiceInfo[] = [];
    const knownBases = getKnownBaseClasses();
    for (const { ast, classes, nsLookup } of cached) {
      for (const cls of classes) {
        for (const bt of cls.baseTypes) {
          const clean = stripGenericArgs(bt);
          // Only treat as service interface if it starts with I + uppercase
          // AND is not a known base class (e.g. ImmutableDataStore, IndexedNode)
          if (
            clean.startsWith("I") &&
            clean.length > 1 &&
            clean[1] === clean[1]!.toUpperCase() &&
            !knownBases.has(clean)
          ) {
            services.push({
              interfaceName: clean,
              implementationName: cls.name,
              interfaceFile: "",
              implementationFile: ast.filePath,
              namespace: nsLookup.get(cls) ?? "",
            });
          }
        }
      }
    }
    return services;
  }

  private findMediators(cached: ParsedFileCache[]): MediatorInfo[] {
    const mediators: MediatorInfo[] = [];
    for (const { ast, classes, nsLookup } of cached) {
      for (const cls of classes) {
        if (deepInheritsFrom(cls, "EntityMediator")) {
          const genericMatch = cls.baseTypes
            .find((bt) => stripGenericArgs(bt) === "EntityMediator")
            ?.match(/EntityMediator<(\w+)>/);
          const viewType = genericMatch ? genericMatch[1]! : "unknown";
          mediators.push({
            name: cls.name,
            viewType,
            filePath: ast.filePath,
            namespace: nsLookup.get(cls) ?? "",
            lineNumber: cls.line,
          });
        }
      }
    }
    return mediators;
  }

  private findControllers(cached: ParsedFileCache[]): ControllerInfo[] {
    const controllers: ControllerInfo[] = [];
    for (const { ast, classes, nsLookup } of cached) {
      for (const cls of classes) {
        if (deepInheritsFrom(cls, "Controller")) {
          const genericMatch = cls.baseTypes
            .find((bt) => stripGenericArgs(bt) === "Controller")
            ?.match(/Controller<(\w+)>/);
          const modelType = genericMatch ? genericMatch[1]! : "unknown";
          controllers.push({
            name: cls.name,
            modelType,
            filePath: ast.filePath,
            namespace: nsLookup.get(cls) ?? "",
            lineNumber: cls.line,
          });
        }
      }
    }
    return controllers;
  }

  private scanEventUsageFromContent(
    content: string,
    filePath: string,
    className: string,
    events: EventUsage[]
  ): void {
    const eventPattern = /\.(Publish|Subscribe|Send)<(\w+)>/g;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      eventPattern.lastIndex = 0;
      let match;
      while ((match = eventPattern.exec(line)) !== null) {
        const action: "publish" | "subscribe" = match[1] === "Subscribe" ? "subscribe" : "publish";
        events.push({ eventType: match[2]!, action, filePath, lineNumber: i + 1, className });
      }
    }
  }

  /**
   * Build a dependency graph from parsed files and event usage.
   * Captures inheritance, interface implementation, DI injection, and event coupling.
   */
  private buildDependencyGraph(
    cached: ParsedFileCache[],
    events: EventUsage[]
  ): DependencyEdge[] {
    const edges: DependencyEdge[] = [];
    const seen = new Set<string>();
    const addEdge = (from: string, to: string, type: DependencyEdge["type"]) => {
      const key = `${from}\u2192${to}:${type}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from, to, type });
    };

    for (const { classes, structs } of cached) {
      for (const cls of classes) {
        // Inheritance edges
        for (const bt of cls.baseTypes) {
          const clean = stripGenericArgs(bt);
          // Check if it's likely a base class vs interface
          if (!clean.startsWith("I") || clean.length <= 1 || clean[1] !== clean[1]!.toUpperCase()) {
            addEdge(cls.name, clean, "inherits");
          } else {
            addEdge(cls.name, clean, "implements");
          }
        }

        // Constructor DI dependencies
        for (const dep of getDependencies(cls)) {
          addEdge(cls.name, stripGenericArgs(dep), "injects");
        }

        // [Inject] field injection dependencies
        for (const dep of getInjectedDependencies(cls)) {
          addEdge(cls.name, dep, "injects");
        }
      }

      for (const struct of structs) {
        for (const bt of struct.baseTypes) {
          addEdge(struct.name, stripGenericArgs(bt), "implements");
        }
      }
    }

    // Event coupling
    const publishers = new Map<string, string[]>();
    const subscribers = new Map<string, string[]>();
    for (const ev of events) {
      if (ev.action === "publish") {
        const list = publishers.get(ev.eventType) ?? [];
        list.push(ev.className);
        publishers.set(ev.eventType, list);
      } else {
        const list = subscribers.get(ev.eventType) ?? [];
        list.push(ev.className);
        subscribers.set(ev.eventType, list);
      }
    }
    for (const [eventType, pubs] of publishers) {
      const subs = subscribers.get(eventType) ?? [];
      for (const pub of pubs) {
        for (const sub of subs) {
          if (pub !== sub) {
            addEdge(pub, sub, "uses_event");
          }
        }
      }
    }

    return edges;
  }

  private async findAsmdefFiles(): Promise<AsmdefInfo[]> {
    const logger = getLogger();
    const files = await glob("**/*.asmdef", {
      cwd: this.projectPath,
      absolute: true,
      ignore: ["**/node_modules/**", "**/Library/**", "**/Temp/**"],
    });
    const asmdefs: AsmdefInfo[] = [];
    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf-8");
        const json = JSON.parse(content) as Record<string, unknown>;
        asmdefs.push({
          name: (json.name as string) ?? "",
          filePath: relative(this.projectPath, filePath),
          rootNamespace: (json.rootNamespace as string) ?? "",
          references: Array.isArray(json.references)
            ? (json.references as string[])
            : [],
        });
      } catch {
        logger.debug(`Failed to parse asmdef: ${filePath}`);
      }
    }
    return asmdefs;
  }

  private async findPrefabFiles(): Promise<PrefabInfo[]> {
    const logger = getLogger();
    const files = await glob("**/*.prefab", {
      cwd: this.projectPath,
      absolute: true,
      ignore: ["**/node_modules/**", "**/Library/**", "**/Temp/**"],
    });
    const prefabs: PrefabInfo[] = [];
    const scriptGuidPattern = /m_Script:\s*\{fileID:\s*\d+,\s*guid:\s*([0-9a-f]{32})/g;
    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf-8");
        const guids: string[] = [];
        const seen = new Set<string>();
        let match;
        scriptGuidPattern.lastIndex = 0;
        while ((match = scriptGuidPattern.exec(content)) !== null) {
          const guid = match[1]!;
          if (!seen.has(guid)) {
            seen.add(guid);
            guids.push(guid);
          }
        }
        const name = basename(filePath, ".prefab");
        prefabs.push({
          name,
          filePath: relative(this.projectPath, filePath),
          scriptGuids: guids,
        });
      } catch {
        logger.debug(`Failed to parse prefab: ${filePath}`);
      }
    }
    return prefabs;
  }

  private async findSceneFiles(): Promise<SceneInfo[]> {
    const logger = getLogger();
    const files = await glob("**/*.unity", {
      cwd: this.projectPath,
      absolute: true,
      ignore: ["**/node_modules/**", "**/Library/**", "**/Temp/**"],
    });
    const scenes: SceneInfo[] = [];
    const rootObjectPattern = /^--- !u!1 &/gm;
    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf-8");
        const matches = content.match(rootObjectPattern);
        const rootObjectCount = matches ? matches.length : 0;
        const name = basename(filePath, ".unity");
        scenes.push({
          name,
          filePath: relative(this.projectPath, filePath),
          rootObjectCount,
        });
      } catch {
        logger.debug(`Failed to parse scene: ${filePath}`);
      }
    }
    return scenes;
  }

  private async findCSharpFiles(): Promise<string[]> {
    return glob("**/*.cs", {
      cwd: this.projectPath,
      absolute: true,
      ignore: ["**/node_modules/**", "**/Library/**", "**/Temp/**"],
    });
  }

  /**
   * Format the analysis result as a readable string for messaging.
   */
  static formatAnalysis(analysis: StradaProjectAnalysis): string {
    const lines: string[] = [];

    lines.push("Strada Project Analysis");
    lines.push("\u2501".repeat(40));

    // Modules
    if (analysis.modules.length > 0) {
      lines.push(`\nModules (${analysis.modules.length}):`);
      for (const mod of analysis.modules) {
        lines.push(`  ${mod.name} (${mod.className})`);
        lines.push(`    File: ${mod.filePath}:${mod.lineNumber}`);
      }
    }

    // Systems
    if (analysis.systems.length > 0) {
      lines.push(`\nECS Systems (${analysis.systems.length}):`);
      for (const sys of analysis.systems) {
        lines.push(
          `  ${sys.name} extends ${sys.baseClass}`
        );
        lines.push(`    File: ${sys.filePath}:${sys.lineNumber}`);
      }
    }

    // Components
    if (analysis.components.length > 0) {
      lines.push(`\nECS Components (${analysis.components.length}):`);
      for (const comp of analysis.components) {
        const readonlyStr = comp.isReadonly ? " (readonly)" : "";
        lines.push(`  ${comp.name}${readonlyStr}`);
        lines.push(`    File: ${comp.filePath}:${comp.lineNumber}`);
      }
    }

    // Services
    if (analysis.services.length > 0) {
      lines.push(`\nDI Services (${analysis.services.length}):`);
      for (const svc of analysis.services) {
        lines.push(`  ${svc.interfaceName} -> ${svc.implementationName}`);
      }
    }

    // Mediators
    if (analysis.mediators.length > 0) {
      lines.push(`\nEntity Mediators (${analysis.mediators.length}):`);
      for (const med of analysis.mediators) {
        lines.push(`  ${med.name}<${med.viewType}>`);
        lines.push(`    File: ${med.filePath}:${med.lineNumber}`);
      }
    }

    // Controllers
    if (analysis.controllers.length > 0) {
      lines.push(`\nControllers (${analysis.controllers.length}):`);
      for (const ctrl of analysis.controllers) {
        lines.push(`  ${ctrl.name}<${ctrl.modelType}>`);
      }
    }

    // Assembly Definitions
    if (analysis.asmdefs.length > 0) {
      lines.push(`\nAssembly Definitions (${analysis.asmdefs.length}):`);
      for (const asmdef of analysis.asmdefs) {
        lines.push(`  ${asmdef.name}`);
        lines.push(`    File: ${asmdef.filePath}`);
        if (asmdef.rootNamespace) {
          lines.push(`    Namespace: ${asmdef.rootNamespace}`);
        }
        if (asmdef.references.length > 0) {
          lines.push(`    References: ${asmdef.references.join(", ")}`);
        }
      }
    }

    // Prefabs
    if (analysis.prefabs.length > 0) {
      lines.push(`\nPrefabs (${analysis.prefabs.length}):`);
      for (const prefab of analysis.prefabs) {
        const scriptCount = prefab.scriptGuids.length;
        const scriptStr = scriptCount > 0 ? ` (${scriptCount} scripts)` : "";
        lines.push(`  ${prefab.name}${scriptStr}`);
        lines.push(`    File: ${prefab.filePath}`);
      }
    }

    // Scenes
    if (analysis.scenes.length > 0) {
      lines.push(`\nScenes (${analysis.scenes.length}):`);
      for (const scene of analysis.scenes) {
        lines.push(`  ${scene.name} (${scene.rootObjectCount} root objects)`);
        lines.push(`    File: ${scene.filePath}`);
      }
    }

    // Event Flow
    if (analysis.events.length > 0) {
      lines.push(`\nEventBus Usage (${analysis.events.length} calls):`);
      const byType = new Map<string, { publishers: string[]; subscribers: string[] }>();
      for (const evt of analysis.events) {
        if (!byType.has(evt.eventType)) {
          byType.set(evt.eventType, { publishers: [], subscribers: [] });
        }
        const entry = byType.get(evt.eventType)!;
        if (evt.action === "publish") {
          entry.publishers.push(evt.className);
        } else {
          entry.subscribers.push(evt.className);
        }
      }
      for (const [type, usage] of byType) {
        lines.push(`  ${type}:`);
        if (usage.publishers.length > 0)
          lines.push(`    Publishers: ${[...new Set(usage.publishers)].join(", ")}`);
        if (usage.subscribers.length > 0)
          lines.push(`    Subscribers: ${[...new Set(usage.subscribers)].join(", ")}`);
      }
    }

    // Dependency Graph
    if (analysis.dependencies && analysis.dependencies.length > 0) {
      lines.push(`\nDependency Graph (${analysis.dependencies.length} edges):`);
      const byType = new Map<string, DependencyEdge[]>();
      for (const edge of analysis.dependencies) {
        const list = byType.get(edge.type) ?? [];
        list.push(edge);
        byType.set(edge.type, list);
      }
      for (const [type, edges] of byType) {
        lines.push(`  ${type} (${edges.length}):`);
        for (const edge of edges.slice(0, 20)) {
          lines.push(`    ${edge.from} \u2192 ${edge.to}`);
        }
        if (edges.length > 20) {
          lines.push(`    ... and ${edges.length - 20} more`);
        }
      }
    }

    // Summary
    lines.push(`\n${"\u2501".repeat(40)}`);
    lines.push(`C# Files: ${analysis.csFileCount}`);
    lines.push(
      `Analyzed: ${analysis.analyzedAt.toISOString().replace("T", " ").split(".")[0]}`
    );

    return lines.join("\n");
  }
}
