# baton

Local agent client with **native delegation** and **observability**. It detects and drives the agent CLIs already installed on your machine (Claude Code, Codex, pi, and any ACP agent) instead of running its own agent loop. Every agent it starts can delegate to any other detected agent; the console shows the live delegation topology, a timeline of every turn and tool call, and full transcripts.

Status: under construction (P1). Design: [docs/DESIGN.md](docs/DESIGN.md).

Provider adapters are derived from [Paseo](https://github.com/getpaseo/paseo) (Apache-2.0); see NOTICE.
