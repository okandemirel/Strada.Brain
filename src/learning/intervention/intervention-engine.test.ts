import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InterventionEngine } from './intervention-engine.js';
import type { Instinct, TrustLevel } from '../types.js';

// =============================================================================
// HELPERS
// =============================================================================

function createMockStorage() {
  return {
    logIntervention: vi.fn(),
  };
}

/**
 * Build a minimal Instinct object with sensible defaults.
 * Only fields used by InterventionEngine are required here.
 */
function makeInstinct(overrides: Partial<Instinct> & { status: Instinct['status']; confidence: number }): Instinct {
  return {
    id: 'instinct_test_001' as Instinct['id'],
    name: 'test instinct',
    type: 'tool_usage',
    triggerPattern: 'test',
    action: 'do something',
    contextConditions: [],
    stats: {
      timesSuggested: 0,
      timesApplied: 0,
      timesFailed: 0,
      successRate: 0 as Instinct['stats']['successRate'],
      averageExecutionMs: 0,
    },
    createdAt: Date.now() as Instinct['createdAt'],
    updatedAt: Date.now() as Instinct['updatedAt'],
    sourceTrajectoryIds: [],
    tags: [],
    trustLevel: 'auto_enabled' as TrustLevel,
    ...overrides,
  } as Instinct;
}

// =============================================================================
// TESTS
// =============================================================================

