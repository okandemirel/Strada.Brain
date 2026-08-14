/**
 * The agent must be told how to choose module boundaries, not just that modules
 * exist.
 *
 * The preamble showed a two-module tree (CoreModule, CombatModule) and said
 * nothing about deciding boundaries. Measured on a live run: asked to build a
 * grid game, the agent produced ONE PixelFlow module and split it internally
 * into Core/Domain/Application/Infrastructure/Presentation — five folders, five
 * assemblies, one concern. Board state, match detection, gravity, scoring, input
 * and presentation all shipped as a single module, so nothing could be replaced,
 * tested or reasoned about on its own.
 *
 * A layer split inside one module is not a decomposition; it is one boundary
 * wearing five names.
 */

import { describe, it, expect } from "vitest";
import { STRADA_AGENT_PREAMBLE } from "./strada-knowledge.js";

describe("module decomposition guidance", () => {
  it("states that a project is many modules, not one", () => {
    expect(STRADA_AGENT_PREAMBLE).toMatch(/Module Decomposition/);
    expect(STRADA_AGENT_PREAMBLE).toMatch(/MANY modules/);
    expect(STRADA_AGENT_PREAMBLE).toMatch(/not one\s+module for the whole game/);
  });

  it("gives a usable test for where a boundary falls", () => {
    // "One concern, changing for one reason" is what makes the rule actionable;
    // without it the agent has a slogan and no way to apply it.
    expect(STRADA_AGENT_PREAMBLE).toMatch(/change for unrelated reasons/);
    expect(STRADA_AGENT_PREAMBLE).toMatch(/one concern end to end/);
  });

  it("names concrete concerns rather than abstractions", () => {
    for (const concern of ["input", "camera", "board", "scoring"]) {
      expect(STRADA_AGENT_PREAMBLE.toLowerCase(), `${concern} not named`).toContain(concern);
    }
  });

  it("says what a module must carry to exist", () => {
    // A folder is not a module: the framework only knows about it once it has an
    // assembly and a config registered through Configure(IModuleBuilder).
    expect(STRADA_AGENT_PREAMBLE).toMatch(/own `\.asmdef`/);
    expect(STRADA_AGENT_PREAMBLE).toMatch(/\*ModuleConfig/);
    expect(STRADA_AGENT_PREAMBLE).toMatch(/Tests\/Runtime/);
  });

  it("rules out the layer-folder substitute explicitly", () => {
    // The measured failure. Without naming it, the agent can satisfy every other
    // line here with Domain/Application/Infrastructure inside one module.
    expect(STRADA_AGENT_PREAMBLE).toMatch(/Layer folders inside a single module/);
    expect(STRADA_AGENT_PREAMBLE).toMatch(/one assembly boundary wearing\s+five names/);
  });

  it("keeps the multi-module file tree it is describing", () => {
    // The rule and the example have to agree, or the example wins.
    expect(STRADA_AGENT_PREAMBLE).toContain("CoreModule/");
    expect(STRADA_AGENT_PREAMBLE).toContain("CombatModule/");
  });

  it("allows a submodule that genuinely belongs to its parent", () => {
    // Nesting is not the problem. A submodule that exists only to serve its
    // parent, and would be meaningless beside it, is a legitimate shape.
    expect(STRADA_AGENT_PREAMBLE).toMatch(/Nest a submodule only when it is genuinely PART OF/);
    expect(STRADA_AGENT_PREAMBLE).toMatch(/GridRenderingModule/);
  });

  it("gives the test for when a submodule should be top-level instead", () => {
    // Without this the rule is a matter of taste; with it there is something to
    // check: could another module depend on this just as well?
    expect(STRADA_AGENT_PREAMBLE).toMatch(/another module could equally depend on/);
  });

  it("rejects a wrapper named after the game", () => {
    // Measured: a run created Assets/Modules/PixelFlowModule/ and started
    // placing real modules inside it. The game is not a concern, so it owns
    // nothing and the wrapper only hides its children.
    expect(STRADA_AGENT_PREAMBLE).toMatch(/named after the game or the feature set/);
    expect(STRADA_AGENT_PREAMBLE).toMatch(/PixelFlowModule\/BoardModule/);
    expect(STRADA_AGENT_PREAMBLE).toMatch(/PixelFlow is the game,\s+not a concern/);
  });

});
