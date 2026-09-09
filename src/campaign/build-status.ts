// ---------------------------------------------------------------------------
// The JSON the web portal reads (GET /api/campaign, `campaign:status` frame).
// One shape for both, built from snapshots the daemon already holds. The
// delivery measurement walks Assets/ and is only taken when asked
// (`?measure=1`); its absence is stated, never faked as zeros.
// ---------------------------------------------------------------------------
import type { CampaignStatusSnapshot } from "./campaign-status.js";
import type { RealTreeGuardianSnapshot } from "../daemon/real-tree-guardian.js";
import type { BuiltAsSpecifiedReport } from "../agents/autonomy/built-as-specified.js";

export interface BuildStatusMeasurement {
  readonly measuredAt: string;
  readonly measured: boolean;
  readonly refusal: string | null;
  readonly shippedScenes: readonly string[];
  readonly shippedRenderers: number;
  readonly shippedWorldRenderers: number;
  readonly shippedSpriteRenderers: number;
  readonly shippedMeshRenderers: number;
  readonly artInventory: BuiltAsSpecifiedReport["artInventory"];
  readonly boundPlaceholderSprites: number;
  readonly unbound: { readonly prefabs: number; readonly models: number; readonly sprites: number };
  readonly primitiveCallSites: number;
  readonly incomplete: readonly string[];
}

export interface BuildStatus {
  readonly generatedAt: string;
  readonly projectRoot?: string;
  readonly campaign: CampaignStatusSnapshot | null;
  readonly guardian: RealTreeGuardianSnapshot | null;
  /** null when not requested; `measured:false` when requested but unmeasurable. */
  readonly measurement: BuildStatusMeasurement | null;
  readonly measurementError?: string;
}

export function summarizeMeasurement(report: BuiltAsSpecifiedReport, now: number = Date.now()): BuildStatusMeasurement {
  return {
    measuredAt: new Date(now).toISOString(),
    measured: report.measured,
    refusal: report.refusal ?? null,
    shippedScenes: report.shippedScenes.map((s) => s.scene),
    shippedRenderers: report.shippedRenderers,
    shippedWorldRenderers: report.shippedWorldRenderers,
    shippedSpriteRenderers: report.shippedSpriteRenderers,
    shippedMeshRenderers: report.shippedMeshRenderers,
    artInventory: report.artInventory,
    boundPlaceholderSprites: report.boundPlaceholderSprites,
    unbound: {
      prefabs: report.unboundPrefabs.length,
      models: report.unboundModels.length,
      sprites: report.unboundSprites.length,
    },
    primitiveCallSites: report.primitiveCallSites,
    incomplete: report.incomplete,
  };
}

export async function buildBuildStatus(input: {
  readonly campaign: CampaignStatusSnapshot | undefined;
  readonly guardian: RealTreeGuardianSnapshot | undefined;
  readonly projectRoot?: string;
  readonly measure: boolean;
  /** Test seam; defaults to assessBuiltAsSpecified. */
  readonly measurer?: (projectRoot: string) => BuiltAsSpecifiedReport;
  readonly now?: number;
}): Promise<BuildStatus> {
  const now = input.now ?? Date.now();
  let measurement: BuildStatusMeasurement | null = null;
  let measurementError: string | undefined;
  if (input.measure) {
    if (!input.projectRoot) {
      measurementError = "No project path is configured — nothing to measure.";
    } else {
      try {
        const measurer = input.measurer ?? (await import("../agents/autonomy/built-as-specified.js")).assessBuiltAsSpecified;
        measurement = summarizeMeasurement(measurer(input.projectRoot), now);
      } catch (err) {
        measurementError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return {
    generatedAt: new Date(now).toISOString(),
    projectRoot: input.projectRoot,
    campaign: input.campaign ?? null,
    guardian: input.guardian ?? null,
    measurement,
    ...(measurementError !== undefined ? { measurementError } : {}),
  };
}
