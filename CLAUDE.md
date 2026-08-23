# Strada.Brain — Agent Instructions

The canonical agent instructions live in [AGENTS.md](./AGENTS.md). Read that file first.

This pointer exists because several subsystems (SelfVault indexing in
`src/vault/self-vault.ts`, README references) expect this file to be present.

## Codebase Memory Vault

When `config.vault.enabled=true`, prefer vault queries (`vault_search`, symbolic
PPR over the call/import graph) over repeated `Read`/`Grep` cycles. See
[docs/vault.md](docs/vault.md).
