export const SETUP_QUERY_PARAM = "strada-setup";

export const SETUP_BOOTSTRAP_STATES = [
  "collecting",
  "saved",
  "booting",
  "ready",
  "failed",
] as const;
export const POST_SETUP_BOOTSTRAP_LANGUAGES = [
  "en",
  "tr",
  "ja",
  "ko",
  "zh",
  "de",
  "es",
  "fr",
] as const;

export type SetupBootstrapState = (typeof SETUP_BOOTSTRAP_STATES)[number];
export type PostSetupBootstrapLanguage = (typeof POST_SETUP_BOOTSTRAP_LANGUAGES)[number];

export interface SetupProviderFailure {
  providerId: string;
  providerName: string;
  detail: string;
}

export interface PostSetupBootstrapAutonomy {
  enabled: true;
  hours?: number;
}

export interface PostSetupBootstrap {
  language: PostSetupBootstrapLanguage;
  autonomy?: PostSetupBootstrapAutonomy;
}

export interface PostSetupBootstrapContext {
  chatId: string;
  profileId: string;
  profileToken?: string;
}

export interface SetupStatusResponse {
  state: SetupBootstrapState;
  detail?: string;
  readyUrl?: string;
  providerFailures?: SetupProviderFailure[];
  providerWarnings?: SetupProviderFailure[];
  postSetupBootstrap?: PostSetupBootstrap;
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

export function isPostSetupBootstrap(value: unknown): value is PostSetupBootstrap {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.language !== "string"
    || !(POST_SETUP_BOOTSTRAP_LANGUAGES as readonly string[]).includes(candidate.language)
  ) {
    return false;
  }

  if (candidate.autonomy !== undefined) {
    if (!candidate.autonomy || typeof candidate.autonomy !== "object") {
      return false;
    }
    const autonomy = candidate.autonomy as Record<string, unknown>;
    if (autonomy.enabled !== true) {
      return false;
    }
    if (autonomy.hours !== undefined) {
      if (typeof autonomy.hours !== "number" || !Number.isFinite(autonomy.hours)) {
        return false;
      }
      if (autonomy.hours < 1 || autonomy.hours > 168) {
        return false;
      }
    }
  }

  return true;
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

  if (candidate.postSetupBootstrap !== undefined && !isPostSetupBootstrap(candidate.postSetupBootstrap)) {
    return false;
  }

  return true;
}
