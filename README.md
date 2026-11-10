# baton

Local agent client with **native delegation** and **observability**. baton detects and drives the agent CLIs already installed on your machine (Claude Code, Codex, pi, and any ACP agent such as Gemini CLI, Qwen Code, Kimi, OpenCode, Goose…) instead of running its own agent loop.

- Every agent baton starts gets a per-node `baton` MCP server with `list_agents`, `delegate`, `wait`, `get_result`, `send`, `cancel`, `status`, `report_result`. Any agent can delegate to any detected agent, across vendors; results come back to the delegating agent automatically.
- The web console shows the live delegation **topology**, a **timeline** of every turn, tool call and permission wait, full **transcripts**, and lets you approve permissions, message any node or cancel a subtree.

Design: [docs/DESIGN.md](docs/DESIGN.md).

## Run

```bash
npm install
npm run build                      # protocol → providers → server → web
node packages/server/dist/cli/main.js serve          # http://127.0.0.1:7433/#token=…
node packages/server/dist/cli/main.js serve --fake   # demo agents, no real CLIs needed
```

Development: `npm run dev` (daemon via tsx) and `npm run dev:web` (Vite on :5173, proxies to :7433; without a token it runs an in-browser demo).

CLI: `baton agents [--refresh]`, `baton runs`, `baton run <agent> "<prompt>" [--cwd] [--model] [--mode] [--auto-approve] [--follow]`, `baton export <runId> --format json|md|otlp`.

Data lives in `~/.baton` (override with `BATON_HOME`). The daemon listens on 127.0.0.1 only and requires the token in `~/.baton/token`.

## Verify

```bash
npm run typecheck && npx vitest run
npx tsx packages/server/scripts/smoke-drivers.ts claude codex pi   # real CLIs + network
```

Provider adapters are derived from [Paseo](https://github.com/getpaseo/paseo) (Apache-2.0); see NOTICE.
