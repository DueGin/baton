# Provider adapter handoff — plan A′

This round preserves native Claude Agent SDK / Codex app-server / Pi RPC, and expands the generic ACP path into 50 data-driven specifications (53 builtin entries total). No protocol, DESIGN, driver-types, web or desktop source was edited. No commit or dependency installation was made.

## Tracked sources and attribution

Sources were read-only. No source-tree scripts or package commands were executed.

| Source | Commit | Derived paths | License |
|---|---|---|---|
| Paseo | `63ea3e55618ab0849cf0a45d5fee02f509b58c73` | provider-registry; Claude/Pi interruption; app/data/acp-provider-catalog; Cursor/Copilot/Kiro/Trae ACP behavior | Apache-2.0, Mohamed Boudra |
| Orca | `a5781b8c151d00afded6f62d9a2529b37e0114d5` | ACP launch registry/specs, Cursor/Kimi dialects, form elicitation | MIT, Copyright 2026 Lovecast Inc. |
| acpx | `0701de4e9e31d39ee652453f240eba81b94f483b` | src/agent-registry.ts command table and package-exec alternatives | MIT, Copyright 2025 OpenClaw Team |

Each derived implementation has a source/license header. Full MIT notices are retained in `licenses/Orca-MIT.txt` and `licenses/acpx-MIT.txt`; existing Paseo attribution remains in the repository NOTICE and file headers.

## Behavior and architecture

- `src/acp-spec.ts`: validated `AcpAgentSpec`, 50 specs, installed/package-runner variants, environments and scrub lists, numeric/date/major-specific version floors, explicit mode flags, MCP transport limits, discovery and question/timeout capabilities, source notes and install links.
- `src/registry.ts`: installed-first detection, bounded version probes, error status for version-floor failure, additive AgentEntry metadata, profiles overriding the spec fields through `agents.<id>` with `extends:"acp"`. Unknown spec keys are rejected. An absent binary remains listed as unavailable with its install hint; `enabled` never installs anything. The existing disabled-entry behavior is retained (unavailable, diagnostic "Disabled in config.json").
- `src/providers/acp-agent.ts`: catalog probes initialize and optionally issue session-free model RPCs. **No `session/new` in any catalog probe**, including custom agents. No authentication RPC/browser login. Actual user sessions still use session/new/load. Cursor uses `cursor/list_available_models`; other catalogs use initialize/_meta/configured models and explicit known modes. Models available only from a session are intentionally not discovered during probing.
- Claude interruption withdraws locally queued input and SDK-consumed/unstarted UUIDs before interrupt. Lifecycle frames remove started UUIDs; `perTaskStopAffordance` is enabled. If an older SDK cannot recall consumed input, the session closes before it can revive the turn.
- Pi clears its queue before abort, tolerating only the known old-version unknown-command response.
- Kimi `auto` is unattended; `yolo` still asks. Explicit provider maps precede the generic mode regex. Kimi streaming argument text is kept out of shell output; terminal exit summaries become structured output.
- Copilot allow-all environment is scrubbed after all overlays, including hosted terminal children. `allow-all` writes the `allow_all` selector; normal modes turn it off. Autopilot is excluded from catalog modes.
- ACP form elicitation and Cursor custom/fallback questions map to native question requests, with original field/option IDs restored on answer. Extension questions receive a timeline tool anchor. URL elicitation emits an http(s) notice/link and replies cancel (showing a link never implies consent).
- Kiro extension command arrivals become notices. Trae's asynchronous standard command announcements remain harmless; baton has no slash-command/skill catalog API. OpenCode/OMP remain ACP.
- Windows installed binaries resolve via existing PATHEXT support; npm/npx variants use `processLaunch` and cmd shim quoting. Every spec and optional package variant has pure macOS/Windows argv coverage.
- The smoke script accepts any detected builtin/configured ID: `npx tsx packages/server/scripts/smoke-drivers.ts <id> ...`. Real smoke was not run in this round.

## Command/version decisions

