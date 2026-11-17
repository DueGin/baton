/**
 * ACP launch specifications derived from Paseo packages/app/src/data/acp-provider-catalog.ts
 * and providers/*-acp-agent.ts @63ea3e5 (Apache-2.0, Mohamed Boudra), Orca
 * src/main/acp/launch/acp-launch-registry.ts and per-agent launch specs @a5781b8
 * (MIT, Copyright 2026 Lovecast Inc.), and acpx src/agent-registry.ts @0701de4e (MIT, OpenClaw Team).
 * Modified for baton: installed-first detection, no scratch sessions, explicit capabilities.
 */
import { z } from "zod";
import { processLaunch, type ProcessLaunch } from "./windows-command.js";
import type { AgentMode, ProviderCatalog } from "./agent-sdk-types.js";

const argv = z.array(z.string().min(1)).min(1);
export const AcpSpecFields = {
  command: argv,
  npx: argv.optional(),
  env: z.record(z.string(), z.string()).default({}),
  scrubEnv: z.array(z.string()).default([]),
  minVersion: z.string().optional(),
  versionFloors: z.record(z.string(), z.string()).optional(),
  versionArgs: z.array(z.string()).default(["--version"]),
  installHint: z.string(),
  homepage: z.string().url(),
  modelDiscovery: z.enum(["initialize", "cursor", "static", "none"]).default("initialize"),
  modelCatalogRpc: z.string().optional(),
  modeMap: z.object({ unattended: z.array(z.string()).default([]), readOnly: z.array(z.string()).default([]) }).optional(),
  mcp: z.object({ supported: z.boolean(), http: z.boolean(), sse: z.boolean(), stdio: z.boolean() }),
  noScratchSession: z.boolean().default(true),
  elicitation: z.object({ form: z.boolean(), url: z.boolean() }).default({ form: true, url: true }),
  longToolCalls: z.boolean().default(false),
  /** Offer image prompt parts (AgentEntry.capabilities.images). Only for agents known to advertise
   * promptCapabilities.image; the session still checks the agent's initialize response. */
  images: z.boolean().default(false),
  /** Budget for initialize / session setup RPCs. Some agents (OpenCode ~11 s cold) start slowly. */
  startupTimeoutMs: z.number().int().positive().default(30000),
  toolTimeout: z.object({ env: z.string(), milliseconds: z.number().int().positive() }).optional(),
  dialect: z.enum(["generic", "cursor", "kimi", "copilot", "opencode", "kiro", "trae"]).default("generic"),
  notes: z.string().optional(),
  source: z.string().default("Paseo 63ea3e5 / acpx 0701de4e / Orca a5781b8"),
  verified: z.enum(["source", "vendor", "smoke"]).default("source"),
};
export const AcpAgentSpecSchema = z.object({ id: z.string().min(1), label: z.string().min(1), ...AcpSpecFields });
export type AcpAgentSpec = z.infer<typeof AcpAgentSpecSchema>;
const HTTP_MCP = { supported: true, http: true, sse: true, stdio: true };
function spec(id: string, label: string, command: string[], homepage: string, extra: Partial<AcpAgentSpec> = {}): AcpAgentSpec {
  return AcpAgentSpecSchema.parse({ id, label, command, homepage, installHint: `Install ${label}: ${homepage}`, mcp: HTTP_MCP, ...extra });
}
export const ACP_AGENT_SPECS: readonly AcpAgentSpec[] = [
  // images: initialize advertises promptCapabilities.image — Gemini CLI acpRpcDispatcher.ts (main, 2026-11-18),
  // Qwen Code 0.27.4 bundle, OpenCode 1.19.5 binary, Kimi Code docs/en/reference/kimi-acp.md.
  spec("gemini", "Gemini CLI", ["gemini", "--acp"], "https://geminicli.com", { npx: ["npx", "-y", "@google/gemini-cli", "--acp"], images: true }),
  spec("qwen", "Qwen Code", ["qwen", "--acp"], "https://qwenlm.github.io/qwen-code-docs/en/users/overview", { npx: ["npx", "-y", "@qwen-code/qwen-code", "--acp"], modeMap: { unattended: ["yolo"], readOnly: ["plan"] }, images: true }),
  spec("kimi", "Kimi Code", ["kimi", "acp"], "https://github.com/MoonshotAI/kimi-code", { images: true, minVersion: "2.5.0", env: { KIMI_CODE_NO_AUTO_UPDATE: "1" }, dialect: "kimi", modeMap: { unattended: ["auto"], readOnly: [] }, notes: "Kimi ACP: auto never asks; yolo still asks about risky actions. Mode names are counterintuitive (Orca evidence)." }),
  spec("opencode", "OpenCode", ["opencode", "acp"], "https://opencode.ai/docs/acp/", { images: true, startupTimeoutMs: 60000, minVersion: "1.18.31", versionFloors: { "1": "1.18.31", "2": "2.0.14" }, env: { OPENCODE_CLIENT: "acp", OPENCODE_ENABLE_QUESTION_TOOL: "false" }, dialect: "opencode", npx: ["npx", "-y", "--package=opencode-ai", "--", "opencode", "acp"], modeMap: { unattended: [], readOnly: ["plan"] }, notes: "1.x cannot answer ACP questions; 2.x ignores the guard and negotiates form elicitation. ACP retained deliberately." }),
  spec("omp", "Oh My Pi", ["omp", "acp"], "https://github.com/can1357/oh-my-pi", { minVersion: "17.0.5", env: { PI_NO_PTY: "1" }, notes: "ACP transport; catalog from initialize/config only. No persistent listing session." }),
  spec("copilot", "GitHub Copilot", ["copilot", "--acp", "--stdio"], "https://github.com/github/copilot-cli", { minVersion: "1.0.88", scrubEnv: ["COPILOT_ALLOW_ALL"], noScratchSession: true, modelDiscovery: "static", dialect: "copilot", modeMap: { unattended: ["allow-all"], readOnly: ["https://agentclientprotocol.com/protocol/session-modes#plan"] }, notes: "Every session is retained upstream; catalog never opens one. Managed policy env remains intact." }),
  spec("cursor", "Cursor", ["cursor-agent", "--disable-auto-update", "acp"], "https://docs.cursor.com/en/cli/overview", { minVersion: "2026.10.21", modelDiscovery: "cursor", modelCatalogRpc: "cursor/list_available_models", noScratchSession: true, dialect: "cursor", modeMap: { unattended: ["yolo"], readOnly: ["plan", "ask"] } }),
  spec("goose", "Goose", ["goose", "acp"], "https://block.github.io/goose/"),
  spec("droid", "Factory Droid", ["droid", "exec", "--output-format", "acp-daemon"], "https://factory.ai/product/cli", { env: { DROID_DISABLE_AUTO_UPDATE: "true", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" }, mcp: { supported: false, http: false, sse: false, stdio: false }, notes: "Paseo uses acp-daemon (0.249.0); acpx uses acp. Vendor ACP page inaccessible on 2026-11-16. Override command for older versions; MCP disabled per Paseo." }),
  spec("hermes", "Hermes", ["hermes", "acp"], "https://hermes-agent.nousresearch.com/docs/user-guide/features/acp"),
  spec("openclaw", "OpenClaw", ["openclaw", "acp"], "https://github.com/openclaw/openclaw"),
  spec("kiro", "Kiro", ["kiro-cli", "acp"], "https://kiro.dev/docs/cli/acp/", { dialect: "kiro", verified: "vendor", notes: "Vendor docs confirm kiro-cli acp; acpx's kiro-cli-chat is legacy." }),
  spec("grok", "Grok", ["grok", "agent", "stdio"], "https://docs.x.ai/build/overview", { notes: "Orca: initialize-only discovery; no interactive authentication during probe." }),
  spec("traecli", "Trae CLI", ["traecli", "acp", "serve"], "https://docs.trae.cn/cli_get-started-with-trae-cli", { dialect: "trae", notes: "Commands/skills arrive asynchronously via available_commands_update; no command API in baton." }),
  spec("devin", "Devin", ["devin", "acp"], "https://cli.devin.ai/docs"),
  spec("qoder", "Qoder", ["qodercli", "--acp"], "https://qoder.com", { npx: ["npx", "-y", "@qoder-ai/qodercli", "--acp"] }),
  spec("amp", "Amp", ["amp-acp"], "https://github.com/tao12345666333/amp-acp", { notes: "ACP bridge, not the native amp CLI." }),
  spec("cline", "Cline", ["cline", "--acp"], "https://cline.bot/cli", { npx: ["npx", "-y", "cline", "--acp"] }),
  spec("kilo", "Kilo Code", ["kilo", "acp"], "https://kilo.ai/docs/code-with-ai/platforms/cli", { npx: ["npx", "-y", "--package=@kilocode/cli", "--", "kilo", "acp"] }),
  spec("auggie", "Auggie", ["auggie", "--acp"], "https://www.augmentcode.com/", { npx: ["npx", "-y", "@augmentcode/auggie", "--acp"], env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" } }),
  spec("junie", "Junie", ["junie", "--acp=true"], "https://junie.jetbrains.com/docs/junie-cli-acp.html"),
  spec("agoragentic", "Agoragentic", ["agoragentic-mcp", "--acp"], "https://agoragentic.com", { npx: ["npx", "-y", "agoragentic-mcp", "--acp"] }),
  spec("autohand", "Autohand", ["autohand-acp"], "https://www.autohand.ai/cli/", { npx: ["npx", "-y", "@autohandai/autohand-acp"] }),
  spec("codebuddy", "CodeBuddy", ["codebuddy", "--acp"], "https://www.codebuddy.cn/cli/"),
  spec("codewhale", "CodeWhale", ["codewhale", "serve", "--acp"], "https://codewhale.net/"),
  spec("cortex", "Cortex Code", ["cortex", "acp", "serve"], "https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli"),
  spec("corust", "Corust", ["corust-agent-acp"], "https://github.com/Corust-ai/corust-agent-release/releases"),
  spec("crow", "Crow CLI", ["crow-cli", "acp"], "https://crow-ai.dev/"),
  spec("deepagents", "Deep Agents", ["deepagents-acp"], "https://docs.langchain.com/oss/javascript/deepagents/overview", { npx: ["npx", "-y", "deepagents-acp"] }),
  spec("dimcode", "Dimcode", ["dimcode", "acp"], "https://dimcode.dev/docs/acp.html", { npx: ["npx", "-y", "dimcode", "acp"] }),
  spec("dirac", "Dirac", ["dirac-cli", "--acp"], "https://dirac.run", { npx: ["npx", "-y", "dirac-cli", "--acp"] }),
  spec("fast-agent", "Fast Agent", ["fast-agent-acp", "-x"], "https://fast-agent.ai/acp/", { npx: ["uvx", "--from", "fast-agent-acp", "fast-agent-acp", "-x"] }),
  spec("fx", "FX", ["fx", "acp"], "https://fx.sh/docs/getting-started/installation"),
  spec("gjc", "GJC", ["gjc", "acp"], "https://gajae-code.com", { env: { GJC_ACP_PERMISSION_MODE: "prompt" } }),
  spec("glm", "GLM", ["glm-acp-agent"], "https://github.com/stefandevo/glm-acp-agent", { npx: ["npx", "-y", "glm-acp-agent"] }),
  spec("hoplite", "Hoplite", ["hoplite", "acp"], "https://hoplite.sh/docs/cli#install"),
  spec("mcode", "MiniMax Code", ["mcode", "acp"], "https://agent.minimax.io", { npx: ["npx", "-y", "-p", "@minimax-ai/code", "mcode", "acp"] }),
  spec("minion", "Minion Code", ["minion-code", "acp"], "https://github.com/femto/minion-code", { npx: ["uvx", "--from", "minion-code", "minion-code", "acp"] }),
  spec("vibe", "Mistral Vibe", ["vibe-acp"], "https://github.com/mistralai/mistral-vibe"),
  spec("nova", "Nova", ["nova", "acp"], "https://www.compassap.ai/portfolio/nova.html", { npx: ["npx", "-y", "@compass-ai/nova", "acp"] }),
  spec("pool", "Poolside", ["pool", "acp"], "https://docs.poolside.ai/cli/pool"),
  spec("sigit", "Sigit", ["sigit"], "https://github.com/getsigit/sigit"),
  spec("stakpak", "Stakpak", ["stakpak", "acp"], "https://stakpak.dev/"),
  spec("vtcode", "VT Code", ["vtcode", "acp"], "https://github.com/vinhnx/VTCode/blob/main/docs/guides/zed-acp.md", { env: { VT_ACP_ENABLED: "1", VT_ACP_ZED_ENABLED: "1" } }),
  spec("ante", "Ante", ["ante", "acp"], "https://github.com/ante-junior/ante", { installHint: "Install ante and the ante-acp bridge; see https://github.com/ante-junior/ante" }),
  spec("deepseek-harness", "DeepSeek Harness", ["dsh", "--profile", "acp"], "https://www.npmjs.com/package/deepseek-harness"),
  spec("iflow", "iFlow", ["iflow", "--experimental-acp"], "https://github.com/iflow-ai/iflow-cli"),
  spec("mux", "Mux", ["mux", "acp"], "https://github.com/coder/mux", { npx: ["npx", "-y", "--package=mux@^0.28.0", "--", "mux", "acp"] }),
  spec("octomind", "Octomind", ["octomind", "acp", "developer:general"], "https://github.com/muvon/octomind"),
  spec("zeroclaw", "ZeroClaw", ["zeroclaw", "acp"], "https://github.com/zeroclaw-labs/zeroclaw"),
];
export function acpLaunch(specification: AcpAgentSpec, variant: "installed" | "npx", platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): ProcessLaunch {
  const command = variant === "npx" ? specification.npx : specification.command;
  if (!command?.length) throw new Error(`${specification.id} has no ${variant} launch variant`);
  let executable = command[0]!;
  if (platform === "win32" && /^(npx|npm|pnpm|bunx)$/i.test(executable)) executable += ".cmd";
  return processLaunch(executable, command.slice(1), env, platform);
}
export function scrubAcpEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const copy = { ...env }, scrub = new Set(keys.map(key => key.toLowerCase()));
  for (const key of Object.keys(copy)) if (scrub.has(key.toLowerCase())) delete copy[key];
  return copy;
}
export function modeFlags(id: string, map?: AcpAgentSpec["modeMap"]): Pick<AgentMode, "isUnattended" | "isReadOnly"> {
  return { isUnattended: map ? map.unattended.includes(id) : /bypass|yolo|full.access|auto.?approve/i.test(id), isReadOnly: map ? map.readOnly.includes(id) : /plan|read.only/i.test(id) };
}
export function staticAcpCatalog(specification?: AcpAgentSpec): ProviderCatalog {
  const ids = new Set([...(specification?.modeMap?.unattended ?? []), ...(specification?.modeMap?.readOnly ?? [])]);
  if (specification?.id === "kimi") ids.add("yolo");
  if (specification?.id === "copilot") ids.add("https://agentclientprotocol.com/protocol/session-modes#agent");
  return { models: [], modes: [...ids].map(id => ({ id, label: id.split("#").at(-1)!, ...modeFlags(id, specification?.modeMap) })) };
}
/** Floors deliberately compare numeric triples, including date versions such as Cursor's. */
export function versionDiagnostic(output: string, specification: Pick<AcpAgentSpec, "minVersion" | "versionFloors">): string | undefined {
  if (!specification.minVersion && !specification.versionFloors) return;
  const found = output.match(/(?<!\d)(\d+)\.(\d+)\.(\d+)/);
  if (!found) return `Cannot verify minimum version ${specification.minVersion}: ${output}`;
  const actual = found.slice(1, 4).map(Number), floor = specification.versionFloors?.[String(actual[0])] ?? specification.minVersion;
  if (!floor) return;
  const expected = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i]! > expected[i]!) return;
    if (actual[i]! < expected[i]!) return `Installed ${found[0]} is below required ${floor}; upgrade this agent.`;
  }
}
