/**
 * Learning Metrics
 *
 * Lightweight runtime counter singleton for learning system observability.
 * Resets on restart; SQLite data persists separately via LearningStorage.
 */

export class LearningMetrics {
  private static instance: LearningMetrics | null = null;

  private reflectionDoneCount = 0;
  private reflectionOverrideCount = 0;
  private consensusVerifyCount = 0;
  private consensusAgreeCount = 0;
  private consensusDisagreements: Array<{ timestamp: number; strategy: string; reasoning: string }> = [];
  private outcomeTrackedCount = 0;
  private outcomeSuccessCount = 0;
  private instinctsUpdatedByOutcome = 0;

  private static readonly MAX_DISAGREEMENTS = 50;

  static getInstance(): LearningMetrics {
    if (!this.instance) this.instance = new LearningMetrics();
    return this.instance;
  }

  static reset(): void {
    this.instance = null;
  }

  recordReflectionDone(): void {
    this.reflectionDoneCount++;
  }

  recordReflectionOverride(): void {
    this.reflectionOverrideCount++;
  }

  recordConsensusResult(params: { agreed: boolean; strategy: string; reasoning: string }): void {
    this.consensusVerifyCount++;
    if (params.agreed) {
      this.consensusAgreeCount++;
    } else {
      this.consensusDisagreements.push({ timestamp: Date.now(), strategy: params.strategy, reasoning: params.reasoning });
      if (this.consensusDisagreements.length > LearningMetrics.MAX_DISAGREEMENTS) {
        this.consensusDisagreements.shift();
      }
    }
  }

  recordOutcome(params: { success: boolean; instinctCount: number }): void {
    this.outcomeTrackedCount++;
    if (params.success) this.outcomeSuccessCount++;
    this.instinctsUpdatedByOutcome += params.instinctCount;
  }

  getReflectionStats() {
    return {
      totalDone: this.reflectionDoneCount,
      totalOverrides: this.reflectionOverrideCount,
      overrideRate: this.reflectionDoneCount > 0
        ? this.reflectionOverrideCount / this.reflectionDoneCount
        : 0,
    };
  }

  getConsensusStats() {
    return {
      totalVerifications: this.consensusVerifyCount,
      agreementRate: this.consensusVerifyCount > 0
        ? this.consensusAgreeCount / this.consensusVerifyCount
        : 0,
      disagreements: [...this.consensusDisagreements],
    };
  }

  getOutcomeStats() {
    return {
      totalTracked: this.outcomeTrackedCount,
      successRate: this.outcomeTrackedCount > 0
        ? this.outcomeSuccessCount / this.outcomeTrackedCount
        : 0,
      instinctsUpdated: this.instinctsUpdatedByOutcome,
    };
  }
}
