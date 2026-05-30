import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import VaultFilesTab from './VaultFilesTab';
import { useVaultStore } from '../../stores/vault-store';

// t returns the key so we can assert on the i18n key regardless of locale.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('VaultFilesTab error handling', () => {
  beforeEach(() => {
    useVaultStore.setState({ selected: 'vault-1', activeFilePath: 'note.md' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useVaultStore.setState({ selected: null, activeFilePath: null });
  });

  it('shows an error instead of a silent blank document when the file fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    const { findByText } = render(<VaultFilesTab />);
    // findByText rejects (failing the test) if the error message never appears.
    expect(await findByText('errors.somethingWentWrong')).toBeTruthy();
  });
});