- Kiro: `kiro-cli acp`, confirmed 2026-11-16 from [vendor ACP documentation](https://kiro.dev/docs/cli/acp/). This supersedes acpx's legacy `kiro-cli-chat acp`. Documentation also warns that signed-out initialize can report only auth capabilities; detection does not log in.
- Droid: Paseo catalog uses `droid exec --output-format acp-daemon`, observed in its 0.249.0 catalog; acpx uses `... acp`. The attempted [Factory ACP page](https://docs.factory.ai/cli/advanced/acp) redirected to a protected Vercel login. This remains source-verified only, with an explicit notes field and command override; MCP injection is disabled per Paseo's supportsMcpServers:false.
- OpenCode floor: 1.x ≥1.18.31; 2.x ≥2.0.14. `OPENCODE_CLIENT=acp` and `OPENCODE_ENABLE_QUESTION_TOOL=false` follow Orca: 1.x cannot answer questions; 2.x ignores the legacy guard and negotiates form elicitation.
- OMP floor 17.0.5, `PI_NO_PTY=1`; Kimi floor 2.5.0; Copilot floor 1.0.88; Cursor date floor 2026.10.21. Other catalog versions are reference snapshots, not invented minimum versions.

## Configuration example

```json
{
  "agents": {
    "my-kimi": {
      "extends": "acp",
      "label": "Custom Kimi",
      "command": ["kimi", "acp"],
      "minVersion": "2.5.0",
      "dialect": "kimi",
      "modeMap": {"unattended": ["auto"], "readOnly": []},
      "mcp": {"supported": true, "http": true, "sse": false, "stdio": true},
      "scrubEnv": ["UNSAFE_OVERRIDE"],
      "noScratchSession": true,
      "models": [{"id": "my-model", "label": "My model"}]
    },
    "opencode": {"extends": "acp", "command": ["npx", "-y", "--package=opencode-ai", "--", "opencode", "acp"]}
  }
}
```

Package variants are opt-in via `command`; detection never silently downloads packages because npx happens to be installed. `noScratchSession:false` cannot opt out of session-free probing. `longToolCalls` is conservative false for the builtin ACP agents; profiles may declare true together with a verified `toolTimeout` env knob. Unsupported long MCP calls use baton's existing async ask_human path. Native ACP elicitation is unaffected.

## Contract issues and remaining limits

No contract change is required for this implementation. The shared AgentEntry capability only has one `mcp` boolean; the spec retains individual transports, while the catalog's boolean reflects observed HTTP injection (required by baton). ACP slash commands, model mutation, optional schema fields, numeric/nested elicitation schemas and plugin UI are outside the current contract. Form support covers 1–4 string/boolean/enum/array fields; oversized/unsupported forms fail explicitly rather than silently partially answering. Unknown transports and unsupported vendor methods fail with diagnostics.

For most long-tail agents, launch argv and capability hints are verified against the tracked sources, **not actual vendor binaries**. Actual MCP HTTP capability is checked against initialize before use. Unverified homepages outside the Paseo catalog are supplied from acpx package/vendor references. Windows was tested with pure launch fixtures, not a Windows host. Catalog probing cannot prove authentication or successful model turns. No globs or arbitrary JavaScript hooks are loaded from config; dialect selection is a closed supported set.

## How to re-sync

1. Pin new upstream commits; diff Paseo provider catalog/subclasses, Orca launch registry/dialects, and acpx registry against the hashes above.
2. Copy only changed data/normalizers into the spec/dialect modules. Preserve attribution and full license notices; do not execute upstream setup scripts.
3. Confirm permission semantics, dangerous environment variables, minimum-version evidence and MCP transport capability for each change. Never infer unattended mode from a new provider's ambiguous label.
4. Keep probes session-free; add initialize/custom-RPC fixtures for catalog differences. Update `modelDiscovery`/configured models instead of creating retained scratch sessions.
5. Run provider/server regression, root typecheck and pure macOS/Windows launch tests. Opt into real smoke for specific installed/authenticated agents and record its version/results separately.

## Validation

Final command results are recorded at the end after regression.

## Final builtin catalog

Verification: **source** = cross-checked against pinned source only; **vendor** = launch command confirmed by current vendor docs; **smoke** = real binary turn (none in this round). "HTTP/SSE/stdio*" denotes spec allowance; actual HTTP/SSE support is negotiated and can be absent. `—` means no evidence-backed version floor.

| ID | Command | Minimum version | MCP | Verified |
|---|---|---|---|---|
| claude | `claude` | — | native HTTP/SSE/stdio | existing native adapter |
| codex | `codex` | — | native HTTP/stdio | existing native adapter |
| pi | `pi` | — | builtin HTTP/stdio or adapter | existing native adapter |
| gemini | `gemini --acp` | — | http/sse/stdio* | source |
| qwen | `qwen --acp` | — | http/sse/stdio* | source |
| kimi | `kimi acp` | 2.5.0 | http/sse/stdio* | source |
| opencode | `opencode acp` | 1.x ≥1.18.31; 2.x ≥2.0.14 | http/sse/stdio* | source |
| omp | `omp acp` | 17.0.5 | http/sse/stdio* | source |
| copilot | `copilot --acp --stdio` | 1.0.88 | http/sse/stdio* | source |
| cursor | `cursor-agent --disable-auto-update acp` | 2026.10.21 | http/sse/stdio* | source |
| goose | `goose acp` | — | http/sse/stdio* | source |
| droid | `droid exec --output-format acp-daemon` | — | none | source |
| hermes | `hermes acp` | — | http/sse/stdio* | source |
| openclaw | `openclaw acp` | — | http/sse/stdio* | source |
| kiro | `kiro-cli acp` | — | http/sse/stdio* | vendor |
| grok | `grok agent stdio` | — | http/sse/stdio* | source |
| traecli | `traecli acp serve` | — | http/sse/stdio* | source |
| devin | `devin acp` | — | http/sse/stdio* | source |
| qoder | `qodercli --acp` | — | http/sse/stdio* | source |
| amp | `amp-acp` | — | http/sse/stdio* | source |
| cline | `cline --acp` | — | http/sse/stdio* | source |
| kilo | `kilo acp` | — | http/sse/stdio* | source |
| auggie | `auggie --acp` | — | http/sse/stdio* | source |
| junie | `junie --acp=true` | — | http/sse/stdio* | source |
| agoragentic | `agoragentic-mcp --acp` | — | http/sse/stdio* | source |
| autohand | `autohand-acp` | — | http/sse/stdio* | source |
| codebuddy | `codebuddy --acp` | — | http/sse/stdio* | source |
| codewhale | `codewhale serve --acp` | — | http/sse/stdio* | source |
| cortex | `cortex acp serve` | — | http/sse/stdio* | source |
| corust | `corust-agent-acp` | — | http/sse/stdio* | source |
| crow | `crow-cli acp` | — | http/sse/stdio* | source |
| deepagents | `deepagents-acp` | — | http/sse/stdio* | source |
| dimcode | `dimcode acp` | — | http/sse/stdio* | source |
| dirac | `dirac-cli --acp` | — | http/sse/stdio* | source |
| fast-agent | `fast-agent-acp -x` | — | http/sse/stdio* | source |
| fx | `fx acp` | — | http/sse/stdio* | source |
| gjc | `gjc acp` | — | http/sse/stdio* | source |
| glm | `glm-acp-agent` | — | http/sse/stdio* | source |
| hoplite | `hoplite acp` | — | http/sse/stdio* | source |
| mcode | `mcode acp` | — | http/sse/stdio* | source |
| minion | `minion-code acp` | — | http/sse/stdio* | source |
| vibe | `vibe-acp` | — | http/sse/stdio* | source |
| nova | `nova acp` | — | http/sse/stdio* | source |
| pool | `pool acp` | — | http/sse/stdio* | source |
| sigit | `sigit` | — | http/sse/stdio* | source |
| stakpak | `stakpak acp` | — | http/sse/stdio* | source |
| vtcode | `vtcode acp` | — | http/sse/stdio* | source |
| ante | `ante acp` | — | http/sse/stdio* | source |
| deepseek-harness | `dsh --profile acp` | — | http/sse/stdio* | source |
| iflow | `iflow --experimental-acp` | — | http/sse/stdio* | source |
| mux | `mux acp` | — | http/sse/stdio* | source |
| octomind | `octomind acp developer:general` | — | http/sse/stdio* | source |
| zeroclaw | `zeroclaw acp` | — | http/sse/stdio* | source |

## Final validation results

- `npx vitest run packages/providers packages/server`: **PASS, 31 files / 415 tests** (final run, including real child fixtures and native ACP-question integration; no network).
- `npm run typecheck`: **PASS**, exit 0: protocol/providers/server build, web `tsc --noEmit`, desktop `tsc -b`.
- Additional strict standalone typecheck for changed tests and `smoke-drivers.ts` with ES2023/Node libraries: **PASS**.
- `git diff --check`: **PASS**.
- Real vendor smoke: **not run**; this round makes no claim of authenticated real turns for the 50 catalog agents.
