/**
 * Dockerfile contract (14F1 / D70, Codex #27).
 *
 * Both images used to fail for the same two reasons, and neither could be
 * caught by a unit test because nothing read the Dockerfiles:
 *
 *   1. The build stage copied only `src/` — not `scripts/` (which holds
 *      `build-package.mjs`, the thing `npm run build` actually runs) and not
 *      `web-portal/` (which `build-package.mjs` builds and copies into
 *      `dist/channels/web/static`). `npm run build` therefore cannot run at
 *      all, and the produced image has no web UI.
 *   2. `docker/Dockerfile.hardened` installed its dependencies with
 *      `npm ci --only=production`, which strips TypeScript and every build
 *      tool, and then handed those node_modules to the stage that runs
 *      `npm run build`.
 *
 * Docker cannot run in the development sandbox, so this suite asserts the
 * invariants over the Dockerfile text — the honest test at this level. It
 * parses the files into stages and checks what each stage copies and installs
 * relative to the `npm run build` step.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface Stage {
  /** Stage alias from `FROM x AS alias`, or the image when unnamed. */
  name: string;
  /** The image or earlier stage this one is based on. */
  base: string;
  /** Logical lines of the stage, continuations already joined. */
  lines: string[];
}

/** Join backslash continuations so one instruction is one line. */
function logicalLines(source: string): string[] {
  const out: string[] = [];
  let buffer = "";
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#") || line.length === 0) {
      if (buffer.length === 0) continue;
    }
    if (line.endsWith("\\")) {
      buffer += `${line.slice(0, -1).trim()} `;
      continue;
    }
    buffer += line;
    if (buffer.trim().length > 0) out.push(buffer.trim());
    buffer = "";
  }
  if (buffer.trim().length > 0) out.push(buffer.trim());
  return out;
}

function parseStages(source: string): Stage[] {
  const stages: Stage[] = [];
  for (const line of logicalLines(source)) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      stages.push({ name: (from[2] ?? from[1]) as string, base: from[1] as string, lines: [] });
      continue;
    }
    if (stages.length > 0) stages[stages.length - 1]!.lines.push(line);
  }
  return stages;
}

function readDockerfile(relPath: string): { source: string; stages: Stage[] } {
  const source = readFileSync(path.join(repoRoot, relPath), "utf8");
  return { source, stages: parseStages(source) };
}

/** The stage that runs `npm run build`, plus the stages it inherits from. */
function buildStageChain(stages: Stage[]): Stage[] {
  const index = stages.findIndex((s) => s.lines.some((l) => /^RUN\b.*npm run build\b/i.test(l)));
  expect(index, "no stage runs `npm run build`").toBeGreaterThanOrEqual(0);
  const chain = [stages[index]!];
  // A stage inherits everything from the stage it is based on (`FROM deps AS
  // builder`), and anything copied in with `--from=<stage>` is present too —
  // both count as available to the build.
  const byName = new Map(stages.map((s) => [s.name, s]));
  for (let i = index - 1; i >= 0; i--) {
    const stage = stages[i]!;
    const inherited = chain.some((c) => c.base === stage.name);
    const copied = chain.some((c) =>
      c.lines.some((l) => new RegExp(`--from=${stage.name}\\b`).test(l)),
    );
    if (inherited || copied) chain.push(stage);
  }
  expect(byName.size).toBeGreaterThan(0);
  return chain;
}

/**
 * True when the stage copies the whole `target` directory.
 *
 * Deliberately strict about the source argument: `COPY
 * web-portal/package.json ./web-portal/` copies a manifest, not the portal,
 * and must not satisfy "the portal sources are in the build context".
 */
function copiesDirectory(stage: Stage, target: string): boolean {
  return stage.lines.some((line) => {
    if (!/^COPY\b/i.test(line)) return false;
    // Drop `COPY`, any flags (--from=, --chown=) and the final destination arg.
    const args = line
      .split(/\s+/)
      .slice(1)
      .filter((a) => !a.startsWith("--"));
    const sources = args.slice(0, -1);
    return sources.some((s) => s.replace(/^\.\//, "").replace(/\/+$/, "").replace(/^\/app\//, "") === target);
  });
}

const DOCKERFILES = ["Dockerfile", "docker/Dockerfile.hardened"] as const;

describe.each(DOCKERFILES)("%s", (relPath) => {
  const { source, stages } = readDockerfile(relPath);

  it("copies scripts/ into the stage that runs `npm run build` (build-package.mjs lives there)", () => {
    const chain = buildStageChain(stages);
    expect(chain.some((stage) => copiesDirectory(stage, "scripts"))).toBe(true);
  });

  it("copies web-portal/ into the stage that runs `npm run build` (the portal build is fatal when missing)", () => {
    const chain = buildStageChain(stages);
    expect(chain.some((stage) => copiesDirectory(stage, "web-portal"))).toBe(true);
  });

  it("installs the portal's own dependencies before building (node_modules is .dockerignore'd)", () => {
    const chain = buildStageChain(stages);
    expect(
      chain.some((stage) =>
        stage.lines.some((l) => /^RUN\b.*npm\s+(ci|install)\b.*web-portal/i.test(l)),
      ),
    ).toBe(true);
  });

  it("copies scripts/ into the production stage so ops scripts exist in the image", () => {
    const production = stages.find((s) => s.name === "production");
    expect(production, "no production stage").toBeDefined();
    expect(copiesDirectory(production!, "scripts")).toBe(true);
  });

  it("gives the build stage dev dependencies (TypeScript is a devDependency)", () => {
    const chain = buildStageChain(stages);
    const installs = chain.flatMap((stage) =>
      stage.lines.filter((l) => /^RUN\b.*npm\s+(ci|install)\b/i.test(l)),
    );
    expect(installs.length, "the build chain installs nothing").toBeGreaterThan(0);
    // No install feeding the build may exclude devDependencies.
    for (const install of installs) {
      if (/web-portal/i.test(install)) continue;
      expect(install).not.toMatch(/--only=production|--omit=dev|--production\b/i);
    }
    expect(installs.some((l) => /--include=dev/i.test(l))).toBe(true);
  });

  it("never uses the removed `npm ci --only=production` form", () => {
    expect(source).not.toMatch(/--only=production/);
  });

  it("ships production-only dependencies in the runtime image", () => {
    // Either the build chain prunes dev dependencies before the production
    // stage copies node_modules, or a dedicated production-deps stage exists.
    const prunes = logicalLines(source).some((l) => /npm\s+prune\b.*(--omit=dev|--production)/i.test(l));
    expect(prunes).toBe(true);
  });
});
