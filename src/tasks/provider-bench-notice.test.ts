import { describe, it, expect, vi } from "vitest";
import { announceCredentialBench, buildProviderBenchNotice } from "./provider-bench-notice.js";
import type { CredentialBenchEvent } from "../agents/providers/provider-health.js";
import type { IChannelSender } from "../channels/channel-core.interface.js";
import type { Task } from "./types.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const EVENT: CredentialBenchEvent = { provider: "Alpha", reason: "401 invalid key", benchedForMs: 8 * 3_600_000, continuingOn: "Beta" };
const EN_PROMPT = "Draft the quarterly bakery inventory report";
const TR_PROMPT = "Fırın envanter raporunu hazırla ve tedarikçi özetini ekle";

const task = (id: string, chatId: string, prompt: string, channelType = "web"): Task =>
  ({ id, chatId, prompt, channelType }) as unknown as Task;

function setup(tasks: Task[]) {
  const sent: Array<[string, string]> = [];
  const channel = {
    sendText: vi.fn(async (chatId: string, text: string) => { sent.push([chatId, text]); }),
    sendMarkdown: vi.fn(async () => {}),
  } as unknown as IChannelSender;
  const progress: Array<[string, string]> = [];
  const manager = {
    listAllActiveTasks: () => tasks,
    addProgress: vi.fn((id: string, message: string) => { progress.push([id, message]); }),
  };
  return { channel, manager, sent, progress };
}

describe("buildProviderBenchNotice", () => {
  it("says which seat, why, for how long, and who carries on, in English", () => {
    expect(buildProviderBenchNotice(EN_PROMPT, EVENT)).toEqual({
      sentence: "Alpha's key was refused, so it is set aside for this session (8 h); the work continues on Beta.",
      note: "Provider Alpha benched for 8 h after its key was refused; the work continues on Beta. Error: 401 invalid key",
    });
  });

  it("follows the task's language", () => {
    expect(buildProviderBenchNotice(TR_PROMPT, EVENT).sentence)
      .toBe("Alpha anahtarı reddedildi, bu oturum boyunca (8 saat) devre dışı; iş Beta ile sürüyor.");
  });

  it("says plainly that no provider is left when none carries on", () => {
    const { continuingOn: _gone, ...bare } = EVENT;
    expect(buildProviderBenchNotice(EN_PROMPT, bare).sentence).toContain("no other provider is left");
  });
});

describe("announceCredentialBench", () => {
  it("records the note on every active task and tells each chat once", async () => {
    const { channel, manager, sent, progress } = setup([
      task("t1", "chat-1", EN_PROMPT), task("t2", "chat-1", EN_PROMPT), task("t3", "chat-2", EN_PROMPT),
    ]);
    await announceCredentialBench(channel, manager, EVENT);
    expect(progress.map(([id]) => id)).toEqual(["t1", "t2", "t3"]);
    expect(sent.map(([chat]) => chat)).toEqual(["chat-1", "chat-2"]);
  });

  it("records the note but tells nobody on a daemon run: no person reads that chat", async () => {
    const { channel, manager, sent, progress } = setup([task("d1", "daemon-chat", EN_PROMPT, "daemon")]);
    await announceCredentialBench(channel, manager, EVENT);
    expect(progress).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("still tells the chat when the record write throws, and never rejects when the send fails", async () => {
    const { channel, manager, sent } = setup([task("t1", "chat-1", EN_PROMPT)]);
    manager.addProgress.mockImplementation(() => { throw new Error("storage closed"); });
    await announceCredentialBench(channel, manager, EVENT);
    expect(sent).toHaveLength(1);
    (channel.sendText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("socket closed"));
    await expect(announceCredentialBench(channel, manager, EVENT)).resolves.toBeUndefined();
  });
});
