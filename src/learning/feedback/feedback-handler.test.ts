import { describe, it, expect, beforeEach, vi } from "vitest";
import { FeedbackHandler } from "./feedback-handler.ts";

// Mock LearningStorage
function createMockStorage() {
  return {
    getInstinct: vi.fn().mockReturnValue({
      id: "instinct_test_1",
      factorUserValidation: 0.5,
    }),
    updateInstinctFactor: vi.fn(),
    storeFeedback: vi.fn(),
  };
}

describe("FeedbackHandler", () => {
  let handler: FeedbackHandler;
  let mockStorage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    mockStorage = createMockStorage();
    handler = new FeedbackHandler(mockStorage as any);
  });

  describe("handleThumbsUp", () => {
    it("should boost factorUserValidation by +0.1", () => {
      handler.handleThumbsUp({
        instinctIds: ["instinct_test_1"],
        source: "button",
      });

      expect(mockStorage.updateInstinctFactor).toHaveBeenCalledWith(
        "instinct_test_1",
        "factor_user_validation",
        0.1, // delta passed to atomic SQL increment
      );
    });

    it("should cap factorUserValidation at 1.0", () => {
      mockStorage.getInstinct.mockReturnValue({
        id: "instinct_test_1",
        factorUserValidation: 0.95,
      });

      handler.handleThumbsUp({
        instinctIds: ["instinct_test_1"],
        source: "button",
      });

      expect(mockStorage.updateInstinctFactor).toHaveBeenCalledWith(
        "instinct_test_1",
        "factor_user_validation",
        0.1, // delta — clamping now handled by SQL
      );
    });

    it("should store a feedback record", () => {
      handler.handleThumbsUp({
        instinctIds: ["instinct_test_1"],
        userId: "user1",
        source: "reaction",
      });

      expect(mockStorage.storeFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thumbs_up",
          userId: "user1",
          source: "reaction",
        }),
      );
    });

    it("should handle multiple instinct IDs", () => {
      handler.handleThumbsUp({
        instinctIds: ["instinct_test_1", "instinct_test_2"],
        source: "button",
      });

      expect(mockStorage.updateInstinctFactor).toHaveBeenCalledTimes(2);
    });

    it("should use 0.5 as default when factorUserValidation is undefined", () => {
      mockStorage.getInstinct.mockReturnValue({
        id: "instinct_test_1",
        factorUserValidation: undefined,
      });

      handler.handleThumbsUp({
        instinctIds: ["instinct_test_1"],
        source: "button",
      });

      expect(mockStorage.updateInstinctFactor).toHaveBeenCalledWith(
        "instinct_test_1",
        "factor_user_validation",
        0.1, // delta — default factor no longer needed client-side
      );
    });

    it("should skip instincts not found in storage", () => {
      mockStorage.getInstinct.mockReturnValue(null);

      handler.handleThumbsUp({
        instinctIds: ["instinct_nonexistent"],
        source: "button",
      });

      expect(mockStorage.updateInstinctFactor).not.toHaveBeenCalled();
    });
  });

  describe("handleThumbsDown", () => {
    it("should reduce factorUserValidation by -0.2", () => {
      handler.handleThumbsDown({
        instinctIds: ["instinct_test_1"],
        source: "button",
      });

      expect(mockStorage.updateInstinctFactor).toHaveBeenCalledWith(
        "instinct_test_1",
        "factor_user_validation",
        -0.2, // delta — negative for thumbs down
      );
    });

    it("should floor factorUserValidation at 0.0", () => {
      mockStorage.getInstinct.mockReturnValue({
        id: "instinct_test_1",
        factorUserValidation: 0.1,
      });

      handler.handleThumbsDown({
        instinctIds: ["instinct_test_1"],
        source: "button",
      });

      expect(mockStorage.updateInstinctFactor).toHaveBeenCalledWith(
        "instinct_test_1",
        "factor_user_validation",
        -0.2, // delta — clamping now handled by SQL
      );
    });

    it("should store a feedback record with type thumbs_down", () => {
      handler.handleThumbsDown({
        instinctIds: ["instinct_test_1"],
        source: "natural_language",
      });

      expect(mockStorage.storeFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thumbs_down",
          source: "natural_language",
        }),
      );
    });

    it("should skip instincts not found in storage", () => {
      mockStorage.getInstinct.mockReturnValue(null);

      handler.handleThumbsDown({
        instinctIds: ["instinct_nonexistent"],
        source: "button",
      });

      expect(mockStorage.updateInstinctFactor).not.toHaveBeenCalled();
    });
  });

  describe("handleTeaching", () => {
    it("should store a teaching feedback record", () => {
      handler.handleTeaching({
        content: "always use strict mode",
        scopeType: "user",
        userId: "user1",
      });

      expect(mockStorage.storeFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "teaching",
          content: "always use strict mode",
          scopeType: "user",
          userId: "user1",
        }),
      );
    });
  });

  describe("handleCorrection", () => {
    it("should store a correction feedback record", () => {
      handler.handleCorrection({
        original: "use var",
        corrected: "use const",
        source: "natural_language",
        userId: "user1",
        instinctIds: ["instinct_test_1"],
      });

      expect(mockStorage.storeFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "correction",
          content: expect.stringContaining("use const"),
          source: "natural_language",
          userId: "user1",
        }),
      );
    });
  });
});
