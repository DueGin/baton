# AGENTS.md — baton

baton is a local agent client with native delegation and observability. Read `docs/DESIGN.md` first; it is the binding contract.

## Layout
- `packages/protocol` — shared types + MCP tool schemas + `applyEvent` reducer. **Lead-owned.**
- `packages/providers` — agent adapters ported from Paseo (Apache-2.0). Every ported file starts with a header naming the original Paseo path and saying it was modified.
- `packages/server` — daemon, kernel, MCP, API, CLI. `src/driver/types.ts` is **lead-owned**.
- `packages/web` — console (Vite + React 19 + @xyflow/react).

## Rules
- Contract files (`docs/DESIGN.md`, `packages/protocol/src/*`, `packages/server/src/driver/types.ts`) are lead-owned. If the contract is wrong or missing something, work around it locally and list the issue in your final report.
- Node ≥ 22.13, TypeScript 5.9 strict, ESM. Relative imports use `.js` suffixes. No `any` (use `unknown` + narrowing).
- Tests: vitest, collocated `*.test.ts`. Run only your package's tests (`npx vitest run <path>`). Tests must be deterministic and must not need network or real agent CLIs unless the file name ends in `.real.test.ts` (opt-in, excluded by default).
- Tests and dev runs use a temporary `BATON_HOME`; never write to `~/.baton` from tests.
- NEVER touch port 6767 or `~/.paseo` — that is the user's running Paseo daemon (which also runs you).
- Do not commit; the lead reviews and merges your worktree.
- Build order: `npx tsc -b packages/protocol packages/providers packages/server`. Run `npm run typecheck` before you report.
