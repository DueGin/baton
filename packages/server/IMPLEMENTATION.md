# Server worker delivery

The daemon is implemented in `src` and only consumes provider agents through `DriverRegistry`.
No commits were created. `src/driver/paseo-adapter.ts` is the requested throwing placeholder:
replace it with the providers worker's implementation when merging.

## Architecture and files

- `src/store/index.ts`: node:sqlite WAL store, append-only per-run event stream and record/item
  projections updated together in an immediate transaction. Uses protocol `applyEvent` for
  projection semantics. Text rows use node-local `itemSeq`.
- `src/kernel/index.ts`: node/session runtimes, limits and budget admission, turns and delegation
  rounds, report/fallback capture, schema corrections, debounced automatic result delivery,
  wait/result consumption, ownership, permissions, cancellation, usage rollups, recovery and
  idle session close/resume. The default delivery debounce is 1500 ms and idle timeout 30 min.
- `src/kernel/prompts.ts`: system instructions, assignment, correction and result prompts.
- `src/kernel/schema.ts`: JSON Schema subset: type (including integer/null and type arrays),
  properties, required, items, enum, additionalProperties. Descriptive metadata is accepted;
  unsupported validation keywords produce explicit validation failures. Two correction turns
  are allowed. No additional package was needed.
- `src/driver/fake.ts`: configurable FakeDriver/FakeSession/FakeDriverRegistry. Scripts can emit
  messages, reasoning, tool items and cumulative turn usage; delay; request permission; fail;
  and call all baton tools through the MCP SDK's actual HTTP client. The default three-agent
  demo builds five nodes (root, three parallel children, one grandchild), includes a permission
  request and simulated integration failure, waits for a specialist and rolls up usage.
- `src/mcp/index.ts`: SDK Streamable HTTP with node token identity and protocol descriptions.
  Uses stateless per-request transports. Provider tool items are enriched; no extra tool span
  is created for an MCP handler invocation.
- `src/api/server.ts`: HTTP REST/SSE, JSON body limit, bearer token file (0600), Host/Origin
  checks, node MCP routing, static console SPA fallback, info endpoint, start/close lifecycle.
- `src/telemetry/index.ts`: replayable JSON (snapshot/events/items), Markdown report and
  OTLP/JSON exports with node/turn/tool span hierarchy and GenAI usage attributes.
- `src/cli/main.ts`: serve, agents/refresh, runs, run/follow and export. HTTP clients discover
  the daemon from `$BATON_HOME/daemon.json`; serve prints the token-fragment console URL.
- `src/index.ts`: startServer and reusable driver/store/kernel exports.
- `src/server.test.ts`: deterministic integration tests using temporary homes and port 0.

## Verification

- `npx tsc -b packages/protocol packages/providers packages/server`: passed.
- `npm run typecheck`: passed (exit 0).
- `npx vitest run packages/server`: 16 tests passed. Tests cover depth 3/reject depth 4,
  concurrent children/fan-out/global limits/budget rejection, report vs fallback, two schema
  corrections then failure, wait any/all/timeout and get_result consumption, follow-up round 2,
  running steer vs unsupported queued delivery, pending/human and policy permissions,
  ownership/root report rejection, descendant cancellation/session closure, restart resume,
  projection equality with replay, text coalescing, idle token invalidation/resume, shipped
  demo, CLI HTTP smoke tests, auth/Host/Origin/content-type checks, SSE seq/header resume,
  and all export formats.
- Integration tests need permission to bind localhost in the managed sandbox; approved runs
  use ephemeral ports and never use 6767 or the user's normal baton data directory.

## Contract points for the lead

1. `Partial<Record>` shallow patch events cannot remove optional fields over JSON because
   undefined is dropped. Follow-up/resume must clear result, deliveredAt, endedAt and errors.
   Local workaround uses existing `node.created`, `delegation.created` and `run.created`
   reducer upsert/replace semantics when clearing fields; no contract file was edited by the
   server worker. A future explicit replace event or null/removal patch syntax is cleaner.
2. `ToolSpanRecord` lacks delegationId although the scope asks for it on enriched spans.
   The server carries an additive delegationId field on the emitted runtime span; transcript
   `ToolCallDetail` uses the existing typed baton.delegationId field.
3. Budget behavior follows the binding `RunPolicy.budget` documentation: exceeding a budget
   rejects new delegation and follow-up admission, and does not cancel running work. The
   design's phase table mentions a hard stop, which conflicts with that explicit record rule.
4. The lead supplied the `RunEvent.itemSeq` correction in this worktree; keep that lead-owned
   protocol change in the merge.

## Deliberate limits / follow-up work

- Production provider execution is pending replacement of the requested adapter placeholder.
- Live OTLP push and parent permission approval remain P2; export is implemented.
- JSON Schema validation is the documented subset, not full draft compliance.
- Projection records use JSON columns plus indexed ids; each append reads the run snapshot
  through the reducer. This favors consistent replay for P1, and can be optimized for very
  large traces later without changing the event contract.
- Streamable HTTP transport is stateless; live events are exposed through the REST SSE API.
- Static hosting is implemented; actual web assets come from the web worker.
