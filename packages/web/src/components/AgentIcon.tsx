// Vendor and model marks. The SVGs in ../assets/vendors are the vendors' own logos (via
// @lobehub/icons, MIT, or the vendor's site favicon), sanitised at import time: no <style>/<script>,
// no remote references, ids prefixed per icon. They are bundled and inlined so single-colour marks
// follow `currentColor` in light and dark themes. Trademarks belong to their owners.
import batonIcon from "../assets/baton-icon.png";

const svgs = import.meta.glob<string>("../assets/vendors/*.svg", { eager: true, query: "?raw", import: "default" });
const vendorSvg: Record<string, string> = Object.fromEntries(Object.entries(svgs).map(([path, svg]) => [path.split("/").at(-1)!.replace(/\.svg$/, ""), svg]));

/** Icon keys for agents (products), keyed by baton agent id. */
export const agentVendors = ["claude", "codex", "pi", "gemini", "qwen", "kimi", "opencode", "copilot", "cursor", "goose", "droid", "hermes", "openclaw", "kiro", "grok", "trae", "devin", "qoder", "amp", "cline", "kilo", "augment", "junie", "codebuddy", "snowflake", "langchain", "zhipu", "minimax", "mistral", "deepseek", "iflow", "coder", "poolside", "generic"] as const;
export type AgentVendor = typeof agentVendors[number];
/** Accent per vendor: tile tint, roster dots and timeline lanes. */
export const vendorColors: Record<AgentVendor, string> = {
  claude: "#d97757", codex: "#5b6cf0", pi: "#6b6b6b", gemini: "#4f7fe8", qwen: "#615ced", kimi: "#2f7bf6", opencode: "#6f7682", copilot: "#8a6fd8",
  cursor: "#6f7682", goose: "#6f7682", droid: "#e0643b", hermes: "#6f7682", openclaw: "#e0473f", kiro: "#9046ff", grok: "#6f7682", trae: "#25c36b",
  devin: "#3e8ee8", qoder: "#2bcf7d", amp: "#f34e3f", cline: "#6f7682", kilo: "#6f7682", augment: "#6f7682", junie: "#47d147", codebuddy: "#6c5cf5",
  snowflake: "#29b5e8", langchain: "#4fa8de", zhipu: "#3859ff", minimax: "#e2167e", mistral: "#fa520f", deepseek: "#4d6bfe", iflow: "#5468ff",
  coder: "#6f7682", poolside: "#4d4dff", generic: "#7c8796",
};
const agentAliases: [RegExp, AgentVendor][] = [
  [/claude|anthropic/, "claude"], [/codex|openai|gpt/, "codex"], [/^omp$|oh-?my-?pi/, "pi"], [/gemini|google/, "gemini"], [/qwen|alibaba/, "qwen"],
  [/kimi|moonshot/, "kimi"], [/github|copilot/, "copilot"], [/factory|droid/, "droid"], [/nous|hermes/, "hermes"], [/xai|grok/, "grok"],
  [/trae/, "trae"], [/augment|auggie/, "augment"], [/kilo/, "kilo"], [/cortex|snowflake/, "snowflake"], [/deepagents|langchain/, "langchain"],
  [/glm|zhipu/, "zhipu"], [/mcode|minimax/, "minimax"], [/vibe|mistral/, "mistral"], [/deepseek/, "deepseek"], [/iflow/, "iflow"],
  [/^mux$|coder/, "coder"], [/^pool$|poolside/, "poolside"], [/roo-?code/, "cline"],
];
export function agentVendor(agent: string): AgentVendor {
  const id = agent.toLowerCase();
  for (const [pattern, vendor] of agentAliases) if (pattern.test(id)) return vendor;
  return agentVendors.find(vendor => vendor !== "generic" && new RegExp(`(^|[-_/])${vendor}($|[-_/])`).test(id)) ?? "generic";
}

/** Vendor icon for a model id such as "claude-sonnet-4-6", "gpt-5.3-codex" or "openrouter/qwen/qwen3-coder". */
const modelAliases: [RegExp, string][] = [
  [/claude|anthropic|sonnet|opus|haiku/, "anthropic"], [/gpt|openai|codex|(^|\/)o[1-9]\b/, "openai"], [/gemini|gemma|google/, "google"],
  [/qwen|qwq/, "qwen"], [/deepseek/, "deepseek"], [/kimi|moonshot/, "kimi"], [/glm|zhipu|chatglm/, "zhipu"], [/minimax|abab/, "minimax"],
  [/grok|xai/, "xai"], [/mistral|devstral|codestral|magistral/, "mistral"], [/llama|meta/, "meta"], [/doubao|seed/, "doubao"],
];
export function modelVendor(model: string): string | undefined {
  const id = model.toLowerCase();
  return modelAliases.find(([pattern]) => pattern.test(id))?.[1];
}

function Inline({ svg, size, vendor }: { svg: string; size: number; vendor: string }) {
  return <span className="agent-vendor-icon" data-agent-vendor={vendor} aria-hidden="true" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
/** Product mark for an agent; agents without a published logo get their initial. */
export function AgentIcon({ agent, size = 18 }: { agent: string; size?: number }) {
  // Team and system notices are sent by baton itself (agent id "generic"/"baton"/"system").
  if (/^(generic|baton|system)$/i.test(agent)) return <span className="agent-vendor-icon agent-baton-icon" data-agent-vendor="baton" aria-hidden="true" style={{ width: size, height: size, backgroundImage: `url(${batonIcon})` }} />;
  const vendor = agentVendor(agent); const svg = vendorSvg[vendor];
  if (svg) return <Inline svg={svg} size={size} vendor={vendor} />;
  const initial = (agent.replace(/^[^a-z0-9]+/i, "")[0] ?? "?").toUpperCase();
  return <span className="agent-vendor-icon agent-monogram" data-agent-vendor="generic" aria-hidden="true" style={{ width: size, height: size, fontSize: `max(var(--text-2xs), ${Math.round(size * 0.62)}px)` }}>{initial}</span>;
}
/** Vendor mark for a model, with an optional agent mark when the model icon is unavailable. */
export function ModelIcon({ model, size = 12, fallbackAgent }: { model?: string; size?: number; fallbackAgent?: string }) {
  const vendor = model ? modelVendor(model) : undefined; const svg = vendor ? vendorSvg[vendor] : undefined;
  if (svg && vendor) return <span className="model-icon" title={model}><Inline svg={svg} size={size} vendor={vendor} /></span>;
  return fallbackAgent !== undefined ? <AgentIcon agent={fallbackAgent} size={size} /> : null;
}
