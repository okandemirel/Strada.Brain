/**
 * Multi-Agent Type System
 *
 * Defines core types, interfaces, and utilities for the multi-agent subsystem.
 * All agent modules import from this file for consistent type contracts.
 *
 * Requirements: AGENT-01, AGENT-02, AGENT-07
 */

import { randomUUID } from "node:crypto";
import type { ChannelType } from "../../channels/channel-messages.interface.js";

// =============================================================================
// CORE TYPES
// =============================================================================

/** Branded string type for agent identifiers */
export type AgentId = string & { readonly __brand: "AgentId" };

/** Agent lifecycle status */
export type AgentStatus = "active" | "stopped" | "budget_exceeded" | "evicted";

// =============================================================================
// CONFIG INTERFACE
// =============================================================================

/** Multi-agent subsystem configuration */
export interface AgentConfig {
  readonly enabled: boolean;
  readonly defaultBudgetUsd: number;
  readonly maxConcurrent: number;
  readonly idleTimeoutMs: number;
  readonly maxMemoryEntries: number;
}

// =============================================================================
// AGENT INSTANCE
// =============================================================================

/** Runtime agent instance state (persisted to SQLite) */
export interface AgentInstance {
  readonly id: AgentId;
  /** Composite key: channelType:chatId */
  readonly key: string;
  readonly channelType: ChannelType;
  readonly chatId: string;
  readonly status: AgentStatus;
  readonly createdAt: number;
  readonly lastActivity: number;
  readonly budgetCapUsd: number;
  readonly memoryEntryCount: number;
}

// =============================================================================
// EVENT PAYLOAD TYPES
// =============================================================================

/** Payload for agent lifecycle events (created, stopped, evicted) */
export interface AgentLifecycleEvent {
  readonly agentId: AgentId;
  readonly key: string;
  readonly channelType: ChannelType;
  readonly chatId: string;
  readonly timestamp: number;
}

/** Payload for agent budget events (extends lifecycle with budget info) */
export interface AgentBudgetEvent extends AgentLifecycleEvent {
  readonly usedUsd: number;
  readonly capUsd: number;
  readonly pct: number;
}

// =============================================================================
// FACTORY & UTILITIES
// =============================================================================

/** Create a new branded AgentId from a random UUID */
export function createAgentId(): AgentId {
  return randomUUID() as AgentId;
}

/** Resolve the composite key for a channel+chat pair */
export function resolveAgentKey(channelType: ChannelType, chatId: string): string {
  return `${channelType}:${chatId}`;
}
