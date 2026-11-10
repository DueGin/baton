# Provider port handoff

Source: read-only Paseo commit `63ea3e5`, Apache-2.0. No source-tree scripts or package commands were run. Every derived file carries its original path, commit, copyright, license and modification header. No dependencies were installed and no commit was made.

## Delivered

- Native Claude Agent SDK, Codex app-server and Pi RPC clients plus one generic ACP client.
- Shared process lifecycle, tree termination, bounded JSONL framing, Codex startup coordination/retry, and the original Claude/Codex/Pi tool parsers.
- Catalog and executable detection with PATH resolution, bounded version probe, cache/force refresh, failure diagnostics, profile overrides from `<home>/config.json`, and all 14 requested built-in agents.
- `createPaseoDriverRegistry({ home, logger? })` in `packages/server/src/driver/paseo-adapter.ts`. This is the sole server source file importing `@baton/providers`. It maps ordered provider events, permissions, timeline items, usage and JSON persistence to the unchanged driver contract.
- Deterministic fake processes for ACP/Codex/Pi and an injected fake Claude SDK query. Tests cover catalogs, create/resume, turn lifecycle, text/reasoning, tool details, permission allow/deny/edit, interrupt, steer, MCP injection, unexpected exit, overlapping turns, cache refresh and shutdown.
- Opt-in real MCP smoke script: `npx tsx packages/server/scripts/smoke-drivers.ts [claude codex pi]`. Creates an ephemeral localhost HTTP MCP server and temporary BATON_HOME/work directories, approves smoke permissions, verifies the actual `ping("hello")` request plus tool timeline/completion/DONE, prints usage and timings, and cleans up.

## Validation

- `npx tsc -b packages/protocol packages/providers packages/server`: PASS.
- `npx vitest run packages/providers packages/server/src/driver`: PASS, 9 files / 126 tests.
- `npm run typecheck`: PASS (exit 0; output below).
- Strict standalone typecheck of new integration tests and `smoke-drivers.ts`, using the repository's ES2023 Node types: PASS.
- `git diff --check`: PASS.
- Real smoke runs: NOT RUN. Require installed agent CLIs, authentication and network.

```text
> baton@0.1.0 typecheck
> tsc -b packages/protocol packages/providers packages/server && npm run typecheck -w @baton/web --if-present
```

## Deliberate cuts

No vendor-specific ACP adapter subclasses (OpenCode, omp, Copilot, Cursor, Kiro, Trae, Kimi), rewind/revert, session import/listing/history hydration, workspace git/file observer, background-work inventory, plugin providers/timeline, voice/audio, rendered image output, native Paseo tools, Paseo labels/notifications/i18n or provider-subagent ownership tree. Native subagent timeline references from retained tool parsers may appear as tool details, but no baton node is created for them. Tool-result images are replaced by placeholders.

## Behavior differences and limits

This is a reduced port: transports and parsers are retained closely, while the large application-coupled session classes are rewritten around baton's smaller contract. It is not the complete Paseo provider closure.

- Claude models/thinking options come from installed SDK `supportedModels()`, rather than Paseo's curated model manifest. Explicit configured models remain usable; native option/feature controls and slash-command catalogs are outside baton's driver contract.
- Codex modes are the three baton presets `default`, `read-only`, `full-access` (plus accepted legacy `bypass` input), without Paseo plan collaboration or auto-review feature machinery. Usage uses cumulative token deltas per baton turn rather than Paseo's latest model-request counters. On interrupt it terminates tracked active-turn terminals; unsupported cleanup falls back to closing the process.
- Pi requires builtin MCP (`registerMcpServer`) or an installed pi-mcp-adapter for injected servers. Detection reports the observed MCP capability; opening with injection fails explicitly when unsupported. Builtin MCP rejects SSE; the adapter path supports configured transport URLs. Temporary extension/config files are private, global MCP tools are merged, and Pi session files persist under `<home>/pi-sessions`.
- Pi native tools remain unattended, as in Paseo. Extension UI confirmation/question requests are mapped to permissions. No synthetic read-only Pi mode is advertised.
- Usage is emitted from native turn/message events. Pi's periodic context-usage poller and Claude's incremental context-window estimator are not included. Available token/cost counters and final usage are retained.
- ACP uses standard initialization/session/model/config-option APIs. Vendor-specific model discovery extensions are omitted; catalog availability depends on what the agent advertises, or profile model overrides. Modes infer unattended/read-only flags from native IDs, which are provider conventions rather than guarantees.
- ACP appends system instructions to the first submitted prompt (also after resume), because standard ACP has no system/developer-instruction field. MCP HTTP/SSE injection checks advertised capability. Native ACP filesystem/terminal operations retain the provider-owned approval flow; ACP permission requests preserve exact selected action IDs.
- Executable resolution uses `which` plus the configured PATH and direct argv spawning. Paseo's platform-specific Windows cmd/bat/package-launch rewriting and managed-runtime search paths are not ported. macOS/Linux is the intended initial target; Windows real launch behavior is unverified.
- Config/profile parse failure makes entries unavailable with diagnostics; detection never rejects. A successful CLI version/catalog probe does not prove the provider can authenticate an actual model turn.

