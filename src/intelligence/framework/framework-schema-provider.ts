/**
 * Framework Schema Provider
 *
 * Provides live API schema data for tool input validation and code generation.
 * Replaces direct imports of STRADA_API constant in tool files.
 * Falls back to static STRADA_API when store has no data.
 */

import { STRADA_API } from "../../agents/context/strada-api-reference.js";
import type { FrameworkKnowledgeStore } from "./framework-knowledge-store.js";
import type { FrameworkAPISnapshot } from "./framework-types.js";

export class FrameworkSchemaProvider {
  private cachedCoreSnapshot: FrameworkAPISnapshot | null | undefined = undefined;

  constructor(private readonly store: FrameworkKnowledgeStore) {}

  /** Invalidate cached snapshot (call after sync) */
  invalidateCache(): void {
    this.cachedCoreSnapshot = undefined;
  }

  private getCoreSnapshot(): FrameworkAPISnapshot | null {
    if (this.cachedCoreSnapshot === undefined) {
      this.cachedCoreSnapshot = this.store.getLatestSnapshot("core");
    }
    return this.cachedCoreSnapshot;
  }

  /** Get system base class names for SystemCreateTool */
  getSystemBaseClasses(): string[] {
    const snapshot = this.getCoreSnapshot();
    if (!snapshot) return [...STRADA_API.baseClasses.systems];

    const bases = snapshot.classes
      .filter(
        (c) =>
          c.isAbstract &&
          (c.name === "SystemBase" ||
            c.name.endsWith("SystemBase") ||
            c.name.startsWith("BurstSystem")),
      )
      .map((c) => c.name);
    return bases.length > 0 ? bases : [...STRADA_API.baseClasses.systems];
  }

  /** Get BurstSystem generic variants */
  getBurstSystemVariants(): string[] {
    const snapshot = this.getCoreSnapshot();
    if (!snapshot) return [...STRADA_API.baseClasses.burstSystemVariants];

    const variants = snapshot.classes
      .filter((c) => c.name.startsWith("BurstSystem<"))
      .map((c) => c.name);
    return variants.length > 0
      ? variants
      : [...STRADA_API.baseClasses.burstSystemVariants];
  }

  /** Get pattern base classes (Controller, Service, View, Model, etc.) */
  getPatternBaseClasses(): string[] {
    const snapshot = this.getCoreSnapshot();
    if (!snapshot) return [...STRADA_API.baseClasses.patterns];

    const patternNames = new Set(
      STRADA_API.baseClasses.patterns.map((p) => p.replace(/<.*>/, "")),
    );
    const found = snapshot.classes
      .filter((c) => patternNames.has(c.name.replace(/<.*>/, "")))
      .map((c) => c.name);
    return found.length > 0 ? found : [...STRADA_API.baseClasses.patterns];
  }

  /** Get component interface name */
  getComponentInterface(): string {
    const snapshot = this.getCoreSnapshot();
    if (!snapshot) return STRADA_API.componentApi.interface;

    const iface = snapshot.interfaces.find((i) => i.name === "IComponent");
    return iface?.name ?? STRADA_API.componentApi.interface;
  }

  /** Get all namespaces */
  getNamespaces(): Record<string, string> {
    const snapshot = this.getCoreSnapshot();
    if (!snapshot)
      return { ...STRADA_API.namespaces } as Record<string, string>;

    const result: Record<string, string> = {};
    for (const ns of snapshot.namespaces) {
      const key = ns.split(".").pop()?.toLowerCase() ?? ns;
      result[key] = ns;
    }
    return result;
  }

  /** Get update phases */
  getUpdatePhases(): string[] {
    return [...STRADA_API.updatePhases];
  }

  /** Get system attributes */
  getSystemAttributes(): typeof STRADA_API.systemAttributes {
    return { ...STRADA_API.systemAttributes };
  }

  /** Get the full static STRADA_API as fallback */
  getStaticAPI(): typeof STRADA_API {
    return STRADA_API;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _provider: FrameworkSchemaProvider | null = null;

/** Get the global schema provider instance */
export function getFrameworkSchemaProvider(): FrameworkSchemaProvider | null {
  return _provider;
}

/** Initialize the global schema provider (called at boot) */
export function initializeFrameworkSchemaProvider(
  store: FrameworkKnowledgeStore,
): void {
  _provider = new FrameworkSchemaProvider(store);
}
