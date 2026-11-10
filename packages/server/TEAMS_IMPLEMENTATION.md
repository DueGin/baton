# Teams and roster approval — server delivery

Implemented against main 4df9efb and the lead-supplied delegateOutput correction.
No commits. No changes to providers, web, driver/types.ts, or DESIGN.md. The modified
protocol/mcp-tools.ts in this worktree is the lead's supplied output-schema correction.

## Behavior

- Run policy defaults to `mode: dynamic`, `teamApproval: true`. Legacy stored `delegation`
  policies normalize via an event on recovery. Invalid modes/approval values are rejected.
- Preset runs default root agent/model/mode/thinking to the preset lead. An explicit different
  root agent does not inherit another provider's model settings. Optional initial dynamic
  rosters are human-owned and apply immediately.
- Team members are role slots with ids, status, actor and change history. Nodes/delegations
  record role/memberId. Dynamic direct-agent delegation adds a unique ad-hoc role. Preset
  role restrictions apply at every depth. Solo injects no baton MCP configuration and blocks
  all kernel baton-tool/delegation entry points.
- `form_team` and `replace_member` are lead-only. `reassign` verifies direct-child ownership.
  `get_team` returns the full TeamRecord with member.delegations (including statuses).
- Agent formation/addition/replacement requests create one pending proposal at a time by
  default. Tool responses use pending_approval/proposalId. Pending-role delegation creates
  a queued DelegationRecord with blockedByProposal and a reserved toNodeId; no NodeRecord,
  driver session, or MCP node token exists until approval. The tool omits nodeId while pending.
- Approve supports edited roster/specs and added/dropped roles. Approved specs override queued
  proposal model/mode/thinking. Dropped roles and rejected proposals cancel queued work.
  Human roster operations bypass approval. Every approval/rejection sends a notice containing
  proposed vs actual specs and feedback to the proposer through the debounced delivery path.
- Reassignment cancels descendants, interrupts/closes the predecessor, marks predecessor
  node/delegation replaced, creates the successor from the same parent, and links both ids.
  The brief context contains up to 2000 characters from the predecessor's last assistant
  response plus edit/write file paths. Human/collateral reassignment notifies the parent;
  parent-initiated immediate reassignment returns the successor without an extra notice.
  A direct-agent reassign that needs approval leaves the predecessor running until approval;
  rejection cancels only the queued successor. Replaced results are excluded from automatic
  delivery and wait/get_result output; explicit wait on the old id returns replacement info.
- Notices persist in SQLite so an approval response survives daemon restart before delivery.
  Blocked queued work and pending proposals also survive restart without becoming interrupted.
- Presets CRUD is SQLite-backed. Unknown catalog ids fail save; known unavailable/disabled
  agents may be saved, with `warnings: string[]` on POST/PUT/save-preset responses. Creating
  a run or adding/replacing a live member still requires ready/enabled agents.
- JSON exports already include team state/events; Markdown now adds roster/change-history
  tables, OTLP includes serialized team plus role/member span attributes.

## API

Implemented contract routes: /api/teams GET/POST, /api/teams/:id PUT/DELETE (plus GET),
/api/runs/:id/team/members POST, .../members/:memberId/replace POST,
.../members/:memberId DELETE, .../team/save-preset POST,
.../team/proposals/:proposalId/approve POST, .../reject POST,
and /api/delegations/:id/reassign POST. Existing bearer/Host/Origin/JSON checks apply.

## Files

New: src/kernel/teams.ts, src/teams.test.ts, this report.
Updated: src/kernel/index.ts, prompts.ts, prompts.test.ts; src/store/index.ts;
src/api/server.ts; src/driver/fake.ts; src/telemetry/index.ts; src/server.test.ts.
Existing production driver/paseo-adapter.ts is retained unchanged.

## Fake demo

`baton serve --fake`, then create a dynamic run with fake-claude/fake-codex/fake-pi.
The root proposes builder/reviewer/researcher roles and ends its turn. It stays pending until
approved through the API/UI. After approval it delegates in parallel across fake agents. The
initial builder fails after recording progress and an edit item; the root proposes a replacement
and ends its turn again. Approve the second proposal to transfer the task/progress to fake-claude
and complete it. Research includes a normal simulated permission request. No real files change.
`teamApproval:false` exercises immediate formation/replacement. The legacy 5-node demo is
retained under prompt `legacy demo` for prior regression coverage.

## Verification

- `npx vitest run packages/server`: 4 files, 40 tests passed (final run 9.53 s).
- `npx tsc -b packages/protocol packages/providers packages/server`: passed.
- `git diff --check`: passed.
- `npm run typecheck`: server/providers/protocol build passes, then web fails in the current
  worktree's unmerged UI: App.tsx (old delegation properties), NewRun.tsx (DelegationMode and
  delegation references), demo/client.ts (optional CreateRunRequest.agent). Web worker owns
  these files; this worker did not edit them.

Coverage includes role delegation/overrides, duplicate role rejection, ad-hoc roles, preset root
and depth-2 enforcement, solo, lead-only and ownership, reassign carry-over/cascade/wait/no-old-
result delivery, human REST reassign/notifications, member removal, presets CRUD/save, approval
as-is/edited/dropped roles/rejection/second-proposal rejection/default-off bypass, ad-hoc and
replacement proposals, restart/legacy migration/durable notices, team.updated replay equality,
exports, prompts and the full two-approval dynamic demo, plus earlier daemon regression tests.

## Contract notes and limits

- The lead corrected delegateOutput to allow pending_approval and optional nodeId/proposalId;
  keep that supplied protocol change when merging.
- DelegationRecord.toNodeId is required even before an approved node exists. The server reserves
  its future id; consumers must tolerate blockedByProposal delegations without a matching node.
- Preset warning fields are additive response metadata because TeamPreset has no warnings field.
- Parent-initiated approval-requiring reassign yields an approval notice (required for every
  proposal outcome) and a parent mapping notice when the delayed transfer applies.
- A roster change and provider interrupt/start cannot be one database transaction. Admission
  is validated first; batch replacement returns warnings for any task it cannot reassign, keeping
  the remaining assignments visible. Runtime/global/budget admission is checked again on release.
- Model availability is delegated to the selected provider; agent catalog readiness is validated.
- Real agent/provider execution was not run in this round; deterministic FakeDriver HTTP tests
  validate kernel/MCP/API behavior. Live OTLP push remains the existing P2 item.
