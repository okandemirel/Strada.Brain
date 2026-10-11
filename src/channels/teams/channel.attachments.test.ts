/**
 * Teams attachments against the REAL media validation (audit channels#1).
 *
 * A file that failed validation or magic bytes was skipped with a bare
 * `continue`, and a document whose download failed went on without its bytes;
 * either way "build the game in this GDD" reached campaign intake without the
 * GDD and built whatever document sat in docs/.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamsChannel } from "./channel.js";
import { detectCampaignIntent } from "../../campaign/campaign-intake.js";
import type { IncomingMessage } from "../channel-messages.interface.js";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Only the network is faked; validation, magic bytes and type mapping are real.
const mockDownloadMedia = vi.fn();
vi.mock("../../utils/media-processor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/media-processor.js")>()),
  downloadMedia: (...args: unknown[]) => mockDownloadMedia(...args),
}));

const GDD_TEXT =
  "PacMan GDD. The player steers a yellow circle through a maze, eating pellets " +
  "while four ghosts chase it. Eating a power pellet turns the ghosts blue for eight " +
  "seconds so they can be eaten for points. Clearing every pellet advances the level.";

describe("TeamsChannel attachments reach campaign intake or the user is told", () => {
  let channel: TeamsChannel;
  let handler: ReturnType<typeof vi.fn>;
  let sendActivity: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDownloadMedia.mockReset();
    channel = new TeamsChannel("app-id", "app-password", 3978, [], "127.0.0.1", true);
    handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    sendActivity = vi.fn().mockResolvedValue({ id: "a1" });
  });

  async function receive(text: string, attachments: Array<Record<string, unknown>>): Promise<void> {
    const context = {
      activity: { type: "message", text, conversation: { id: "chat-1" }, from: { id: "user-1" }, attachments },
      sendActivity,
    };
    (channel as unknown as { adapter: unknown }).adapter = {
      process: async (_req: unknown, _res: unknown, logic: (ctx: unknown) => Promise<void>) => logic(context),
    };
    await (channel as unknown as {
      handleRequest: (req: unknown, res: unknown) => Promise<void>;
    }).handleRequest({ method: "POST", url: "/api/messages" }, { headersSent: false, writeHead: vi.fn(), end: vi.fn() });
  }

  it("a GDD shared as a Teams file arrives with its bytes and is the document the campaign builds", async () => {
    const data = Buffer.from(GDD_TEXT);
    mockDownloadMedia.mockResolvedValue({ data, mimeType: "text/plain", size: data.length });

    await receive("build the game in this GDD", [
      {
        contentType: "application/vnd.microsoft.teams.file.download.info",
        name: "PacMan_GDD.txt",
        content: { downloadUrl: "https://contoso.sharepoint.com/f1", fileType: "txt" },
      },
    ]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(detectCampaignIntent(handler.mock.calls[0]![0] as IncomingMessage)).toMatchObject({
      kind: "gdd-attachment",
      sourceName: "PacMan_GDD.txt",
    });
  });

  it("a .docx GDD the validator refuses is reported to the user and the caption is not forwarded", async () => {
    mockDownloadMedia.mockResolvedValue({
      data: Buffer.from("PK\u0003\u0004..."),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 7,
    });

    await receive("build the game in this GDD", [
      {
        contentType: "application/vnd.microsoft.teams.file.download.info",
        name: "PacMan_GDD.docx",
        content: { downloadUrl: "https://contoso.sharepoint.com/f1", fileType: "docx" },
      },
    ]);

    expect(handler).not.toHaveBeenCalled();
    expect(sendActivity).toHaveBeenCalledTimes(1);
    expect(String(sendActivity.mock.calls[0]![0])).toContain("PacMan_GDD.docx");
    expect(String(sendActivity.mock.calls[0]![0])).toContain("not accepted");
  });

  it("a document whose download fails is reported, not forwarded without its bytes", async () => {
    mockDownloadMedia.mockResolvedValue(null);

    await receive("build the game in this GDD", [
      {
        contentType: "application/vnd.microsoft.teams.file.download.info",
        name: "PacMan_GDD.pdf",
        content: { downloadUrl: "https://contoso.sharepoint.com/f1", fileType: "pdf" },
      },
    ]);

    expect(handler).not.toHaveBeenCalled();
    expect(String(sendActivity.mock.calls[0]?.[0])).toContain("PacMan_GDD.pdf");
  });

  it("the message's own HTML body is not a file: it is neither forwarded as one nor reported", async () => {
    await receive("hello there", [{ contentType: "text/html", content: "<div>hello there</div>" }]);

    expect(mockDownloadMedia).not.toHaveBeenCalled();
    expect(sendActivity).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0]![0] as IncomingMessage).attachments).toBeUndefined();
  });
});
