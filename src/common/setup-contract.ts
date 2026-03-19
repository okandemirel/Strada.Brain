export const SETUP_QUERY_PARAM = "strada-setup";

export const SETUP_BOOTSTRAP_STATES = [
  "collecting",
  "saved",
  "booting",
  "ready",
  "failed",
] as const;

export type SetupBootstrapState = (typeof SETUP_BOOTSTRAP_STATES)[number];

export interface SetupProviderFailure {
  providerId: string;
  providerName: string;
  detail: string;
}

export interface SetupStatusResponse {
  state: SetupBootstrapState;
  detail?: string;
  readyUrl?: string;
  providerFailures?: SetupProviderFailure[];
  providerWarnings?: SetupProviderFailure[];
}

export function isSetupBootstrapState(value: unknown): value is SetupBootstrapState {
  return typeof value === "string"
    && (SETUP_BOOTSTRAP_STATES as readonly string[]).includes(value);
}

export function isSetupProviderFailure(value: unknown): value is SetupProviderFailure {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.providerId === "string"
    && typeof candidate.providerName === "string"
    && typeof candidate.detail === "string";
}

export function isSetupStatusResponse(value: unknown): value is SetupStatusResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (!isSetupBootstrapState(candidate.state)) {
    return false;
  }

  if (candidate.detail !== undefined && typeof candidate.detail !== "string") {
    return false;
  }

  if (candidate.readyUrl !== undefined && typeof candidate.readyUrl !== "string") {
    return false;
  }

  if (
    candidate.providerFailures !== undefined
    && (!Array.isArray(candidate.providerFailures)
      || !candidate.providerFailures.every(isSetupProviderFailure))
  ) {
    return false;
  }

  if (
    candidate.providerWarnings !== undefined
    && (!Array.isArray(candidate.providerWarnings)
      || !candidate.providerWarnings.every(isSetupProviderFailure))
  ) {
    return false;
  }

  return true;
}
