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
 * Round 10 #20 added a third: both images ran `npm ci` BEFORE copying
 * `scripts/`, while the root `prepare` lifecycle script is
 * `node scripts/install-git-hooks.mjs` — npm runs it as part of that very
 * install, so a build from a clean checkout died at install time. The standard
 * image also set `NODE_ENV=production` and installed the portal's dependencies
 * without `--include=dev`, leaving the portal build with no tsc and no vite.
 * Neither could be caught before, because this suite ignored the ORDER of the
 * instructions and exempted portal installs from its dev-dependency check.
 *
 * Docker cannot run in the development sandbox, so this suite asserts the
 * invariants over the Dockerfile text — the honest test at this level. It
 * parses the files into stages and checks what each stage copies and installs
 * relative to the `npm run build` step, and in what order.
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
function copiesDirectoryLine(line: string, target: string): boolean {
  if (!/^COPY\b/i.test(line)) return false;
  // Drop `COPY`, any flags (--from=, --chown=) and the final destination arg.
  const args = line
    .split(/\s+/)
    .slice(1)
    .filter((a) => !a.startsWith("--"));
  const sources = args.slice(0, -1);
  return sources.some(
    (s) => s.replace(/^\.\//, "").replace(/\/+$/, "").replace(/^\/app\//, "") === target,
  );
}

function copiesDirectory(stage: Stage, target: string): boolean {
  return stage.lines.some((line) => copiesDirectoryLine(line, target));
}

/**
 * The build chain's instructions in the order Docker executes them.
 *
 * `buildStageChain` returns the build stage first and its ancestors after it;
 * an instruction's position only means something the other way round, so the
 * chain is reversed before its lines are concatenated. That is what makes
 * "copied before installed" expressible at all (#20).
 */
function buildChainLines(stages: Stage[]): string[] {
  return [...buildStageChain(stages)].reverse().flatMap((stage) => stage.lines);
}

/** A root-package install — the one npm runs the `prepare` lifecycle for. */
function isRootInstall(line: string): boolean {
  if (!/^RUN\b.*npm\s+(ci|install)\b/i.test(line)) return false;
  return !/--prefix\s+\S*web-portal|web-portal/i.test(line);
}

/**
 * Top-level directories the root package's install-time lifecycle scripts read.
 *
 * Taken from package.json rather than hardcoded, so the contract follows the
 * scripts: `prepare` is `node scripts/install-git-hooks.mjs` today, and
 * whatever path a future lifecycle script names has to be in the image before
 * the install that runs it.
 */
function lifecyclePrerequisiteDirs(): string[] {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const lifecycle = ["preinstall", "install", "postinstall", "prepare", "prepublish"];
  const dirs = new Set<string>();
  for (const name of lifecycle) {
    const body = pkg.scripts?.[name];
    if (!body) continue;
    for (const match of body.matchAll(/(?:^|[\s"'=])(?:\.\/)?([A-Za-z0-9_.-]+)\/[A-Za-z0-9_./-]+/g)) {
      const dir = match[1] as string;
      if (dir === "." || dir === "..") continue;
      dirs.add(dir);
    }
  }
  return [...dirs];
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
    // No install feeding the build may exclude devDependencies — the portal's
    // included (#20): its build script is `tsc -b && vite build` and both of
    // those are devDependencies of web-portal/package.json.
    for (const install of installs) {
      expect(install).not.toMatch(/--only=production|--omit=dev|--production\b/i);
    }
    expect(installs.some((l) => /--include=dev/i.test(l))).toBe(true);
  });

  it("installs the portal's dev dependencies explicitly (NODE_ENV=production omits them)", () => {
    // `ENV NODE_ENV=production` in the build stage makes npm drop
    // devDependencies from an install that does not ask for them, and the
    // portal's tsc/vite are devDependencies. --include=dev is the only thing
    // that keeps the portal buildable regardless of NODE_ENV (#20).
    const portalInstalls = buildChainLines(stages).filter(
      (l) => /^RUN\b.*npm\s+(ci|install)\b/i.test(l) && /web-portal/i.test(l),
    );
    expect(portalInstalls.length, "nothing installs the portal's dependencies").toBeGreaterThan(0);
    for (const install of portalInstalls) {
      expect(install, "portal install without --include=dev").toMatch(/--include=dev/i);
    }
  });

  it("copies the lifecycle prerequisites before the install that runs them (#20)", () => {
    // npm runs the root package's `prepare` as part of `npm ci`. `prepare` is
    // `node scripts/install-git-hooks.mjs`, so an install that happens before
    // scripts/ is copied fails right there — "Cannot find module" — and takes
    // the whole image with it.
    const lines = buildChainLines(stages);
    const installIndex = lines.findIndex(isRootInstall);
    expect(installIndex, "the build chain never installs the root package").toBeGreaterThanOrEqual(0);
    const prerequisites = lifecyclePrerequisiteDirs();
    expect(prerequisites, "package.json declares no install-time lifecycle script").not.toEqual([]);
    for (const dir of prerequisites) {
      const copiedAt = lines.findIndex((l) => copiesDirectoryLine(l, dir));
      expect(copiedAt, `${dir}/ is never copied into the build chain`).toBeGreaterThanOrEqual(0);
      expect(
        copiedAt,
        `${dir}/ is copied at instruction ${copiedAt}, after the install at ${installIndex}`,
      ).toBeLessThan(installIndex);
    }
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
