import { describe, it, expect } from "vitest";
import { selectNodeTools, isNodeScopedTask, NODE_SCOPE_MARKER, NODE_CORE_TOOLS } from "./node-tool-offer.js";

const registry = [
  "file_read", "file_write", "file_edit", "grep_search", "glob_search", "git_status", "git_commit",
  "unity_verify_change", "unity_delivery_measure", "unity_playthrough",
  "unity_generate_sprite", "unity_generate_mesh", "unity_generate_audio", "unity_bind_sprite", "unity_place_prefab",
  "unity_animation_play", "unity_navmesh_bake", "unity_my_assets_cloud", "unity_scene_build", "unity_prerender_frames",
  "strada_create_module", "strada_scaffold_feature", "code_quality",
].map((name) => ({ name, chars: name.length }));

const batchNode =
  "Batch 2: call unity_delivery_measure once and take the first 24 placeholder paths; then call unity_generate_sprite exactly TWICE " +
  "with batch of 12; then unity_delivery_measure again, run unity_verify_change, and commit.\n\n" + NODE_SCOPE_MARKER;

describe("a plan node is offered the tools its task names, their families, and the core — not the whole registry (measured 2026-09-10: 106 tools, 73 352 chars per turn)", () => {
  it("names the tools in the text, keeps their family and the core, withholds the rest", () => {
    const offer = selectNodeTools(batchNode, registry);
    expect(offer.narrowed).toBe(true);
    expect(offer.named).toEqual(["unity_delivery_measure", "unity_generate_sprite", "unity_verify_change"]);
    const names = offer.offered.map((t) => t.name);
    for (const n of ["unity_generate_sprite", "unity_generate_mesh", "unity_generate_audio", "unity_delivery_measure", "unity_verify_change", "file_read", "git_commit", "grep_search"]) {
      expect(names, n).toContain(n);
    }
    for (const n of ["unity_animation_play", "unity_navmesh_bake", "unity_my_assets_cloud", "strada_create_module", "code_quality", "unity_scene_build"]) {
      expect(names, n).not.toContain(n);
    }
    expect(offer.withheld).toBeGreaterThan(5);
  });

  it("a node that names no tool keeps the whole offer — narrowing on a guess would hide the tool it needed", () => {
    const offer = selectNodeTools("Implement the driver adapter over the game's flow and input services.\n\n" + NODE_SCOPE_MARKER, registry);
    expect(offer.narrowed).toBe(false);
    expect(offer.offered).toHaveLength(registry.length);
    expect(offer.withheld).toBe(0);
  });

  it("matches whole identifiers only", () => {
    const offer = selectNodeTools("Run unity_verify_change_report and unity_bind_sprite. " + NODE_SCOPE_MARKER, registry);
    expect(offer.named).toEqual(["unity_bind_sprite"]);
    expect(offer.offered.map((t) => t.name)).toContain("unity_verify_change"); // core, not named
  });

  it("the marker decides whether a task is node-scoped", () => {
    expect(isNodeScopedTask("do the thing")).toBe(false);
    expect(isNodeScopedTask("do the thing\n\n" + NODE_SCOPE_MARKER + "\nYou are executing ONE node")).toBe(true);
    expect(NODE_CORE_TOOLS.has("unity_playthrough")).toBe(true);
  });
});
