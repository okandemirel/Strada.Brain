/**
 * Agent Core v2 — ModelGateway public surface (ARCHITECTURE §5.2).
 *
 * The single LLM entry point that wraps the frozen `silentStream` (imports + delegates; does
 * not reimplement). Purely additive — nothing in v1 imports this yet (Phase 2 foundation).
 */

export { ModelGateway } from "./model-gateway.js";
export type {
  ModelCallRequest,
  ModelCallResult,
  ModelGatewayOptions,
  SilentStreamPort,
  ChunkObserver,
  VisibleAnswerCapture,
  SessionLike,
  GatewayToolDefinition,
} from "./model-gateway.js";
