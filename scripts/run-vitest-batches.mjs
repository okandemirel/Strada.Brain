import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { failuresFromJsonReport, runAllBatches } from "./vitest-batch-policy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const srcRoot = join(repoRoot, "src");
const testsRoot = join(repoRoot, "tests");
const vitestCli = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const TARGET_FILES_PER_BATCH = 40;
const BASE_ARGS = ["run", "--disableConsoleIntercept"];

async function collectTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectTestFiles(fullPath);
      }
      if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        return [relative(repoRoot, fullPath)];
      }
      return [];
    }),
  );
  return files.flat();
}

function runVitest(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitestCli, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`vitest exited via signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * One batch, with vitest's JSON report written next to the normal output so
 * the end-of-run summary can list every failing test by name.
 */
async function runBatch(batch, reportDir, number) {
  const reportFile = join(reportDir, `batch-${number}.json`);
  const exitCode = await runVitest([
    ...BASE_ARGS,
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${reportFile}`,
    ...batch,
  ]);
  if (exitCode === 0) return exitCode;
  try {
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    return { exitCode, failures: failuresFromJsonReport(report, (file) => relative(repoRoot, file)) };
  } catch {
    // No report (vitest died before writing it): the batch output says why.
    return exitCode;
  }
}

function partitionFiles(files) {
  const batchCount = Math.max(1, Math.ceil(files.length / TARGET_FILES_PER_BATCH));
  const batches = Array.from({ length: batchCount }, () => []);

  files.forEach((file, index) => {
    batches[index % batchCount].push(file);
  });

  return batches.filter((batch) => batch.length > 0);
}

async function main() {
  // Ensure max heap size for large test suites — set programmatically so
  // `npm run test` works on Windows where POSIX `VAR=val cmd` syntax is unsupported.
  if (!process.env.NODE_OPTIONS?.includes("--max-old-space-size")) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, "--max-old-space-size=8192"]
      .filter(Boolean).join(" ");
  }

  const forwardedArgs = process.argv.slice(2);

  if (forwardedArgs.length > 0) {
    const exitCode = await runVitest([...BASE_ARGS, ...forwardedArgs]);
    process.exit(exitCode);
  }

  const srcFiles = await collectTestFiles(srcRoot);
  let testsFiles = [];
  try {
    testsFiles = await collectTestFiles(testsRoot);
  } catch {
    // tests/ directory may not exist
  }
  const files = [...srcFiles, ...testsFiles].sort();
  const batches = partitionFiles(files);

  // Every batch runs; a failure is reported at the end, not by stopping early.
  const reportDir = await mkdtemp(join(tmpdir(), "strada-vitest-batches-"));
  let batchNumber = 0;
  const exitCode = await runAllBatches(batches, (batch) => runBatch(batch, reportDir, ++batchNumber));
  await rm(reportDir, { recursive: true, force: true });
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
