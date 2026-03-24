/**
 * Workspace File REST Endpoints
 *
 * Provides REST API endpoints for the workspace file explorer:
 *   GET /api/workspace/files?path=<dir>     -- directory listing
 *   GET /api/workspace/file?path=<file>     -- file content with language detection
 *   GET /api/workspace/diff/:taskId         -- diff data for a goal task
 *
 * All paths undergo strict security validation before any filesystem access.
 * Follows the inline route-matching pattern used by DashboardServer.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, relative, normalize, extname } from "node:path";
import { readdir, readFile, realpath, stat } from "node:fs/promises";

// =============================================================================
// CONSTANTS
// =============================================================================

const DENYLIST = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
  ".env.development",
  "node_modules",
  ".git/objects",
  ".git/refs",
  ".git/hooks",
];

const MAX_DEPTH = 10;

/** Max file size we'll read and return (1 MB). */
const MAX_FILE_SIZE = 1_048_576;

const NO_CACHE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache",
};

// =============================================================================
// LANGUAGE DETECTION
// =============================================================================

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".cs": "csharp",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".xml": "xml",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".md": "markdown",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".sql": "sql",
  ".graphql": "graphql",
  ".proto": "protobuf",
  ".toml": "toml",
  ".ini": "ini",
  ".cfg": "ini",
  ".shader": "hlsl",
  ".hlsl": "hlsl",
  ".glsl": "glsl",
  ".cginc": "hlsl",
  ".compute": "hlsl",
  ".asmdef": "json",
  ".asmref": "json",
  ".unity": "yaml",
  ".prefab": "yaml",
  ".asset": "yaml",
  ".mat": "yaml",
  ".meta": "yaml",
  ".txt": "plaintext",
  ".log": "plaintext",
  ".dockerfile": "dockerfile",
  ".lua": "lua",
  ".rb": "ruby",
  ".php": "php",
  ".r": "r",
};

export function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? "plaintext";
}

// =============================================================================
// PATH SECURITY
// =============================================================================

export interface PathSafetyResult {
  safe: boolean;
  resolved: string;
  error?: string;
}

/**
 * Validate a requested path against the project root.
 *
 * Security checks (in order):
 *   1. Reject null bytes
 *   2. Normalize and reject traversal sequences (..)
 *   3. Resolve to absolute path, verify it is within projectRoot
 *   4. Enforce max depth
 *   5. Check denylist (exact match and prefix match)
 */
export function isPathSafe(requestedPath: string, projectRoot: string): PathSafetyResult {
  // 1. Reject null bytes
  if (requestedPath.includes("\x00")) {
    return { safe: false, resolved: "", error: "Invalid path: null bytes" };
  }

  // 2. Normalize and reject traversal sequences
  const normalized = normalize(requestedPath);
  if (normalized.includes("..")) {
    return { safe: false, resolved: "", error: "Path traversal rejected" };
  }

  // 3. Resolve to absolute and verify containment
  const resolved = resolve(projectRoot, normalized);
  const rel = relative(projectRoot, resolved);

  // If relative path starts with '..' or is absolute, it's outside project root
  if (rel.startsWith("..") || resolve(projectRoot, rel) !== resolved) {
    return { safe: false, resolved: "", error: "Path outside project" };
  }

  // 4. Check depth
  const segments = rel.split(/[/\\]/).filter(Boolean);
  const depth = segments.length;
  if (depth > MAX_DEPTH) {
    return { safe: false, resolved: "", error: "Path too deep" };
  }

  // 5. Denylist check — exact match or prefix
  for (const denied of DENYLIST) {
    if (rel === denied || rel.startsWith(denied + "/") || rel.startsWith(denied + "\\")) {
      return { safe: false, resolved: "", error: `Path denied: ${denied}` };
    }
  }

  return { safe: true, resolved };
}

// =============================================================================
// HELPERS
// =============================================================================

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, NO_CACHE_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * After initial isPathSafe check, verify the real (symlink-resolved) path
 * is still within the project root.
 *
 * Returns:
 *   { status: 'ok', realPath } — safe to access
 *   { status: 'escaped' }      — symlink points outside project
 *   { status: 'not_found' }    — path does not exist
 *   { status: 'error' }        — other filesystem error
 */
async function verifyRealPath(
  resolvedPath: string,
  projectRoot: string,
): Promise<{ status: "ok"; realPath: string } | { status: "escaped" | "not_found" | "error" }> {
  try {
    const real = await realpath(resolvedPath);
    const projectReal = await realpath(projectRoot);
    const rel = relative(projectReal, real);
    if (rel.startsWith("..") || resolve(projectReal, rel) !== real) {
      return { status: "escaped" };
    }
    return { status: "ok", realPath: real };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "not_found" };
    return { status: "error" };
  }
}

// =============================================================================
// ROUTE HANDLER
// =============================================================================

/**
 * Handle /api/workspace/* requests.
 * Returns true if the request was handled, false if it should fall through.
 */
