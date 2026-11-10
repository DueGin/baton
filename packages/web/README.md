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

- Run list, live totals and policy controls, new Run dialog.
- Dagre topology with provider cards, delegation results, inline permission actions,
  stable positions between structural changes, minimap and follow toggle. Fit uses
  0.85–1.1 zoom to keep text readable; minimap hides below 900px canvas width and while
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

Demo starts with a Claude root delegating to Codex, Claude and pi, including a pi
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
The browser demo's baton message formats are compared against the server's pure
prompt formatters in web tests, including batched delivery and escaped title attributes.

Known limits: browser and daemon integration QA are performed by the lead. The timeline
groups spans in linear time and uses one SVG, but a 30-node/2,000-span browser performance
profile has not been run. Demo data is held in memory, while browser theme/default-policy
preferences persist locally. Daemon profile editing and default-policy persistence have
no REST endpoints in the current contract, so Settings shows profile notes read-only and
passes local defaults explicitly on Run creation. Transcript rendering intentionally
supports paragraphs, code fences, lists, inline code and bold only.
