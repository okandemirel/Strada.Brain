import type {
  ConfigCatalogEntry,
  ConfigCatalogSummary,
  ConfigTier,
} from "../common/capability-contract.js";

interface ConfigDescriptor {
  category: string;
  tier: ConfigTier;
  description: string;
}

const EXACT_RULES: Record<string, ConfigDescriptor> = {
  unityProjectPath: {
    category: "Core",
    tier: "core",
    description: "Protected Unity project root used by the golden-path coding workflow.",
  },
  providerChain: {
    category: "Core",
    tier: "core",
    description: "Primary response-worker pool for the default Strada loop.",
  },
  openaiAuthMode: {
    category: "Core",
    tier: "core",
    description: "OpenAI authentication mode for the shared control plane.",
  },
  language: {
    category: "Core",
    tier: "core",
    description: "Primary language for setup and user-facing responses.",
  },
  streamingEnabled: {
    category: "Core",
    tier: "core",
    description: "Streaming responses on the default chat surfaces.",
  },
  shellEnabled: {
    category: "Core",
    tier: "core",
    description: "Shell execution availability for the coding loop.",
  },
  "web.port": {
    category: "Core",
    tier: "core",
    description: "Port for the protected web chat surface.",
  },
  "dashboard.enabled": {
    category: "Core",
    tier: "core",
    description: "Enable the local dashboard used by the default web surface.",
  },
  "security.readOnlyMode": {
    category: "Security",
    tier: "core",
    description: "Hard safety switch for read-only exploration mode.",
  },
  "security.requireEditConfirmation": {
    category: "Security",
    tier: "core",
    description: "Interactive write confirmation policy for the golden path.",
  },
  logLevel: {
    category: "Operations",
    tier: "advanced",
    description: "Runtime log verbosity.",
  },
  logFile: {
    category: "Operations",
    tier: "advanced",
    description: "Primary Strada log output file.",
  },
};

