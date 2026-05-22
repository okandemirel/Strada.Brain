/// <reference lib="webworker" />
/**
 * D3 force-simulation web worker.
 *
 * Runs `d3-force` off the main thread, posting batched position updates back
 * to the UI via transferable Float32Array buffers. Throttles tick emissions
 * to ~30fps to avoid swamping the main thread.
 *
 * Import in Vite (native worker support, no plugin required):
 *
 *   const worker = new Worker(
 *     new URL('./force-simulation.worker.ts', import.meta.url),
 *     { type: 'module' },
 *   );
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

import {
  DEFAULT_SIM_CONFIG,
  type InMsg,
  type LinkIn,
  type NodeIn,
  type OutMsg,
  type SimConfig,
} from './force-simulation-types';

// d3-force mutates the node objects in place, adding x/y/vx/vy/index. We keep
// our own shape so we can preserve positions across updates by id.
interface SimNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  fx?: number | null;
  fy?: number | null;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
}

/** ~30fps tick throttle. */
const TICK_INTERVAL_MS = 1000 / 30;

let simulation: Simulation<SimNode, SimLink> | null = null;
let nodes: SimNode[] = [];
let config: SimConfig = { ...DEFAULT_SIM_CONFIG };
let lastTickAt = 0;
let lastEmittedIds: string[] | null = null;

/** Type-safe `postMessage` helper. Float32Array buffer is transferred. */
function post(msg: OutMsg, transfer?: Transferable[]): void {
  const ctx = self as unknown as DedicatedWorkerGlobalScope;
  if (transfer && transfer.length > 0) {
    ctx.postMessage(msg, transfer);
  } else {
    ctx.postMessage(msg);
  }
}

function emitTick(force = false): void {
  if (!simulation || nodes.length === 0) {
    return;
  }
  const now = performance.now();
  if (!force && now - lastTickAt < TICK_INTERVAL_MS) {
    return;
  }
  lastTickAt = now;

  const len = nodes.length;
  const positions = new Float32Array(len * 2);
  const nodeIds = new Array<string>(len);
  for (let i = 0; i < len; i += 1) {
    const n = nodes[i];
    positions[i * 2] = n.x;
    positions[i * 2 + 1] = n.y;
    nodeIds[i] = n.id;
  }
  lastEmittedIds = nodeIds;
  post(
    { type: 'tick', positions, nodeIds },
    [positions.buffer],
  );
}

/**
 * Build (id-preserving) `SimNode[]` from incoming node messages, reusing
 * previous SimNode instances by id so velocity / fixed-position state survives
 * across `update-nodes` refreshes.
 *
 * Invariant for already-simulating nodes (those with a `prev` entry):
 *   - DO NOT overwrite `prev.x` / `prev.y` / `prev.vx` / `prev.vy` from the
 *     caller-supplied `n.x` / `n.y`. The worker owns position/velocity once a
 *     node is in the simulation; snapping back to stale host-provided
 *     coordinates would defeat velocity continuity and cause visible jitter.
 *   - DO apply `n.fx` / `n.fy` if the caller passed them — fixed positions are
 *     authoritative (e.g. user-drag pin). When a fixed coord is set, mirror it
 *     into `x` / `y` so the rendered position matches immediately.
 *
 * Finite-value invariant: `fx` / `fy` / `x` / `y` supplied by the host MUST be
 * finite numbers (or `null` for fx/fy to release a pin). A NaN or Infinity
 * propagates through d3-force on the next tick and freezes the simulation
 * unrecoverably — the only escape is a full worker restart. We reject any
 * non-finite caller input here:
 *   - Non-finite `n.fx` / `n.fy` → coerced to `null` (releases the pin) rather
 *     than corrupting the stored value.
 *   - Non-finite `n.x` / `n.y` for NEW nodes → replaced by a small random
 *     position around origin so d3-force still has a valid starting point.
 *
 * Incoming `n.x` / `n.y` are only used to seed brand-new nodes (no prev entry).
 */
function reconcileNodes(incomingNodes: NodeIn[]): SimNode[] {
  const prevById = new Map<string, SimNode>();
  for (const n of nodes) {
    prevById.set(n.id, n);
  }

  const capped = incomingNodes.slice(0, Math.max(0, config.maxNodes));
  return capped.map((n) => {
    // Sanitize fx/fy: null releases a pin; a finite number sets it; anything
    // else (NaN, Infinity, undefined) is treated as "not supplied" so we never
    // poison the simulation with a non-finite fixed coordinate.
    const fxProvided = n.fx !== undefined;
    const fyProvided = n.fy !== undefined;
    const fxSafe: number | null | undefined = fxProvided
      ? (n.fx === null || Number.isFinite(n.fx) ? n.fx : null)
      : undefined;
    const fySafe: number | null | undefined = fyProvided
      ? (n.fy === null || Number.isFinite(n.fy) ? n.fy : null)
      : undefined;

    const prev = prevById.get(n.id);
    if (prev) {
      // Preserve simulating x/y/vx/vy. Only fixed positions override.
      if (fxSafe !== undefined) {
        prev.fx = fxSafe;
        if (fxSafe !== null) prev.x = fxSafe;
      }
      if (fySafe !== undefined) {
        prev.fy = fySafe;
        if (fySafe !== null) prev.y = fySafe;
      }
      return prev;
    }
    // Seed brand-new nodes. Reject non-finite caller-supplied x/y and fall back
    // to a small random offset around origin so d3-force has a valid start.
    const seedX = Number.isFinite(n.x) ? (n.x as number) : (Math.random() - 0.5) * 100;
    const seedY = Number.isFinite(n.y) ? (n.y as number) : (Math.random() - 0.5) * 100;
    const node: SimNode = { id: n.id, x: seedX, y: seedY, vx: 0, vy: 0 };
    if (fxSafe !== undefined) node.fx = fxSafe;
    if (fySafe !== undefined) node.fy = fySafe;
    return node;
  });
}

