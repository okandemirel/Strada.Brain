// ---------------------------------------------------------------------------
// HubChannel — several channel adapters behind the daemon's single channel slot.
//
// Incoming messages from every member reach the one handler the daemon
// registers, unchanged (msg.channelType stays the member's own, so tasks and
// campaigns record where they really came from). Outgoing calls are routed to
// the member that owns the chat id: the member a message with that id last
// arrived on, else the member that claims the id's shape (Telegram ids are
// integers, web ids are UUIDs, the CLI is "cli-local"), else the first member —
// and that last fallback is logged once per id, because a reply that lands on
// the wrong channel is a bug worth seeing.
//
// Setters and broadcasts that carry no chat id fan out to every member that
// implements them. Per-chat capabilities a member lacks degrade explicitly:
// a typing indicator becomes a no-op, an attachment becomes a markdown line
// naming the file, a stream never starts (the caller then sends the final
// text whole). Nothing is silently dropped.
// ---------------------------------------------------------------------------
import type { IChannelAdapter } from "../channel.interface.js";
import type { IncomingMessage, Attachment } from "../channel-messages.interface.js";
import type { ConfirmationRequest } from "../channel-core.interface.js";
import type { PostSetupBootstrapContext } from "../../common/setup-contract.js";
import { AppError } from "../../common/errors.js";
import { getLoggerSafe } from "../../utils/logger.js";

type Handler = (msg: IncomingMessage) => Promise<void>;

/** The optional surface members may expose; every call site below feature-checks. */
interface MemberExtras {
  claimsChatId?(chatId: string): boolean;
  sendSystemMessage?(chatId: string, text: string): Promise<void>;
  sendTypingIndicator?(chatId: string): Promise<void>;
  sendTypingStop?(chatId: string): void;
  sendAttachment?(chatId: string, attachment: Attachment): Promise<void>;
  requestConfirmation?(req: ConfirmationRequest): Promise<string>;
  startStreamingMessage?(chatId: string): Promise<string | undefined>;
  updateStreamingMessage?(chatId: string, streamId: string, accumulatedText: string): Promise<void>;
  finalizeStreamingMessage?(chatId: string, streamId: string, finalText: string): Promise<void>;
  editMessage?(chatId: string, messageId: string, newContent: string): Promise<void>;
  setAppliedInstinctIds?(chatId: string, instinctIds: string[]): void;
  broadcastRaw?(message: string): void;
  broadcastBuildStatus?(): Promise<void>;
  setBuildStatusProvider?(provider: unknown): void;
}

type Member = IChannelAdapter & MemberExtras;

export class HubChannel implements IChannelAdapter {
  readonly name: string;
  readonly members: readonly Member[];
  private readonly owners = new Map<string, Member>();
  private readonly unownedWarned = new Set<string>();
  private handler: Handler | undefined;

  constructor(members: readonly IChannelAdapter[]) {
    if (members.length < 2) {
      throw new AppError("A channel hub needs at least two member channels", "HUB_TOO_FEW_MEMBERS");
    }
    this.members = members as readonly Member[];
    this.name = members.map((m) => m.name).join("+");
  }

  // ---- lifecycle -----------------------------------------------------------

  async connect(): Promise<void> {
    const connected: Member[] = [];
    for (const member of this.members) {
      try {
        await member.connect();
        connected.push(member);
      } catch (err) {
        // One member failing must not leave the others half-alive.
        await Promise.allSettled(connected.map((m) => m.disconnect()));
        throw new AppError(
          `Channel "${member.name}" failed to connect: ${err instanceof Error ? err.message : String(err)}`,
          "HUB_MEMBER_CONNECT_FAILED",
        );
      }
    }
  }

