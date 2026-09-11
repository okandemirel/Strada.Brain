/**
 * The build tool's fenced JSON verdict → the campaign's build evidence.
 * A missing or broken verdict is `ran: false` — disclosed, never a pass.
 */
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlayerBuildOutput, makeRunPlayer, looksLikePlayer } from "./stage-runtime.js";

const artifactDir = mkdtempSync(join(tmpdir(), "build-artifact-"));
// A REAL StandaloneOSX artifact: .app is a bundle DIRECTORY holding Contents,
// and the bundle holds an actual binary. The fixture used to be a 6-byte file,
// which is exactly what an empty file named Game.app is — and the gate passed
// it (Codex 2026-09-11 E#2); then it became a bundle whose only content was a
// 6-byte file, which is what an empty bundle is (G#3).
const realArtifact = join(artifactDir, "Game.app");
mkdirSync(join(realArtifact, "Contents", "MacOS"), { recursive: true });
writeFileSync(join(realArtifact, "Contents", "MacOS", "Game"), Buffer.alloc(64 * 1024, 7));

const built =
  "PLAYER BUILT (StandaloneOSX).\nTarget StandaloneOSX; 2 scene(s): Assets/Scenes/Main.unity, Assets/Scenes/Level.unity; 118 s; 3 warning(s); 0 error(s).\n" +
  "Artifact: /p/Builds/StandaloneOSX/Game.app — 83.9 MB on disk.\n\n```json\n" +
  JSON.stringify({
    ok: true, reasons: [],
    result: { built: true, exitCode: 0, target: "StandaloneOSX", outputPath: realArtifact, sizeBytes: 88_000_000, durationMs: 118_000, warnings: 3, scenes: ["a", "b"], errors: [] },
    artifact: { path: realArtifact, exists: true, sizeBytes: 88_000_000 },
    measuredAt: "2026-09-10T13:00:00.000Z",
  }) + "\n```";

describe("makeRunPlayer — the tool's own failure reaches the caller (Codex 2026-09-11 D#6)", () => {
  const registry = (result: { content?: unknown; isError?: boolean }, names = ["unity_run_player"]) => ({
    getAvailableToolNames: () => names,
    execute: async () => result,
  });

  it("throws what an unsupported host said, and stays silent on success", async () => {
    await expect(makeRunPlayer(registry({ content: "unsupported artifact on this host", isError: true }))("/p", "/p/Game.apk"))
      .rejects.toThrow(/unsupported artifact on this host/);
    await expect(makeRunPlayer(registry({ content: "PLAYER PLAY-THROUGH OK" }))("/p", "/p/Game.app")).resolves.toBeUndefined();
    await expect(makeRunPlayer(registry({}, []))("/p", "/p/Game.app")).rejects.toThrow(/not registered/);
  });
});

