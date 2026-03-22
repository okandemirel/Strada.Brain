/**
 * AgentDB Clock Utility
 *
 * Shared time function used across agentdb helper modules.
 * Supports test-only clock override via _setNowFn / _resetNowFn.
 */

import type { TimestampMs } from "../../types/index.js";
import { createBrand } from "../../types/index.js";

/** Get current timestamp as TimestampMs */
let _nowFn: () => TimestampMs = () => createBrand(Date.now(), "TimestampMs" as const);

export function getNow(): TimestampMs {
  return _nowFn();
}

/** @internal Test-only: override the clock */
export function _setNowFn(fn: () => TimestampMs): void {
  _nowFn = fn;
}

/** @internal Test-only: reset the clock to real time */
export function _resetNowFn(): void {
  _nowFn = () => createBrand(Date.now(), "TimestampMs" as const);
}
