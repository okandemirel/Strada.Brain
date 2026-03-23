---
trigger: glob
globs: web-portal/**
---

# Web Portal Rules

- Separate React + Vite project with its own `package.json`
- Build output goes to `src/channels/web/static/`
- Run `npm run bootstrap` to install and build
- Tests: `npm run test:portal`
- Keep frontend isolated from backend — communicate via API/WebSocket only
