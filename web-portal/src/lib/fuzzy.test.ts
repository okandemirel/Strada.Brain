import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyScore } from './fuzzy';

describe('fuzzyMatch', () => {
  it('returns true for empty query (treats as no filter)', () => {
    expect(fuzzyMatch('anything', '')).toBe(true);
    expect(fuzzyMatch('', '')).toBe(true);
  });

  it('matches exact substrings case-insensitively', () => {
    expect(fuzzyMatch('Go to Files', 'files')).toBe(true);
    expect(fuzzyMatch('Go to Files', 'FILES')).toBe(true);
  });

  it('matches in-order non-contiguous characters', () => {
    expect(fuzzyMatch('Reindex vault', 'rvlt')).toBe(true);
    expect(fuzzyMatch('Reindex vault', 'rdxvlt')).toBe(true);
  });

  it('rejects out-of-order characters', () => {
    expect(fuzzyMatch('Reindex vault', 'tluv')).toBe(false);
  });

  it('rejects when any character is missing', () => {
    expect(fuzzyMatch('abc def', 'xyz')).toBe(false);
  });
});

describe('fuzzyScore', () => {
  it('scores exact substring at 1', () => {
    expect(fuzzyScore('Go to Files', 'files')).toBe(1);
  });

  it('scores non-match at 0', () => {
    expect(fuzzyScore('abc', 'xyz')).toBe(0);
  });

  it('scores contiguous matches higher than spread matches', () => {
    const tight = fuzzyScore('xxfilesxx', 'fil');
    const spread = fuzzyScore('f___i___l', 'fil');
    expect(tight).toBeGreaterThan(spread);
  });

  it('empty query returns 1 (no filtering)', () => {
    expect(fuzzyScore('anything', '')).toBe(1);
  });
});
