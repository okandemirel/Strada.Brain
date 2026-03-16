import type { RoutingPreset, RoutingWeights } from "./routing-types.js";

export const ROUTING_PRESETS: Record<RoutingPreset, RoutingWeights> = {
  budget: {
    costWeight: 0.6,
    capabilityWeight: 0.2,
    speedWeight: 0.2,
    diversityWeight: 0.0,
  },
  balanced: {
    costWeight: 0.2,
    capabilityWeight: 0.4,
    speedWeight: 0.1,
    diversityWeight: 0.3,
  },
  performance: {
    costWeight: 0.0,
    capabilityWeight: 0.6,
    speedWeight: 0.2,
    diversityWeight: 0.2,
  },
};
