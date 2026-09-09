// ---------------------------------------------------------------------------
// unity_delivery_measure — the campaign's delivery assessment, as a tool.
//
// Measured 2026-09-09 10:25-11:25 on the placeholder-art mission: its first
// node, "Measure and record initial placeholder-grade sprite count using
// tools", spent an hour reading and writing code because no tool exposed the
// inventory the campaign's own gate reads (assessBuiltAsSpecified). Every
// delivery verdict — placeholder-grade sprites, shipped renderers, unbound
// prefabs — is now one read-only call away, so a run can MEASURE instead of
// estimating or re-implementing.
// ---------------------------------------------------------------------------
import type { ToolContext, ToolExecutionResult } from "../tool.interface.js";
import { assessBuiltAsSpecified } from "../../autonomy/built-as-specified.js";

const MAX_LISTED_PATHS = 60;

export class UnityDeliveryMeasureTool {
  readonly name = "unity_delivery_measure";
  readonly description =
    "Measure the project the way the delivery gate does: shipped scenes and what they render, the art " +
    "inventory (prefabs, models, sprites, how many sprites are placeholder-grade and which), unbound " +
    "prefabs/models/sprites, and the structural refusal if any. Read-only. Use it for any count you " +
    "would otherwise estimate; report its numbers verbatim.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      listPlaceholders: {
        type: "boolean",
        description: `Also list placeholder-grade sprite paths (up to ${MAX_LISTED_PATHS}, bound ones first). Default true.`,
      },
    },
  };

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const listPlaceholders = input["listPlaceholders"] !== false;
    let report: ReturnType<typeof assessBuiltAsSpecified>;
    try {
      report = assessBuiltAsSpecified(context.projectPath);
    } catch (err) {
      return { content: `Error: delivery measurement failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    if (!report.measured) {
      return {
        content: "Error: the project could not be measured (no Assets/ to read, or the walk did not complete) — nothing here is a count.",
        isError: true,
      };
    }
    const placeholders = report.placeholderSpritePaths ?? [];
    const payload = {
      measuredAt: new Date().toISOString(),
      projectPath: context.projectPath,
      refusal: report.refusal ?? null,
      shippedScenes: report.shippedScenes.map((s) => s.scene),
      shippedRenderers: report.shippedRenderers,
      shippedWorldRenderers: report.shippedWorldRenderers,
      artInventory: report.artInventory,
      unbound: {
        prefabs: report.unboundPrefabs.length,
        models: report.unboundModels.length,
        sprites: report.unboundSprites.length,
      },
      placeholderSprites: {
        count: report.artInventory.placeholderSprites,
        listed: listPlaceholders ? placeholders.slice(0, MAX_LISTED_PATHS) : [],
        listedIsPartial: listPlaceholders && placeholders.length > MAX_LISTED_PATHS,
      },
    };
    return { content: JSON.stringify(payload, null, 2) };
  }
}
