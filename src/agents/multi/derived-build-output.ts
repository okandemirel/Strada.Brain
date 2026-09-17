/**
 * Is this path COMPILER OUTPUT, or work somebody authored?
 *
 * One predicate, one place, because two different decisions turn on it and they
 * disagreed for a while about what "generated" means:
 *
 *   - `WorkspaceLeaseManager.shouldCommitEntry` — whether the file travels back
 *     from a lease into the project at all.
 *   - `judgePublication` (src/tasks/publication.ts) — HOW SERIOUS a conflict on
 *     the file is. A conflict on derived output is disclosed as a note; a
 *     conflict on authored work is a LOSS that fails the task.
 *
 * The two error directions are not symmetric, and the rule below is shaped by
 * that:
 *
 *   - Calling authored work "derived" LOSES IT. The change stays in
 *     .strada/lease-conflicts, the publication says nothing the run authored
 *     was lost, and the task settles green. Silent, permanent from the user's
 *     point of view.
 *   - Calling derived output "authored" only costs a false alarm: a goal fails
 *     over a file the project rebuilds for itself (measured live 2026-09-16
 *     19:03, twice on the same generated NuGet graph).
 *
 * Both have happened. So the rule takes a NAME the toolchain actually writes,
 * in a PLACE the toolchain actually writes it — never a bare directory name.
 */

/** A directory MSBuild names for a build configuration: obj/Debug/…, bin/Release/… */
const CONFIG_DIR = /^(?:Debug|Release)$/i;

/** A target-framework directory: obj/net8.0/…, obj/netstandard2.1/…, bin/net8.0-android/… */
const FRAMEWORK_DIR = /^net(?:standard|coreapp)?[0-9][0-9.]*(?:-[a-z0-9.]+)?$/i;

/**
 * Compilable source. MSBuild's own generated sources (AssemblyInfo, the
 * editorconfig shims, source-generator output) are written UNDER a
 * configuration/target-framework directory, never at the root of `obj/`, so a
 * `.cs` sitting directly in an `obj/` folder is the game's own file in a
 * directory that happens to be called obj — and source is the category where a
 * wrong "derived" verdict destroys hand-written work.
 *
 * Measured 2026-09-17: `Assets/obj/PixelFlow.Runtime.AssemblyInfo.cs`, an
 * authored file, matched the intermediate-name list below and was reported as
 * "nothing the run authored was lost".
 */
const AUTHORED_SOURCE = /\.(?:cs|vb|fs)$/i;

/**
 * The files .NET writes DIRECTLY into `obj/` — restore output, not compile
 * output. These are NAMES .NET writes, not any file with the same extension:
 * `Assets/obj/terrain.cache` is a game's own baked data and was once
 * classified as compiler output (Codex 2026-09-12 T#10).
 */
const INTERMEDIATE_NAME = new RegExp(
  "^(?:" +
    "project\\.(?:assets\\.json|nuget\\.cache|packagespec\\.json)" +
    // NuGet's restore graph, written into obj/ beside the rest: it was not in
    // this list, so it travelled with every lease, the project restored its own
    // copy, and the two CONFLICTED — which failed the goal that had done the
    // work (measured live 2026-09-16 19:03).
    "|.+\\.(?:csproj|vbproj|fsproj)\\.nuget\\.dgspec\\.json" +
    "|.+\\.(?:csproj|vbproj|fsproj)\\.(?:nuget\\.g\\.(?:props|targets)|CopyComplete|FileListAbsolute\\.txt)" +
    "|.+\\.(?:assets|AssemblyInfoInputs|CoreCompileInputs|GeneratedMSBuildEditorConfig)\\.(?:cache|editorconfig)" +
    "|.+\\.sourcelink\\.json" +
  ")$",
  "i",
);

/**
 * Compiler output, at ANY depth.
 *
 * Path-only excludes used to look at a path's FIRST segment, so
 * `Tools/PixelFlowCoreBuild/obj/Debug/…` and its `bin/Debug/…` twin travelled
 * with every lease — and since the project builds them too, all thirteen came
 * back as CONFLICTS and the whole commit published nothing (measured live
 * 2026-09-12 11:26 and 11:51). These are derived from the sources beside them;
 * nothing is lost by leaving them where they were built.
 *
 * `obj/` is .NET's own name for its intermediate directory; `bin/` is only
 * derived when it holds a build configuration, so a repository's own `bin/`
 * of scripts is untouched.
 *
 * @param rel A project-relative path, with either separator.
 */
export function isDerivedBuildOutput(rel: string): boolean {
  const parts = rel.split(/[/\\]/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const next = parts[i + 1] ?? "";
    // `bin` and `obj` are only derived when they hold what a compiler puts
    // there. The bare directory NAME is not enough: a game's own
    // `Assets/Models/obj/Hero.obj` was classified derived and dropped from
    // publication, which loses authored work (Codex 2026-09-12 S#8).
    if (part !== "bin" && part !== "obj") continue;
    // A configuration or target-framework directory IS the toolchain's own
    // signal — everything below one belongs to the build.
    if (CONFIG_DIR.test(next) || FRAMEWORK_DIR.test(next)) return true;
    if (part !== "obj" || i + 2 !== parts.length) continue;
    // A file sitting directly in obj/. Source here is authored: see
    // AUTHORED_SOURCE. `continue` rather than `return`, so a later `obj/Debug`
    // segment in the same path still decides for itself.
    if (AUTHORED_SOURCE.test(next)) continue;
    if (INTERMEDIATE_NAME.test(next)) return true;
  }
  return false;
}
