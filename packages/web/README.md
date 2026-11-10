# baton web console

From the repository root:

```sh
npx tsc -b packages/protocol
npm run dev -w @baton/web
```

Open `http://127.0.0.1:5173/`. Without a token the console uses an in-browser demo;
`?demo=1` forces demo mode even when a token is saved. Reload to reset the demo.
No CLI is spawned and no files are changed by demo actions.

For a real daemon, open `http://127.0.0.1:5173/#token=<daemon-token>`.
The token is moved to sessionStorage and removed from the address. Every API request,
including the fetch-streamed SSE connection, uses a Bearer header. Vite proxies `/api`
and `/mcp` to `http://127.0.0.1:7433`. A production build goes to `packages/web/dist`.

The store fetches a snapshot then subscribes from `lastSeq`, reconnecting with the last
applied run sequence. Transcript rows are fetched only on first opening a node and are
updated by `item` events; repeat `itemSeq` replaces the row. An in-flight transcript
fetch cannot overwrite newer streamed content.

Implemented screens:

- Cross-run 待处理 home page: permissions, roster proposals, agent questions and
  stall/round-limit escalations, grouped by Run and ordered by oldest pending item.
  Its independent fetch-streamed SSE subscription refetches on every `changed`,
  reconciles after connection, and refetches after reconnect. It remains active on
  every console page. Run/sidebar counts use `pendingTotal`.
- Run list, live totals and policy controls, new Run dialog.
- Dagre topology with provider cards, delegation results, inline permission actions,
  stable positions between structural changes, minimap and follow toggle. Fit uses
  0.45–1.1 zoom; minimap hides below 900px canvas width and while
  the inspector is open.
- SVG timeline with node/turn/tool/wait bands, delegation and delivery arrows,
  pointer-centered wheel zoom, drag pan, hover details and node selection. Rows are
  44px high; the title column starts at 260px and resizes by dragging its divider or
  using the focused divider's arrow keys. Tool kinds have distinct colors and tooltips.
- Node-switchable conversation, safe markdown-lite, collapsed reasoning, per-kind
  tool details, and message composer (Cmd/Ctrl+Enter). Server `baton-assignment` and
  `baton-results` messages render as task/result cards linking to the child inspector,
  with JSON and artifacts collapsed. Malformed wrappers fall back to escaped text.
- Inspector with brief, acceptance, output schema, JSON result, artifacts, permissions,
  usage, metadata, recent transcript, message and cancel-subtree actions.
- Agents catalog and browser-local default policy / theme settings.

Permission cards support allow once, always allow (editable command prefix/path
glob, global/Run scope, optional agent restriction), and deny. Settings includes
permission rule create/delete, decision/source, scope, hit count and last hit.
Questions support option buttons and free text; answers are durable `baton-answer`
transcript cards. Escalations support dismiss, cancel, and per-delegation round
extension with an optional note. Node cards/inspector show 等你回答 and 停滞;
the timeline shows question waits and escalation markers/bands.

Browser notifications are opt-in in Settings and request native browser permission
from that action. New pending items (excluding nonblocking questions) and completed
Run transitions notify only while the tab is hidden, with a 30-second per-Run merge
window. New Run and Settings have collapsed advanced policy controls for team size,
stall minutes and maximum delegation rounds.

Teams are available both as a Run tab and as saved presets in the left navigation.
New Run supports dynamic teams (optional seeded roles), a preset's lead and roster,
or solo execution. Dynamic roster proposals require human confirmation by default.
The confirmation card allows role/agent/model/responsibility edits, adding/removing
roles, approval and rejection with feedback. Pending proposals appear in the Run's
pending count and team-tab badge. Queued tasks are listed on the proposal card;
their reserved node IDs do not appear on the graph until approved. Human roster
edits apply immediately. Preset create/edit/save display availability warnings
returned by the server; unknown agent IDs are rejected.

The Run team tab shows every role slot, including replaced/removed history, per-status
delegation counts, actor/reason, and the lead's rationale. Members can be added,
replaced (optionally moving active work), removed, or saved as a preset. Topology
cards and the inspector can reassign work (including failed tasks) to a member or agent; old
nodes stay visible as replaced with a dashed connection to their successors.
The timeline marks roster/proposal decisions on the root row. `baton-notice`
messages appear as safely escaped notice cards.

Demo opens the global inbox with all four kinds. The 人工介入 Run has a blocking
question, a stalled builder and a tester with a held round-limit follow-up. Answer,
extend/dismiss/cancel, and inspect the durable answer/notice messages. Settings has
a sample permission rule with a hit; always-allow creates rules in the same demo.
The login-flow Run has a pending team proposal; its queued delegates
remain stopped until approved (and use any edited specs). Dropped roles or rejected
proposals cancel their queued work. A saved product-team preset is included. Select
the search Run in the sidebar to inspect an evolving team and a replacement.

The search demo has a Claude root delegating to Codex, Claude and pi, including a pi
grandchild that fails. Completed results are delivered to parents. The demo continues
streaming usage, message replacements and verification tools after opening; one UI
permission stays pending until resolved. Allow/deny and autoApprove resolve it and
deliver the final result. New runs, messages and cancellation also use the client interface.

Validation:

```sh
BATON_HOME=/tmp/baton-web-tests npx vitest run packages/web/src
npm run typecheck
npm run build -w @baton/web
```

Tests cover protocol replay/store integration, same-item replacement, lazy-load races,
reconnection offsets, token handling, SSE chunking, safe content rendering, deterministic
demo relationships/actions, time math, tree ordering and graph geometry.
Team tests also cover the shared reducer's full-roster replacement, active slots and
delegation counts, preset validation/CRUD, progress-preserving reassignment, notice
parsing, original/edited approval, dropped roles, rejection, a second pending-proposal
error, replacement approval, and disabled-approval behavior.
The browser demo's baton message formats are compared against the server's pure
prompt formatters in web tests, including batched delivery and escaped title attributes.
Human-loop tests cover cross-Run grouping, pattern derivation, reducer upserts,
remembered rules and precedence, durable answers, escalation choices, cancellation,
inbox reconnect/races, typed API calls, SSE `changed`, escaped cards, notification
gating/coalescing and maximum team size.

Known limits: browser and daemon integration QA are performed by the lead. The timeline
groups spans in linear time and uses one SVG, but a 30-node/2,000-span browser performance
profile has not been run. Demo data is held in memory, while browser theme/default-policy
preferences persist locally. Daemon profile editing and default-policy persistence have
no REST endpoints in the current contract, so Settings shows profile notes read-only and
passes local defaults explicitly on Run creation. Transcript rendering intentionally
supports paragraphs, code fences, lists, inline code and bold only.
