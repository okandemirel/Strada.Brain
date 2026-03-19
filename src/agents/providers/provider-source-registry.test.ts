import { describe, expect, it } from "vitest";
import { extractProviderOfficialSignals } from "./provider-source-registry.js";

describe("provider-source-registry", () => {
  it("extracts MiniMax model ids and feature lines from official source text", () => {
    const signals = extractProviderOfficialSignals(
      "minimax",
      {
        url: "https://platform.minimaxi.com/docs/api-reference/api-overview",
        label: "MiniMax API overview",
        kind: "html",
      },
      `
        <h1>MiniMax API</h1>
        <p>文本生成接口使用 MiniMax-M2.7，MiniMax-M2.7-highspeed。</p>
        <p>模型可以生成对话内容、工具调用，并支持流式输出。</p>
      `,
    );

    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "model",
          value: "MiniMax-M2.7",
        }),
        expect.objectContaining({
          kind: "model",
          value: "MiniMax-M2.7-highspeed",
        }),
      ]),
    );
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "feature",
          tags: expect.arrayContaining(["tool-calling", "streaming"]),
        }),
      ]),
    );
  });
});
