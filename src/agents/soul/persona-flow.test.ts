/**
 * Persona end-to-end flow test — create → switch → verify roundtrip.
 *
 * Exercises CreatePersonalityTool and SwitchPersonalityTool through their real
 * .execute() methods, wired to a REAL SoulLoader (real temp-dir filesystem) and
 * a REAL UserProfileStore (real in-memory better-sqlite3). No mocks of the units
 * under test, no network, no LLM — only the logger module is stubbed (matching
 * the surrounding test files).
 *
 * Proves: a profile created via the tool lands on disk, the active persona is
 * persisted in SQLite, and both the profile content and the active-persona
 * pointer are retrievable afterwards.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { SoulLoader } from "./soul-loader.js";
import { UserProfileStore } from "../../memory/unified/user-profile-store.js";
import { CreatePersonalityTool } from "../tools/create-personality.js";
import { SwitchPersonalityTool } from "../tools/switch-personality.js";
import type { ToolContext } from "../tools/tool.interface.js";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const JARVIS_CONTENT = `# Jarvis

## Identity
You are Jarvis, a composed and precise assistant.

## Communication Style
Concise, polite, slightly formal.

## Personality
Calm, dependable, and a touch witty.`;

describe("persona create → switch → verify flow (real fs + real sqlite)", () => {
  let testDir: string;
  let db: Database.Database;
  let loader: SoulLoader;
  let store: UserProfileStore;
  let context: ToolContext;

  const USER_ID = "user-roundtrip-1";

  beforeEach(async () => {
    // Real temp project directory for the SoulLoader to read/write profiles.
    testDir = join(tmpdir(), `persona-flow-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "soul.md"), "default personality");

    loader = new SoulLoader(testDir);
    await loader.initialize();

    // Real in-memory SQLite — genuine persistence, no network.
    db = new Database(":memory:");
    store = new UserProfileStore(db);

    // ToolContext wired with the REAL loader + store (cast: the tools detect
    // these via duck-typed structural guards in personality-context.ts).
    context = {
      projectPath: testDir,
      workingDirectory: testDir,
      readOnly: false,
      userId: USER_ID,
      soulLoader: loader,
      userProfileStore: store,
    } as unknown as ToolContext;
  });

  afterEach(async () => {
    if (loader) loader.shutdown();
    if (db) db.close();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  });

  it("creates a profile, switches the active persona, and reads both back", async () => {
    const create = new CreatePersonalityTool();
    const switchTool = new SwitchPersonalityTool();

    // 1. CREATE — writes the profile to .strada-memory/profiles/ on the real fs
    //    and (per the tool) sets it active in the real SQLite store.
    const createResult = await create.execute(
      { name: "jarvis", content: JARVIS_CONTENT },
      context,
    );
    expect(createResult.isError).toBeUndefined();
    expect(createResult.content).toContain("created and activated");

    // The newly created profile is now an available profile on the real loader.
    expect(loader.getProfiles()).toContain("jarvis");

    // Create already activated it in SQLite.
    expect(store.getProfile(USER_ID)?.activePersona).toBe("jarvis");

    // 2. SWITCH — flip to default, then back to jarvis, persisting in SQLite.
    const switchToDefault = await switchTool.execute({ profile: "default" }, context);
    expect(switchToDefault.isError).toBeUndefined();
    expect(store.getProfile(USER_ID)?.activePersona).toBe("default");

    const switchBack = await switchTool.execute({ profile: "jarvis" }, context);
    expect(switchBack.isError).toBeUndefined();
    expect(switchBack.content).toContain("jarvis");

    // 3. VERIFY — the active-persona pointer in SQLite resolves to "jarvis",
    //    and reading that profile back off the real filesystem yields exactly
    //    the content we created.
    const activePersona = store.getProfile(USER_ID)?.activePersona;
    expect(activePersona).toBe("jarvis");

    const persistedContent = await loader.getProfileContent(activePersona!);
    expect(persistedContent).toBe(JARVIS_CONTENT);
  });

  it("survives a fresh SoulLoader instance pointed at the same dir (real disk persistence)", async () => {
    const create = new CreatePersonalityTool();

    const createResult = await create.execute(
      { name: "jarvis", content: JARVIS_CONTENT },
      context,
    );
    expect(createResult.isError).toBeUndefined();

    // Tear down the live loader and spin up a brand-new one over the SAME
    // temp dir — this proves the profile is on disk, not just in memory.
    loader.shutdown();
    const reloaded = new SoulLoader(testDir);
    await reloaded.initialize();
    try {
      expect(reloaded.getProfiles()).toContain("jarvis");
      expect(await reloaded.getProfileContent("jarvis")).toBe(JARVIS_CONTENT);
    } finally {
      reloaded.shutdown();
    }
  });

  it("switch rejects a profile that was never created", async () => {
    const switchTool = new SwitchPersonalityTool();

    const result = await switchTool.execute({ profile: "never-made" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown profile");

    // Active persona in SQLite is untouched (still the default).
    expect(store.getProfile(USER_ID)?.activePersona ?? "default").toBe("default");
  });
});