function reconcileLinks(incomingLinks: LinkIn[], validIds: Set<string>): SimLink[] {
  return incomingLinks
    .filter((l) => validIds.has(l.source) && validIds.has(l.target))
    .map((l) => ({ source: l.source, target: l.target }));
}

function createForces(): void {
  if (!simulation) return;
  simulation
    .force(
      'link',
      forceLink<SimNode, SimLink>([])
        .id((d) => d.id)
        .distance(config.linkDistance),
    )
    .force('charge', forceManyBody<SimNode>().strength(config.chargeStrength))
    .force('center', forceCenter<SimNode>(0, 0).strength(config.centerStrength))
    .force('collide', forceCollide<SimNode>(config.collideRadius));
}

/**
 * Create the simulation instance exactly once (on `init`).
 *
 * Subsequent `update-nodes` messages reuse this simulation by swapping the
 * node array and link force in place. This preserves velocity continuity and
 * avoids the "everything jumps" effect that a fresh `forceSimulation()` would
 * cause on every filter change.
 */
function createSimulation(initialNodes: SimNode[]): void {
  simulation = forceSimulation<SimNode, SimLink>(initialNodes)
    .alphaDecay(config.alphaDecay)
    .on('tick', () => emitTick())
    .on('end', () => {
      emitTick(true);
      post({ type: 'end' });
    });
  createForces();
}

/**
 * Reconfigure an existing simulation with a new node/link set without
 * recreating it. Reheats to alpha=0.3 so the new arrangement settles, but
 * keeps velocities for surviving nodes intact.
 */
function updateSimulationGraph(incomingNodes: NodeIn[], incomingLinks: LinkIn[]): void {
  nodes = reconcileNodes(incomingNodes);
  const validIds = new Set(nodes.map((n) => n.id));
  const links = reconcileLinks(incomingLinks, validIds);

  if (!simulation) {
    createSimulation(nodes);
  } else {
    simulation.nodes(nodes);
  }

  if (simulation) {
    const linkForce = simulation.force('link');
    if (linkForce && 'links' in linkForce) {
      (linkForce as ReturnType<typeof forceLink<SimNode, SimLink>>).links(links);
    }
    simulation.alpha(Math.max(simulation.alpha(), 0.3)).restart();
  }
}

function applyConfig(partial: Partial<SimConfig>): void {
  config = { ...config, ...partial };
  if (!simulation) return;

  const linkForce = simulation.force('link');
  if (linkForce && 'distance' in linkForce) {
    (linkForce as ReturnType<typeof forceLink<SimNode, SimLink>>).distance(config.linkDistance);
  }
  const chargeForce = simulation.force('charge');
  if (chargeForce && 'strength' in chargeForce) {
    (chargeForce as ReturnType<typeof forceManyBody<SimNode>>).strength(config.chargeStrength);
  }
  const centerForce = simulation.force('center');
  if (centerForce && 'strength' in centerForce) {
    (centerForce as ReturnType<typeof forceCenter<SimNode>>).strength(config.centerStrength);
  }
  const collideForce = simulation.force('collide');
  if (collideForce && 'radius' in collideForce) {
    (collideForce as ReturnType<typeof forceCollide<SimNode>>).radius(config.collideRadius);
  }
  simulation.alphaDecay(config.alphaDecay);
}

function handleMessage(msg: InMsg): void {
  switch (msg.type) {
    case 'init': {
      config = { ...DEFAULT_SIM_CONFIG, ...msg.config };
      lastEmittedIds = null;
      // Fresh init: tear down any previous simulation so we don't leak state.
      if (simulation) {
        simulation.stop();
        simulation = null;
      }
      nodes = [];
      updateSimulationGraph(msg.nodes, msg.links);
      break;
    }
    case 'update-nodes': {
      // Reuses the existing simulation: swaps the node array and link list in
      // place so velocity / fixed positions survive. `updateSimulationGraph`
      // reheats to alpha=0.3.
      updateSimulationGraph(msg.nodes, msg.links);
      break;
    }
    case 'config': {
      applyConfig(msg.config);
      break;
    }
    case 'reheat': {
      if (simulation) {
        simulation.alpha(msg.alpha ?? 1).restart();
      }
      break;
    }
    case 'stop': {
      if (simulation) {
        simulation.stop();
        simulation = null;
      }
      nodes = [];
      lastEmittedIds = null;
      break;
    }
    case 'fix-node': {
      const target = nodes.find((n) => n.id === msg.id);
      if (!target) return;
      target.fx = msg.x;
      target.fy = msg.y;
      if (msg.x !== null) target.x = msg.x;
      if (msg.y !== null) target.y = msg.y;
      if (simulation) {
        simulation.alpha(Math.max(simulation.alpha(), 0.2)).restart();
      }
      break;
    }
    default: {
      const never: never = msg;
      post({ type: 'error', message: `Unknown message: ${JSON.stringify(never)}` });
    }
  }
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener('message', (event: MessageEvent<InMsg>) => {
  try {
    handleMessage(event.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', message });
  }
});

// Silence unused-variable warnings for state that exists only to support
// transferable buffers / future diagnostics.
void lastEmittedIds;
