/**
 * CAN THIS DELIVERY'S OWN MEASUREMENTS FAIL?
 *
 * Every gate here passes on a fixture at boot (`gate-liveness.ts`). That
 * proves the code fires; it does not prove the gate would have caught a
 * defect in THIS game, whose scenes, modules and assets are nothing like a
 * fixture. The north star asks for the stronger thing: break the delivered
 * project in a way the gate exists to catch, run the SAME measurement over
 * it, and require a refusal.
 *
 * Nothing on disk is touched. A control runs the real reader with an `io`
 * that rewrites one file's contents as it is read, so the project the person
 * receives is never the project a control damaged — and the reader under
 * test is the one the delivery uses, not a copy of it.
 *
 * A control that cannot be set up (the project has no scene to empty, no
 * registration to delete) is reported as such. "Not applicable" is a
 * measurement; silence is not.
 */
import { join } from "node:path";
import {
  assessBuiltAsSpecified,
  defaultBuiltAsSpecifiedIo,
  type BuiltAsSpecifiedIo,
} from "../agents/autonomy/built-as-specified.js";
import { assessUnregisteredServices } from "../agents/autonomy/scene-wiring.js";
import { identityAnswersSpec, readProjectIdentity, PROJECT_SETTINGS_PATH } from "./project-identity.js";

export interface NegativeControl {
  /** The gate under test. */
  readonly gate: string;
  /** What was broken, in the words of the defect it imitates. */
  readonly defect: string;
  /** True when the measurement refused the broken project. */
  readonly fired: boolean;
  /** Why it could not run, when it could not. */
  readonly skipped?: string;
  /** What the measurement said — its refusal, or its silence. */
  readonly detail: string;
}

/** Does any scene under Assets instantiate a prefab? (What control 1 removes.) */
function placesAnyPrefab(projectRoot: string, io: BuiltAsSpecifiedIo): boolean {
  const assets = join(projectRoot, "Assets");
  if (!io.exists(assets)) return false;
  for (const scene of io.listFiles(assets, (f) => f.endsWith(".unity"))) {
    try {
      if (/^\s*m_SourcePrefab:/mu.test(io.readFile(scene))) return true;
    } catch {
      // Unreadable scene: it may hold one, and a control must not claim
      // inapplicability it did not measure.
      return true;
    }
  }
  return false;
}

/** An io that answers with `replace` for the files `rewrite` names, and the real file otherwise. */
function withRewrite(
  base: BuiltAsSpecifiedIo,
  rewrite: (path: string, text: string) => string | undefined,
): BuiltAsSpecifiedIo {
  return {
    ...base,
    readFile: (path: string): string => {
      const real = base.readFile(path);
      return rewrite(path, real) ?? real;
    },
  };
}

/** Every line of a Unity scene that instantiates a prefab, removed. */
function sceneWithoutPrefabs(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*m_SourcePrefab:/u.test(line) && !/^PrefabInstance:/u.test(line))
    .join("\n");
}

/**
 * Run the controls over `projectRoot`, against the document the delivery is
 * judged with. `handheld` is the same reading the delivery gate used.
 */