describe("parsePlayerBuildOutput", () => {
  it("an existing file that is NOT a player build does not authenticate it (Codex 2026-09-11 D#12)", () => {
    const notAPlayer = join(artifactDir, "package.json");
    writeFileSync(notAPlayer, "{}");
    const claimed = "PLAYER BUILT.\n\n```json\n" + JSON.stringify({ ok: true, reasons: [], artifact: { path: notAPlayer, exists: true } }) + "\n```";
    const parsed = parsePlayerBuildOutput(claimed);
    expect(parsed).toMatchObject({ ran: true, ok: false });
    expect(parsed.reasons?.join(" ")).toContain("not a player artifact");
    // A WebGL folder is a player build — one with a build in it. A six-byte
    // index.html beside nothing else is a page, not a game (Codex G#3).
    const webgl = join(artifactDir, "WebGL");
    mkdirSync(join(webgl, "Build"), { recursive: true });
    writeFileSync(join(webgl, "index.html"), "<html>");
    writeFileSync(join(webgl, "Build", "game.data"), Buffer.alloc(256 * 1024, 3));
    // …and the page has to load the build beside it (L#17).
    expect(looksLikePlayer(webgl)).toBe(false);
    writeFileSync(join(webgl, "index.html"), `<html><script src="Build/game.loader.js"></script></html>`);
    expect(looksLikePlayer(webgl)).toBe(true);
    expect(looksLikePlayer(notAPlayer)).toBe(false);
  });

  it("a claimed artifact that is NOT on disk is not a successful build (Codex 2026-09-11 C#12)", () => {
    const claimed = "PLAYER BUILT.\n\n```json\n" + JSON.stringify({ ok: true, reasons: [], artifact: { path: "/does/not/exist/Game.app", exists: true } }) + "\n```";
    const parsed = parsePlayerBuildOutput(claimed);
    expect(parsed).toMatchObject({ ran: true, ok: false });
    expect(parsed.reasons?.join(" ")).toContain("is not on disk");
  });

  it("ok WITHOUT an artifact on disk is not a successful build (Codex 2026-09-11 B#3)", () => {
    const noArtifact = "PLAYER BUILT.\n\n```json\n" + JSON.stringify({ ok: true, reasons: [], artifact: { exists: false } }) + "\n```";
    const parsed = parsePlayerBuildOutput(noArtifact);
    expect(parsed).toMatchObject({ ran: true, ok: false });
    expect(parsed.reasons?.join(" ")).toContain("named no artifact");
    expect(parsed.artifactPath).toBeUndefined();
  });

  it("a built player: ran, ok, artifact path and size, target, duration, scene count", () => {
    expect(parsePlayerBuildOutput(built)).toEqual({
      ran: true, ok: true, reasons: [], target: "StandaloneOSX", durationMs: 118_000, scenes: 2,
      artifactPath: realArtifact, sizeBytes: 88_000_000,
      detail: "PLAYER BUILT (StandaloneOSX).", measuredAt: "2026-09-10T13:00:00.000Z",
    });
  });

  it("a failed build keeps its reasons and names no artifact; an artifact that does not exist is not one", () => {
    const failed = "PLAYER BUILD FAILED.\n```json\n" + JSON.stringify({ ok: false, reasons: ["build failed with exit code 21"], result: { target: "Android", scenes: [], durationMs: 5 }, artifact: { path: "/p/x.apk", exists: false, sizeBytes: 0 } }) + "\n```";
    expect(parsePlayerBuildOutput(failed)).toMatchObject({ ran: true, ok: false, reasons: ["build failed with exit code 21"], target: "Android" });
    expect(parsePlayerBuildOutput(failed).artifactPath).toBeUndefined();
  });

  it("no verdict, or a broken one, is NOT MEASURED with the first line as the reason", () => {
    expect(parsePlayerBuildOutput("Unity crashed before the builder ran\nmore")).toEqual({ ran: false, detail: "Unity crashed before the builder ran" });
    expect(parsePlayerBuildOutput("")).toEqual({ ran: false, detail: "the build tool returned no verdict" });
    expect(parsePlayerBuildOutput("x\n```json\n{not json\n```")).toEqual({ ran: false, detail: "the build tool's verdict was not valid JSON" });
  });
});

