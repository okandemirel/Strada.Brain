/**
 * React hook that drives the force-simulation worker.
 *
 * - Lazily spawns the worker on the first non-empty input.
 * - Tears down on unmount.
 * - Batches position updates through requestAnimationFrame so React renders
 *   at most once per frame regardless of worker tick frequency.
 * - Returns a mutable `positions` Map plus a `version` counter consumers can
 *   subscribe to (read the Map fresh on each render).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import type { GraphLink, GraphNode } from './graph-types';
import {
  DEFAULT_SIM_CONFIG,
  type InMsg,
  type LinkIn,
  type NodeIn,
  type OutMsg,
  type SimConfig,
} from './force-simulation-types';

export interface UseForceSimulationOptions {
  nodes: GraphNode[];
  links: GraphLink[];
  config?: Partial<SimConfig>;
  enabled?: boolean;
}

export interface UseForceSimulationResult {
  /**
   * Stable lookup for the latest simulated position of a node. Reads the
   * underlying ref at call time so callers always see the most recent value
   * without re-rendering on every tick.
   */
  getPosition: (id: string) => { x: number; y: number } | undefined;
  /**
   * Ref-typed live position map for advanced consumers that need to iterate
   * (e.g. computing world bounds). Returning the ref object itself — not its
   * `.current` — keeps the hook compliant with `react-hooks/refs`.
   */
  positions: MutableRefObject<Map<string, { x: number; y: number }>>;
  /** Increments each animation frame that receives new positions. */
  version: number;
  /** True while the worker is alive and the simulation has not ended. */
  running: boolean;
  /** Kick the simulation back up to full alpha. */
  reheat: () => void;
  /** Pin/unpin a node. Pass `null` to release. */
  fixNode: (id: string, pos: { x: number; y: number } | null) => void;
  /** Stop and dispose the worker. */
  stop: () => void;
}

function linkEndpointId(end: string | GraphNode): string {
  return typeof end === 'string' ? end : end.id;
}

function toNodeIn(node: GraphNode): NodeIn {
  const out: NodeIn = { id: node.id };
  if (typeof node.x === 'number') out.x = node.x;
  if (typeof node.y === 'number') out.y = node.y;
  return out;
}

function toLinkIn(link: GraphLink): LinkIn {
  return {
    source: linkEndpointId(link.source),
    target: linkEndpointId(link.target),
  };
}

