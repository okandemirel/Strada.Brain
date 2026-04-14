import { useVaultStore } from '../../stores/vault-store';

export default function VaultList() {
  const { vaults, selected, select } = useVaultStore();
  if (vaults.length === 0) return <div className="p-4 text-sm text-muted-foreground">No vaults registered</div>;
  return (
    <ul className="p-2 space-y-1">
      {vaults.map((v) => (
        <li key={v.id}>
          <button
            onClick={() => select(v.id)}
            className={`w-full text-left px-2 py-1 rounded ${selected === v.id ? 'bg-accent' : 'hover:bg-accent/50'}`}
          >
            <div className="text-sm font-medium">{v.id}</div>
            <div className="text-xs text-muted-foreground">{v.kind}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}
