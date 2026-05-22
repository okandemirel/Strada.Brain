/**
 * Shared message protocol and config types for the force-simulation worker.
 *
 * Used by both `force-simulation.worker.ts` and `useForceSimulation.ts`.
 * Kept in its own module so the worker bundle does not pull in React types.
 */

export interface SimConfig {
  /** Target distance for links. */
  linkDistance: number;
  /** Charge strength (negative = repulsion). */
  chargeStrength: number;
  /** Strength of the centering force. */
  centerStrength: number;
  /** Collision radius applied per node. */
  collideRadius: number;
  /** Alpha decay rate (controls how fast the sim cools). */
  alphaDecay: number;
  /** Hard cap on the number of nodes processed by the simulation. */
  maxNodes: number;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  linkDistance: 100,
  chargeStrength: -100,
  centerStrength: 0.05,
  collideRadius: 8,
  alphaDecay: 0.0228,
  maxNodes: 5000,
};

export interface NodeIn {
  id: string;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface LinkIn {
  source: string;
  target: string;
}

/** Messages sent from the main thread to the worker. */
export type InMsg =
  | { type: 'init'; nodes: NodeIn[]; links: LinkIn[]; config: SimConfig }
  | { type: 'update-nodes'; nodes: NodeIn[]; links: LinkIn[] }
  | { type: 'config'; config: Partial<SimConfig> }
  | { type: 'reheat'; alpha?: number }
  | { type: 'stop' }
  | { type: 'fix-node'; id: string; x: number | null; y: number | null };

/** Messages sent from the worker to the main thread. */
export type OutMsg =
  | { type: 'tick'; positions: Float32Array; nodeIds: string[] }
  | { type: 'end' }
  | { type: 'error'; message: string };
