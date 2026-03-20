import { describe, expect, it } from "vitest";
import { isSetupStatusResponse } from "./setup-contract.js";
import {
  buildPostSetupBootstrap,
  buildPostSetupWelcomeMessage,
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
      readyUrl: "http://127.0.0.1:3000/",
      postSetupBootstrap: buildPostSetupBootstrap({
        LANGUAGE_PREFERENCE: "tr",
        AUTONOMOUS_DEFAULT_ENABLED: "true",
        AUTONOMOUS_DEFAULT_HOURS: "24",
      }),
      providerWarnings: [{
        providerId: "kimi",
        providerName: "Kimi (Moonshot)",
        detail: "Health check failed.",
      }],
    });

    const booting = transitionSetupStatus(saved, { type: "bootstrap_starting" });
    expect(booting.providerWarnings).toEqual(saved.providerWarnings);
    expect(booting.readyUrl).toBe("http://127.0.0.1:3000/");

    const ready = transitionSetupStatus(booting, { type: "bootstrap_ready", readyUrl: "/app" });
    expect(ready.providerWarnings).toEqual(saved.providerWarnings);
    expect(ready.postSetupBootstrap).toEqual(saved.postSetupBootstrap);
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

  it("preserves ready urls for booting and failed states", () => {
    const booting = transitionSetupStatus(createSetupStatus(), {
      type: "bootstrap_starting",
      readyUrl: "http://127.0.0.1:3002/",
    });
    expect(deriveSetupBootstrapView(booting)?.readyUrl).toBe("http://127.0.0.1:3002/");

    const failed = transitionSetupStatus(booting, {
      type: "bootstrap_failed",
      detail: "Startup timed out.",
    });
    expect(deriveSetupBootstrapView(failed)?.readyUrl).toBe("http://127.0.0.1:3002/");
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

    expect(isSetupStatusResponse({
      state: "saved",
      postSetupBootstrap: {
        language: "en",
        autonomy: {
          enabled: true,
          hours: 200,
        },
      },
    })).toBe(false);

    expect(isSetupStatusResponse({
      state: "saved",
      postSetupBootstrap: {
        language: "tr",
      },
    })).toBe(true);
  });

  it("formats a localized post-setup welcome message", () => {
    expect(buildPostSetupWelcomeMessage("tr")).toContain("Merhaba");
    expect(buildPostSetupWelcomeMessage("en")).toContain("brief");
  });
});
