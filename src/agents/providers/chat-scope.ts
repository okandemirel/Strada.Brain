import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/**
 * WHICH CHAT a provider call serves, for a provider that routes on it.
 *
 * OpenCode asks for an `x-opencode-session` that stays the same for one
 * conversation, so its router can send the conversation's calls to where their
 * prefix is already cached. One provider object serves every chat, and the id
 * it generated at construction put every chat under one session (2026-11-05).
 *
 * Ambient rather than threaded, like the run's provenance (run-provenance.ts):
 * a chat's turns, decompositions and reviews reach the provider through the
 * agent loop and the fallback chain, and none of those calls is handed the
 * chat. The orchestrator's task scope sets it (ChatScopedStorage).
 */
const current = new AsyncLocalStorage<string>();

/** Runs `fn` with `chatId` as the chat of every provider call it makes. */
export function withChatScope<T>(chatId: string, fn: () => T): T {
  return current.run(chatId, fn);
}

/** The chat the running provider call serves, or undefined outside one. */
export function currentChatId(): string | undefined {
  const chatId = current.getStore();
  return chatId === undefined || chatId === "" ? undefined : chatId;
}

/**
 * A provider session id for a chat. The same on every call, on every account
 * and after a restart, so the chat keeps its cache routing; different for every
 * chat; and not the chat id itself, which can be a channel's user id. Shaped
 * like the UUID it replaces.
 */
export function chatSessionId(chatId: string): string {
  const hex = createHash("sha256").update(`strada-provider-session\u0000${chatId}`).digest("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/**
 * The orchestrator's task-context storage, which also names the context's chat
 * to the providers. Every message, run and background task opens its context
 * through it, so every provider call inside one knows its chat.
 */
export class ChatScopedStorage<T extends { readonly chatId: string }> {
  private readonly storage = new AsyncLocalStorage<T>();

  run<R>(context: T, fn: () => R): R {
    return this.storage.run(context, () => withChatScope(context.chatId, fn));
  }

  getStore(): T | undefined {
    return this.storage.getStore();
  }
}
