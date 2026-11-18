import type { AgentEntry, AgentModel } from "@baton/protocol";

const checkedAt = "2026-11-10T07:00:00.000Z";
const levels = (...ids: string[]): AgentModel["thinkingOptions"] => ids.map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1), ...(id === "medium" ? { isDefault: true } : {}) }));
/** Each agent reports its own model catalog; the default model stays first. pi's list is long enough to be searchable. */
const extraModels: Record<string, AgentModel[]> = {
  claude: [{ id: "claude-opus-4-6", label: "Opus 4.6", description: "最强推理，适合架构与审查", thinkingOptions: levels("medium", "high") }, { id: "claude-haiku-4-5", label: "Haiku 4.5", description: "快速、便宜，不支持思考级别" }],
  codex: [{ id: "gpt-5.2", label: "GPT-5.2", description: "通用推理", thinkingOptions: levels("low", "medium", "high", "xhigh") }, { id: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini", description: "轻量快速", thinkingOptions: levels("medium", "high") }],
  pi: [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", thinkingOptions: levels("low", "medium", "high") }, { id: "qwen3-max", label: "Qwen3 Max", description: "dashscope" }, { id: "gpt-5.2", label: "GPT-5.2", description: "openai" },
    { id: "openrouter/qwen/qwen3-coder", label: "Qwen3 Coder", description: "OpenRouter" }, { id: "deepseek-v4", label: "DeepSeek V4", description: "deepseek" }, { id: "kimi-k2", label: "Kimi K2", description: "moonshot" },
    { id: "glm-4.6", label: "GLM-4.6", description: "zhipu" }, { id: "grok-4", label: "Grok 4", description: "xai" }, { id: "mistral-large", label: "Mistral Large", description: "mistral" },
  ],
};
const core: AgentEntry[] = [
  { id: "claude", label: "Claude Code", version: "2.1.38", model: "claude-sonnet-4-6", modelLabel: "Sonnet 4.6", installHint: "npm i -g @anthropic-ai/claude-code", homepage: "https://code.claude.com" },
  { id: "codex", label: "Codex", version: "0.106.0", model: "gpt-5.3-codex", modelLabel: "GPT-5.3 Codex", installHint: "npm i -g @openai/codex", homepage: "https://github.com/openai/codex" },
  { id: "pi", label: "pi", version: "0.55.0", model: "gemini-2.5-pro", modelLabel: "Gemini 2.5 Pro", installHint: "npm i -g @mariozechner/pi-coding-agent", homepage: "https://pi.dev" },
  { id: "gemini", label: "Gemini CLI", version: undefined, model: "gemini-2.5-pro", modelLabel: "Gemini 2.5 Pro", installHint: "npm i -g @google/gemini-cli", homepage: "https://github.com/google-gemini/gemini-cli" },
].map(agent => ({ id: agent.id, label: agent.label, kind: agent.id === "gemini" ? "acp" : "native", status: agent.id === "gemini" ? "unavailable" : "ready", enabled: true, version: agent.version, source: "builtin", minVersion: agent.id === "claude" ? "2.0.0" : undefined, installHint: agent.installHint, homepage: agent.homepage, diagnostic: agent.id === "gemini" ? "未在 PATH 中找到 gemini。安装 CLI 后重新检测。" : undefined, models: [{ id: agent.model, label: agent.modelLabel, isDefault: true, thinkingOptions: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] }, ...(extraModels[agent.id] ?? [])], modes: [{ id: "default", label: "Default" }, { id: "plan", label: "Read only", isReadOnly: true }], defaultModeId: "default", capabilities: { steer: agent.id !== "pi", resume: true, reasoning: true, mcp: true, images: agent.id !== "pi" }, notes: agent.id === "codex" ? "代码实现、测试和重构" : agent.id === "pi" ? "快速检索、独立审查" : "任务拆分、跨 agent 协调", checkedAt }));

const extra = [
  ["qwen", "Qwen Code", "npm i -g @qwen-code/qwen-code", "https://github.com/QwenLM/qwen-code"],
  ["kimi", "Kimi CLI", "uv tool install kimi-cli", "https://github.com/MoonshotAI/kimi-cli"],
  ["opencode", "OpenCode", "npm i -g opencode-ai", "https://opencode.ai"],
  ["copilot", "GitHub Copilot", "npm i -g @github/copilot", "https://github.com/features/copilot/cli"],
  ["cursor", "Cursor Agent", undefined, "https://cursor.com/cli"],
  ["goose", "Goose", undefined, "https://block.github.io/goose"],
  ["droid", "Factory Droid", undefined, "https://factory.ai"],
  ["hermes", "Hermes Agent", undefined, "https://github.com/NousResearch/hermes-agent"],
  ["cline", "Cline", "npm i -g cline", "https://cline.bot"],
  ["roo", "Roo Code", undefined, "https://roocode.com"],
  ["kiro", "Kiro CLI", undefined, "https://kiro.dev"],
  ["auggie", "Augment Auggie", "npm i -g @augmentcode/auggie", "https://www.augmentcode.com"],
  ["vibe", "Mistral Vibe", "uv tool install mistral-vibe", "https://github.com/mistralai/mistral-vibe"],
  ["junie", "JetBrains Junie", undefined, "https://www.jetbrains.com/junie"],
  ["amp", "Amp", undefined, "https://ampcode.com"],
  ["aider", "Aider", "uv tool install aider-chat", "https://aider.chat"],
  ["trae", "TRAE", undefined, "https://www.trae.ai"],
  ["openhands", "OpenHands", "uv tool install openhands", "https://openhands.dev"],
  ["continue", "Continue", "npm i -g @continuedev/cli", "https://www.continue.dev"],
  ["qoder", "Qoder", undefined, "https://qoder.com"],
  ["crush", "Crush", undefined, "https://github.com/charmbracelet/crush"],
  ["kilocode", "Kilo Code", undefined, "https://kilo.ai"],
  ["forge", "Forge", undefined, "https://forgecode.dev"],
  ["stakpak", "Stakpak", undefined, "https://stakpak.dev"],
  ["mox", "Mox", undefined, "https://github.com/mox-labs/mox"],
  ["custom-linter", "团队代码检查", "npm run agent:lint", "https://example.com/team-agents"],
] as const;

/** Browser-only fixture, not an executable catalog; mixed states keep installation and error UI reviewable. */
export const demoAgents: AgentEntry[] = [...core, ...extra.map((spec, index): AgentEntry => {
  const [id, label, installHint, homepage] = spec; const enabled = index % 9 !== 8;
  const status = index % 6 === 0 ? "ready" : index % 6 === 1 ? "error" : "unavailable";
  return { id, label, kind: "acp", enabled, status, source: id === "custom-linter" ? "config" : "builtin", installHint, homepage, minVersion: index === 1 ? "1.0.0" : undefined, version: status === "ready" ? "1.2.0" : status === "error" ? "0.8.0" : undefined, diagnostic: !enabled ? "此 agent 已在配置中禁用。" : status === "error" ? index === 1 ? "当前版本 0.8.0 低于要求 1.0.0，请升级后重新检测。" : "ACP initialize 探测失败，请检查本机配置。" : status === "unavailable" ? `未在 PATH 中找到 ${id}。` : undefined, models: status === "ready" ? [{ id: `${id}-default`, label: "Default", isDefault: true }] : [], modes: status === "ready" ? [{ id: "default", label: "Default" }] : [], capabilities: { steer: index % 3 === 0, resume: index % 2 === 0, reasoning: true, mcp: index % 3 !== 1, images: index % 4 === 0 }, defaultModeId: "default", checkedAt };
})];
