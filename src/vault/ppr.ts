import type { VaultEdge } from './vault.interface.js';

export interface PprOptions {
  damping: number;      // teleport probability (classic PageRank d); common value: 0.15
  iterations: number;
  epsilon: number;
}

const DEFAULTS: PprOptions = { damping: 0.15, iterations: 10, epsilon: 1e-6 };

/**
 * Personalized PageRank on a directed edge list.
 * Returns a Map of symbolId → stationary probability, personalized by `seeds`.
 * Dangling mass teleports to the seed vector (classic PPR formulation).
 */
export function runPpr(
  edges: VaultEdge[],
  seeds: string[],
  opts?: Partial<PprOptions>,
): Map<string, number> {
  const o = { ...DEFAULTS, ...(opts ?? {}) };
  const nodes = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    nodes.add(e.fromSymbol);
    nodes.add(e.toSymbol);
    const list = outgoing.get(e.fromSymbol) ?? [];
    list.push(e.toSymbol);
    outgoing.set(e.fromSymbol, list);
  }
  const valid = seeds.filter((s) => nodes.has(s));
  if (valid.length === 0) return new Map();

  const teleport = new Map<string, number>();
  for (const s of valid) teleport.set(s, 1 / valid.length);

  let rank = new Map<string, number>();
  for (const v of nodes) rank.set(v, teleport.get(v) ?? 0);

  for (let iter = 0; iter < o.iterations; iter++) {
    const walk = new Map<string, number>();
    for (const v of nodes) walk.set(v, 0);
    let dangling = 0;
    for (const v of nodes) {
      const r = rank.get(v)!;
      const outs = outgoing.get(v);
      if (!outs || outs.length === 0) {
        dangling += r;
        continue;
      }
      const share = r / outs.length;
      for (const u of outs) walk.set(u, (walk.get(u) ?? 0) + share);
    }
    // Standard PPR update (phase2-review I5 — rewritten for clarity, unchanged behaviour):
    //   r'(v) = d · s(v) + (1 − d) · (Σ_u r(u)/out(u) + dangling · s(v))
    // where s(v) is the seed (teleport) weight, d is the teleport probability, and the
    // dangling mass redistributes entirely to the seed vector.
    const next = new Map<string, number>();
    let diff = 0;
    for (const v of nodes) {
      const seedWeight = teleport.get(v) ?? 0;
      const walkMass = walk.get(v) ?? 0;
      const nv = o.damping * seedWeight
               + (1 - o.damping) * (walkMass + dangling * seedWeight);
      diff += Math.abs(nv - rank.get(v)!);
      next.set(v, nv);
    }
    rank = next;
    if (diff < o.epsilon) break;
  }
  return rank;
}
