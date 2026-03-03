import { describe, it, expect } from "vitest";
import {
  createHelpBlocks,
  createConfirmationBlocks,
  createCodeBlockSection,
  createSuccessBlock,
  createErrorBlock,
  createInfoBlock,
  createProcessingBlock,
  createStreamingBlock,
  splitLongText,
  createDivider,
  createContextBlock,
} from "../blocks.js";

describe("Slack Blocks", () => {
  describe("createHelpBlocks", () => {
    it("should create help blocks with default bot name", () => {
      const blocks = createHelpBlocks();
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks[0].type).toBe("header");
    });

    it("should create help blocks with custom bot name", () => {
      const blocks = createHelpBlocks("Custom Bot");
      const header = blocks[0] as { type: string; text: { text: string } };
      expect(header.text.text).toContain("Custom Bot");
    });
  });

  describe("createConfirmationBlocks", () => {
    it("should create confirmation blocks with question and buttons", () => {
      const blocks = createConfirmationBlocks("Delete this file?", "File: test.cs", "action_123");
      
      expect(blocks.length).toBe(3);
      expect(blocks[0].type).toBe("section");
      expect(blocks[2].type).toBe("actions");
    });

    it("should create confirmation blocks without details", () => {
      const blocks = createConfirmationBlocks("Delete this file?", undefined, "action_123");
      
      expect(blocks.length).toBe(2);
    });
  });

  describe("createCodeBlockSection", () => {
    it("should create code block with language", () => {
      const blocks = createCodeBlockSection("const x = 1;", "javascript");
      
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe("section");
    });

    it("should create code block with filename", () => {
      const blocks = createCodeBlockSection("const x = 1;", "javascript", "test.js");
      
      expect(blocks.length).toBe(2);
      expect(blocks[0].type).toBe("context");
    });

    it("should truncate long code", () => {
      const longCode = "x".repeat(3000);
      const blocks = createCodeBlockSection(longCode, "csharp");
      
      expect(blocks.length).toBe(1);
    });
  });

  describe("createSuccessBlock", () => {
    it("should create success block with message", () => {
      const blocks = createSuccessBlock("File created successfully");
      
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe("section");
    });

    it("should create success block with details", () => {
      const blocks = createSuccessBlock("File created", "/path/to/file.cs");
      
      expect(blocks.length).toBe(2);
    });
  });

  describe("createErrorBlock", () => {
    it("should create error block with message", () => {
      const blocks = createErrorBlock("Failed to create file");
      
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe("section");
    });

    it("should create error block with error details", () => {
      const blocks = createErrorBlock("Failed", "Error: Permission denied");
      
      expect(blocks.length).toBe(2);
    });
  });

  describe("createInfoBlock", () => {
    it("should create info block with default emoji", () => {
      const blocks = createInfoBlock("Information message");
      
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe("section");
    });

    it("should create info block with custom emoji", () => {
      const blocks = createInfoBlock("Warning message", "⚠️");
      
      expect(blocks.length).toBe(1);
    });
  });

  describe("createProcessingBlock", () => {
    it("should create processing block", () => {
      const blocks = createProcessingBlock("Generating code");
      
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe("section");
    });
  });

  describe("createStreamingBlock", () => {
    it("should create streaming block with text", () => {
      const blocks = createStreamingBlock("Processing your request...");
      
      expect(blocks.length).toBe(2);
      expect(blocks[0].type).toBe("section");
      expect(blocks[1].type).toBe("context");
    });

    it("should handle empty text", () => {
      const blocks = createStreamingBlock("");
      
      expect(blocks.length).toBe(2);
    });
  });

  describe("splitLongText", () => {
    it("should return single chunk for short text", () => {
      const chunks = splitLongText("Short text", 100);
      
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toBe("Short text");
    });

    it("should split long text into multiple chunks", () => {
      const longText = "Line1\n\nLine2\n\nLine3" + "x".repeat(3000);
      const chunks = splitLongText(longText, 100);
      
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe("createDivider", () => {
    it("should create divider block", () => {
      const block = createDivider();
      
      expect(block.type).toBe("divider");
    });
  });

  describe("createContextBlock", () => {
    it("should create context block with elements", () => {
      const block = createContextBlock(["Element 1", "Element 2"]);
      
      expect(block.type).toBe("context");
      expect(block.elements.length).toBe(2);
    });
  });
});