  async disconnect(): Promise<void> {
    const results = await Promise.allSettled(this.members.map((m) => m.disconnect()));
    for (const [i, r] of results.entries()) {
      if (r.status === "rejected") {
        getLoggerSafe().warn("Hub member failed to disconnect", {
          member: this.members[i]?.name,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
  }

  isHealthy(): boolean {
    return this.members.every((m) => m.isHealthy());
  }

  /** Which members are healthy — for boot reports and /daemon status. */
  memberHealth(): ReadonlyArray<{ name: string; healthy: boolean }> {
    return this.members.map((m) => ({ name: m.name, healthy: m.isHealthy() }));
  }

  // ---- incoming ------------------------------------------------------------

  onMessage(handler: Handler): void {
    this.handler = handler;
    for (const member of this.members) {
      member.onMessage(async (msg) => {
        this.owners.set(msg.chatId, member);
        await this.handler?.(msg);
      });
    }
  }

  // ---- routing -------------------------------------------------------------

  /** The member that owns a chat id (see the file header for the order of precedence). */
  ownerOf(chatId: string): Member {
    const known = this.owners.get(chatId);
    if (known) return known;
    const claimant = this.members.find((m) => m.claimsChatId?.(chatId) === true);
    if (claimant) {
      this.owners.set(chatId, claimant);
      return claimant;
    }
    const primary = this.members[0]!;
    if (!this.unownedWarned.has(chatId)) {
      this.unownedWarned.add(chatId);
      getLoggerSafe().warn("Hub: no member owns this chat id — routing to the primary channel", {
        chatId,
        primary: primary.name,
        members: this.members.map((m) => m.name),
      });
    }
    return primary;
  }

  claimsChatId(chatId: string): boolean {
    return this.owners.has(chatId) || this.members.some((m) => m.claimsChatId?.(chatId) === true);
  }

  // ---- per-chat sending ----------------------------------------------------

  sendText(chatId: string, text: string): Promise<void> {
    return this.ownerOf(chatId).sendText(chatId, text);
  }

  sendMarkdown(chatId: string, markdown: string): Promise<void> {
    return this.ownerOf(chatId).sendMarkdown(chatId, markdown);
  }

  async sendSystemMessage(chatId: string, text: string): Promise<void> {
    const owner = this.ownerOf(chatId);
    if (owner.sendSystemMessage) return owner.sendSystemMessage(chatId, text);
    return owner.sendText(chatId, text);
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    await this.ownerOf(chatId).sendTypingIndicator?.(chatId);
  }

  sendTypingStop(chatId: string): void {
    this.ownerOf(chatId).sendTypingStop?.(chatId);
  }

  async sendAttachment(chatId: string, attachment: Attachment): Promise<void> {
    const owner = this.ownerOf(chatId);
    if (owner.sendAttachment) return owner.sendAttachment(chatId, attachment);
    const where = attachment.url ? ` — ${attachment.url}` : attachment.size !== undefined ? ` (${attachment.size} bytes, not deliverable on ${owner.name})` : ` (not deliverable on ${owner.name})`;
    await owner.sendMarkdown(chatId, `📎 ${attachment.type}: ${attachment.name}${where}`);
  }

  requestConfirmation(req: ConfirmationRequest): Promise<string> {
    const owner = this.ownerOf(req.chatId);
    if (!owner.requestConfirmation) {
      return Promise.reject(new AppError(`Channel "${owner.name}" cannot ask for confirmation`, "HUB_MEMBER_NOT_INTERACTIVE"));
    }
    return owner.requestConfirmation(req);
  }

  async startStreamingMessage(chatId: string): Promise<string | undefined> {
    const owner = this.ownerOf(chatId);
    return owner.startStreamingMessage ? owner.startStreamingMessage(chatId) : undefined;
  }

  async updateStreamingMessage(chatId: string, streamId: string, accumulatedText: string): Promise<void> {
    await this.ownerOf(chatId).updateStreamingMessage?.(chatId, streamId, accumulatedText);
  }

  async finalizeStreamingMessage(chatId: string, streamId: string, finalText: string): Promise<void> {
    const owner = this.ownerOf(chatId);
    if (owner.finalizeStreamingMessage) return owner.finalizeStreamingMessage(chatId, streamId, finalText);
    // A stream that was never started on this member has nothing to finalize;
    // the text still has to reach the chat.
    await owner.sendMarkdown(chatId, finalText);
  }

  editMessage(chatId: string, messageId: string, newContent: string): Promise<void> {
    const owner = this.ownerOf(chatId);
    if (!owner.editMessage) {
      return Promise.reject(new AppError(`Channel "${owner.name}" cannot edit messages`, "HUB_MEMBER_NO_EDIT"));
    }
    return owner.editMessage(chatId, messageId, newContent);
  }

  setAppliedInstinctIds(chatId: string, instinctIds: string[]): void {
    this.ownerOf(chatId).setAppliedInstinctIds?.(chatId, instinctIds);
  }

  // ---- fan-out (no chat id) ------------------------------------------------

  setPostSetupBootstrapHandler(handler: ((context: PostSetupBootstrapContext) => Promise<void> | void) | null): void {
    for (const m of this.members) m.setPostSetupBootstrapHandler?.(handler);
  }

  setTaskOwnerResolver(resolver: (taskId: string) => string | null | undefined | Promise<string | null | undefined>): void {
    for (const m of this.members) m.setTaskOwnerResolver?.(resolver);
  }

  setWorkspaceBusEmitter(emitter: ((event: string, payload: unknown) => boolean | void) | null): void {
    for (const m of this.members) m.setWorkspaceBusEmitter?.(emitter);
  }

  setFeedbackHandler(
    handler: (type: "thumbs_up" | "thumbs_down", instinctIds: string[], userId?: string, source?: "reaction" | "button") => void,
  ): void {
    for (const m of this.members) m.setFeedbackHandler?.(handler);
  }

  setBuildStatusProvider(provider: unknown): void {
    for (const m of this.members) m.setBuildStatusProvider?.(provider);
  }

  async broadcastBuildStatus(): Promise<void> {
    await Promise.allSettled(this.members.map((m) => m.broadcastBuildStatus?.()));
  }

  broadcastRaw(message: string): void {
    for (const m of this.members) m.broadcastRaw?.(message);
  }
}
