import { describe, expect, it } from "vitest";

import { assessViewLayer } from "./scene-wiring.js";

function io(files: Record<string, string>) {
  return {
    listFiles: () => Object.keys(files),
    readFile: (p: string) => files[p] ?? "",
    exists: () => true,
  };
}

const SERVICE = "namespace Game { public class BoardService : IBoardService { } }";

describe("whether a project can render anything", () => {
  it("reports no views when prefabs exist and nothing drives them", () => {
    // The measured shape: services and systems, prefabs, and no MonoBehaviour.
    const result = assessViewLayer("/p", io({
      "/p/Assets/Modules/Board/BoardService.cs": SERVICE,
      "/p/Assets/Modules/Board/BoardSystem.cs": "public class BoardSystem : SystemBase { }",
      "/p/Assets/Modules/Board/Prefabs/Cube.prefab": "",
    }));

    expect(result?.hasViews).toBe(false);
    expect(result?.prefabCount).toBe(1);
    expect(result?.scriptCount).toBe(2);
  });

  it("counts a MonoBehaviour as a view", () => {
    const result = assessViewLayer("/p", io({
      "/p/Assets/Modules/Board/CubeView.cs": "public class CubeView : MonoBehaviour { }",
      "/p/Assets/Modules/Board/Prefabs/Cube.prefab": "",
    }));

    expect(result?.hasViews).toBe(true);
  });

  it("counts Strada.Core's own bridge as a view", () => {
    const result = assessViewLayer("/p", io({
      "/p/Assets/Modules/Board/CubeBinding.cs": "public class CubeBinding : EntityMediator { }",
      "/p/Assets/Modules/Board/Prefabs/Cube.prefab": "",
    }));

    expect(result?.hasViews).toBe(true);
  });

  it("says nothing about a project with no prefabs to render", () => {
    // A simulation or a library owes nobody a view.
    expect(assessViewLayer("/p", io({ "/p/Assets/Lib/Thing.cs": SERVICE }))).toBeNull();
  });

  it("does not count a test as the project's view layer", () => {
    const result = assessViewLayer("/p", io({
      "/p/Assets/Tests/PlayMode/BootTest.cs": "public class BootTest : MonoBehaviour { }",
      "/p/Assets/Modules/Board/BoardService.cs": SERVICE,
      "/p/Assets/Modules/Board/Prefabs/Cube.prefab": "",
    }));

    expect(result?.hasViews).toBe(false);
    expect(result?.scriptCount).toBe(1);
  });
});
