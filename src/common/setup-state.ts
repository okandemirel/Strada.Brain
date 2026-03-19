import {
  SETUP_QUERY_PARAM,
  type SetupBootstrapState,
  type SetupProviderFailure,
  type SetupStatusResponse,
} from "./setup-contract.js";

export const SETUP_STATE_DEFAULT_DETAILS: Record<SetupBootstrapState, string> = {
  collecting: "Waiting for setup to begin.",
  saved: "Configuration accepted. Starting Strada on this same URL.",
  booting: "Strada is starting the main web app.",
  ready: "Strada is ready. Redirecting now.",
  failed: "Strada could not finish starting. Re-open setup and fix the configuration.",
};

export type SetupStatusTransition =
  | { type: "reset" }
  | {
    type: "config_saved";
    detail?: string;
    providerWarnings?: SetupProviderFailure[];
  }
  | {
    type: "bootstrap_starting";
    detail?: string;
  }
  | {
    type: "bootstrap_ready";
    readyUrl?: string;
    detail?: string;
  }
  | {
    type: "bootstrap_failed";
    detail: string;
  };

export type SetupBootstrapViewStatus = "saved" | "booting" | "success" | "error";

export interface SetupBootstrapView {
  saveStatus: SetupBootstrapViewStatus;
  detail: string;
  readyUrl?: string;
  shouldPoll: boolean;
  canRetry: boolean;
}

export function createSetupStatus(state: SetupBootstrapState = "collecting"): SetupStatusResponse {
  if (state === "collecting") {
    return { state };
  }
  return {
    state,
    detail: SETUP_STATE_DEFAULT_DETAILS[state],
    ...(state === "ready" ? { readyUrl: "/" } : {}),
  };
}

export function getSetupStatusDetail(status: Pick<SetupStatusResponse, "state" | "detail">): string {
  return status.detail?.trim() || SETUP_STATE_DEFAULT_DETAILS[status.state];
}

export function transitionSetupStatus(
  current: SetupStatusResponse,
  transition: SetupStatusTransition,
): SetupStatusResponse {
  switch (transition.type) {
    case "reset":
      return createSetupStatus("collecting");
    case "config_saved":
      return {
        state: "saved",
        detail: transition.detail ?? SETUP_STATE_DEFAULT_DETAILS.saved,
        providerWarnings: transition.providerWarnings ?? current.providerWarnings,
      };
    case "bootstrap_starting":
      return {
        state: "booting",
        detail: transition.detail ?? SETUP_STATE_DEFAULT_DETAILS.booting,
        providerWarnings: current.providerWarnings,
      };
    case "bootstrap_ready":
      return {
        state: "ready",
        detail: transition.detail ?? SETUP_STATE_DEFAULT_DETAILS.ready,
        readyUrl: transition.readyUrl ?? "/",
        providerWarnings: current.providerWarnings,
      };
    case "bootstrap_failed":
      return {
        state: "failed",
        detail: transition.detail,
        providerWarnings: current.providerWarnings,
      };
  }
}

export function deriveSetupBootstrapView(status: SetupStatusResponse): SetupBootstrapView | null {
  switch (status.state) {
    case "collecting":
      return null;
    case "saved":
      return {
        saveStatus: "saved",
        detail: getSetupStatusDetail(status),
        shouldPoll: true,
        canRetry: false,
      };
    case "booting":
      return {
        saveStatus: "booting",
        detail: getSetupStatusDetail(status),
        shouldPoll: true,
        canRetry: false,
      };
    case "ready":
      return {
        saveStatus: "success",
        detail: getSetupStatusDetail(status),
        readyUrl: status.readyUrl || "/",
        shouldPoll: false,
        canRetry: false,
      };
    case "failed":
      return {
        saveStatus: "error",
        detail: getSetupStatusDetail(status),
        shouldPoll: false,
        canRetry: true,
      };
  }
}

export function buildSetupRetryHref(): string {
  const params = new URLSearchParams({
    [SETUP_QUERY_PARAM]: "1",
    retry: "1",
  });
  return `/?${params.toString()}`;
}
