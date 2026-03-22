import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const srcRoot = join(repoRoot, "src");
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

  const files = (await collectTestFiles(srcRoot)).sort();
  const batches = partitionFiles(files);

  for (const [index, batch] of batches.entries()) {
    console.log(
      `\n[vitest-batch] ${index + 1}/${batches.length} (${batch.length} files)`,
    );
    const exitCode = await runVitest([...BASE_ARGS, ...batch]);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
