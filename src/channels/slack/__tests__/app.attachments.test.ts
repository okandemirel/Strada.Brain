/**
 * Slack files against the REAL media validation (audit channels#1).
 *
 * A file that failed validation, failed its magic-byte check or was not
 * described by Slack was skipped with a bare `continue`: no reply, no log, and
 * the caption went on alone. "build the game in this GDD" with a .docx GDD
 * then matched gdd-from-docs and built whatever document sat in docs/.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackChannel } from "../app.js";
import { detectCampaignIntent } from "../../../campaign/campaign-intake.js";
import type { IncomingMessage } from "../../channel-messages.interface.js";

vi.mock("../../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../commands.js", () => ({ registerSlashCommands: vi.fn() }));
vi.mock("@slack/bolt", () => ({ App: vi.fn(), directMention: vi.fn() }));

// Only the network is faked; validation, magic bytes and type mapping are real.
const mockDownloadMedia = vi.fn();
vi.mock("../../../utils/media-processor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/media-processor.js")>()),
  downloadMedia: (...args: unknown[]) => mockDownloadMedia(...args),
}));

const GDD_TEXT =
  "PacMan GDD. The player steers a yellow circle through a maze, eating pellets " +
  "while four ghosts chase it. Eating a power pellet turns the ghosts blue for eight " +
  "seconds so they can be eaten for points. Clearing every pellet advances the level.";

describe("SlackChannel files reach campaign intake or the user is told", () => {
  let channel: SlackChannel;
  let handler: ReturnType<typeof vi.fn>;
  let say: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDownloadMedia.mockReset();
    channel = new SlackChannel({
      botToken: "xoxb-test-token",
      signingSecret: "test-secret",
      appToken: "xapp-test-token",
      socketMode: true,
      allowedWorkspaces: ["T001"],
      allowedUserIds: ["U456"],
    });
    handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    say = vi.fn().mockResolvedValue(undefined);
  });

  async function receive(text: string, files: Array<Record<string, unknown>>): Promise<void> {
    await (channel as unknown as {
      handleIncomingMessage: (message: Record<string, unknown>, say: ReturnType<typeof vi.fn>) => Promise<void>;
    }).handleIncomingMessage(
      { type: "message", subtype: "file_share", user: "U456", team: "T001", channel: "C789", text, ts: "1700000000.000001", files },
      say,
    );
  }

  it("a plain-text GDD arrives with its bytes and is the document the campaign builds", async () => {
    const data = Buffer.from(GDD_TEXT);
    mockDownloadMedia.mockResolvedValue({ data, mimeType: "text/plain", size: data.length });

    await receive("build the game in this GDD", [
      { id: "F1", name: "PacMan_GDD.txt", mimetype: "text/plain", size: data.length, url_private: "https://files.slack.com/f1" },
    ]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(detectCampaignIntent(handler.mock.calls[0]![0] as IncomingMessage)).toMatchObject({
      kind: "gdd-attachment",
      sourceName: "PacMan_GDD.txt",
    });
  });

  it("a .docx GDD the validator refuses is reported to the user and the caption is not forwarded", async () => {
    mockDownloadMedia.mockResolvedValue({ data: Buffer.from("PK\u0003\u0004..."), mimeType: "application/zip", size: 7 });

    await receive("build the game in this GDD", [
      {
        id: "F1",
        name: "PacMan_GDD.docx",
        mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 40_000,
        url_private: "https://files.slack.com/f1",
      },
    ]);

    expect(handler).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(say.mock.calls[0]![0])).toContain("PacMan_GDD.docx");
    expect(JSON.stringify(say.mock.calls[0]![0])).toContain("not accepted");
  });

  it("a document whose download fails is reported, not forwarded without its bytes", async () => {
    mockDownloadMedia.mockResolvedValue(null);

    await receive("build the game in this GDD", [
      { id: "F1", name: "PacMan_GDD.pdf", mimetype: "application/pdf", size: 9_000, url_private: "https://files.slack.com/f1" },
    ]);

    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(say.mock.calls[0]?.[0])).toContain("PacMan_GDD.pdf");
  });

  it("a file-only message whose file is refused gets a reply instead of silence", async () => {
    mockDownloadMedia.mockResolvedValue({ data: Buffer.from("not a pdf"), mimeType: "application/pdf", size: 9 });

    await receive("", [
      { id: "F1", name: "PacMan_GDD.pdf", mimetype: "application/pdf", size: 9, url_private: "https://files.slack.com/f1" },
    ]);

    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(say.mock.calls[0]?.[0])).toContain("PacMan_GDD.pdf");
  });

  it("the reply stays in the thread the file was shared in", async () => {
    mockDownloadMedia.mockResolvedValue(null);

    await (channel as unknown as {
      handleIncomingMessage: (message: Record<string, unknown>, say: ReturnType<typeof vi.fn>) => Promise<void>;
    }).handleIncomingMessage(
      {
        type: "message", subtype: "file_share", user: "U456", team: "T001", channel: "C789",
        text: "build the game in this GDD", ts: "1700000000.000002", thread_ts: "1700000000.000000",
        files: [{ id: "F1", name: "PacMan_GDD.pdf", mimetype: "application/pdf", size: 9_000, url_private: "https://files.slack.com/f1" }],
      },
      say,
    );

    expect(say.mock.calls[0]?.[0]).toMatchObject({ thread_ts: "1700000000.000000" });
  });
});
