import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * POST /api/vaults — register + index a new vault. On success the server
 * returns {id, name, rootPath, kind, status: 'indexing'}; the caller refreshes
 * the vault list so the new entry appears even while background indexing is
 * still in flight.
 */
interface RegisterVaultResponse {
  id?: string;
  error?: string;
  status?: string;
}

export interface RegisterVaultDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Called after a successful POST so the parent can refetch `/api/vaults`. */
  onRegistered(): void;
}

type VaultKind = 'unity' | 'generic';

export function RegisterVaultDialog({
  open,
  onOpenChange,
  onRegistered,
}: RegisterVaultDialogProps) {
  const { t } = useTranslation('vault');
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [kind, setKind] = useState<VaultKind>('unity');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setRootPath('');
    setKind('unity');
    setError(null);
    setSubmitting(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedPath = rootPath.trim();
    if (!trimmedName || !trimmedPath) {
      setError(t('register.error.generic'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch('/api/vaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, rootPath: trimmedPath, kind }),
      });
      const data = (await resp.json().catch(() => ({}))) as RegisterVaultResponse;
      if (!resp.ok) {
        // Map server error codes to user-facing copy where we have a good translation.
        const serverErr = typeof data?.error === 'string' ? data.error : '';
        if (/path/i.test(serverErr)) setError(t('register.error.invalidPath'));
        else setError(t('register.error.generic'));
        setSubmitting(false);
        return;
      }
      onRegistered();
      handleOpenChange(false);
    } catch {
      setError(t('register.error.generic'));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="mb-1">{t('register.title')}</DialogTitle>
        <DialogDescription className="mb-4">
          {t('register.description')}
        </DialogDescription>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <label
              htmlFor="register-vault-name"
              className="text-xs font-medium text-[var(--color-text-secondary)]"
            >
              {t('register.nameLabel')}
            </label>
            <Input
              id="register-vault-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('register.namePlaceholder')}
              maxLength={64}
              autoFocus
              disabled={submitting}
              required
            />
          </div>
          <div className="space-y-1">
            <label
              htmlFor="register-vault-path"
              className="text-xs font-medium text-[var(--color-text-secondary)]"
            >
              {t('register.pathLabel')}
            </label>
            <Input
              id="register-vault-path"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder={t('register.pathPlaceholder')}
              maxLength={1024}
              disabled={submitting}
              required
            />
          </div>
          <div className="space-y-1">
            <label
              htmlFor="register-vault-kind"
              className="text-xs font-medium text-[var(--color-text-secondary)]"
            >
              {t('register.kindLabel')}
            </label>
            <select
              id="register-vault-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as VaultKind)}
              disabled={submitting}
              className={cn(
                'flex h-9 w-full rounded-lg border border-border bg-input-bg px-3 py-1 text-sm text-text shadow-sm transition-colors',
                'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--color-accent-glow)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <option value="unity">{t('register.kindUnity')}</option>
              <option value="generic">{t('register.kindGeneric')}</option>
            </select>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-md border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 px-3 py-2 text-xs text-[var(--color-error)]"
            >
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs border border-[var(--color-border-subtle)]',
                'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]',
                'disabled:opacity-50',
              )}
            >
              {t('register.cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || !rootPath.trim()}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium',
                'bg-[var(--color-accent)] text-[var(--color-on-accent,white)] hover:bg-[var(--color-accent)]/90',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {submitting ? t('register.indexing') : t('register.submit')}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default RegisterVaultDialog;
