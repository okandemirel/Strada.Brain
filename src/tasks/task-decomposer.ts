/**
 * Task Decomposer (Phase 2 stub)
 *
 * Optional LLM-based subtask breakdown.
 * For complex prompts, breaks into max 5 subtasks.
 * Each subtask becomes a child Task with parentId reference.
 *
 * Initial implementation just runs single tasks — decomposition
 * will be added in a future phase.
 */

export class TaskDecomposer {
  /**
   * Check if a prompt should be decomposed into subtasks.
   * Phase 2: will use LLM to determine complexity.
   * Current: always returns false (single task execution).
   */
  shouldDecompose(_prompt: string): boolean {
    return false;
  }

  /**
   * Decompose a prompt into subtasks.
   * Phase 2: will use LLM for decomposition.
   * Current: returns the original prompt as a single item.
   */
  async decompose(prompt: string): Promise<string[]> {
    return [prompt];
  }
}
