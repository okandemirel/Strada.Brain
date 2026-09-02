import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidCSharpIdentifier,
  isValidCSharpType,
  validatePath,
} from "./path-guard.js";

describe("isValidCSharpIdentifier", () => {
  it("accepts 'MyClass'", () => {
    expect(isValidCSharpIdentifier("MyClass")).toBe(true);
  });

  it("accepts '_field'", () => {
    expect(isValidCSharpIdentifier("_field")).toBe(true);
  });

  it("rejects '123Bad' (starts with digit)", () => {
    expect(isValidCSharpIdentifier("123Bad")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidCSharpIdentifier("")).toBe(false);
  });

  it("rejects names exceeding 256 characters", () => {
    expect(isValidCSharpIdentifier("a".repeat(257))).toBe(false);
  });

  it("accepts dotted name 'Game.Module' when allowDots=true", () => {
    expect(isValidCSharpIdentifier("Game.Module", true)).toBe(true);
  });

  it("rejects dotted name 'Game.Module' when allowDots=false", () => {
    expect(isValidCSharpIdentifier("Game.Module", false)).toBe(false);
  });

  it("rejects '.Bad' even when allowDots=true (leading dot)", () => {
    expect(isValidCSharpIdentifier(".Bad", true)).toBe(false);
  });
});

describe("isValidCSharpType", () => {
  it("accepts 'float3'", () => {
    expect(isValidCSharpType("float3")).toBe(true);
  });

  it("accepts 'List<int>'", () => {
    expect(isValidCSharpType("List<int>")).toBe(true);
  });

  it("accepts 'Dictionary<string, List<int>>'", () => {
    expect(isValidCSharpType("Dictionary<string, List<int>>")).toBe(true);
  });

  it("accepts 'int[]'", () => {
    expect(isValidCSharpType("int[]")).toBe(true);
  });

  it("accepts 'float?'", () => {
    expect(isValidCSharpType("float?")).toBe(true);
  });

  it("rejects 'bad;inject' (semicolon injection)", () => {
    expect(isValidCSharpType("bad;inject")).toBe(false);
  });

  it("rejects 'bad{}' (curly braces)", () => {
    expect(isValidCSharpType("bad{}")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidCSharpType("")).toBe(false);
  });

  it("rejects strings containing newline characters", () => {
    expect(isValidCSharpType("int\nfoo")).toBe(false);
    expect(isValidCSharpType("int\rfoo")).toBe(false);
  });
});

describe("validatePath", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "path-guard-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("accepts a normal valid path", async () => {
    writeFileSync(join(tempDir, "test.cs"), "content");
    const result = await validatePath(tempDir, "test.cs");
    expect(result.valid).toBe(true);
    expect(result.fullPath).toContain("test.cs");
  });

  it("rejects path with '../..' that escapes the project root", async () => {
    const result = await validatePath(tempDir, "../../etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("outside the project directory");
  });

  it("rejects blocked pattern: .env", async () => {
    writeFileSync(join(tempDir, ".env"), "SECRET=x");
    const result = await validatePath(tempDir, ".env");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Access to sensitive files is not permitted");
  });

  it("rejects blocked pattern: .git/config", async () => {
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    writeFileSync(join(tempDir, ".git", "config"), "");
    const result = await validatePath(tempDir, ".git/config");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Access to sensitive files is not permitted");
  });

  it("rejects blocked pattern: node_modules", async () => {
    mkdirSync(join(tempDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(tempDir, "node_modules", "pkg", "index.js"), "");
    const result = await validatePath(tempDir, "node_modules/pkg/index.js");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Access to sensitive files is not permitted");
  });

  it("rejects empty path", async () => {
    const result = await validatePath(tempDir, "");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Path is required");
  });

  it("accepts new file when parent directory exists", async () => {
    mkdirSync(join(tempDir, "Assets"), { recursive: true });
    const result = await validatePath(tempDir, "Assets/NewFile.cs");
    expect(result.valid).toBe(true);
  });

  it("rejects new file when parent directory does not exist", async () => {
    const result = await validatePath(tempDir, "NonExistent/Sub/NewFile.cs");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Parent directory does not exist");
  });

  it("rejects path containing null byte", async () => {
    const result = await validatePath(tempDir, "file\0.cs");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Path contains invalid characters");
  });

  it("accepts project root itself", async () => {
    const result = await validatePath(tempDir, ".");
    expect(result.valid).toBe(true);
  });
});

describe("validatePath blocks every .env variant, not just single-suffix ones", () => {
  // Audited 2026-09-02: `/\.env\.[a-z]+$/i` required exactly one all-alpha
  // segment after `.env.`, so `.env.production.local`, `.env.local.bak`,
  // `.env.dev2`, `.env.staging-eu` — and the two backup names this repo
  // already pushed a live key in (`.env.bak.191546`, `.env.backup-loglevel`,
  // see .gitignore) — were all handed to file_read in full. .gitignore was
  // widened to `.env.*` after that incident; the runtime guard was not.
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "path-guard-env-"));
    mkdirSync(join(tempDir, "config"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const blocked = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
    ".env.development.local",
    ".env.test.local",
    ".env.local.bak",
    ".env.dev2",
    ".env.staging-eu",
    ".env.bak.191546",
    ".env.backup-loglevel",
    ".env.local.example",
    "config/.env.production.local",
  ];

  for (const name of blocked) {
    it(`refuses ${name}`, async () => {
      writeFileSync(join(tempDir, name), "STRIPE_SECRET_KEY=sk_live_x\n");
      const result = await validatePath(tempDir, name);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Access to sensitive files is not permitted");
    });
  }

  const allowed = ["environment.json", "Assets/Env.cs", ".envrc", "config/EnvSettings.cs", "env.md"];

  for (const name of allowed) {
    it(`still accepts ${name}`, async () => {
      mkdirSync(join(tempDir, "Assets"), { recursive: true });
      writeFileSync(join(tempDir, name), "x");
      const result = await validatePath(tempDir, name);
      expect(result.valid).toBe(true);
    });
  }
});
