// ---------------------------------------------------------------------------
// HubOwnerStore — cross-process ownership writes (Codex round 9 #31).
//
// Two store instances over ONE database file are the two daemons: the store
// must never rewrite a binding it was not asked to change, because the value
// it last read may already be stale.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HubOwnerStore, HUB_OWNERS_DB_FILE, HUB_OWNERS_LEGACY_FILE, HUB_OWNERS_MIGRATED_SUFFIX } from "./owner-store.js";
import { openDescriptorsOn } from "../../tests/helpers/open-handles.js";

const loggerStub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
vi.mock("../../utils/logger.js", () => ({ getLoggerSafe: () => loggerStub, getLogger: () => loggerStub }));

const SLACK_CHAT = "C123:1700000000.000100";
const TELEGRAM_CHAT = "222333";

describe("HubOwnerStore", () => {
  let dir: string;
  let dbPath: string;
  let legacyPath: string;
  const opened: HubOwnerStore[] = [];

  const store = (): HubOwnerStore => {
    const s = new HubOwnerStore(dbPath);
    opened.push(s);
    return s;
  };

  beforeEach(() => {
    for (const key of ["warn", "info", "debug", "error"] as const) loggerStub[key].mockReset();
    dir = mkdtempSync(join(tmpdir(), "hub-owner-store-"));
    dbPath = join(dir, HUB_OWNERS_DB_FILE);
    legacyPath = join(dir, HUB_OWNERS_LEGACY_FILE);
  });

  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Round 9 #31: bind() used to pass its ENTIRE first-read map into a
  // whole-file replace, so a value another daemon had changed in the meantime
  // was overwritten by the stale one this daemon happened to be holding.
  it("never rewrites a chat it was not asked to change, even from a stale view", () => {
    const daemonA = store();
    const daemonB = store();
    daemonA.bind(SLACK_CHAT, "slack");

    // What daemon A is holding in memory…
    const staleView = daemonA.load();
    expect(staleView.get(SLACK_CHAT)).toBe("slack");
    // …while daemon B rebinds that very chat to the channel it really lives on.
    daemonB.bind(SLACK_CHAT, "telegram");

    // Daemon A now learns an UNRELATED chat. Its read of the store is stale;
    // the write must still touch only the chat it is binding.
    const readsStale = vi.spyOn(daemonA, "load").mockReturnValue(staleView);
    daemonA.bind(TELEGRAM_CHAT, "telegram");
    readsStale.mockRestore();

    const onDisk = store().load();
    expect(onDisk.get(SLACK_CHAT)).toBe("telegram");
    expect(onDisk.get(TELEGRAM_CHAT)).toBe("telegram");
  });

  // Round 9 #31: two daemons that both read the file and then renamed their
  // own snapshots kept only the last writer's binding.
  it("keeps both bindings when two stores write from the same stale view", () => {
    const daemonA = store();
    const daemonB = store();
    // Both read the store while it was still empty (the interleaving the
    // read-merge-rename file could not survive).
    const readsEmptyA = vi.spyOn(daemonA, "load").mockReturnValue(new Map());
    const readsEmptyB = vi.spyOn(daemonB, "load").mockReturnValue(new Map());
    daemonA.bind(SLACK_CHAT, "slack");
    daemonB.bind(TELEGRAM_CHAT, "telegram");
    readsEmptyA.mockRestore();
    readsEmptyB.mockRestore();

    const onDisk = store().load();
    expect(onDisk.get(SLACK_CHAT)).toBe("slack");
    expect(onDisk.get(TELEGRAM_CHAT)).toBe("telegram");
    expect(onDisk.size).toBe(2);
  });

  it("round-trips bindings and lets a rebind replace one without touching the others", () => {
    const writer = store();
    writer.bind(SLACK_CHAT, "slack");
    writer.bind(TELEGRAM_CHAT, "telegram");
    writer.bind(SLACK_CHAT, "web");

    const onDisk = store().load();
    expect(onDisk.get(SLACK_CHAT)).toBe("web");
    expect(onDisk.get(TELEGRAM_CHAT)).toBe("telegram");
    expect(onDisk.size).toBe(2);
    expect(loggerStub.warn).not.toHaveBeenCalled();
  });

  // The JSON file is imported ONCE so an upgrade loses nobody's bindings, and
  // it is renamed aside rather than deleted.
  it("imports an existing hub-owners.json once and keeps it as .migrated", () => {
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, owners: { [SLACK_CHAT]: "slack", [TELEGRAM_CHAT]: "telegram", "": "web", bad: 7 } }),
      "utf8",
    );

    const migrated = store().load();
    expect(migrated.get(SLACK_CHAT)).toBe("slack");
    expect(migrated.get(TELEGRAM_CHAT)).toBe("telegram");
    expect(migrated.size).toBe(2); // the empty id and the non-string value are skipped
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}${HUB_OWNERS_MIGRATED_SUFFIX}`)).toBe(true);
    expect(JSON.parse(readFileSync(`${legacyPath}${HUB_OWNERS_MIGRATED_SUFFIX}`, "utf8"))).toMatchObject({
      owners: { [SLACK_CHAT]: "slack" },
    });

    // A rebind after the migration is not undone by a later construction, and
    // the file is not imported twice.
    store().bind(SLACK_CHAT, "telegram");
    expect(store().load().get(SLACK_CHAT)).toBe("telegram");
  });

  it("lets a database row win over the legacy file for the same chat", () => {
    store().bind(SLACK_CHAT, "telegram"); // the live value
    writeFileSync(legacyPath, JSON.stringify({ version: 1, owners: { [SLACK_CHAT]: "slack" } }), "utf8");

    expect(store().load().get(SLACK_CHAT)).toBe("telegram");
  });

  it("tolerates a corrupt legacy file: it is left in place and the store still works", () => {
    writeFileSync(legacyPath, "{not json", "utf8");

    const s = store();
    expect(s.load().size).toBe(0);
    expect(loggerStub.warn).toHaveBeenCalledWith(expect.stringMatching(/corrupt/i), expect.objectContaining({ path: legacyPath }));
    expect(existsSync(legacyPath)).toBe(true);

    s.bind(SLACK_CHAT, "slack");
    expect(store().load().get(SLACK_CHAT)).toBe("slack");
  });

  it("degrades to a no-op instead of throwing when the database cannot be opened", () => {
    writeFileSync(dbPath, "this is not a sqlite database", "utf8");

    const s = store();
    expect(() => s.bind(SLACK_CHAT, "slack")).not.toThrow();
    expect(s.load().size).toBe(0);
    expect(loggerStub.warn).toHaveBeenCalledWith(expect.stringMatching(/unavailable/i), expect.objectContaining({ path: dbPath }));
    // Windows 2026-09-26: the failed open kept its connection, so the file
    // stayed locked (EBUSY) for the life of the process.
    expect(openDescriptorsOn(dbPath)).toBe(0);
  });

  it("defaults to the Strada home", () => {
    const home = mkdtempSync(join(tmpdir(), "hub-owner-home-"));
    const saved = process.env["STRADA_HOME"];
    process.env["STRADA_HOME"] = home;
    try {
      expect(HubOwnerStore.defaultPath()).toBe(join(home, HUB_OWNERS_DB_FILE));
    } finally {
      if (saved === undefined) delete process.env["STRADA_HOME"];
      else process.env["STRADA_HOME"] = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
