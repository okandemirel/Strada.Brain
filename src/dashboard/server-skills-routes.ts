/**
 * Skills management API routes for the dashboard server.
 *
 * Handles:
 *   GET  /api/skills
 *   GET  /api/skills/registry
 *   POST /api/skills/install
 *   POST /api/skills/:name/enable
 *   POST /api/skills/:name/disable
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SkillEntry } from "../skills/types.js";
import { setSkillEnabled } from "../skills/skill-config.js";
import { fetchRegistry, searchRegistry } from "../skills/skill-registry-client.js";
import { isValidSkillName, installSkillFromRepo } from "../skills/skill-installer.js";
import { sendJson, sendJsonError } from "./server-types.js";
import type { RouteContext } from "./server-types.js";

/**
 * Try to handle skills-related routes. Returns true if the route was handled.
 */
export function handleSkillsRoutes(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  if (!url.startsWith("/api/skills")) return false;

  // GET /api/skills -- list all skill entries
  if (url === "/api/skills" && method === "GET") {
    const entries: SkillEntry[] = ctx.skillManager
      ? ctx.skillManager.getEntries()
      : [];
    sendJson(res, { skills: entries });
    return true;
  }

  // GET /api/skills/registry?q=<query>&refresh=true
  const registryMatch = url.match(/^\/api\/skills\/registry/);
  if (registryMatch && method === "GET") {
    const params = new URL(url, "http://localhost").searchParams;
    const query = params.get("q") ?? "";
    const refresh = params.get("refresh") === "true";

    void (async () => {
      try {
        const registry = await fetchRegistry(refresh);
        const results = query ? searchRegistry(registry, query) : Object.entries(registry.skills);

        // Cross-reference with installed skills
        const installed = new Set(
          (ctx.skillManager?.getEntries() ?? []).map((e) => e.manifest.name)
        );

        const skills = results.map(([name, entry]) => ({
          name,
          ...entry,
          installed: installed.has(name),
        }));

        sendJson(res, { skills });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
      }
    })();
    return true;
  }

  // POST /api/skills/install -- install from registry or URL
  if (url === "/api/skills/install" && method === "POST") {
    void ctx.readJsonBody<{ name?: string; repo?: string }>(req, res).then(async (parsed) => {
      if (!parsed) return;
      try {
        const { name, repo } = parsed;
        if (!name || typeof name !== "string") {
          sendJsonError(res, 400, "name is required");
          return;
        }

        if (!isValidSkillName(name)) {
          sendJsonError(res, 400, "Invalid skill name");
          return;
        }

        // Determine repo URL
        let repoUrl = repo;
        if (!repoUrl) {
          const registry = await fetchRegistry();
          const entry = registry.skills[name];
          if (!entry) {
            sendJsonError(res, 404, `Skill "${name}" not found in registry`);
            return;
          }
          repoUrl = entry.repo;
        }

        const result = await installSkillFromRepo(name, repoUrl);
        if (!result.success) {
          const status = result.error?.includes("already installed") ? 409 : 500;
          sendJsonError(res, status, result.error ?? "Installation failed");
          return;
        }

        sendJson(res, { success: true, message: `Skill "${name}" installed. Restart to activate.` });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
      }
    });
    return true;
  }

  // POST /api/skills/:name/enable
  const enableMatch = url.match(/^\/api\/skills\/([^/]+)\/enable$/);
  if (enableMatch && method === "POST") {
    const name = decodeURIComponent(enableMatch[1] ?? "");
    if (!isValidSkillName(name)) {
      sendJsonError(res, 400, "Invalid skill name");
      return true;
    }
    void setSkillEnabled(name, true).then(() => {
      sendJson(res, { success: true });
    }).catch((err) => {
      sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
    });
    return true;
  }

  // POST /api/skills/:name/disable
  const disableMatch = url.match(/^\/api\/skills\/([^/]+)\/disable$/);
  if (disableMatch && method === "POST") {
    const name = decodeURIComponent(disableMatch[1] ?? "");
    if (!isValidSkillName(name)) {
      sendJsonError(res, 400, "Invalid skill name");
      return true;
    }
    void setSkillEnabled(name, false).then(() => {
      sendJson(res, { success: true });
    }).catch((err) => {
      sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
    });
    return true;
  }

  return false;
}