export function runNegativeControls(
  projectRoot: string,
  gddText: string | undefined,
  handheld: boolean,
  io: BuiltAsSpecifiedIo = defaultBuiltAsSpecifiedIo,
): NegativeControl[] {
  const controls: NegativeControl[] = [];

  // 1. The structural gate: a shipped scene that places nothing.
  const live = (() => {
    try {
      return assessBuiltAsSpecified(projectRoot, io);
    } catch (err) {
      return { threw: err instanceof Error ? err.message : String(err) };
    }
  })();
  if ("threw" in live) {
    controls.push({
      gate: "built as specified",
      defect: "a shipped scene that places nothing",
      fired: false,
      skipped: `the project could not be measured as it is (${live.threw})`,
      detail: "a control over an unmeasurable project would prove nothing",
    });
  } else if (!live.measured) {
    controls.push({
      gate: "built as specified",
      defect: "a shipped scene that places nothing",
      fired: false,
      skipped: `the project could not be measured as it is (${live.incomplete.join("; ") || "no reason given"})`,
      detail: "a control over an unmeasurable project would prove nothing",
    });
  } else if (live.refusal !== undefined) {
    controls.push({
      gate: "built as specified",
      defect: "a shipped scene that places nothing",
      fired: false,
      skipped: "the project is ALREADY refused, so breaking it further measures nothing",
      detail: live.refusal.slice(0, 160),
    });
  } else if (live.shippedScenes.length === 0) {
    // Nothing is enabled in the build, so there is no shipped scene for the
    // defect to apply to. The delivery's own reading already says this;
    // repeating it as a dead gate would be a false alarm.
    controls.push({
      gate: "built as specified",
      defect: "every prefab instance removed from every shipped scene",
      fired: false,
      skipped: "no scene is enabled in the build, so this project ships no scene to break",
      detail: "the structural gate's other readings still stand; this control did not run",
    });
  } else if (!placesAnyPrefab(projectRoot, io)) {
    // Nothing to remove: a scene that instantiates nothing cannot be made
    // emptier, so a control over it would report "did not fire" and read as a
    // dead gate when the truth is that the control never applied.
    controls.push({
      gate: "built as specified",
      defect: "every prefab instance removed from every shipped scene",
      fired: false,
      skipped: "no scene in this project instantiates a prefab, so there is nothing to remove",
      detail: "the structural gate's other readings still stand; this control did not run",
    });
  } else {
    const broken = (() => {
      try {
        return assessBuiltAsSpecified(
          projectRoot,
          withRewrite(io, (path, text) => (path.endsWith(".unity") ? sceneWithoutPrefabs(text) : undefined)),
        );
      } catch {
        return undefined;
      }
    })();
    if (broken === undefined) {
      controls.push({
        gate: "built as specified",
        defect: "every prefab instance removed from every shipped scene",
        fired: false,
        detail: "the measurement threw on the broken project",
      });
    } else if (broken.refusal !== undefined) {
      controls.push({
        gate: "built as specified",
        defect: "every prefab instance removed from every shipped scene",
        fired: true,
        detail: broken.refusal,
      });
    } else if (broken.shippedRenderers > 0) {
      // The scenes draw through something other than prefab instances, so
      // this defect never applied to this game: calling that a dead gate
      // would be the false alarm a control is supposed to prevent.
      controls.push({
        gate: "built as specified",
        defect: "every prefab instance removed from every shipped scene",
        fired: false,
        skipped:
          `the shipped scenes still place ${broken.shippedRenderers} renderer(s) without any prefab instance, ` +
          "so removing them is not the defect this gate catches here",
        detail: "a stronger control would have to empty the scenes themselves",
      });
    } else {
      controls.push({
        gate: "built as specified",
        defect: "every prefab instance removed from every shipped scene",
        fired: false,
        detail: "the broken project ships scenes with 0 renderers and the measurement still passed",
      });
    }
  }

  // 2. The registration gate: the container told about nothing.
  const registeredNow = assessUnregisteredServices(projectRoot, io);
  const brokenRegistrations = assessUnregisteredServices(
    projectRoot,
    withRewrite(io, (path, text) =>
      path.endsWith(".cs") ? text.replace(/\bRegister(?:Service|Controller)\s*</gu, "NotARegistration<") : undefined,
    ),
  );
  if (brokenRegistrations.length === 0) {
    controls.push({
      gate: "service registration",
      defect: "every RegisterService call removed",
      fired: false,
      skipped: "this project declares no service class, so there is nothing to leave unregistered",
      detail: "no `…Service` class was found under Assets",
    });
  } else {
    controls.push({
      gate: "service registration",
      defect: "every RegisterService call removed",
      fired: brokenRegistrations.length > registeredNow.length,
      detail:
        brokenRegistrations.length > registeredNow.length
          ? `names ${brokenRegistrations.length} unregistered service(s) where the delivery names ${registeredNow.length}`
          : `names ${brokenRegistrations.length} either way — removing the registrations changed nothing it reports`,
    });
  }

  // 3. The identity gate: a handheld build with nobody's name on it.
  if (!handheld) {
    controls.push({
      gate: "app identity",
      defect: "the company name and application identifier emptied",
      fired: false,
      skipped: "the document asks for no handheld platform, so this gate does not refuse on identity",
      detail: "not applicable to this document",
    });
  } else {
    const emptied = readProjectIdentity(projectRoot, (path) => {
      const text = io.readFile(path);
      return path.endsWith(PROJECT_SETTINGS_PATH.replace("ProjectSettings/", "")) || path.includes("ProjectSettings")
        ? text.replace(/^(\s*companyName:).*$/mu, "$1 DefaultCompany").replace(/^(\s*applicationIdentifier:).*$/mu, "$1 {}")
        : text;
    });
    const verdict = identityAnswersSpec(emptied, gddText, true);
    controls.push({
      gate: "app identity",
      defect: "the company name and application identifier emptied",
      fired: verdict.refusal !== undefined,
      detail: verdict.refusal ?? "the measurement still passed — a nameless handheld build would have gone out",
    });
  }

  return controls;
}

/** One line per control, and a count a person can read at a glance. */
export function describeNegativeControls(controls: readonly NegativeControl[]): string[] {
  const ran = controls.filter((c) => c.skipped === undefined);
  const fired = ran.filter((c) => c.fired);
  const head =
    ran.length === 0
      ? "Negative controls: none could run on this project — nothing here says the gates would have caught a defect"
      : `Negative controls: ${fired.length} of ${ran.length} gates refused the project once it was broken on purpose` +
        (controls.length > ran.length ? `, ${controls.length - ran.length} not applicable` : "");
  return [
    head,
    ...controls.map((c) =>
      c.skipped === undefined
        ? `- ${c.gate}: ${c.fired ? "FIRED" : "DID NOT FIRE"} on ${c.defect} — ${c.detail.slice(0, 140)}`
        : `- ${c.gate}: not run — ${c.skipped}`,
    ),
  ];
}

/** Where the controls read the settings from, for a caller that wants to say so. */
export const NEGATIVE_CONTROL_SETTINGS_PATH = join("ProjectSettings", "ProjectSettings.asset");
