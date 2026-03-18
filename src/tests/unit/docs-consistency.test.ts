import { existsSync, readFileSync } from "node:fs";
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

const localizedProviderChainPhrases: Record<(typeof localizedReadmes)[number], string> = {
  "README.de.md": "Standard-Orchestrierungspool",
  "README.es.md": "pool de orquestacion por defecto",
  "README.fr.md": "pool d'orchestration par d&eacute;faut",
  "README.ja.md": "既定のオーケストレーションプール",
  "README.ko.md": "기본 오케스트레이션 풀",
  "README.tr.md": "varsayilan orkestrasyon havuzu",
  "README.zh.md": "默认编排池",
};

const localizedControlPlanePhrases: Record<(typeof localizedReadmes)[number], string> = {
  "README.de.md": "Strada bleibt die Control Plane",
  "README.es.md": "Strada sigue siendo el plano de control",
  "README.fr.md": "Strada reste le plan de contr&ocirc;le",
  "README.ja.md": "Strada はコントロールプレーンのまま",
  "README.ko.md": "Strada는 계속 컨트롤 플레인으로 남고",
  "README.tr.md": "Strada control-plane olarak kalir",
  "README.zh.md": "Strada 仍然是控制平面",
};

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
    expect(readRepoFile("src/config/README.md")).toContain("STRADA_HOME");
    expect(readRepoFile("README.md")).toContain("clarification-review");
    expect(readRepoFile("README.md")).toContain("verifier pipeline");
    expect(readRepoFile("README.md")).toContain("phase outcomes");
    expect(readRepoFile("src/agents/README.md")).toContain("Clarification Review");
    expect(readRepoFile("src/agents/README.md")).toContain("Verifier Pipeline");
  });

  it("marks localized READMEs as translations that defer to the English canonical README", () => {
    for (const relativePath of localizedReadmes) {
      const content = readRepoFile(relativePath);
      expect(content).toMatch(/\[README\.md\]\(README\.md\)/u);
      expect(content).toMatch(/translation|ceviri|uebersetzung|traduccion|traduction|翻訳|번역|翻译/ui);
      expect(content).not.toMatch(/76\s*(?:tools?|arac|outils?|herramientas|ツール|개 도구|工具)/iu);
      expect(content).toContain("OPENAI_AUTH_MODE");
      expect(content).toContain("chatgpt-subscription");
      expect(content).toContain("EMBEDDING_PROVIDER=openai");
      expect(content).toContain("OPENAI_API_KEY");
      expect(content).toContain(localizedProviderChainPhrases[relativePath]);
      expect(content).toContain(localizedControlPlanePhrases[relativePath]);
      expect(content).toContain("./strada install-command");
      expect(content).toContain("./Strada.Brain/strada install-command");
      expect(content).toContain("./Strada.Brain/strada setup");
      expect(content).toMatch(/shell|profil|profile|PATH|zsh|bash|fish|シェル|셸|终端/ui);
      expect(content).toContain("./strada setup --web");
      expect(content).toContain("./strada setup --terminal");
      expect(content).toContain("./strada doctor");
      expect(content).toContain("./strada                  #");
      expect(content).toContain("strada --daemon");
      expect(content).toContain("strada --web");
      expect(content).toContain("strada --terminal");
      expect(content).toContain("nvm");
      expect(content).toContain("clarification-review");
      expect(content).toMatch(/phase outcomes|phase outcome|phase-outcomes|Phase-Outcomes/iu);
      expect(content).toContain("`approved`, `continued`, `replanned`, `blocked`");
      expect(content).not.toMatch(/# .*npm install -g strada-brain/u);
    }
  });

  it("keeps install docs aligned with the source-first release path", () => {
    const englishReadme = readRepoFile("README.md");
    expect(englishReadme).toContain("./strada install-command");
    expect(englishReadme).toContain("./Strada.Brain/strada install-command");
    expect(englishReadme).toContain("./Strada.Brain/strada setup");
    expect(englishReadme).toContain("No `cd` required");
    expect(englishReadme).toContain("updates your shell profile automatically");
    expect(englishReadme).toContain("~/.strada");
    expect(englishReadme).toContain("STRADA_HOME");
    expect(englishReadme).toContain("./strada setup --web");
    expect(englishReadme).toContain("Node.js 20.19+");
    expect(englishReadme).toContain("nvm");
    expect(englishReadme).toContain("prefix` / `globalconfig`");
    expect(englishReadme).toContain("./strada setup --terminal");
    expect(englishReadme).toContain("git clone https://github.com/okandemirel/Strada.Brain.git Strada.Brain");
    expect(englishReadme).toContain("repository root");
    expect(englishReadme).toContain("ENOENT ... /Strada/package.json");
    expect(englishReadme).toContain("./strada                  # Canonical source-checkout launcher");
    expect(englishReadme).toContain("strada --daemon");
    expect(englishReadme).toContain("strada --web");
    expect(englishReadme).toContain("strada --terminal");
    expect(englishReadme).toContain("./strada setup --web");
    expect(englishReadme).toContain("./strada doctor");
    expect(englishReadme).toContain("prefers **Web Browser** by default");
    expect(englishReadme).toContain("bare `strada` command");
    expect(englishReadme).toContain("not currently published on the public npm registry");
    expect(englishReadme).not.toMatch(/# Global install \(recommended\)\s+npm install -g strada-brain/u);
  });

  it("keeps the docs folder free of historical plan/spec snapshot directories", () => {
    expect(existsSync(path.join(REPO_ROOT, "docs", "audit"))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, "docs", "remediation"))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, "docs", "superpowers"))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, "docs", "analysis"))).toBe(false);
  });

  it("states that docs only keep authoritative product documentation", () => {
    const docsGuide = readRepoFile("docs/README.md");
    expect(docsGuide).toContain("intentionally small");
    expect(docsGuide).toContain("If a behavior matters today");
  });
});
