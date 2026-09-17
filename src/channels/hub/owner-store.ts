// ---------------------------------------------------------------------------
// HubOwnerStore — durable {chatId → channelType} for the HubChannel (plan 2.10,
// audit 12F2/D59).
//
// Which member a chat id belongs to used to live only in memory, so after a
// restart a daemon/goal notification for a persisted chat fell back to
// `claimsChatId` shape-guessing or the primary member. The hub persists nothing
// else, so this is a small JSON file under the Strada home
// (`~/.strada/hub-owners.json`, `STRADA_HOME` respected) written whenever a
// mapping changes and read once at construction. Failures are logged, never
// thrown: a routing hint must not take the channel down.
// ---------------------------------------------------------------------------
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStradaHome } from "../../common/runtime-paths.js";
import { getLoggerSafe } from "../../utils/logger.js";

export const HUB_OWNERS_FILE = "hub-owners.json";

interface OwnersFile {
  version: 1;
  owners: Record<string, string>;
}

export class HubOwnerStore {
  constructor(readonly filePath: string) {}

  /** The default location: `<strada home>/hub-owners.json`. */
  static defaultPath(): string {
    return join(resolveStradaHome(), HUB_OWNERS_FILE);
  }

  load(): Map<string, string> {
    const owners = new Map<string, string>();
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        getLoggerSafe().warn("Hub owner store unreadable — starting without persisted ownership", {
          path: this.filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return owners;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<OwnersFile> | null;
      const entries = parsed && typeof parsed === "object" && parsed.owners && typeof parsed.owners === "object" ? parsed.owners : {};
      for (const [chatId, channelType] of Object.entries(entries)) {
        if (typeof chatId === "string" && chatId && typeof channelType === "string" && channelType) {
          owners.set(chatId, channelType);
        }
      }
    } catch (err) {
      getLoggerSafe().warn("Hub owner store corrupt — starting without persisted ownership", {
        path: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return owners;
  }

  save(owners: ReadonlyMap<string, string>): void {
    const body: OwnersFile = { version: 1, owners: Object.fromEntries(owners) };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
      renameSync(tmp, this.filePath);
    } catch (err) {
      getLoggerSafe().warn("Hub owner store write failed — ownership will not survive a restart", {
        path: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
