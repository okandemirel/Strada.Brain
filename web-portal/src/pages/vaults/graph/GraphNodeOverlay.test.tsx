import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { useVaultStore } from '../../../stores/vault-store';

const fetchMock = vi.fn();

import { GraphNodeOverlay } from './GraphNodeOverlay';

describe('GraphNodeOverlay', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    useVaultStore.setState({
      selected: 'v1',
      vaults: [{ id: 'v1', kind: 'unity-project' }],
      searchResults: [],
      graphCache: {},
      activeFilePath: null,
      selectedSymbolId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing when nodeId is null', () => {
    render(<GraphNodeOverlay nodeId={null} onClose={() => {}} />);
    expect(screen.queryByText('Open in Editor')).not.toBeInTheDocument();
  });

  it('fetches callers and renders them', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/callers')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [{ fromSymbol: 'src/b.ts', toSymbol: 'a', kind: 'method', atLine: 10 }],
          }),
        });
      }
      if (url.includes('/backlinks')) {
        return Promise.resolve({ status: 404 });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    render(<GraphNodeOverlay nodeId="a" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('method')).toBeInTheDocument();
    });
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
  });

  it('fetches backlinks and renders them', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/callers')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [] }),
        });
      }
      if (url.includes('/backlinks')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [{ fromNote: 'note-1' }, { fromNote: 'note-2' }],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    render(<GraphNodeOverlay nodeId="a" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Backlinks')).toBeInTheDocument();
    });

    expect(screen.getByText('note-1')).toBeInTheDocument();
    expect(screen.getByText('note-2')).toBeInTheDocument();
  });

  it('gracefully handles missing backlinks endpoint (404)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/callers')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [] }),
        });
      }
      if (url.includes('/backlinks')) {
        return Promise.resolve({ status: 404 });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    render(<GraphNodeOverlay nodeId="a" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('No backlinks')).toBeInTheDocument();
    });
  });

  it('calls onClose when backdrop is clicked', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });

    const onClose = vi.fn();
    render(<GraphNodeOverlay nodeId="a" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Open in Editor')).toBeInTheDocument();
    });

    // Backdrop is the first absolute inset-0 div with z-20
    const backdrop = screen.getByText('Open in Editor').closest('div[class*="translate-x-0"]')
      ?.previousElementSibling;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalled();
  });
});
