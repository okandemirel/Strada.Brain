/**
 * WHICH FRAMEWORK CONSTRUCT A ROW IS IMPLEMENTED WITH, read from the check the
 * system itself wrote. Measured 2026-10-14 against the north-star scorecard:
 * no requirement row had ever named one, because nothing recorded it — and a
 * planner's or a worker's statement about it would be a claim, which is the
 * class of statement every other gate here refuses.
 */
import { describe, it, expect } from "vitest";
import { constructsNamedBy, DI_PREFIX } from "./acceptance-constructs.js";

describe("constructsNamedBy", () => {
  it("names a framework type the body spells from the root", () => {
    expect(
      constructsNamedBy({
        body: 'var view = Find<global::Strada.Core.Sync.EntityView>("Ship");\nAssert.That(view, Is.Not.Null);',
      }),
    ).toEqual(["Strada.Core.Sync.EntityView"]);
  });

  it("names a module's construct by the path the body wrote, member access included", () => {
    // Telling a type from its member needs a compiler; what matters here is
    // that the check went through the framework at all.
    expect(
      constructsNamedBy({ body: "var screens = global::Strada.Modules.ScreenModule.ScreenStack.Current;" }),
    ).toEqual(["Strada.Modules.ScreenModule.ScreenStack.Current"]);
  });

  it("records a type resolved through the framework's registration as the registration", () => {
    expect(
      constructsNamedBy({
        setup: "yield return Boot();",
        body: "var beam = Service<global::Game.Modules.Harbor.IBeamService>();\nAssert.That(beam.Lit, Is.True);",
      }),
    ).toEqual([`${DI_PREFIX}Game.Modules.Harbor.IBeamService`]);
  });

  it("reads every part the writer returned, and repeats nothing", () => {
    expect(
      constructsNamedBy({
        setup: "var a = Service<global::Game.Modules.Harbor.IBeamService>();",
        act: "yield return TapViewport(0.5f, 0.5f);",
        observe: "global::Strada.Core.Sync.EntityView",
        body: "var b = Service<global::Game.Modules.Harbor.IBeamService>();",
      }),
    ).toEqual([`${DI_PREFIX}Game.Modules.Harbor.IBeamService`, "Strada.Core.Sync.EntityView"]);
  });

  it("names nothing for a check that only reads the game's own surface", () => {
    expect(
      constructsNamedBy({
        body: 'var ships = Find("Ship");\nAssert.That(ships.Length, Is.EqualTo(3));',
      }),
    ).toEqual([]);
    expect(constructsNamedBy({})).toEqual([]);
    expect(constructsNamedBy({ body: "" })).toEqual([]);
  });

  it("does not take a game type for a framework one, nor a Strada-looking name that is not the framework", () => {
    expect(
      constructsNamedBy({
        body: "var x = global::Game.Modules.Harbor.BeamView.Current;\nvar y = global::StradaLike.Core.Thing.Value;",
      }),
    ).toEqual([]);
  });

  it("reads the registered type up to its first generic argument", () => {
    expect(
      constructsNamedBy({ body: "var r = Service<global::Game.Modules.Harbor.IRepo<global::Game.Modules.Harbor.Ship>>();" }),
    ).toEqual([`${DI_PREFIX}Game.Modules.Harbor.IRepo`]);
  });
});
