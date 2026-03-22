import { describe, it, expect } from 'vitest'
import type { GoalNode, GoalNodeId } from '../../goals/types.js'
import {
  isNodeTrulyDone,
  getNextReviewStatus,
} from '../../goals/types.js'
import type { ReviewStatus } from '../../goals/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<GoalNode> = {}): GoalNode {
  const now = Date.now()
  return {
    id: 'goal_test_001' as GoalNodeId,
    parentId: null,
    task: 'test task',
    dependsOn: [],
    depth: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewStatus type on GoalNode', () => {
  it('GoalNode can have reviewStatus field with type ReviewStatus', () => {
    const node = makeNode({ reviewStatus: 'spec_review' })
    expect(node.reviewStatus).toBe('spec_review')
  })

  it('ReviewStatus type accepts all valid values', () => {
    const validStatuses: ReviewStatus[] = [
      'none',
      'spec_review',
      'quality_review',
      'review_passed',
      'review_stuck',
    ]
    for (const status of validStatuses) {
      const node = makeNode({ reviewStatus: status })
      expect(node.reviewStatus).toBe(status)
    }
  })

  it('default reviewStatus is none (undefined treated as none)', () => {
    const node = makeNode()
    expect(node.reviewStatus).toBeUndefined()
    // The system treats undefined as 'none'
    expect(isNodeTrulyDone({ ...node, status: 'completed', reviewStatus: undefined })).toBe(false)
  })

  it('reviewIterations defaults to 0 (undefined)', () => {
    const node = makeNode()
    expect(node.reviewIterations).toBeUndefined()
    // Treated as 0
    expect(node.reviewIterations ?? 0).toBe(0)
  })
})

describe('getNextReviewStatus transitions', () => {
  it('none -> spec_review (valid)', () => {
    const next = getNextReviewStatus('none', false, 0, 3)
    expect(next).toBe('spec_review')
  })

  it('spec_review -> quality_review when spec passes', () => {
    const next = getNextReviewStatus('spec_review', true, 1, 3)
    expect(next).toBe('quality_review')
  })

  it('spec_review -> spec_review when spec fails (retry)', () => {
    const next = getNextReviewStatus('spec_review', false, 1, 3)
    expect(next).toBe('spec_review')
  })

  it('quality_review -> review_passed when quality passes', () => {
    const next = getNextReviewStatus('quality_review', true, 2, 3)
    expect(next).toBe('review_passed')
  })

  it('quality_review -> quality_review when quality fails (retry)', () => {
    const next = getNextReviewStatus('quality_review', false, 1, 3)
    expect(next).toBe('quality_review')
  })

  it('spec_review -> review_stuck after max iterations', () => {
    const next = getNextReviewStatus('spec_review', false, 3, 3)
    expect(next).toBe('review_stuck')
  })

  it('quality_review -> review_stuck after max iterations', () => {
    const next = getNextReviewStatus('quality_review', false, 3, 3)
    expect(next).toBe('review_stuck')
  })

  it('review_passed stays review_passed', () => {
    const next = getNextReviewStatus('review_passed', true, 0, 3)
    expect(next).toBe('review_passed')
  })

  it('review_stuck stays review_stuck', () => {
    const next = getNextReviewStatus('review_stuck', false, 5, 3)
    expect(next).toBe('review_stuck')
  })
})

describe('isNodeTrulyDone', () => {
  it('returns false when status=completed but reviewStatus is not review_passed', () => {
    const node = makeNode({ status: 'completed', reviewStatus: 'spec_review' })
    expect(isNodeTrulyDone(node)).toBe(false)
  })

  it('returns false when status=completed and reviewStatus is none (undefined)', () => {
    const node = makeNode({ status: 'completed' })
    expect(isNodeTrulyDone(node)).toBe(false)
  })

  it('returns true when status=completed and reviewStatus=review_passed', () => {
    const node = makeNode({ status: 'completed', reviewStatus: 'review_passed' })
    expect(isNodeTrulyDone(node)).toBe(true)
  })

  it('returns true for failed status (does not need review)', () => {
    const node = makeNode({ status: 'failed' })
    expect(isNodeTrulyDone(node)).toBe(true)
  })

  it('returns true for skipped status (does not need review)', () => {
    const node = makeNode({ status: 'skipped' })
    expect(isNodeTrulyDone(node)).toBe(true)
  })

  it('returns false for pending status', () => {
    const node = makeNode({ status: 'pending' })
    expect(isNodeTrulyDone(node)).toBe(false)
  })

  it('returns false for executing status', () => {
    const node = makeNode({ status: 'executing' })
    expect(isNodeTrulyDone(node)).toBe(false)
  })
})

describe('validateReviewTransition (via getNextReviewStatus)', () => {
  it('rejects direct none -> review_passed (must go through spec_review and quality_review)', () => {
    // From 'none', regardless of passed=true, we go to spec_review first
    const next = getNextReviewStatus('none', true, 0, 3)
    expect(next).toBe('spec_review')
    expect(next).not.toBe('review_passed')
  })

  it('rejects direct none -> quality_review', () => {
    const next = getNextReviewStatus('none', true, 0, 3)
    expect(next).not.toBe('quality_review')
  })
})
