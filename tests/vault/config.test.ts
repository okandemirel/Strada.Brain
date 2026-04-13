import { describe, it, expect, vi, beforeEach } from 'vitest';
import { realpathSync, statSync } from 'node:fs';
import { loadConfig, resetConfigCache } from '../../src/config/config.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

// Base env satisfying required fields; individual tests may override
const BASE_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-test-key-123',
  UNITY_PROJECT_PATH: '/test/project',
};

function makeEnv(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...BASE_ENV, ...overrides };
}

describe('vault config', () => {
  beforeEach(() => {
    resetConfigCache();
    vi.mocked(realpathSync).mockImplementation((p) => String(p));
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
  });

  it('exposes vault.enabled defaulting to false', () => {
    const cfg = loadConfig(makeEnv());
    expect(cfg.vault).toBeDefined();
    expect(cfg.vault.enabled).toBe(false);
  });

  it('parses vault.enabled=true from env', () => {
    const cfg = loadConfig(makeEnv({ STRADA_VAULT_ENABLED: 'true' }));
    expect(cfg.vault.enabled).toBe(true);
  });

  it('defaults writeHookBudgetMs to 200 and debounceMs to 800', () => {
    const cfg = loadConfig(makeEnv());
    expect(cfg.vault.writeHookBudgetMs).toBe(200);
    expect(cfg.vault.debounceMs).toBe(800);
  });
});
