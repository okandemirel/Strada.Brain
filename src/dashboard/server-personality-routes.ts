/**
 * Personality and user-related API routes for the dashboard server.
 *
 * Handles:
 *   GET  /api/personality
 *   POST /api/personality/profiles
 *   DELETE /api/personality/profiles/:name
 *   POST /api/personality/switch
 *   GET  /api/user/autonomous
 *   POST /api/user/autonomous
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveAutonomousModeWithDefault } from "../memory/unified/user-profile-store.js";
import {
  SYSTEM_PROFILES,
  PROFILE_NAME_RE,
  DASHBOARD_IDENTITY_MAX_LENGTH,
  isDashboardIdentityPartTooLong,
  resolveDashboardIdentityKey,
  sendJson,
  sendJsonError,
  type RouteContext,
} from "./server-types.js";

/**
 * Try to handle personality and user routes. Returns true if the route was handled.
 */
export function handlePersonalityRoutes(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  // GET /api/personality -- Soul/personality info (supports ?chatId= for per-user overlay)
  if ((url === "/api/personality" || url.startsWith("/api/personality?")) && method === "GET") {
    if (!ctx.soulLoader) {
      sendJson(res, { personality: null });
      return true;
    }

    let activeProfile = ctx.soulLoader.getActiveProfile();

    const chatId = new URL(url, "http://localhost").searchParams.get("chatId");
    if (chatId && ctx.userProfileStore?.getProfile) {
      const profile = ctx.userProfileStore.getProfile(chatId);
      if (profile?.activePersona && profile.activePersona !== "default") {
        activeProfile = profile.activePersona;
      }
    }

    sendJson(res, {
      personality: {
        content: ctx.soulLoader.getContent(),
        activeProfile,
        profiles: ctx.soulLoader.getProfiles(),
        channelOverrides: ctx.soulLoader.getChannelOverrides(),
      },
    });
    return true;
  }

  // POST /api/personality/profiles -- Create a custom profile
  if (method === "POST" && url === "/api/personality/profiles") {
    if (!ctx.soulLoader) {
      sendJsonError(res, 501, "Soul loader not available");
      return true;
    }
    void ctx.readJsonBody<{ name?: string; content?: string }>(req, res, 12_288).then(async (parsed) => {
      if (!parsed) return;
      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
      const content = typeof parsed.content === "string" ? parsed.content : "";
      if (!name || !PROFILE_NAME_RE.test(name)) {
        sendJsonError(res, 400, "Invalid profile name (alphanumeric, dash, underscore only)");
        return;
      }
      if (SYSTEM_PROFILES.has(name)) {
        sendJsonError(res, 400, `Cannot create a profile named '${name}' — it is a system profile`);
        return;
      }
      if (!content || content.length > 10240) {
        sendJsonError(res, 400, "Content must be non-empty and at most 10KB");
        return;
      }
      try {
        const success = await ctx.soulLoader!.saveProfile(name, content);
        if (!success) {
          sendJsonError(res, 500, "Failed to save profile");
          return;
        }
        sendJson(res, { success: true, profile: name, profiles: ctx.soulLoader!.getProfiles() });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
      }
    });
    return true;
  }

  // DELETE /api/personality/profiles/{name} -- Delete a custom profile
  if (method === "DELETE" && url.startsWith("/api/personality/profiles/")) {
    if (!ctx.soulLoader) {
      sendJsonError(res, 501, "Soul loader not available");
      return true;
    }
    const profileName = decodeURIComponent(url.slice("/api/personality/profiles/".length).split("?")[0]!);
    if (!profileName || !PROFILE_NAME_RE.test(profileName)) {
      sendJsonError(res, 400, "Invalid profile name");
      return true;
    }
    if (SYSTEM_PROFILES.has(profileName)) {
      sendJsonError(res, 400, `Cannot delete system profile '${profileName}'`);
      return true;
    }
    void (async () => {
      try {
        const success = await ctx.soulLoader!.deleteProfile(profileName);
        if (!success) {
          sendJsonError(res, 404, `Profile '${profileName}' not found or could not be deleted`);
          return;
        }
        sendJson(res, { success: true, profiles: ctx.soulLoader!.getProfiles() });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
      }
    })();
    return true;
  }

  // POST /api/personality/switch -- Switch active personality profile
  if (method === "POST" && url === "/api/personality/switch") {
    if (!ctx.soulLoader) {
      sendJsonError(res, 501, "Soul loader not available");
      return true;
    }
    void ctx.readJsonBody<{ profile?: string; chatId?: string }>(req, res).then(async (parsed) => {
      if (!parsed) return;
      const profile = typeof parsed.profile === "string" ? parsed.profile.trim() : "";
      if (!profile || !PROFILE_NAME_RE.test(profile)) {
        sendJsonError(res, 400, "Invalid profile name");
        return;
      }
      try {
        // Validate profile exists (no global mutation — per-user only)
        const available = ctx.soulLoader!.getProfiles();
        if (!available.includes(profile)) {
          sendJsonError(res, 400, `Profile '${profile}' not found. Available: ${available.join(", ")}`);
          return;
        }
        // Persist per-user persona
        if (parsed.chatId && ctx.userProfileStore?.setActivePersona) {
          try {
            ctx.userProfileStore.setActivePersona(parsed.chatId, profile);
          } catch { /* non-fatal — persona update is best-effort */ }
        }
        sendJson(res, { success: true, activeProfile: profile });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
      }
    });
    return true;
  }

  // GET /api/user/autonomous -- Check autonomous mode status
  if (method === "GET" && url.startsWith("/api/user/autonomous")) {
    if (!ctx.userProfileStore) {
      sendJsonError(res, 501, "User profile store not available");
      return true;
    }
    const params = new URL(url, "http://localhost").searchParams;
    const chatId = params.get("chatId");
    const userId = params.get("userId");
    const conversationId = params.get("conversationId");
    if (!chatId) {
      sendJsonError(res, 400, "Missing required query parameter: chatId");
      return true;
    }
    if (
      chatId.length > DASHBOARD_IDENTITY_MAX_LENGTH ||
      isDashboardIdentityPartTooLong(userId) ||
      isDashboardIdentityPartTooLong(conversationId)
    ) {
      sendJsonError(res, 400, `Identity values too long (max ${DASHBOARD_IDENTITY_MAX_LENGTH} chars)`);
      return true;
    }
    const identityKey = resolveDashboardIdentityKey(chatId, userId, conversationId);
    void resolveAutonomousModeWithDefault(
      ctx.userProfileStore,
      identityKey,
      ctx.getAutonomousDefaults(),
    ).then((result) => {
      sendJson(res, result);
    }).catch((err) => {
      sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
    });
    return true;
  }

  // POST /api/user/autonomous -- Set autonomous mode
  if (method === "POST" && url.startsWith("/api/user/autonomous")) {
    if (!ctx.userProfileStore) {
      sendJsonError(res, 501, "User profile store not available");
      return true;
    }
    // Identity from query params (consistent with GET handler)
    const params = new URL(url, "http://localhost").searchParams;
    const chatId = params.get("chatId");
    const userId = params.get("userId");
    const conversationId = params.get("conversationId");
    if (!chatId) {
      sendJsonError(res, 400, "Missing required query parameter: chatId");
      return true;
    }
    if (
      chatId.length > DASHBOARD_IDENTITY_MAX_LENGTH ||
      isDashboardIdentityPartTooLong(userId) ||
      isDashboardIdentityPartTooLong(conversationId)
    ) {
      sendJsonError(res, 400, `Identity values too long (max ${DASHBOARD_IDENTITY_MAX_LENGTH} chars)`);
      return true;
    }
    void ctx.readJsonBody<{ enabled?: boolean; durationHours?: number; hours?: number }>(req, res).then((parsed) => {
      if (!parsed) return;
      if (typeof parsed.enabled !== "boolean") {
        sendJsonError(res, 400, "Missing required field: enabled (boolean)");
        return;
      }
      const hours = parsed.durationHours ?? parsed.hours;
      const MIN_HOURS = 1;
      const MAX_HOURS = 168;
      if (hours !== undefined && (typeof hours !== "number" || hours < MIN_HOURS || hours > MAX_HOURS)) {
        sendJsonError(res, 400, `hours must be between ${MIN_HOURS} and ${MAX_HOURS}`);
        return;
      }
      const identityKey = resolveDashboardIdentityKey(chatId!, userId, conversationId);
      const expiresAt = hours && hours > 0
        ? Date.now() + hours * 3600000
        : undefined;
      void ctx.userProfileStore!.setAutonomousMode(identityKey, parsed.enabled, expiresAt).then(() => {
        sendJson(res, { success: true, enabled: parsed.enabled, expiresAt: expiresAt ?? null });
      }).catch((err) => {
        sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
      });
    });
    return true;
  }

  return false;
}
