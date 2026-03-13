import { readFile } from "node:fs/promises";
import { relative } from "node:path";
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
} from "./csharp-deep-parser.js";
import { getLogger } from "../utils/logger.js";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB per file

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

export interface StradaProjectAnalysis {
  modules: ModuleInfo[];
  systems: SystemInfo[];
  components: ComponentInfo[];
  services: ServiceInfo[];
  mediators: MediatorInfo[];
  controllers: ControllerInfo[];
  events: EventUsage[];
  dependencies: DependencyEdge[];
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
   * Resolve namespace for a type by walking the AST's namespace declarations.
   */
  private static resolveNamespace(ast: CSharpAST, type: TypeDecl): string {
    for (const ns of ast.namespaces) {
      if (ns.members.some((m) => m === type)) return ns.name;
      // Check nested types
      for (const m of ns.members) {
        if ((m.kind === "class" || m.kind === "struct") && m.nestedTypes.some((n) => n === type)) {
          return ns.name;
        }
      }
    }
    return "";
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

    const parsed: CSharpAST[] = [];
    const events: EventUsage[] = [];
    for (const filePath of csFiles) {
      try {
        const content = await readFile(filePath, "utf-8");
        if (content.length > MAX_FILE_SIZE) continue;

        const relPath = relative(this.projectPath, filePath);
        const ast = parseDeep(content, relPath);
        parsed.push(ast);

        // Scan for event usage inline (regex on raw content — method bodies not in AST)
        const classes = getClasses(ast);
        const className = classes[0]?.name ?? "unknown";
        this.scanEventUsageFromContent(content, relPath, className, events);
      } catch {
        logger.debug(`Failed to parse: ${filePath}`);
      }
    }

    const modules = this.findModules(parsed);
    const systems = this.findSystems(parsed);
    const components = this.findComponents(parsed);
    const services = this.findServices(parsed);
    const mediators = this.findMediators(parsed);
    const controllers = this.findControllers(parsed);
    const dependencies = this.buildDependencyGraph(parsed, events);

    const result: StradaProjectAnalysis = {
      modules,
      systems,
      components,
      services,
      mediators,
      controllers,
      events,
      dependencies,
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
    });