describe("a named player artifact must BE one (Codex 2026-09-11 E#2, G#3)", () => {
  // A real container ends with its central directory; "PK\u0003\u0004" and
  // padding is a first-bytes costume (Codex 2026-09-11 L#17).
  const zip = (bytes: number): Buffer => Buffer.concat([
    Buffer.from("PK\u0003\u0004", "latin1"),
    Buffer.alloc(bytes, 9),
    Buffer.from("PK\u0005\u0006", "latin1"),
    Buffer.alloc(18),
  ]);
  /** An ELF header shape: class, endianness, e_type EXEC and a machine. */
  const elf = (payload: Buffer): Buffer => {
    const head = Buffer.alloc(64);
    head[0] = 0x7f; head.write("ELF", 1, "latin1");
    head[4] = 2; head[5] = 1; head[6] = 1;
    head.writeUInt16LE(2, 16); // e_type = ET_EXEC
    head.writeUInt16LE(0x3e, 18); // e_machine = x86-64
    return Buffer.concat([head, payload]);
  };

  it("rejects a name, a size and a padded file; accepts a real package", () => {
    const empty = join(artifactDir, "empty.app");
    writeFileSync(empty, "");
    expect(looksLikePlayer(empty)).toBe(false);

    // Big enough, and nothing but padding: no package header.
    const padded = join(artifactDir, "Padded.apk");
    writeFileSync(padded, "x".repeat(131_072));
    expect(looksLikePlayer(padded)).toBe(false);

    // A real ZIP container, but too small to be a game.
    const tinyApk = join(artifactDir, "tiny.apk");
    writeFileSync(tinyApk, zip(1024));
    expect(looksLikePlayer(tinyApk)).toBe(false);

    // A real, plausible package.
    const realApk = join(artifactDir, "real.apk");
    writeFileSync(realApk, zip(256 * 1024));
    expect(looksLikePlayer(realApk)).toBe(true);

    // A LINUX player is an ELF binary, and the macOS branch used to demand
    // Mach-O of it — refusing a perfectly good build (Codex 2026-09-11 I#15).
    const linux = join(artifactDir, "Game.x86_64");
    // 0x7f "ELF", the 64-bit class byte, and the executable bit: a header
    // shape, not four magic bytes (Codex 2026-09-11 K#12).
    writeFileSync(linux, elf(Buffer.alloc(256 * 1024, 1)));
    chmodSync(linux, 0o755);
    expect(looksLikePlayer(linux)).toBe(true);
    // …a well-formed header with no execute permission is not a player.
    chmodSync(linux, 0o644);
    expect(looksLikePlayer(linux)).toBe(false);
    chmodSync(linux, 0o755);
    // …and neither is one whose class byte is nonsense.
    const badClass = join(artifactDir, "BadClass.x86_64");
    const wrongClass = elf(Buffer.alloc(256 * 1024, 1)); wrongClass[4] = 9;
    writeFileSync(badClass, wrongClass);
    chmodSync(badClass, 0o755);
    expect(looksLikePlayer(badClass)).toBe(false);
    const notElf = join(artifactDir, "Fake.x86_64");
    writeFileSync(notElf, Buffer.alloc(256 * 1024, 0x41));
    expect(looksLikePlayer(notElf)).toBe(false);
  });

  it("rejects an EMPTY bundle and accepts one with a binary in it", () => {
    // The directory names are right and there is nothing inside anywhere.
    const hollow = join(artifactDir, "Hollow.app");
    mkdirSync(join(hollow, "Contents", "MacOS"), { recursive: true });
    expect(looksLikePlayer(hollow)).toBe(false);
    // A plist alone is metadata, not a player.
    writeFileSync(join(hollow, "Contents", "Info.plist"), "<plist/>");
    expect(looksLikePlayer(hollow)).toBe(false);
    // The bundle with a real binary in it is a player.
    expect(looksLikePlayer(realArtifact)).toBe(true);
    // A WEB BUILD IS ITS DATA: a padded index.html with no Build folder is a
    // page, not a game (Codex 2026-09-11 I#15).
    const webgl = join(artifactDir, "WebGL2");
    mkdirSync(webgl, { recursive: true });
    writeFileSync(join(webgl, "index.html"), `<html><script src="Build/game.loader.js"></script>${"<!-- pad -->".repeat(1000)}</html>`);
    expect(looksLikePlayer(webgl)).toBe(false);
    mkdirSync(join(webgl, "Build"), { recursive: true });
    writeFileSync(join(webgl, "Build", "game.data"), Buffer.alloc(256 * 1024, 5));
    expect(looksLikePlayer(webgl)).toBe(true);
  });
});

describe("a build folder must hold a build (Codex 2026-09-11 J#23)", () => {
  it("rejects an empty Build/ beside a padded page, and a near-miss ELF header", () => {
    const web = join(artifactDir, "WebGL3");
    mkdirSync(join(web, "Build"), { recursive: true });
    writeFileSync(join(web, "index.html"), `<html><script src="Build/game.loader.js"></script>${"<!-- pad -->".repeat(1000)}</html>`);
    // The payload has to be INSIDE the build directory.
    expect(looksLikePlayer(web)).toBe(false);
    writeFileSync(join(web, "Build", "game.data"), Buffer.alloc(256 * 1024, 2));
    expect(looksLikePlayer(web)).toBe(true);

    // "AELF" is not an ELF header.
    const nearMiss = join(artifactDir, "NearMiss.x86_64");
    writeFileSync(nearMiss, Buffer.concat([Buffer.from("AELF", "latin1"), Buffer.alloc(256 * 1024, 1)]));
    expect(looksLikePlayer(nearMiss)).toBe(false);
  });
});

