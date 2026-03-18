import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

const authoritativeDocs = [
  "README.md",
  "SECURITY.md",
  "src/config/README.md",
  "src/channels/README.md",
  "src/dashboard/README.md",
  "src/agents/README.md",
  "src/common/README.md",
] as const;

const localizedReadmes = [
  "README.de.md",
  "README.es.md",
  "README.fr.md",
  "README.ja.md",
  "README.ko.md",
  "README.tr.md",
  "README.zh.md",
] as const;

const historicalDocs = [
  "docs/audit/2026-03-17-full-audit.md",
  "docs/remediation/2026-03-17-p0-plan.md",
  "docs/superpowers/plans/2026-03-14-media-sharing.md",
  "docs/superpowers/plans/2026-03-15-memory-architecture-overhaul.md",
  "docs/superpowers/plans/2026-03-16-agent-core-phase1-phase2.md",
  "docs/superpowers/plans/2026-03-16-multi-provider-orchestration.md",
  "docs/superpowers/plans/2026-03-16-setup-wizard-auto-update.md",
  "docs/superpowers/specs/2026-03-14-soul-md-system-design.md",
  "docs/superpowers/specs/2026-03-15-memory-architecture-overhaul-design.md",
  "docs/superpowers/specs/2026-03-16-agent-core-design.md",
  "docs/superpowers/specs/2026-03-16-multi-provider-orchestration-design.md",
  "docs/superpowers/specs/2026-03-16-setup-wizard-auto-update-design.md",
] as const;

const deprecatedEnvPatterns = [
  /`DISCORD_CLIENT_ID`/u,
  /`DEPLOYMENT_ENABLED`/u,
  /`DELEGATION_ENABLED`/u,
  /`DELEGATION_MAX_DEPTH`/u,
] as const;

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("docs consistency", () => {
  it("keeps authoritative docs free of deprecated env names and stale dashboard defaults", () => {
    for (const relativePath of authoritativeDocs) {
      const content = readRepoFile(relativePath);

      for (const pattern of deprecatedEnvPatterns) {
        expect(content).not.toMatch(pattern);
      }

      expect(content).not.toContain("| `DASHBOARD_PORT` | `3001` |");
      expect(content).not.toContain("DASHBOARD_PORT=3001");
    }
  });

  it("documents that OpenAI subscription auth does not cover embeddings quota", () => {
    expect(readRepoFile("README.md")).toContain(
      "It does not grant OpenAI API billing or embeddings quota.",
    );
    expect(readRepoFile("src/config/README.md")).toContain(
      "It does not imply OpenAI API quota for embeddings",
    );
  });

  it("marks historical docs as non-authoritative snapshots", () => {
    for (const relativePath of historicalDocs) {
      const content = readRepoFile(relativePath);
      expect(content).toMatch(/not the (?:authoritative source|source of truth) for current runtime behavior or env defaults/u);
    }
  });

  it("marks localized READMEs as translations that defer to the English canonical README", () => {
    for (const relativePath of localizedReadmes) {
      const content = readRepoFile(relativePath);
      expect(content).toMatch(/\[README\.md\]\(README\.md\)/u);
      expect(content).toMatch(/translation|ceviri|uebersetzung|traduccion|traduction|翻訳|번역|翻译/ui);
      expect(content).not.toMatch(/76\s*(?:tools?|arac|outils?|herramientas|ツール|개 도구|工具)/iu);
      expect(content).toContain("OPENAI_AUTH_MODE");
      expect(content).toContain("chatgpt-subscription");
    }
  });

  it("keeps the setup wizard historical plan aligned with the current dashboard port", () => {
    const content = readRepoFile("docs/superpowers/plans/2026-03-16-setup-wizard-auto-update.md");
    expect(content).toContain('lines.push("DASHBOARD_PORT=3100");');
  });
});