    return result;
  }

  private findModules(parsed: CSharpAST[]): ModuleInfo[] {
    const modules: ModuleInfo[] = [];
    for (const ast of parsed) {
      for (const cls of getClasses(ast)) {
        if (deepInheritsFrom(cls, "ModuleConfig")) {
          modules.push({
            name: cls.name.replace(/ModuleConfig$|Module$/, ""),
            className: cls.name,
            filePath: ast.filePath,
            namespace: StradaAnalyzer.resolveNamespace(ast, cls),
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

  private findSystems(parsed: CSharpAST[]): SystemInfo[] {
    const systems: SystemInfo[] = [];
    const systemBases = ["SystemBase", "JobSystemBase", "BurstSystemBase"];
    for (const ast of parsed) {
      for (const cls of getClasses(ast)) {
        if (!cls.modifiers.includes("abstract")) {
          for (const base of systemBases) {
            if (deepInheritsFrom(cls, base)) {
              const baseType = cls.baseTypes.find((bt) => {
                const clean = bt.replace(/<[^>]+>/g, "");
                return systemBases.includes(clean);
              }) ?? base;
              systems.push({
                name: cls.name,
                filePath: ast.filePath,
                namespace: StradaAnalyzer.resolveNamespace(ast, cls),
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

  private findComponents(parsed: CSharpAST[]): ComponentInfo[] {
    const components: ComponentInfo[] = [];
    for (const ast of parsed) {
      for (const struct of getStructs(ast)) {
        if (deepImplements(struct, "IComponent")) {
          components.push({
            name: struct.name,
            filePath: ast.filePath,
            namespace: StradaAnalyzer.resolveNamespace(ast, struct),
            isReadonly: struct.modifiers.includes("readonly"),
            lineNumber: struct.line,
          });
        }
      }
    }
    return components;
  }

  private findServices(parsed: CSharpAST[]): ServiceInfo[] {
    const services: ServiceInfo[] = [];
    for (const ast of parsed) {
      for (const cls of getClasses(ast)) {
        for (const bt of cls.baseTypes) {
          const clean = stripGenericArgs(bt);
          if (clean.startsWith("I") && clean.length > 1 && clean[1] === clean[1]!.toUpperCase()) {
            services.push({
              interfaceName: clean,
              implementationName: cls.name,
              interfaceFile: "",
              implementationFile: ast.filePath,
              namespace: StradaAnalyzer.resolveNamespace(ast, cls),
            });
          }
        }
      }
    }
    return services;
  }

  private findMediators(parsed: CSharpAST[]): MediatorInfo[] {
    const mediators: MediatorInfo[] = [];
    for (const ast of parsed) {
      for (const cls of getClasses(ast)) {
        if (deepInheritsFrom(cls, "EntityMediator")) {
          const genericMatch = cls.baseTypes
            .find((bt) => bt.replace(/<[^>]+>/g, "") === "EntityMediator")
            ?.match(/EntityMediator<(\w+)>/);
          const viewType = genericMatch ? genericMatch[1]! : "unknown";
          mediators.push({
            name: cls.name,
            viewType,
            filePath: ast.filePath,
            namespace: StradaAnalyzer.resolveNamespace(ast, cls),
            lineNumber: cls.line,
          });
        }
      }
    }
    return mediators;
  }

  private findControllers(parsed: CSharpAST[]): ControllerInfo[] {
    const controllers: ControllerInfo[] = [];
    for (const ast of parsed) {
      for (const cls of getClasses(ast)) {
        if (deepInheritsFrom(cls, "Controller")) {
          const genericMatch = cls.baseTypes
            .find((bt) => bt.replace(/<[^>]+>/g, "") === "Controller")
            ?.match(/Controller<(\w+)>/);
          const modelType = genericMatch ? genericMatch[1]! : "unknown";
          controllers.push({
            name: cls.name,
            modelType,
            filePath: ast.filePath,
            namespace: StradaAnalyzer.resolveNamespace(ast, cls),
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
    const publishRegex = /\.Publish<(\w+)>/g;
    const subscribeRegex = /\.Subscribe<(\w+)>/g;
    const sendRegex = /\.Send<(\w+)>/g;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      let match;
      publishRegex.lastIndex = 0;
      while ((match = publishRegex.exec(line)) !== null) {
        events.push({ eventType: match[1]!, action: "publish", filePath, lineNumber: i + 1, className });
      }
      subscribeRegex.lastIndex = 0;
      while ((match = subscribeRegex.exec(line)) !== null) {
        events.push({ eventType: match[1]!, action: "subscribe", filePath, lineNumber: i + 1, className });
      }
      sendRegex.lastIndex = 0;
      while ((match = sendRegex.exec(line)) !== null) {
        events.push({ eventType: match[1]!, action: "publish", filePath, lineNumber: i + 1, className });
      }
    }
  }

  /**
   * Build a dependency graph from parsed files and event usage.
   * Captures inheritance, interface implementation, DI injection, and event coupling.
   */
  private buildDependencyGraph(
    parsed: CSharpAST[],
    events: EventUsage[]
  ): DependencyEdge[] {
    const edges: DependencyEdge[] = [];
    const seen = new Set<string>();
    const addEdge = (from: string, to: string, type: DependencyEdge["type"]) => {
      const key = `${from}→${to}:${type}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from, to, type });
    };

    for (const ast of parsed) {
      for (const cls of getClasses(ast)) {
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

      for (const struct of getStructs(ast)) {
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
    lines.push("━".repeat(40));

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
          lines.push(`    ${edge.from} → ${edge.to}`);
        }
        if (edges.length > 20) {
          lines.push(`    ... and ${edges.length - 20} more`);
        }
      }
    }

    // Summary
    lines.push(`\n${"━".repeat(40)}`);
    lines.push(`C# Files: ${analysis.csFileCount}`);
    lines.push(
      `Analyzed: ${analysis.analyzedAt.toISOString().replace("T", " ").split(".")[0]}`
    );

    return lines.join("\n");
  }
}