export function handleWorkspaceRoute(
  url: string,
  method: string,
  _req: IncomingMessage,
  res: ServerResponse,
  projectRoot: string | undefined,
): boolean {
  if (!url.startsWith("/api/workspace")) return false;

  // Guard: project root must be configured
  if (!projectRoot) {
    jsonResponse(res, 400, { error: "Project path not configured" });
    return true;
  }

  // -- GET /api/workspace/files?path=<dir> --------------------------------
  if (method === "GET" && (url.startsWith("/api/workspace/files?") || url === "/api/workspace/files")) {
    const params = new URL(url, "http://localhost").searchParams;
    const pathParam = params.get("path");

    if (!pathParam) {
      jsonResponse(res, 400, { error: "Missing required query parameter: path" });
      return true;
    }

    const check = isPathSafe(pathParam, projectRoot);
    if (!check.safe) {
      jsonResponse(res, 403, { error: check.error ?? "Access denied" });
      return true;
    }

    // Async directory listing
    void (async () => {
      const realCheck = await verifyRealPath(check.resolved, projectRoot);
      if (realCheck.status !== "ok") {
        const statusCode = realCheck.status === "escaped" ? 403 : realCheck.status === "not_found" ? 404 : 500;
        const msg = realCheck.status === "escaped" ? "Path escapes project boundary" : realCheck.status === "not_found" ? "Directory not found" : "Failed to access path";
        jsonResponse(res, statusCode, { error: msg });
        return;
      }

      try {
        const dirStat = await stat(realCheck.realPath);
        if (!dirStat.isDirectory()) {
          jsonResponse(res, 400, { error: "Path is not a directory" });
          return;
        }

        const dirEntries = await readdir(realCheck.realPath, { withFileTypes: true });
        const entries = dirEntries.map((entry) => {
          const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
          return { name: entry.name, type };
        });

        // Sort: directories first, then alphabetical
        entries.sort((a, b) => {
          if (a.type === "directory" && b.type !== "directory") return -1;
          if (a.type !== "directory" && b.type === "directory") return 1;
          return a.name.localeCompare(b.name);
        });

        jsonResponse(res, 200, { entries, path: pathParam });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          jsonResponse(res, 404, { error: "Directory not found" });
        } else if (code === "EACCES") {
          jsonResponse(res, 403, { error: "Access denied" });
        } else {
          jsonResponse(res, 500, { error: "Failed to list directory" });
        }
      }
    })();

    return true;
  }

  // -- GET /api/workspace/file?path=<file> --------------------------------
  if (method === "GET" && (url.startsWith("/api/workspace/file?") || url === "/api/workspace/file")) {
    const params = new URL(url, "http://localhost").searchParams;
    const pathParam = params.get("path");

    if (!pathParam) {
      jsonResponse(res, 400, { error: "Missing required query parameter: path" });
      return true;
    }

    const check = isPathSafe(pathParam, projectRoot);
    if (!check.safe) {
      jsonResponse(res, 403, { error: check.error ?? "Access denied" });
      return true;
    }

    // Async file read
    void (async () => {
      const realCheck = await verifyRealPath(check.resolved, projectRoot);
      if (realCheck.status !== "ok") {
        const statusCode = realCheck.status === "escaped" ? 403 : realCheck.status === "not_found" ? 404 : 500;
        const msg = realCheck.status === "escaped" ? "Path escapes project boundary" : realCheck.status === "not_found" ? "File not found" : "Failed to access path";
        jsonResponse(res, statusCode, { error: msg });
        return;
      }

      try {
        const fileStat = await stat(realCheck.realPath);
        if (!fileStat.isFile()) {
          jsonResponse(res, 400, { error: "Path is not a file" });
          return;
        }
        if (fileStat.size > MAX_FILE_SIZE) {
          jsonResponse(res, 413, { error: "File too large", maxBytes: MAX_FILE_SIZE });
          return;
        }

        const content = await readFile(realCheck.realPath, "utf-8");
        const language = detectLanguage(pathParam);

        jsonResponse(res, 200, {
          content,
          language,
          path: pathParam,
          size: fileStat.size,
        });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          jsonResponse(res, 404, { error: "File not found" });
        } else if (code === "EACCES") {
          jsonResponse(res, 403, { error: "Access denied" });
        } else {
          jsonResponse(res, 500, { error: "Failed to read file" });
        }
      }
    })();

    return true;
  }

  // -- GET /api/workspace/diff/:taskId ------------------------------------
  const diffMatch = url.match(/^\/api\/workspace\/diff\/([^/?]+)(?:\?.*)?$/);
  if (method === "GET" && diffMatch) {
    // Diff data is not yet wired to goal storage — return 404 as placeholder
    jsonResponse(res, 404, { error: "Diff not found" });
    return true;
  }

  // No match within /api/workspace namespace
  jsonResponse(res, 404, { error: "Workspace endpoint not found" });
  return true;
}
