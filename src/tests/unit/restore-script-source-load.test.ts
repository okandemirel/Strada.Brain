import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `scripts/restore.mjs` in a source checkout (no dist/) loads the restore API
 * through tsx. It handed tsx a bare absolute path, which works on POSIX but is
 * read on Windows as a URL with scheme `c:` (ERR_UNSUPPORTED_ESM_URL_SCHEME):
 * the emergency restore could not start there. What reaches tsx is recorded on
 * the way through to the real tsx.
 */
const tsImportSpecifiers = vi.hoisted(() => [] as string[]);
vi.mock("tsx/esm/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tsx/esm/api")>();
  return {
    ...actual,
    tsImport: (specifier: string, options: Parameters<typeof actual.tsImport>[1]) => {
      tsImportSpecifiers.push(specifier);
      return actual.tsImport(specifier, options);
    },
  };
});

const RESTORE_SCRIPT = path.join(process.cwd(), "scripts", "restore.mjs");

interface RestoreLoader {
  loadDatabaseBackupModule: (root: string) => Promise<{ module: Record<string, unknown>; source: string }>;
}

describe("restore.mjs without a build", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads the TypeScript source by its file URL", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-source-"));
    dirs.push(root);
    const source = path.join(root, "src", "core", "database-backup.ts");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    // An ESM package, as the real checkout is.
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(source, "export const loadedFrom: string = \"source\";\n");
    const { loadDatabaseBackupModule } = (await import(pathToFileURL(RESTORE_SCRIPT).href)) as RestoreLoader;

    tsImportSpecifiers.length = 0;
    const loaded = await loadDatabaseBackupModule(root);

    expect(loaded.source).toBe(source);
    expect(loaded.module["loadedFrom"]).toBe("source");
    expect(tsImportSpecifiers).toEqual([pathToFileURL(source).href]);
  });
});
