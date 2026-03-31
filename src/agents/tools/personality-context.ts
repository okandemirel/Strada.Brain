/**
 * Shared context type guards and interfaces for personality tools.
 *
 * Used by both switch-personality.ts and create-personality.ts to detect
 * SoulLoader and UserProfileStore on the ToolContext without duplication.
 */

import type { ToolContext } from "./tool.interface.js";

export interface SoulLoaderLike {
  getProfiles(): string[];
}

export interface SoulLoaderWithPersistence extends SoulLoaderLike {
  saveProfile(name: string, content: string): Promise<boolean>;
  getProfileContent(name: string): Promise<string | null>;
}

export interface UserProfileStoreLike {
  setActivePersona(chatId: string, persona: string): void;
}

export function hasSoulLoader(ctx: ToolContext): ctx is ToolContext & { soulLoader: SoulLoaderLike } {
  const record = ctx as unknown as Record<string, unknown>;
  return (
    record.soulLoader != null &&
    typeof (record.soulLoader as Record<string, unknown>).getProfiles === "function"
  );
}

export function hasSoulLoaderWithPersistence(ctx: ToolContext): ctx is ToolContext & { soulLoader: SoulLoaderWithPersistence } {
  const record = ctx as unknown as Record<string, unknown>;
  const loader = record.soulLoader as Record<string, unknown> | null | undefined;
  return (
    loader != null &&
    typeof loader.getProfiles === "function" &&
    typeof loader.saveProfile === "function" &&
    typeof loader.getProfileContent === "function"
  );
}

export function hasUserProfileStore(ctx: ToolContext): ctx is ToolContext & { userProfileStore: UserProfileStoreLike } {
  const record = ctx as unknown as Record<string, unknown>;
  return (
    record.userProfileStore != null &&
    typeof (record.userProfileStore as Record<string, unknown>).setActivePersona === "function"
  );
}
