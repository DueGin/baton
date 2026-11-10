# Human-in-the-loop P1 — server delivery

Implemented on main 90e9bd2, retaining the lead's team prompts and reassignment lineage fixes.
No commits. No provider/web/driver-contract edits. The DESIGN.md change in this worktree is
lead-supplied (solo exposes only ask_human).

## Implementation

- `src/kernel/human.ts`: ask_human records/events, blocking activity, answer delivery, terminal
  question cancellation, stall and round-limit escalation records, extend/cancel/dismiss.
- `src/kernel/permission-rules.ts`: rule creation/remember and deterministic matcher. Deny
  outranks allow across scopes; run outranks global among the same decision; equal priority
  uses stable creation order. Names are exact/case-insensitive or `*`; agent scoping is exact.
  Shell prefixes normalize whitespace and require an argument boundary; file globs use paths
  relative to the run cwd. Hits/lastHitAt and createdFrom are persisted.
- `src/notifications/index.ts`: injectable notification function and per-run 30-second batch
  coalescing. macOS uses execFile('osascript', argv), with AppleScript string escaping and
  no shell. Pending items resolved before the batch flush are excluded. Completion is deduped
  until the run becomes active again. Config notifications.desktop defaults to darwin-only.
- `src/store/index.ts`: questions/escalations projection tables follow applyEvent in the same
  transaction as event append; permission-rule and extra-round tables; inbox aggregation and
  pendingTotal. Extra rounds and pending questions survive restart.
- `src/kernel/index.ts`: integration, stall timer reset on every driver event, policy defaults
  and validation, send round admission, permission policy order, persisted answer/notice queue.
  A blocking child question suspends its assignment at idle without prematurely producing a
  fallback result. Answer opens trigger=user when idle, steers or queues when running.
- `src/api/server.ts`: inbox GET + debounced `changed` SSE, question answer, escalation resolve,
  permission-rule GET/POST/DELETE, permission remember, notifier config and injection lifecycle.
- `src/mcp/index.ts`: solo exposes only ask_human; all other tools are omitted and rejected.
- `src/kernel/teams.ts`: maxTeamSize enforcement for formation/addition/edited approval; defaults
  to five active members. Existing member-replacement lineage code retained.
- `src/kernel/prompts.ts`: routing contracts, reuse roster first, human judgment guidance,
  blocking/round-escalation end-turn guidance, assigned-file-only and git operation boundaries.
  Existing mandatory-team rule for multi-file/multi-deliverable work is retained.
- `src/telemetry/index.ts`: questions/escalations in JSON snapshots/events, Markdown sections,
  and OTLP resource attributes.
- `src/index.ts`: exported notification injection types.
- Tests: new `src/human.test.ts`, updated prompts/server/teams regression tests.

## Behavior and defaults

maxTeamSize=5, stallMinutes=10 (fractional positive minutes accepted), maxRoundsPerDelegation=3.
An optional internal stallTimeoutMs allows fast tests. Stall is emitted once per eventless
turn episode; any subsequent driver event resets it. Non-root stall also notifies its parent.

Round-limit escalation holds the original follow-up until extend (default +2), cancels the
subtree on cancel, discards on dismiss, and sends the human note to the parent for all outcomes.
Additional allowed rounds persist per delegation rather than increasing the whole run's policy.

Permission order: baton-tool policy auto-allow → rules → autoApprove → human. Human deny
always sends: "The human denied this action. Do not retry it; choose a different approach or
ask_human." Remember decisions validate before provider response and save the rule after the
response succeeds. Concurrent decisions for one permission are rejected.

Inbox includes permissions, proposals, all pending questions (including nonblocking), and
escalations, oldest first with runTitle. Desktop notifications include only blocking questions,
permissions, proposals, escalations, and run work completion. SSE batching does not starve under
continuous provider events; heartbeat is 15 seconds. Normal bearer/Host/Origin checks apply.

## Verification

- `npx tsc -b packages/protocol packages/providers packages/server`: passed.
- `npx vitest run packages/server`: 5 files / 57 tests passed (final run 9.84 seconds).
- `git diff --check`: passed.
- `npm run typecheck`: protocol/providers/server passed; web (not updated in this worktree)
  fails because demo/client.ts and demo/scenario.ts omit questions/escalations, and derive.ts
  omits RunSummary.pendingTotal. Web worker owns those files.

Focused tests use FakeDriver real HTTP MCP and temp homes/port 0. They cover blocking question
suspend/resume, nonblocking steer, terminal/cancel cleanup, solo tool list, event replay equality,
stall reset/single episode/parent notice, round extend/cancel/dismiss, permission name/prefix/glob/
agent and scope/deny precedence, remember allow/deny/hits/fixed denial, baton policy precedence,
inbox order/pendingTotal/SSE, notification coalescing/completion injection/config, maxTeamSize,
and restart persistence. Existing full daemon and teams demos remain regression coverage.

## Contract notes / limits

- Solo ask_human ambiguity was resolved by the lead: solo injects MCP with only ask_human.
- Permission-rule CRUD follows the specified GET/POST and DELETE routes; editing is delete/create.
- Notification batching is a 30-second fixed window from the first event, then one combined
  notification (rather than sending immediately and spamming updates). Injection overrides the
  platform/config choice for deterministic tests.
- RunStatus is unchanged: normal completed work remains idle until the existing idle-close
  lifecycle. Completion notification uses root idle + no active nodes/delegations, excluding
  blocking questions and roster proposals.
- Stale pending escalations remain available for the human to dismiss after a node has recovered
  or ended; the contract only mandates automatic cancellation for questions.
- Live macOS notification permission/UI and real agent CLIs were not exercised in this round;
  tests inject a notifier and use actual HTTP MCP with deterministic fake sessions.
