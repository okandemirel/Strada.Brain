import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { announceSupervisorDeath, describeSupervisorDeath, telegramChatIdsFromEnv } from "./supervisor-death.js";

const report = {
  at: "2026-09-10T12:00:00.000Z",
  restarts: 10,
  maxRestarts: 10,
  lastExit: { code: 1, signal: null },
  entryPoint: "/install/dist/index.js",
  logHint: "/install/.strada/logs/strada-brain.log",
};

describe("when the supervisor gives up, somebody is told (audited 2026-09-10: it stopped in silence after ten restarts)", () => {
  it("writes the marker atomically and messages every allowed Telegram user, counting what landed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-death-"));
    try {
      const calls: Array<{ url: string; body: string }> = [];
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return { ok: calls.length !== 2 } as Response; // the second chat fails
      }) as unknown as typeof fetch;
      const outcome = await announceSupervisorDeath(report, {
        markerPath: join(dir, ".strada", "supervisor-dead.json"),
        telegram: { token: "123:abc", chatIds: ["11", "22", "33"] },
        fetchImpl,
      });
      expect(outcome).toEqual({ markerWritten: true, telegramAttempted: 3, telegramDelivered: 2 });
      expect(readdirSync(join(dir, ".strada"))).toEqual(["supervisor-dead.json"]);
      expect(JSON.parse(readFileSync(join(dir, ".strada", "supervisor-dead.json"), "utf8")).restarts).toBe(10);
      expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
      expect(JSON.parse(calls[0]!.body)).toMatchObject({ chat_id: "11" });
      expect(JSON.parse(calls[0]!.body).text).toContain("exited 11 times (limit 10), last with exit code 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with no Telegram configured, only the marker is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-death-"));
    try {
      const outcome = await announceSupervisorDeath(report, { markerPath: join(dir, "m.json") });
      expect(outcome).toEqual({ markerWritten: true, telegramAttempted: 0, telegramDelivered: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the token and allowlist from the environment, and names a signal when there was one", () => {
    expect(telegramChatIdsFromEnv({ TELEGRAM_BOT_TOKEN: "t", ALLOWED_TELEGRAM_USER_IDS: "1, 2,x,3" })).toEqual({ token: "t", chatIds: ["1", "2", "3"] });
    expect(telegramChatIdsFromEnv({ TELEGRAM_BOT_TOKEN: "t" })).toBeUndefined();
    expect(telegramChatIdsFromEnv({ ALLOWED_TELEGRAM_USER_IDS: "1" })).toBeUndefined();
    expect(describeSupervisorDeath({ ...report, lastExit: { code: null, signal: "SIGKILL" } })).toContain("last with signal SIGKILL");
  });
});

describe("the next boot reports the death and clears the marker", () => {
  it("turns the marker into one warning sentence and removes the file", async () => {
    const { takeSupervisorDeathMarker } = await import("../core/boot-report.js");
    const { writeFileSync, existsSync, mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sup-marker-"));
    try {
      const path = join(dir, "supervisor-dead.json");
      writeFileSync(path, JSON.stringify(report));
      const line = takeSupervisorDeathMarker(path);
      expect(line).toContain("The supervisor gave up before this boot (2026-09-10T12:00:00.000Z): the daemon exited 11 times (limit 10), last with exit code 1");
      expect(existsSync(path)).toBe(false);
      expect(takeSupervisorDeathMarker(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
