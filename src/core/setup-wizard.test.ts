import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { SetupWizard } from "./setup-wizard.js";

describe("SetupWizard path validation", () => {
  it("re-validates the project path during save using the resolved home-directory path", async () => {
    const wizard = new SetupWizard();

    const result = await (wizard as unknown as {
      validateProjectPathForSave: (
        rawPath: string,
      ) => Promise<{ valid: true; resolved: string } | { valid: false; error: string }>;
    }).validateProjectPathForSave(homedir());

    expect(result).toEqual({ valid: true, resolved: homedir() });
  });

  it("rejects project paths outside the home directory at save time", async () => {
    const wizard = new SetupWizard();

    const result = await (wizard as unknown as {
      validateProjectPathForSave: (
        rawPath: string,
      ) => Promise<{ valid: true; resolved: string } | { valid: false; error: string }>;
    }).validateProjectPathForSave("/tmp");

    expect(result).toEqual({
      valid: false,
      error: "Path must be inside your home directory",
    });
  });
});
