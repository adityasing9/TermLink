# Contributing to TermLink

We welcome contributions across networking, CLI UX, cross-platform compatibility, security auditing, and documentation.

## Local Development

```bash
npm install
npm run dev          # Starts standalone WebSocket signaling server on http://localhost:3000
npm run cli -- create
npm run cli -- 47
```

## Verification Before Opening a Pull Request

```bash
npm run lint
npm test
npm run build
npm pack --dry-run
```

## Code Standards

- Maintain clear package boundaries under `packages/` and `apps/` with no circular dependencies.
- Never silently overwrite user files, auto-execute remote commands, or auto-enable remote shell access.
- Every new protocol message must be validated in `packages/protocol`.
- Add unit or integration tests in `tests/` for all behavioral changes.
