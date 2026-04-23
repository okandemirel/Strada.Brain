import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../i18n';
import { RegisterVaultDialog } from './RegisterVaultDialog';

/**
 * RegisterVaultDialog covers the happy-path POST + error rendering. jsdom
 * stubs Radix portal mounting, so we assert on text content rendered into
 * the document tree directly.
 */
describe('RegisterVaultDialog', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let onOpenChange: (open: boolean) => void;
  let onRegistered: () => void;
  let onOpenChangeMock: ReturnType<typeof vi.fn>;
  let onRegisteredMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    onOpenChangeMock = vi.fn();
    onRegisteredMock = vi.fn();
    onOpenChange = (open: boolean) => { (onOpenChangeMock as (v: boolean) => void)(open); };
    onRegistered = () => { (onRegisteredMock as () => void)(); };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not render when closed', () => {
    render(
      <RegisterVaultDialog
        open={false}
        onOpenChange={onOpenChange}
        onRegistered={onRegistered}
      />,
    );
    // Dialog title should not be present when closed
    expect(screen.queryByText(/register a new vault/i)).toBeNull();
  });

  it('renders form when open', () => {
    render(
      <RegisterVaultDialog
        open
        onOpenChange={onOpenChange}
        onRegistered={onRegistered}
      />,
    );
    expect(screen.getByText(/register a new vault/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/project root path/i)).toBeInTheDocument();
  });

  it('calls onRegistered on successful POST', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'generic:abc12345', status: 'indexing' }),
    } as Response);

    render(
      <RegisterVaultDialog
        open
        onOpenChange={onOpenChange}
        onRegistered={onRegistered}
      />,
    );

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'My Proj' } });
    fireEvent.change(screen.getByLabelText(/project root path/i), {
      target: { value: '/abs/path' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register & index/i }));

    await waitFor(() => {
      expect(onRegisteredMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(onOpenChangeMock).toHaveBeenCalledWith(false);
  });

  it('renders error message on invalid path response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'path does not exist' }),
    } as Response);

    render(
      <RegisterVaultDialog
        open
        onOpenChange={onOpenChange}
        onRegistered={onRegistered}
      />,
    );

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'My Proj' } });
    fireEvent.change(screen.getByLabelText(/project root path/i), {
      target: { value: '/nope' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register & index/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(onRegisteredMock).not.toHaveBeenCalled();
  });
});
