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
import type { ChainValidator } from "./chain-validator.js";
import { CompositeTool } from "./composite-tool.js";
import { ChainMetadataSchema, computeCompositeMetadata } from "./chain-types.js";
import type { ToolChainConfig } from "./chain-types.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type { LearningStorage } from "../storage/learning-storage.js";
import type { IEventEmitter, LearningEventMap } from "../../core/event-bus.js";
import type { ITool } from "../../agents/tools/tool.interface.js";
import { getLogger } from "../../utils/logger.js";

/** Type guard for CompositeTool duck-typing (supports both real instances and test mocks) */
function isCompositeTool(tool: ITool): tool is CompositeTool {
  return "toolSequence" in tool && "containsTool" in tool;
}

export class ChainManager {
  private detectionTimer: ReturnType<typeof setInterval> | null = null;
  private readonly activeChainNames = new Set<string>();
  /** Track candidate keys (comma-joined tool sequences) to avoid re-synthesizing */
  private readonly activeCandidateKeys = new Set<string>();

  constructor(
    private readonly detector: ChainDetector,
    private readonly synthesizer: ChainSynthesizer,
    private readonly toolRegistry: ToolRegistry,
    private readonly learningStorage: LearningStorage,
    private readonly orchestrator: { addTool(tool: ITool): void; removeTool(name: string): void },
    private readonly eventBus: IEventEmitter<LearningEventMap>,
    private readonly config: ToolChainConfig,
    private readonly chainValidator?: ChainValidator,
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

    // Start periodic detection timer (minimum 60s to prevent resource exhaustion)
    const MIN_DETECTION_INTERVAL_MS = 60_000;
    const interval = Math.max(this.config.detectionIntervalMs, MIN_DETECTION_INTERVAL_MS);
    this.detectionTimer = setInterval(
      () => { void this.runDetectionCycle(); },
      interval,
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

        const toolMeta = computeCompositeMetadata(
          chainMetadata.toolSequence.map((name) => this.toolRegistry.getMetadata(name)),
        );
        this.toolRegistry.registerOrUpdate(tool, toolMeta);
        this.orchestrator.addTool(tool);
        this.activeChainNames.add(instinct.name);
        this.activeCandidateKeys.add(instinct.triggerPattern);
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

      // Filter out candidates already synthesized (match by candidate key)
      const newCandidates = candidates.filter(
        (c) => !this.activeCandidateKeys.has(c.key),
      );

      if (newCandidates.length === 0) return;

      getLogger().info(
        `Chain detection: ${newCandidates.length} new candidate(s) found`,
      );

      const newTools = await this.synthesizer.synthesize(newCandidates);
      for (const tool of newTools) {
        this.orchestrator.addTool(tool);
        this.activeChainNames.add(tool.name);
        this.activeCandidateKeys.add(tool.toolSequence.join(","));
      }

      // Post-synthesis validation (INTEL-05)
      if (this.chainValidator && newTools.length > 0) {
        const instincts = this.learningStorage.getInstincts({ type: "tool_chain" });
        for (const tool of newTools) {
          const instinct = instincts.find(i => i.name === tool.name);
          if (instinct) {
            this.chainValidator.validatePostSynthesis(tool.name, tool.toolSequence, instinct.id);
          }
        }
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

      if (isCompositeTool(tool) && tool.containsTool(toolName)) {
        const candidateKey = tool.toolSequence.join(",");
        this.toolRegistry.unregister(chainName);
        this.orchestrator.removeTool(chainName);
        this.activeChainNames.delete(chainName);
        this.activeCandidateKeys.delete(candidateKey);

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

  /**
   * Handle chain deprecation from ChainValidator confidence cascade.
   * Unregisters the chain from ToolRegistry and Orchestrator, removes from
   * internal tracking sets, and emits chain:invalidated event.
   */
  handleChainDeprecated(chainName: string): void {
    const tool = this.toolRegistry.get(chainName);
    if (tool && isCompositeTool(tool)) {
      this.activeCandidateKeys.delete(tool.toolSequence.join(","));
    }

    this.toolRegistry.unregister(chainName);
    this.orchestrator.removeTool(chainName);
    this.activeChainNames.delete(chainName);

    this.eventBus.emit("chain:invalidated", {
      chainName,
      reason: "Bayesian confidence below deprecation threshold",
      timestamp: Date.now(),
    });

    getLogger().info(
      `Chain deprecated '${chainName}': Bayesian confidence below threshold`,
    );
  }

  /** Get count of active composite tools */
  get activeCount(): number {
    return this.activeChainNames.size;
  }
}