describe("a build folder holding only a log is not a build (Codex 2026-09-11 K#12)", () => {
  it("wants the page and the data, not one of them", () => {
    const logOnly = join(artifactDir, "WebGL4");
    mkdirSync(join(logOnly, "Build"), { recursive: true });
    writeFileSync(join(logOnly, "index.html"), `<html><script src="Build/game.loader.js"></script>${"<!-- pad -->".repeat(1000)}</html>`);
    writeFileSync(join(logOnly, "Build", "build.log"), "A".repeat(4096));
    expect(looksLikePlayer(logOnly)).toBe(false);

    // Data with no page at all is not something anyone can open.
    const dataOnly = join(artifactDir, "WebGL5");
    mkdirSync(join(dataOnly, "Build"), { recursive: true });
    writeFileSync(join(dataOnly, "Build", "game.data"), Buffer.alloc(256 * 1024, 4));
    expect(looksLikePlayer(dataOnly)).toBe(false);

    // Both: a build.
    // A PAGE THAT LOADS NOTHING is not a web build: "<html>a WebGL build</html>"
    // beside 4 KB of zeros passed as a delivered game (Codex 2026-09-11 L#17).
    writeFileSync(join(dataOnly, "index.html"), "<html>a WebGL build</html>");
    expect(looksLikePlayer(dataOnly)).toBe(false);
    writeFileSync(join(dataOnly, "index.html"), `<html><script src="Build/game.loader.js"></script></html>`);
    expect(looksLikePlayer(dataOnly)).toBe(true);
  });
});

describe("magic bytes are a costume, not a player (Codex 2026-09-11 L#17, L#18)", () => {
  const elfHeader = (): Buffer => {
    const head = Buffer.alloc(64);
    head[0] = 0x7f; head.write("ELF", 1, "latin1");
    head[4] = 2; head[5] = 1; head[6] = 1;
    head.writeUInt16LE(2, 16);
    head.writeUInt16LE(0x3e, 18);
    return head;
  };

  it("refuses five magic bytes followed by 65 531 zeros", () => {
    // Exactly the artifact that reached `done`: the magic, the class byte,
    // the executable bit, and nothing else in the file at all.
    const fake = join(artifactDir, "FakeElf.x86_64");
    writeFileSync(fake, Buffer.concat([Buffer.from([0x7f]), Buffer.from("ELF", "latin1"), Buffer.from([2]), Buffer.alloc(65_536 - 5)]));
    chmodSync(fake, 0o755);
    expect(looksLikePlayer(fake)).toBe(false);

    // …an ELF header shape with no content behind it is still not a player.
    const hollow = join(artifactDir, "Hollow.x86_64");
    writeFileSync(hollow, Buffer.concat([elfHeader(), Buffer.alloc(2 * 1024 * 1024)]));
    chmodSync(hollow, 0o755);
    expect(looksLikePlayer(hollow)).toBe(false);

    // …and a header that declares no executable type is not one either.
    const notExec = join(artifactDir, "NotExec.x86_64");
    const relocatable = elfHeader(); relocatable.writeUInt16LE(1, 16);
    writeFileSync(notExec, Buffer.concat([relocatable, Buffer.alloc(256 * 1024, 7)]));
    chmodSync(notExec, 0o755);
    expect(looksLikePlayer(notExec)).toBe(false);

    // A ZIP is its central directory, not its first two bytes.
    const costume = join(artifactDir, "Costume.apk");
    writeFileSync(costume, Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), Buffer.alloc(256 * 1024, 3)]));
    expect(looksLikePlayer(costume)).toBe(false);

    // An MZ with no PE signature behind it is not a Windows player.
    const mz = join(artifactDir, "Costume.exe");
    writeFileSync(mz, Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(256 * 1024, 3)]));
    expect(looksLikePlayer(mz)).toBe(false);
    const pe = Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(256 * 1024, 3)]);
    pe.writeUInt32LE(0x80, 0x3c);
    pe.write("PE\u0000\u0000", 0x80, "latin1");
    writeFileSync(mz, pe);
    expect(looksLikePlayer(mz)).toBe(true);
  });

  it("accepts a web build whose entry page is not called index.html (L#18)", () => {
    // Renaming the entry page does not invalidate its relative references,
    // and refusing it made a perfectly good build undeliverable.
    const web = join(artifactDir, "WebGL6");
    mkdirSync(join(web, "Build"), { recursive: true });
    writeFileSync(join(web, "play.html"), `<html><script src="Build/game.loader.js"></script></html>`);
    writeFileSync(join(web, "Build", "game.data"), Buffer.alloc(256 * 1024, 5));
    expect(looksLikePlayer(web)).toBe(true);
  });
});
