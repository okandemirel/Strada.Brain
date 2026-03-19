import { describe, expect, it } from "vitest";
import { isSetupStatusResponse } from "./setup-contract.js";
import {
  buildSetupRetryHref,
  createSetupStatus,
  deriveSetupBootstrapView,
  getSetupStatusDetail,
  transitionSetupStatus,
} from "./setup-state.js";

describe("setup-state", () => {
  it("preserves provider warnings across bootstrap transitions", () => {
    const saved = transitionSetupStatus(createSetupStatus(), {
      type: "config_saved",
      providerWarnings: [{
        providerId: "kimi",
        providerName: "Kimi (Moonshot)",
        detail: "Health check failed.",
      }],
    });

    const booting = transitionSetupStatus(saved, { type: "bootstrap_starting" });
    expect(booting.providerWarnings).toEqual(saved.providerWarnings);

    const ready = transitionSetupStatus(booting, { type: "bootstrap_ready", readyUrl: "/app" });
    expect(ready.providerWarnings).toEqual(saved.providerWarnings);
  });

  it("derives bootstrap views for ready and failed states", () => {
    const readyView = deriveSetupBootstrapView(
      transitionSetupStatus(createSetupStatus(), { type: "bootstrap_ready", readyUrl: "/chat" }),
    );
    expect(readyView).toEqual({
      saveStatus: "success",
      detail: "Strada is ready. Redirecting now.",
      readyUrl: "/chat",
      shouldPoll: false,
      canRetry: false,
    });

    const failedView = deriveSetupBootstrapView(
      transitionSetupStatus(createSetupStatus(), {
        type: "bootstrap_failed",
        detail: "Provider preflight failed.",
      }),
    );
    expect(failedView).toEqual({
      saveStatus: "error",
      detail: "Provider preflight failed.",
      shouldPoll: false,
      canRetry: true,
    });
  });

  it("falls back to canonical detail text when a state omits detail", () => {
    expect(getSetupStatusDetail({ state: "booting" })).toBe("Strada is starting the main web app.");
  });

  it("builds a shared retry href", () => {
    expect(buildSetupRetryHref()).toBe("/?strada-setup=1&retry=1");
  });

  it("rejects malformed provider warning entries from setup status payloads", () => {
    expect(isSetupStatusResponse({
      state: "saved",
      providerWarnings: [{ providerId: "kimi", providerName: "Kimi (Moonshot)" }],
    })).toBe(false);

    expect(isSetupStatusResponse({
      state: "saved",
      providerWarnings: [{
        providerId: "kimi",
        providerName: "Kimi (Moonshot)",
        detail: "Health check failed.",
      }],
    })).toBe(true);
  });
});
