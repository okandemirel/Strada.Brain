# Web Portal

React + Vite frontend for the local Strada.Brain web channel.

## Development

Install portal dependencies:

```bash
npm ci
npm ci --prefix web-portal
```

Run the portal dev server:

```bash
npm --prefix web-portal run dev
```

The backend web channel is started from the repo root:

```bash
strada start --channel web
```

## Quality Gates

```bash
npm --prefix web-portal run lint
npm --prefix web-portal run typecheck
npm --prefix web-portal run test
```

`npm --prefix web-portal run test` uses the repo root Vitest install, so the root `npm ci` step is required.

Repo-level shortcuts from the root directory:

```bash
npm run lint
npm run typecheck
npm run test:portal
```

## Build Output

`npm --prefix web-portal run build` writes static assets to `web-portal/dist/`.

The root `npm run build` command compiles the backend and copies the portal bundle into `dist/channels/web/static/` for packaged runs.