export function useForceSimulation(
  opts: UseForceSimulationOptions,
): UseForceSimulationResult {
  const { nodes, links, config, enabled = true } = opts;

  const workerRef = useRef<Worker | null>(null);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const pendingRef = useRef<{ ids: string[]; positions: Float32Array } | null>(null);
  const rafRef = useRef<number | null>(null);
  const initializedRef = useRef(false);

  const [version, setVersion] = useState(0);
  const [running, setRunning] = useState(false);

  /** Merge config defaults so the worker always receives a complete object. */
  const mergedConfig = useMemo<SimConfig>(
    () => ({ ...DEFAULT_SIM_CONFIG, ...(config ?? {}) }),
    [config],
  );

  // Stable snapshot of config for the spawn effect so it doesn't relaunch the
  // worker on every render. We push partial updates separately below.
  const configRef = useRef<SimConfig>(mergedConfig);

  /**
   * Stable signature of (nodes, links). `buildGraphData` produces a fresh
   * array reference every render, which would otherwise re-fire the driving
   * effect below and re-post the worker on each parent re-render — churning
   * the simulation for no reason. We hash the ids/endpoints into a string so
   * dep comparison is by value, not by reference. The actual nodes/links
   * arrays are still read via refs at effect time so the worker sees the
   * latest data.
   */
  const nodesRef = useRef<GraphNode[]>(nodes);
  const linksRef = useRef<GraphLink[]>(links);
  // useLayoutEffect (not assignment during render) so we stay compliant with
  // the react-hooks/refs lint rule. The ref is consumed by the worker-driving
  // effect below, which fires AFTER this layout effect on the same commit.
  useLayoutEffect(() => {
    nodesRef.current = nodes;
    linksRef.current = links;
  }, [nodes, links]);

  const payloadSignature = useMemo(() => {
    // Compact: join ids and endpoint pairs. Order-sensitive (matches array
    // iteration). For very large graphs this still runs O(n+m) per build,
    // which is the same order of magnitude as buildGraphData itself.
    let nodeSig = '';
    for (let i = 0; i < nodes.length; i += 1) {
      nodeSig += (i === 0 ? '' : ',') + nodes[i].id;
    }
    let linkSig = '';
    for (let i = 0; i < links.length; i += 1) {
      const l = links[i];
      const s = typeof l.source === 'string' ? l.source : l.source.id;
      const t = typeof l.target === 'string' ? l.target : l.target.id;
      linkSig += (i === 0 ? '' : ',') + s + '>' + t;
    }
    return nodeSig + '|' + linkSig;
  }, [nodes, links]);

  const flushPending = useCallback(() => {
    rafRef.current = null;
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    const { ids, positions } = pending;
    // Length-guard: the worker emits paired (x,y) Float32s per id. If the two
    // arrays disagree we'd index past the end of `positions`, producing NaN
    // positions and silently corrupting the canvas. Bail out with a diagnostic
    // instead — the next worker tick will resync.
    if (ids.length * 2 !== positions.length) {
      console.warn(
        '[force-simulation] tick length mismatch',
        { ids: ids.length, positions: positions.length },
      );
      return;
    }
    for (let i = 0; i < ids.length; i += 1) {
      positionsRef.current.set(ids[i], {
        x: positions[i * 2],
        y: positions[i * 2 + 1],
      });
    }
    setVersion((v) => v + 1);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null) return;
    if (typeof requestAnimationFrame === 'undefined') {
      flushPending();
      return;
    }
    rafRef.current = requestAnimationFrame(flushPending);
  }, [flushPending]);

  const postMessage = useCallback((msg: InMsg, transfer?: Transferable[]): void => {
    const worker = workerRef.current;
    if (!worker) return;
    if (transfer && transfer.length > 0) {
      worker.postMessage(msg, transfer);
    } else {
      worker.postMessage(msg);
    }
  }, []);

  const ensureWorker = useCallback((): Worker | null => {
    if (workerRef.current) return workerRef.current;
    if (typeof Worker === 'undefined') return null;

    const worker = new Worker(
      new URL('./force-simulation.worker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.addEventListener('message', (event: MessageEvent<OutMsg>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'tick': {
          pendingRef.current = { ids: msg.nodeIds, positions: msg.positions };
          scheduleFlush();
          break;
        }
        case 'end': {
          setRunning(false);
          break;
        }
        case 'error': {
          // Surface worker errors as console output without breaking the host UI.
          // Consumers can wrap the hook with an error boundary if they want UI signal.
          console.error('[force-simulation worker]', msg.message);
          setRunning(false);
          break;
        }
      }
    });

    worker.addEventListener('error', (event: ErrorEvent) => {
      console.error('[force-simulation worker:onerror]', event.message);
      setRunning(false);
    });

    workerRef.current = worker;
    return worker;
  }, [scheduleFlush]);

  const teardown = useCallback(() => {
    if (rafRef.current !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = null;
    pendingRef.current = null;
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    initializedRef.current = false;
    setRunning(false);
  }, []);

  // Drive the worker lifecycle based on inputs.
  //
  // Dep list intentionally uses `payloadSignature` (a string) rather than the
  // `nodes`/`links` array references. `buildGraphData` returns fresh arrays
  // every render, which would re-post identical worker messages every render
  // and reheat the simulation needlessly. The actual arrays are read through
  // refs at effect time so the worker always sees the latest objects.
  useEffect(() => {
    const currentNodes = nodesRef.current;
    const currentLinks = linksRef.current;
    if (!enabled || currentNodes.length === 0) {
      if (workerRef.current && initializedRef.current) {
        postMessage({ type: 'stop' });
        initializedRef.current = false;
        // Defer the state flip out of this effect body to avoid the
        // react-hooks/set-state-in-effect cascade. The worker will also emit
        // an `end` message once it settles, which is idempotent with this.
        queueMicrotask(() => setRunning(false));
      }
      return;
    }

    const worker = ensureWorker();
    if (!worker) return;

    const nodeMsgs = currentNodes.map(toNodeIn);
    const linkMsgs = currentLinks.map(toLinkIn);

    if (!initializedRef.current) {
      postMessage({
        type: 'init',
        nodes: nodeMsgs,
        links: linkMsgs,
        config: configRef.current,
      });
      initializedRef.current = true;
      // Defer state flip; see comment on the stop branch above.
      queueMicrotask(() => setRunning(true));
    } else {
      postMessage({
        type: 'update-nodes',
        nodes: nodeMsgs,
        links: linkMsgs,
      });
      queueMicrotask(() => setRunning(true));
    }
  }, [enabled, payloadSignature, ensureWorker, postMessage]);

  // Push config changes without rebuilding the simulation.
  useEffect(() => {
    configRef.current = mergedConfig;
    if (workerRef.current && initializedRef.current) {
      postMessage({ type: 'config', config: mergedConfig });
    }
  }, [mergedConfig, postMessage]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  const reheat = useCallback(() => {
    if (!workerRef.current || !initializedRef.current) return;
    postMessage({ type: 'reheat' });
    setRunning(true);
  }, [postMessage]);

  const fixNode = useCallback(
    (id: string, pos: { x: number; y: number } | null) => {
      if (!workerRef.current || !initializedRef.current) return;
      postMessage({
        type: 'fix-node',
        id,
        x: pos ? pos.x : null,
        y: pos ? pos.y : null,
      });
    },
    [postMessage],
  );

  const stop = useCallback(() => {
    teardown();
  }, [teardown]);

  const getPosition = useCallback(
    (id: string): { x: number; y: number } | undefined => positionsRef.current.get(id),
    [],
  );

  return {
    getPosition,
    positions: positionsRef,
    version,
    running,
    reheat,
    fixNode,
    stop,
  };
}