## Contract / integration notes

No contract change was required and no lead-owned file was edited by this worker. The worktree shows an external modification to `packages/protocol/src/events.ts` (`seq` → `itemSeq`); it was left untouched.

The contract cannot express why MCP is unavailable beyond capabilities/diagnostic, nor a per-session capability change. Pi/ACP can therefore be locally installed and detectable while `capabilities.mcp` is false; opens requiring unsupported injection reject with a diagnostic. Agent selection should respect that capability.

`DriverSession` has no live model/mode/thinking mutation methods, so selection is applied at open/resume and provider-initiated model/mode changes are forwarded. Claude's native effective model may arrive asynchronously with SDK `system/init` after `open` resolves.

Progress dashboard setup could not complete: the available CLI reported that the progress plugin was not installed/reachable. No daemon files, port 6767 or `~/.paseo` were touched.

## File inventory

Counts include comments and blank lines: **6098 production TypeScript lines**, **2334 test/fixture lines**, **119 smoke-script lines**, **8551 total lines** across 35 files. This report is excluded from those counts.

| File | LOC |
|---|---:|
| `packages/providers/src/agent-sdk-types.ts` | 315 |
| `packages/providers/src/compat.ts` | 15 |
| `packages/providers/src/index.ts` | 7 |
| `packages/providers/src/process.ts` | 17 |
| `packages/providers/src/providers/acp-agent.ts` | 347 |
| `packages/providers/src/providers/acp-tool-detail.test.ts` | 12 |
| `packages/providers/src/providers/acp-tool-detail.ts` | 37 |
| `packages/providers/src/providers/agents.test.ts` | 145 |
| `packages/providers/src/providers/claude/tool-call-detail-parser.ts` | 131 |
| `packages/providers/src/providers/claude/tool-call-mapper.test.ts` | 426 |
| `packages/providers/src/providers/claude/tool-call-mapper.ts` | 164 |
| `packages/providers/src/providers/claude-agent.test.ts` | 125 |
| `packages/providers/src/providers/claude-agent.ts` | 261 |
| `packages/providers/src/providers/codex/app-server-startup.ts` | 159 |
| `packages/providers/src/providers/codex/app-server-transport.ts` | 432 |
| `packages/providers/src/providers/codex/tool-call-detail-parser.ts` | 113 |
| `packages/providers/src/providers/codex/tool-call-mapper.test.ts` | 1196 |
| `packages/providers/src/providers/codex/tool-call-mapper.ts` | 1030 |
| `packages/providers/src/providers/codex-agent.ts` | 242 |
| `packages/providers/src/providers/jsonl-frame-decoder.test.ts` | 108 |
| `packages/providers/src/providers/jsonl-frame-decoder.ts` | 242 |
| `packages/providers/src/providers/jsonl-rpc-process.ts` | 300 |
| `packages/providers/src/providers/pi/tool-call-mapper.test.ts` | 117 |
| `packages/providers/src/providers/pi/tool-call-mapper.ts` | 421 |
| `packages/providers/src/providers/pi-agent.ts` | 241 |
| `packages/providers/src/providers/tool-call-detail-primitives.ts` | 866 |
| `packages/providers/src/providers/tool-call-mapper-utils.ts` | 225 |
| `packages/providers/src/registry.test.ts` | 42 |
| `packages/providers/src/registry.ts` | 173 |
| `packages/providers/src/session.ts` | 113 |
| `packages/providers/src/tree-kill.ts` | 95 |
| `packages/providers/src/test-utils/fake-agent.mjs` | 100 |
| `packages/server/src/driver/paseo-adapter.ts` | 152 |
| `packages/server/src/driver/paseo-adapter.test.ts` | 63 |
| `packages/server/scripts/smoke-drivers.ts` | 119 |
