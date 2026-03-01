import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { glob } from "glob";
import {
  parseCSharpFile,
  inheritsFrom,
  implementsInterface,
  type CSharpFileInfo,
} from "./csharp-parser.js";
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

export interface StrataProjectAnalysis {
  modules: ModuleInfo[];
  systems: SystemInfo[];
  components: ComponentInfo[];
  services: ServiceInfo[];
  mediators: MediatorInfo[];
  controllers: ControllerInfo[];
  events: EventUsage[];
  csFileCount: number;
  analyzedAt: Date;
}

/**
 * Analyzes a Unity project using Strada.Core framework.
 * Scans C# files and extracts framework-specific information.
 */
export class StrataAnalyzer {
  private readonly projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * Run a full project analysis.
   */
  async analyze(): Promise<StrataProjectAnalysis> {
    const logger = getLogger();
    logger.info("Starting Strata project analysis", {
      projectPath: this.projectPath,
    });

    // Find all C# files
    const csFiles = await this.findCSharpFiles();
    logger.info(`Found ${csFiles.length} C# files`);

    // Parse all files and scan events inline (single pass, no buffering)
    const parsed: CSharpFileInfo[] = [];
    const events: EventUsage[] = [];
    for (const filePath of csFiles) {
      try {
        const content = await readFile(filePath, "utf-8");
        if (content.length > MAX_FILE_SIZE) continue;

        const relPath = relative(this.projectPath, filePath);
        const fileInfo = parseCSharpFile(content, relPath);
        parsed.push(fileInfo);

        // Scan for event usage inline while content is in scope
        this.scanEventUsage(content, fileInfo, events);
      } catch {
        logger.debug(`Failed to parse: ${filePath}`);
      }
    }

    // Extract Strada-specific information
    const modules = this.findModules(parsed);
    const systems = this.findSystems(parsed);
    const components = this.findComponents(parsed);
    const services = this.findServices(parsed);
    const mediators = this.findMediators(parsed);
    const controllers = this.findControllers(parsed);

    const result: StrataProjectAnalysis = {
      modules,
      systems,
      components,
      services,
      mediators,
      controllers,
      events,
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

  private findModules(parsed: CSharpFileInfo[]): ModuleInfo[] {
    const modules: ModuleInfo[] = [];
    for (const file of parsed) {
      for (const cls of file.classes) {
        if (
          inheritsFrom(cls, "ModuleConfig") ||
          cls.baseClass?.includes("ModuleConfig")
        ) {
          modules.push({
            name: cls.name.replace(/ModuleConfig$|Module$/, ""),
            className: cls.name,
            filePath: file.filePath,
            namespace: cls.namespace,
            systems: [],
            services: [],
            dependencies: [],
            lineNumber: cls.lineNumber,
          });
        }
      }
    }
    return modules;
  }

  private findSystems(parsed: CSharpFileInfo[]): SystemInfo[] {
    const systems: SystemInfo[] = [];
    const systemBases = ["SystemBase", "JobSystemBase", "SystemGroup"];

    for (const file of parsed) {
      for (const cls of file.classes) {
        if (!cls.isAbstract) {
          for (const base of systemBases) {
            if (inheritsFrom(cls, base) || cls.baseClass?.includes(base)) {
              systems.push({
                name: cls.name,
                filePath: file.filePath,
                namespace: cls.namespace,
                baseClass: cls.baseClass ?? base,
                lineNumber: cls.lineNumber,
              });
              break;
            }
          }
        }
      }
    }
    return systems;
  }

  private findComponents(parsed: CSharpFileInfo[]): ComponentInfo[] {
    const components: ComponentInfo[] = [];
    for (const file of parsed) {
      for (const struct of file.structs) {
        if (implementsInterface(struct, "IComponent")) {
          components.push({
            name: struct.name,
            filePath: file.filePath,
            namespace: struct.namespace,
            isReadonly: struct.isReadonly,
            lineNumber: struct.lineNumber,
          });
        }
      }
    }
    return components;
  }

  private findServices(parsed: CSharpFileInfo[]): ServiceInfo[] {
    const services: ServiceInfo[] = [];

    // Find classes that implement I-prefixed interfaces
    for (const file of parsed) {
      for (const cls of file.classes) {
        // Look for classes that implement an I-prefixed interface
        for (const iface of cls.interfaces) {
          const cleanIface = iface.replace(/<[^>]+>/g, "");
          if (cleanIface.startsWith("I") && cleanIface.length > 1) {
            services.push({
              interfaceName: cleanIface,
              implementationName: cls.name,
              interfaceFile: "", // Would need more sophisticated search
              implementationFile: file.filePath,
              namespace: cls.namespace,
            });
          }
        }
      }
    }

    return services;
  }

  private findMediators(parsed: CSharpFileInfo[]): MediatorInfo[] {
    const mediators: MediatorInfo[] = [];
    for (const file of parsed) {
      for (const cls of file.classes) {
        if (
          cls.baseClass?.includes("EntityMediator") ||
          inheritsFrom(cls, "EntityMediator")
        ) {
          // Extract view type from generic argument
          const genericMatch = cls.baseClass?.match(/EntityMediator<(\w+)>/);
          const viewType = genericMatch ? genericMatch[1]! : "unknown";

          mediators.push({
            name: cls.name,
            viewType,
            filePath: file.filePath,
            namespace: cls.namespace,
            lineNumber: cls.lineNumber,
          });
        }
      }
    }
    return mediators;
  }

  private findControllers(parsed: CSharpFileInfo[]): ControllerInfo[] {
    const controllers: ControllerInfo[] = [];
    for (const file of parsed) {
      for (const cls of file.classes) {
        if (
          cls.baseClass?.includes("Controller") ||
          inheritsFrom(cls, "Controller")
        ) {
          const genericMatch = cls.baseClass?.match(/Controller<(\w+)>/);
          const modelType = genericMatch ? genericMatch[1]! : "unknown";

          controllers.push({
            name: cls.name,
            modelType,
            filePath: file.filePath,
            namespace: cls.namespace,
            lineNumber: cls.lineNumber,
          });
        }
      }
    }
    return controllers;
  }

  private scanEventUsage(
    content: string,
    fileInfo: CSharpFileInfo,
    events: EventUsage[]
  ): void {
    const publishRegex = /\.Publish<(\w+)>/g;
    const subscribeRegex = /\.Subscribe<(\w+)>/g;
    const sendRegex = /\.Send<(\w+)>/g;

    const lines = content.split("\n");
    const className = fileInfo.classes[0]?.name ?? "unknown";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      let match;

      publishRegex.lastIndex = 0;
      while ((match = publishRegex.exec(line)) !== null) {
        events.push({
          eventType: match[1]!,
          action: "publish",
          filePath: fileInfo.filePath,
          lineNumber: i + 1,
          className,
        });
      }

      subscribeRegex.lastIndex = 0;
      while ((match = subscribeRegex.exec(line)) !== null) {
        events.push({
          eventType: match[1]!,
          action: "subscribe",
          filePath: fileInfo.filePath,
          lineNumber: i + 1,
          className,
        });
      }

      sendRegex.lastIndex = 0;
      while ((match = sendRegex.exec(line)) !== null) {
        events.push({
          eventType: match[1]!,
          action: "publish",
          filePath: fileInfo.filePath,
          lineNumber: i + 1,
          className,
        });
      }
    }
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
  static formatAnalysis(analysis: StrataProjectAnalysis): string {
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

    // Summary
    lines.push(`\n${"━".repeat(40)}`);
    lines.push(`C# Files: ${analysis.csFileCount}`);
    lines.push(
      `Analyzed: ${analysis.analyzedAt.toISOString().replace("T", " ").split(".")[0]}`
    );

    return lines.join("\n");
  }
}
