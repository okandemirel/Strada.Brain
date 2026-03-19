import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REQUIRED_SCRIPTS = [
  "pentest/scripts/run-all-tests.sh",
  "pentest/scripts/test-sast.sh",
  "pentest/scripts/test-path-traversal.sh",
  "pentest/scripts/test-command-injection.sh",
  "pentest/scripts/test-ssrf.sh",
] as const;

describe("package script contract", () => {
  it("keeps repository-backed security scripts available", () => {
    for (const relativePath of REQUIRED_SCRIPTS) {
      const fullPath = path.join(process.cwd(), relativePath);
      expect(fs.existsSync(fullPath), `${relativePath} should exist`).toBe(true);
      const content = fs.readFileSync(fullPath, "utf8");
      expect(content.startsWith("#!/usr/bin/env bash")).toBe(true);
    }
  });
});