describe('InterventionEngine', () => {
  let engine: InterventionEngine;
  let mockStorage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    mockStorage = createMockStorage();
    engine = new InterventionEngine(mockStorage as any);
  });

  // ---------------------------------------------------------------------------
  // evaluate()
  // ---------------------------------------------------------------------------

  describe('evaluate()', () => {
    it('should return enrich (passive) for proposed instincts regardless of confidence', () => {
      const instinct = makeInstinct({ status: 'proposed', confidence: 0.95, trustLevel: 'auto_enabled' });
      const result = engine.evaluate('some_tool', {}, [instinct]);

      expect(result.action).toBe('enrich');
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].tier).toBe('passive');
    });

    it('should return auto_apply for permanent + auto_enabled + confidence > 0.8', () => {
      const instinct = makeInstinct({ status: 'permanent', confidence: 0.9, trustLevel: 'auto_enabled' });
      const result = engine.evaluate('some_tool', {}, [instinct]);

      expect(result.action).toBe('auto_apply');
      expect(result.matches[0].tier).toBe('auto');
    });

    it('should cap active instincts at warn tier even when confidence > 0.8', () => {
      const instinct = makeInstinct({ status: 'active', confidence: 0.95, trustLevel: 'auto_enabled' });
      const result = engine.evaluate('some_tool', {}, [instinct]);

      expect(result.action).toBe('warn');
      expect(result.matches[0].tier).toBe('warn');
    });

    it('should exclude deprecated instincts', () => {
      const instinct = makeInstinct({ status: 'deprecated', confidence: 0.9, trustLevel: 'auto_enabled' });
      const result = engine.evaluate('some_tool', {}, [instinct]);

      expect(result.action).toBe('none');
      expect(result.matches).toHaveLength(0);
    });

    it('should exclude evolved instincts', () => {
      const instinct = makeInstinct({ status: 'evolved', confidence: 0.9, trustLevel: 'auto_enabled' });
      const result = engine.evaluate('some_tool', {}, [instinct]);

      expect(result.action).toBe('none');
      expect(result.matches).toHaveLength(0);
    });

    it('should return highest-priority action from multiple instincts', () => {
      const warnInstinct = makeInstinct({ id: 'instinct_w1' as Instinct['id'], status: 'active', confidence: 0.9, trustLevel: 'auto_enabled' });
      const suggestInstinct = makeInstinct({ id: 'instinct_s1' as Instinct['id'], status: 'proposed', confidence: 0.5, trustLevel: 'auto_enabled' });

      const result = engine.evaluate('some_tool', {}, [warnInstinct, suggestInstinct]);

      // warnInstinct is active (cap warn) → warn
      // suggestInstinct is proposed (cap passive) → enrich
      // highest: warn
      expect(result.action).toBe('warn');
      expect(result.matches).toHaveLength(2);
    });

    it('should return none when no instincts match', () => {
      const result = engine.evaluate('some_tool', {}, []);

      expect(result.action).toBe('none');
      expect(result.matches).toHaveLength(0);
      expect(result.toolName).toBe('some_tool');
    });

    it('should cap action by trust level — new trust gives enrich even for high confidence active', () => {
      const instinct = makeInstinct({ status: 'active', confidence: 0.7, trustLevel: 'new' });
      const result = engine.evaluate('some_tool', {}, [instinct]);

      // active caps at warn, new trust caps at passive → enrich
      expect(result.action).toBe('enrich');
      expect(result.matches[0].tier).toBe('passive');
    });

    it('should cap action by trust level — suggest_only gives max suggest', () => {
      const instinct = makeInstinct({ status: 'permanent', confidence: 0.9, trustLevel: 'suggest_only' });
      const result = engine.evaluate('some_tool', {}, [instinct]);

      // permanent allows auto, but suggest_only caps at suggest
      expect(result.action).toBe('suggest');
      expect(result.matches[0].tier).toBe('suggest');
    });

    it('should cap action by trust level — warn_enabled gives max warn', () => {
      const instinct = makeInstinct({ status: 'permanent', confidence: 0.9, trustLevel: 'warn_enabled' });
      const result = engine.evaluate('some_tool', {}, [instinct]);

      // permanent allows auto, warn_enabled caps at warn
      expect(result.action).toBe('warn');
      expect(result.matches[0].tier).toBe('warn');
    });

    it('should default trustLevel to new when missing', () => {
      const instinct = makeInstinct({ status: 'permanent', confidence: 0.9 });
      // Remove trustLevel to simulate missing field
      (instinct as any).trustLevel = undefined;

      const result = engine.evaluate('some_tool', {}, [instinct]);

      // permanent allows auto, but default is new → passive
      expect(result.action).toBe('enrich');
    });
  });

  // ---------------------------------------------------------------------------
  // advanceTrust()
  // ---------------------------------------------------------------------------

  describe('advanceTrust()', () => {
    it('should advance new -> suggest_only on first approval', () => {
      const ctx = { approvals: 1, rejections: 0, totalUses: 1, confidence: 0.5, lifecycle: 'active', overridden: false };
      expect(engine.advanceTrust('new', ctx)).toBe('suggest_only');
    });

    it('should stay new when no approvals', () => {
      const ctx = { approvals: 0, rejections: 0, totalUses: 0, confidence: 0.5, lifecycle: 'active', overridden: false };
      expect(engine.advanceTrust('new', ctx)).toBe('new');
    });

    it('should advance suggest_only -> warn_enabled with 3+ approvals and 0 rejections', () => {
      const ctx = { approvals: 3, rejections: 0, totalUses: 5, confidence: 0.7, lifecycle: 'active', overridden: false };
      expect(engine.advanceTrust('suggest_only', ctx)).toBe('warn_enabled');
    });

    it('should NOT advance suggest_only -> warn_enabled if rejections > 0', () => {
      const ctx = { approvals: 5, rejections: 1, totalUses: 6, confidence: 0.7, lifecycle: 'active', overridden: false };
      expect(engine.advanceTrust('suggest_only', ctx)).toBe('suggest_only');
    });

    it('should NOT advance suggest_only -> warn_enabled if approvals < 3', () => {
      const ctx = { approvals: 2, rejections: 0, totalUses: 4, confidence: 0.7, lifecycle: 'active', overridden: false };
      expect(engine.advanceTrust('suggest_only', ctx)).toBe('suggest_only');
    });

    it('should NOT advance to auto_enabled if lifecycle != permanent', () => {
      const ctx = { approvals: 10, rejections: 0, totalUses: 15, confidence: 0.9, lifecycle: 'active', overridden: false };
      expect(engine.advanceTrust('warn_enabled', ctx)).toBe('warn_enabled');
    });

    it('should advance to auto_enabled for permanent instincts with 10+ approvals and confidence > 0.8', () => {
      const ctx = { approvals: 10, rejections: 0, totalUses: 15, confidence: 0.9, lifecycle: 'permanent', overridden: false };
      expect(engine.advanceTrust('warn_enabled', ctx)).toBe('auto_enabled');
    });

    it('should not advance to auto_enabled if confidence is exactly 0.8 (requires > 0.8)', () => {
      const ctx = { approvals: 10, rejections: 0, totalUses: 15, confidence: 0.8, lifecycle: 'permanent', overridden: false };
      expect(engine.advanceTrust('warn_enabled', ctx)).toBe('warn_enabled');
    });

    it('should not advance if overridden', () => {
      const ctx = { approvals: 15, rejections: 0, totalUses: 20, confidence: 0.95, lifecycle: 'permanent', overridden: true };
      expect(engine.advanceTrust('warn_enabled', ctx)).toBe('warn_enabled');
    });

    it('should stay auto_enabled once reached', () => {
      const ctx = { approvals: 100, rejections: 0, totalUses: 100, confidence: 0.99, lifecycle: 'permanent', overridden: false };
      expect(engine.advanceTrust('auto_enabled', ctx)).toBe('auto_enabled');
    });
  });

  // ---------------------------------------------------------------------------
  // logIntervention()
  // ---------------------------------------------------------------------------

  describe('logIntervention()', () => {
    it('should store an intervention log entry with correct fields', async () => {
      await engine.logIntervention('instinct_001', 'bash', 'warn', 'applied', 'user_42');

      expect(mockStorage.logIntervention).toHaveBeenCalledOnce();
      const call = mockStorage.logIntervention.mock.calls[0][0];
      expect(call).toMatchObject({
        instinctId: 'instinct_001',
        toolName: 'bash',
        tier: 'warn',
        actionTaken: 'applied',
        userId: 'user_42',
      });
      expect(typeof call.id).toBe('string');
      expect(call.id.length).toBeGreaterThan(0);
      expect(typeof call.createdAt).toBe('number');
    });

    it('should store intervention log without userId when not provided', async () => {
      await engine.logIntervention('instinct_002', 'read', 'passive', 'dismissed');

      expect(mockStorage.logIntervention).toHaveBeenCalledOnce();
      const call = mockStorage.logIntervention.mock.calls[0][0];
      expect(call.userId).toBeUndefined();
      expect(call.instinctId).toBe('instinct_002');
    });
  });
});
