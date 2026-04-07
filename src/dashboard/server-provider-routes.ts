/**
 * Provider-related API routes for the dashboard server.
 *
 * Handles:
 *   GET  /api/providers/available
 *   GET  /api/providers/active
 *   GET  /api/rag/status
 *   POST /api/providers/switch
 *   GET  /api/providers/intelligence
 *   GET  /api/providers/capabilities
 *   POST /api/models/refresh
 *   GET  /api/agent-activity
 *   POST /api/routing/preset
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { projectScopeMatches } from "../learning/runtime-artifact-manager.js";
import {
  DASHBOARD_IDENTITY_MAX_LENGTH,
  isDashboardIdentityPartTooLong,
  resolveDashboardIdentityKey,
  VALID_ROUTING_PRESETS,
  PROVIDER_NAME_RE,
  sendJson,
  sendJsonError,
  type RouteContext,
} from "./server-types.js";

/**
 * Try to handle provider-related routes. Returns true if the route was handled.
 */
export function handleProviderRoutes(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  // GET /api/providers/available -- List available providers
  if (method === "GET" && (url === "/api/providers/available" || url.startsWith("/api/providers/available?"))) {
    if (!ctx.providerManager) {
      sendJsonError(res, 501, "Provider manager not available");
      return true;
    }
    try {
      const params = new URL(url, "http://localhost").searchParams;
      const withModels = params.get("withModels") === "true";

      if (withModels && ctx.providerManager.listAvailableWithModels) {
        void ctx.providerManager.listAvailableWithModels().then((providers) => {
          sendJson(res, { providers });
        }).catch((err) => {
          sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
        });
      } else {
        const providers = ctx.providerManager.listAvailable();
        sendJson(res, { providers });
      }
    } catch (err) {
      sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
    }
    return true;
  }

  // GET /api/providers/active -- Get active provider for a chat
  if (method === "GET" && url.startsWith("/api/providers/active")) {
    if (!ctx.providerManager) {
      sendJsonError(res, 501, "Provider manager not available");
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
    try {
      const identityKey = resolveDashboardIdentityKey(chatId, userId, conversationId);
      const active = ctx.providerManager.getActiveInfo(identityKey);
      const executionPool = ctx.providerManager.listExecutionCandidates?.(identityKey) ?? null;
      sendJson(res, { active, executionPool });
    } catch (err) {
      sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
    }
    return true;
  }

  // GET /api/rag/status -- Get runtime embedding/RAG provider status
  if (method === "GET" && url === "/api/rag/status") {
    if (!ctx.embeddingStatusProvider) {
      sendJsonError(res, 501, "Embedding status is not available");
      return true;
    }
    try {
      const status = ctx.embeddingStatusProvider.getStatus();
      sendJson(res, { status });
    } catch (err) {
      sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
    }
    return true;
  }

  // POST /api/providers/switch -- Switch provider for a chat
  if (method === "POST" && url === "/api/providers/switch") {
    if (!ctx.providerManager) {
      sendJsonError(res, 501, "Provider manager not available");
      return true;
    }
    void ctx.readJsonBody<{
      chatId?: string;
      userId?: string;
      conversationId?: string;
      provider?: string;
      model?: string;
      selectionMode?: "strada-preference-bias" | "strada-hard-pin";
      hardPin?: boolean;
    }>(req, res).then((parsed) => {
      if (!parsed) return;
      if (!parsed.chatId || !parsed.provider) {
        sendJsonError(res, 400, "Missing required fields: chatId (string), provider (string)");
        return;
      }
      if (
        (typeof parsed.chatId === "string" && parsed.chatId.length > DASHBOARD_IDENTITY_MAX_LENGTH) ||
        isDashboardIdentityPartTooLong(parsed.userId ?? null) ||
        isDashboardIdentityPartTooLong(parsed.conversationId ?? null)
      ) {
        sendJsonError(res, 400, `Identity values too long (max ${DASHBOARD_IDENTITY_MAX_LENGTH} chars)`);
        return;
      }
      // Validate model name format
      const MODEL_NAME_RE = /^[a-zA-Z0-9._:\-/]{1,128}$/;
      if (parsed.model && !MODEL_NAME_RE.test(parsed.model)) {
        sendJsonError(res, 400, "Invalid model name");
        return;
      }
      // Validate provider name against available providers
      const available = ctx.providerManager!.listAvailable();
      if (!available.some((p: { name: string }) => p.name === parsed.provider)) {
        sendJsonError(res, 400, `Provider "${parsed.provider}" is not available`);
        return;
      }
      const selectionMode = parsed.selectionMode === "strada-hard-pin" || parsed.hardPin === true
        ? "strada-hard-pin"
        : "strada-preference-bias";
      const identityKey = resolveDashboardIdentityKey(parsed.chatId, parsed.userId, parsed.conversationId);
      void ctx.providerManager!.setPreference(identityKey, parsed.provider, parsed.model, selectionMode).then(() => {
        sendJson(res, {
          success: true,
          provider: parsed.provider,
          model: parsed.model ?? null,
          selectionMode,
        });
      }).catch((err) => {
        sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
      });
    });
    return true;
  }

  // GET /api/providers/intelligence -- Get provider intelligence info
  if (method === "GET" && url.startsWith("/api/providers/intelligence")) {
    const params = new URL(url, "http://localhost").searchParams;
    const provider = params.get("provider");
    if (!provider) {
      sendJsonError(res, 400, "Missing required query parameter: provider");
      return true;
    }
    // Validate provider name format to prevent reflection of arbitrary input
    if (!PROVIDER_NAME_RE.test(provider)) {
      sendJsonError(res, 400, "Invalid provider name format");
      return true;
    }
    void import("../agents/providers/provider-knowledge.js").then(({ buildProviderIntelligence, getProviderIntelligenceSnapshot }) => {
      const available = ctx.providerManager?.describeAvailable?.()
        ?? ctx.providerManager?.listAvailable().map((entry) => ({
          name: entry.name,
          label: entry.label ?? entry.name,
          defaultModel: entry.defaultModel ?? "default",
          capabilities: ctx.providerManager?.getProviderCapabilities?.(entry.name, entry.defaultModel),
          officialSnapshot: null,
        }))
        ?? [];
      const descriptor = available.find((entry) => entry.name === provider);
      if (!descriptor) {
        sendJsonError(res, 404, `Unknown provider: ${provider}`);
        return;
      }
      const snapshot = getProviderIntelligenceSnapshot(
        provider,
        descriptor.defaultModel,
        undefined,
        descriptor.capabilities ?? undefined,
        descriptor.label,
      );
      const intelligence = buildProviderIntelligence(
        provider,
        descriptor.defaultModel,
        undefined,
        descriptor.capabilities ?? undefined,
        descriptor.label,
      );
      sendJson(res, {
        provider,
        snapshot,
        intelligence,
        officialSnapshot: descriptor.officialSnapshot ?? null,
      });
    }).catch((err) => {
      sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
    });
    return true;
  }

  // GET /api/providers/capabilities -- Get capabilities for all providers
  if (method === "GET" && url === "/api/providers/capabilities") {
    void import("../agents/providers/provider-knowledge.js").then(({ getProviderIntelligenceSnapshot }) => {
      const available = ctx.providerManager?.describeAvailable?.()
        ?? ctx.providerManager?.listAvailable().map((entry) => ({
          name: entry.name,
          label: entry.label ?? entry.name,
          defaultModel: entry.defaultModel ?? "default",
          capabilities: ctx.providerManager?.getProviderCapabilities?.(entry.name, entry.defaultModel),
          officialSnapshot: null,
        }))
        ?? [];
      const capabilities = available.map((entry) => getProviderIntelligenceSnapshot(
        entry.name,
        entry.defaultModel,
        undefined,
        entry.capabilities ?? undefined,
        entry.label,
      ));
      sendJson(res, {
        capabilities,
        officialSnapshots: available
          .filter((entry) => entry.officialSnapshot)
          .map((entry) => ({
            provider: entry.name,
            snapshot: entry.officialSnapshot,
          })),
      });
    }).catch((err) => {
      sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
    });
    return true;
  }

  // POST /api/models/refresh -- Trigger model intelligence refresh
  if (method === "POST" && url === "/api/models/refresh") {
    const now = Date.now();
    if (ctx.lastModelRefreshMs && now - ctx.lastModelRefreshMs < 60_000) {
      const retryAfter = Math.ceil((60_000 - (now - ctx.lastModelRefreshMs)) / 1000);
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfter) });
      res.end(JSON.stringify({ error: "Rate limit: model refresh allowed once per 60 seconds", retryAfterSeconds: retryAfter }));
      return true;
    }
    ctx.setLastModelRefreshMs(now);

    if (!ctx.providerManager?.refreshCatalog) {
      sendJsonError(res, 501, "Provider catalog refresh not available");
      return true;
    }

    void ctx.providerManager.refreshCatalog().then((result) => {
      if (!result) {
        sendJsonError(res, 501, "Provider catalog refresh not available");
        return;
      }
      sendJson(res, { success: true, result });
    }).catch((err) => {
      sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
    });
    return true;
  }

  // GET /api/agent-activity -- Recent routing decisions and agent activity
  if (method === "GET" && (url === "/api/agent-activity" || url.startsWith("/api/agent-activity?"))) {
    const query = new URL(req.url ?? "", `http://${req.headers.host ?? "127.0.0.1"}`).searchParams;
    const identityKey = resolveDashboardIdentityKey(
      query.get("chatId") ?? "default",
      query.get("userId"),
      query.get("conversationId"),
    );
    const routingDecisions = ctx.providerRouter?.getRecentDecisions(20, identityKey) ?? [];
    const executionTraces = ctx.providerRouter?.getRecentExecutionTraces?.(20, identityKey) ?? [];
    const phaseOutcomes = ctx.providerRouter?.getRecentPhaseOutcomes?.(20, identityKey) ?? [];
    const phaseScores = ctx.providerRouter?.getPhaseScoreboard?.(12, identityKey) ?? [];
    const artifacts = (ctx.runtimeArtifactManager?.getRecentArtifactsForIdentity(identityKey, {
      states: ["active", "shadow", "retired", "rejected"],
      limit: 12,
    }) ?? [])
      .filter((artifact) => projectScopeMatches(artifact.projectWorldFingerprint, ctx.projectScopeFingerprint))
      .map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        state: artifact.state,
        name: artifact.name,
        description: artifact.description,
        projectWorldFingerprint: artifact.projectWorldFingerprint,
        stats: artifact.stats,
        lastStateReason: artifact.lastStateReason,
        updatedAt: artifact.updatedAt,
      }));
    const preset = ctx.providerRouter?.getPreset() ?? "balanced";
    sendJson(res, { routing: routingDecisions, execution: executionTraces, outcomes: phaseOutcomes, phaseScores, artifacts, preset });
    return true;
  }

  // POST /api/routing/preset -- Change routing preset at runtime
  if (method === "POST" && url === "/api/routing/preset") {
    if (!ctx.providerRouter) {
      sendJsonError(res, 501, "Provider router not available");
      return true;
    }
    void ctx.readJsonBody<{ preset?: string }>(req, res).then((parsed) => {
      if (!parsed) return;
      const preset = typeof parsed.preset === "string" ? parsed.preset.trim() : "";
      if (!VALID_ROUTING_PRESETS.has(preset)) {
        sendJsonError(res, 400, "Invalid preset. Must be one of: budget, balanced, performance");
        return;
      }
      ctx.providerRouter!.setPreset(preset as "budget" | "balanced" | "performance");
      sendJson(res, { success: true, preset });
    });
    return true;
  }

  return false;
}
