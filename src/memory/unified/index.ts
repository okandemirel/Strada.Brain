/**
 * Unified Memory Module Exports
 * 
 * AgentDB + HNSW Vector Search Integration for Strata.Brain
 */

// Core interfaces
export type {
  IUnifiedMemory,
  UnifiedMemoryEntry,
  UnifiedMemoryQuery,
  UnifiedMemoryStats,
  MigrationStatus,
  UnifiedMemoryConfig,
} from "./unified-memory.interface.js";

export {
  MemoryTier,
  DEFAULT_MEMORY_CONFIG,
} from "./unified-memory.interface.js";

// AgentDB implementation
export {
  AgentDBMemory,
  createAgentDBMemory,
} from "./agentdb-memory.js";

// AgentDB adapter (IUnifiedMemory -> IMemoryManager bridge)
export { AgentDBAdapter } from "./agentdb-adapter.js";

// Migration utilities
export {
  MemoryMigrator,
  BackwardCompatibleMemory,
  runAutomaticMigration,
} from "./migration.js";