const PREFIX_RULES: Array<{ prefix: string; descriptor: ConfigDescriptor }> = [
  {
    prefix: "telegram.",
    descriptor: {
      category: "Channels",
      tier: "experimental",
      description: "Optional Telegram channel configuration outside the protected default surface.",
    },
  },
  {
    prefix: "discord.",
    descriptor: {
      category: "Channels",
      tier: "experimental",
      description: "Optional Discord channel configuration outside the protected default surface.",
    },
  },
  {
    prefix: "slack.",
    descriptor: {
      category: "Channels",
      tier: "experimental",
      description: "Optional Slack channel configuration outside the protected default surface.",
    },
  },
  {
    prefix: "whatsapp.",
    descriptor: {
      category: "Channels",
      tier: "experimental",
      description: "Optional WhatsApp channel configuration outside the protected default surface.",
    },
  },
  {
    prefix: "matrix.",
    descriptor: {
      category: "Channels",
      tier: "experimental",
      description: "Optional Matrix channel configuration outside the protected default surface.",
    },
  },
  {
    prefix: "irc.",
    descriptor: {
      category: "Channels",
      tier: "experimental",
      description: "Optional IRC channel configuration outside the protected default surface.",
    },
  },
  {
    prefix: "teams.",
    descriptor: {
      category: "Channels",
      tier: "experimental",
      description: "Optional Teams channel configuration outside the protected default surface.",
    },
  },
  {
    prefix: "dashboard.",
    descriptor: {
      category: "Operations",
      tier: "advanced",
      description: "Dashboard configuration beyond the minimal web golden path.",
    },
  },
  {
    prefix: "websocketDashboard.",
    descriptor: {
      category: "Operations",
      tier: "advanced",
      description: "Live dashboard socket configuration.",
    },
  },
  {
    prefix: "prometheus.",
    descriptor: {
      category: "Operations",
      tier: "advanced",
      description: "Optional Prometheus exposure.",
    },
  },
  {
    prefix: "memory.",
    descriptor: {
      category: "Knowledge",
      tier: "advanced",
      description: "Memory backend, storage, and consolidation settings.",
    },
  },
  {
    prefix: "rag.",
    descriptor: {
      category: "Knowledge",
      tier: "advanced",
      description: "Semantic retrieval and embedding configuration.",
    },
  },
  {
    prefix: "bayesian.",
    descriptor: {
      category: "Learning",
      tier: "advanced",
      description: "Confidence and learning heuristics.",
    },
  },
  {
    prefix: "crossSession.",
    descriptor: {
      category: "Learning",
      tier: "advanced",
      description: "Cross-session memory and reuse behavior.",
    },
  },
  {
    prefix: "reRetrieval.",
    descriptor: {
      category: "Learning",
      tier: "advanced",
      description: "Adaptive memory re-retrieval tuning.",
    },
  },
  {
    prefix: "toolChain.",
    descriptor: {
      category: "Learning",
      tier: "advanced",
      description: "Composite tool-chain synthesis settings.",
    },
  },
  {
    prefix: "goal.",
    descriptor: {
      category: "Execution",
      tier: "advanced",
      description: "Interactive goal execution behavior.",
    },
  },
  {
    prefix: "tasks.",
    descriptor: {
      category: "Execution",
      tier: "advanced",
      description: "Task concurrency and routing controls.",
    },
  },
  {
    prefix: "interaction.",
    descriptor: {
      category: "Execution",
      tier: "advanced",
      description: "Silent-first execution visibility, heartbeat timing, and escalation policy.",
    },
  },
  {
    prefix: "daemon.",
    descriptor: {
      category: "Operations",
      tier: "advanced",
      description: "Opt-in daemon automation controls.",
    },
  },
  {
    prefix: "notification.",
    descriptor: {
      category: "Operations",
      tier: "advanced",
      description: "Daemon notification routing and urgency controls.",
    },
  },
  {
    prefix: "quietHours.",
    descriptor: {
      category: "Operations",
      tier: "advanced",
      description: "Quiet-hours buffering rules for daemon notifications.",
    },
  },
  {
    prefix: "digest.",
    descriptor: {
      category: "Operations",
      tier: "advanced",
      description: "Digest scheduling and delivery settings.",
    },
  },
  {
    prefix: "agent.",
    descriptor: {
      category: "Multi-Agent",
      tier: "experimental",
      description: "Advanced multi-agent controls kept opt-in during recovery.",
    },
  },
  {
    prefix: "delegation.",
    descriptor: {
      category: "Multi-Agent",
      tier: "experimental",
      description: "Sub-agent delegation controls kept opt-in during recovery.",
    },
  },
  {
    prefix: "deployment.",
    descriptor: {
      category: "Deployment",
      tier: "experimental",
      description: "Deployment automation stays experimental until it is fully wired and verified.",
    },
  },
  {
    prefix: "routing.",
    descriptor: {
      category: "Providers",
      tier: "advanced",
      description: "Routing preset and phase-switching policy.",
    },
  },
  {
    prefix: "consensus.",
    descriptor: {
      category: "Providers",
      tier: "advanced",
      description: "Consensus review policy across providers.",
    },
  },
  {
    prefix: "strada.",
    descriptor: {
      category: "Project",
      tier: "advanced",
      description: "Strada-specific dependency and source knowledge settings.",
    },
  },
  {
    prefix: "autoUpdate.",
    descriptor: {
      category: "Operations",
      tier: "advanced",
      description: "Self-update behavior and idle-apply policy.",
    },
  },
];

const DEFAULT_DESCRIPTOR: ConfigDescriptor = {
  category: "System",
  tier: "advanced",
  description: "General runtime configuration.",
};

export function describeConfigEntry(key: string): ConfigDescriptor {
  const exact = EXACT_RULES[key];
  if (exact) {
    return exact;
  }

  const matched = PREFIX_RULES.find((rule) => key.startsWith(rule.prefix));
  if (matched) {
    return matched.descriptor;
  }

  return DEFAULT_DESCRIPTOR;
}

export function buildConfigCatalogEntries(config: Record<string, unknown>): ConfigCatalogEntry[] {
  return Object.entries(config)
    .map(([key, value]) => {
      const descriptor = describeConfigEntry(key);
      return {
        key,
        value,
        category: descriptor.category,
        tier: descriptor.tier,
        description: descriptor.description,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function summarizeConfigCatalog(entries: ConfigCatalogEntry[]): ConfigCatalogSummary {
  return entries.reduce<ConfigCatalogSummary>((summary, entry) => {
    summary[entry.tier] += 1;
    return summary;
  }, { core: 0, advanced: 0, experimental: 0 });
}
