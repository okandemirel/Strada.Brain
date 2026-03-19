export type CapabilityTier = "production" | "beta" | "experimental";
export type CapabilityStatus = "active" | "degraded" | "inactive";
export type CapabilityTruth = "health-checked" | "wired" | "declared-only";

export interface CapabilityDescriptor {
  id: string;
  name: string;
  area: string;
  tier: CapabilityTier;
  status: CapabilityStatus;
  truth: CapabilityTruth;
  detail: string;
  defaultSurface: boolean;
}

export type BootStageId = "runtime" | "providers" | "knowledge" | "channel" | "ops";
export type BootStageStatus = "ready" | "degraded" | "failed";

export interface BootStageReport {
  id: BootStageId;
  label: string;
  status: BootStageStatus;
  detail: string;
  notices?: string[];
}

export interface BootReport {
  generatedAt: string;
  channelType: string;
  stages: BootStageReport[];
  capabilities: CapabilityDescriptor[];
  goldenPath: {
    channels: string[];
    recommendedPreset: "balanced";
    protectedWorkflows: string[];
  };
  startupNotices: string[];
}

export type ConfigTier = "core" | "advanced" | "experimental";

export interface ConfigCatalogEntry {
  key: string;
  value: unknown;
  category: string;
  tier: ConfigTier;
  description: string;
}

export interface ConfigCatalogSummary {
  core: number;
  advanced: number;
  experimental: number;
}
