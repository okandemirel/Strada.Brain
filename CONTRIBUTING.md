# Contributing to Strada.Brain

Thank you for your interest in contributing. This guide covers the development setup, coding standards, and pull request process.

## Prerequisites

- **Node.js** >= 20.0.0
- **npm** (comes with Node.js)
- A code editor with TypeScript support (VS Code recommended)

## Development Setup

```bash
# Clone the repository
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain

# Install dependencies
npm install

# Copy environment config
cp .env.example .env
# Fill in at least ANTHROPIC_API_KEY and JWT_SECRET

# Start in development mode (hot-reload via tsx)
npm run dev -- cli
```

## Code Style

- **TypeScript strict mode** is enabled. All code must pass `npm run typecheck` with zero errors.
- **ESLint** enforces consistent style. Run `npm run lint` before committing.
- Use `import type` for type-only imports.
- Prefer `readonly` properties on interfaces and class fields.
- Use branded types from `src/types/` (e.g., `ChatId`, `MemoryId`, `TimestampMs`) instead of raw primitives.
- Keep functions under 30 lines where possible. Extract helpers for complex logic.
- Use descriptive names: `calculateUserDiscount` over `calcDisc`.
- All new modules should export from an `index.ts` barrel file.

## Pull Request Process

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/my-feature
   ```
2. Make your changes. Write tests for new functionality.
3. Ensure all checks pass:
   ```bash
   npm run typecheck
   npm run lint
   npm test
   ```
4. Commit with a clear message describing the change.
5. Push and open a pull request against `main`.
6. A maintainer will review your PR. Address any feedback, then it will be merged.

## Testing

- Tests use **Vitest** (`npm test`).
- Place test files next to the source file they test, named `*.test.ts`.
- Mock external dependencies (AI providers, file system, network) in unit tests.
- Test edge cases: empty inputs, large inputs, error conditions.
- Integration tests go in `src/tests/`.

## Adding a New Tool

1. Create a file in `src/agents/tools/` implementing `ITool` from `tool.interface.ts`.
2. Define `name`, `description`, and `inputSchema` (Zod-compatible JSON Schema).
3. Implement the `execute(input, context)` method.
4. Register the tool in the bootstrap process (`src/core/bootstrap.ts`).
5. Write tests covering success and error paths.

## Adding a New Channel

1. Create a directory under `src/channels/` (e.g., `src/channels/mychannel/`).
2. Implement the `IChannelAdapter` interface from `channel.interface.ts`.
3. Optionally implement `IChannelStreaming`, `IChannelRichMessaging`, or `IChannelInteractive`.
4. Register the channel in `src/core/bootstrap.ts`.
5. Add the channel type to `SupportedChannelType` in `src/common/constants.ts`.

## Security Guidelines

- Never hardcode secrets or credentials in source files.
- Never commit `.env` files.
- Validate all user input at system boundaries using Zod schemas.
- Sanitize file paths with the path guard before any file system operation.
- When adding tools that execute commands, respect the `readOnly` flag from `ToolContext`.
- Run `npm run security:audit` periodically to check for dependency vulnerabilities.

## Questions?

Open an issue on GitHub if you have questions about contributing.
