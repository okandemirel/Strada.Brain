import { useEffect, useState } from 'react';
import VaultList from './vaults/VaultList';
import VaultFilesTab from './vaults/VaultFilesTab';
import VaultSearchTab from './vaults/VaultSearchTab';
import { useVaultStore } from '../stores/vault-store';

type Tab = 'files' | 'search';

export default function VaultsPage() {
  const [tab, setTab] = useState<Tab>('files');
  const setVaults = useVaultStore((s) => s.setVaults);

  useEffect(() => {
    fetch('/api/vaults')
      .then((r) => r.json())
      .then((d) => setVaults(d.items ?? []))
      .catch(() => setVaults([]));
  }, [setVaults]);

  return (
    <div className="grid grid-cols-[280px_1fr] h-full">
      <aside className="border-r overflow-auto">
        <VaultList />
      </aside>
      <main className="flex flex-col h-full">
        <nav className="border-b p-2 flex gap-2">
          <button onClick={() => setTab('files')} className={`px-3 py-1 ${tab === 'files' ? 'border-b-2 border-accent' : ''}`}>Files</button>
          <button onClick={() => setTab('search')} className={`px-3 py-1 ${tab === 'search' ? 'border-b-2 border-accent' : ''}`}>Search</button>
        </nav>
        <section className="flex-1 overflow-hidden">
          {tab === 'files' ? <VaultFilesTab /> : <VaultSearchTab />}
        </section>
      </main>
    </div>
  );
}
