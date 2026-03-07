/**
 * ChainManager -- Lifecycle orchestrator for tool chain synthesis
 *
 * Manages the full lifecycle of composite tools:
 * - Startup: loads existing chain instincts from storage, rebuilds and registers CompositeTools
 * - Detection: periodic timer fires to discover new chain candidates
 * - Synthesis: delegates to ChainSynthesizer for LLM-based chain creation
 * - Invalidation: auto-invalidates chains when component tools are removed
 * - Shutdown: clears detection timer
 */

import type { ChainDetector } from "./chain-detector.js";
import type { ChainSynthesizer } from "./chain-synthesizer.js";
import { CompositeTool } from "./composite-tool.js";
import { ChainMetadataSchema } from "./chain-types.js";
import type { ToolChainConfig } from "./chain-types.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type { LearningStorage } from "../storage/learning-storage.js";
import type { IEventBus, LearningEventMap } from "../../core/event-bus.js";
import type { ITool } from "../../agents/tools/tool.interface.js";
import type { ToolCategory } from "../../core/tool-registry.js";
import { getLogger } from "../../utils/logger.js";

export class ChainManager {
  private detectionTimer: ReturnType<typeof setInterval> | null = null;
  private readonly activeChainNames = new Set<string>();

  constructor(
    private readonly detector: ChainDetector,
    private readonly synthesizer: ChainSynthesizer,
    private readonly toolRegistry: ToolRegistry,
    private readonly learningStorage: LearningStorage,
    private readonly orchestrator: { addTool(tool: ITool): void; removeTool(name: string): void },
    private readonly eventBus: IEventBus<LearningEventMap>,
    private readonly config: ToolChainConfig,
  ) {}

  /**
   * Initialize: load existing chains from storage and start periodic detection.
   * When config.enabled is false, returns immediately without loading or starting timer.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      getLogger().info("Tool chain synthesis disabled");
      return;
    }

    // Load existing tool_chain instincts from storage
    this.loadExistingChains();

    // Start periodic detection timer
    this.detectionTimer = setInterval(
      () => { void this.runDetectionCycle(); },
      this.config.detectionIntervalMs,
    );

    getLogger().info("ChainManager started", {
      loadedChains: this.activeChainNames.size,
      detectionIntervalMs: this.config.detectionIntervalMs,
    });
  }

  /** Stop detection timer */
  stop(): void {
    if (this.detectionTimer) {
      clearInterval(this.detectionTimer);
      this.detectionTimer = null;
    }
  }

  /**
   * Load active tool_chain instincts from storage, rebuild and register CompositeTools.
   * Skips chains whose component tools no longer exist in the registry.
   */
  private loadExistingChains(): void {
    const chainInstincts = this.learningStorage
      .getInstincts({ type: "tool_chain" })
      .filter((i) => i.status === "active" || i.status === "permanent");

    for (const instinct of chainInstincts) {
      try {
        const chainMetadata = ChainMetadataSchema.parse(
          JSON.parse(instinct.action),
        );

        // Validate all tools still exist before registering
        const allToolsExist = chainMetadata.toolSequence.every((t) =>
          this.toolRegistry.has(t),
        );
        if (!allToolsExist) {
          getLogger().debug(
            `Skipping chain '${instinct.name}': missing component tools`,
          );
          continue;
        }

        const tool = new CompositeTool(
          {
            name: instinct.name,
            description: instinct.triggerPattern,
            inputSchema: {},
            chainMetadata,
          },
          this.toolRegistry,
          this.eventBus,
        );

        this.toolRegistry.registerOrUpdate(tool, {
          category: "composite" as ToolCategory,
          dangerous: true,
          requiresConfirmation: false,
          readOnly: false,
        });
        this.orchestrator.addTool(tool);
        this.activeChainNames.add(instinct.name);
      } catch (error) {
        getLogger().debug(
          `Failed to load chain instinct '${instinct.name}'`,
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  /**
   * Run a detection cycle: detect candidates, filter already-active, synthesize, register.
   * Called periodically by the detection timer.
   */
  async runDetectionCycle(): Promise<void> {
    try {
      const candidates = this.detector.detect();

      // Filter out candidates whose key matches already-active chain keys
      const newCandidates = candidates.filter(
        (c) => !this.activeChainNames.has(c.key),
      );

      if (newCandidates.length === 0) return;

      getLogger().info(
        `Chain detection: ${newCandidates.length} new candidate(s) found`,
      );

      const newTools = await this.synthesizer.synthesize(newCandidates);
      for (const tool of newTools) {
        this.orchestrator.addTool(tool);
        this.activeChainNames.add(tool.name);
      }

      if (newTools.length > 0) {
        getLogger().info(
          `Chain synthesis: ${newTools.length} new composite tool(s) registered`,
        );
      }
    } catch (error) {
      getLogger().debug("Chain detection cycle error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Auto-invalidate chains when a component tool is removed.
   * Checks all active composite tools and removes any that contain the removed tool.
   */
  handleToolRemoved(toolName: string): void {
    for (const chainName of [...this.activeChainNames]) {
      const tool = this.toolRegistry.get(chainName);
      if (!tool) continue;

      // Check if this composite tool contains the removed tool (duck-type check)
      if ("containsTool" in tool && typeof (tool as CompositeTool).containsTool === "function" && (tool as CompositeTool).containsTool(toolName)) {
        this.toolRegistry.unregister(chainName);
        this.orchestrator.removeTool(chainName);
        this.activeChainNames.delete(chainName);

        this.eventBus.emit("chain:invalidated", {
          chainName,
          reason: `Component tool '${toolName}' removed`,
          timestamp: Date.now(),
        });

        getLogger().info(
          `Auto-invalidated chain '${chainName}': component '${toolName}' removed`,
        );
      }
    }
  }

  /** Get count of active composite tools */
  get activeCount(): number {
    return this.activeChainNames.size;
  }
}
