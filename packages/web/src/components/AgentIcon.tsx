import type { ReactNode } from "react";

export const agentVendors = ["claude", "codex", "pi", "gemini", "qwen", "kimi", "opencode", "copilot", "cursor", "goose", "droid", "hermes", "cline", "roo", "kiro", "auggie", "vibe", "junie", "amp", "aider", "trae", "generic"] as const;
export type AgentVendor = typeof agentVendors[number];
export const vendorColors: Record<AgentVendor, string> = { claude: "#cc795a", codex: "#22a584", pi: "#8c7ce9", gemini: "#5989dc", qwen: "#8876e5", kimi: "#4585dd", opencode: "#78909c", copilot: "#9b74d8", cursor: "#758999", goose: "#bf9242", droid: "#d5854a", hermes: "#24a4a6", cline: "#638cba", roo: "#b07c54", kiro: "#9872d0", auggie: "#387cbf", vibe: "#dc8040", junie: "#6b9a38", amp: "#d66057", aider: "#449d84", trae: "#319987", generic: "#758799" };
export function agentVendor(agent: string): AgentVendor {
  const id = agent.toLowerCase();
  if (/claude|anthropic/.test(id)) return "claude";
  if (/codex|openai|gpt/.test(id)) return "codex";
  if (/gemini|google/.test(id)) return "gemini";
  if (/qwen|alibaba/.test(id)) return "qwen";
  if (/kimi|moonshot/.test(id)) return "kimi";
  if (/augment/.test(id)) return "auggie";
  if (/mistral/.test(id)) return "vibe";
  return agentVendors.find(vendor => vendor !== "generic" && new RegExp(`(^|[-_/])${vendor}($|[-_/])`).test(id)) ?? "generic";
}
/** Original inline SVG marks, drawn locally; no remote assets or vendor font dependencies. */
export function AgentIcon({ agent, size = 18 }: { agent: string; size?: number }) {
  const vendor = agentVendor(agent);
  const marks: Record<AgentVendor, ReactNode> = {
    claude: <><circle cx="12" cy="12" r="3" /><path d="M12 2v5m0 10v5M2 12h5m10 0h5M5 5l4 4m6 6 4 4M5 19l4-4m6-6 4-4M8 2l2 5m4 10 2 5M2 8l5 2m10 4 5 2M16 2l-2 5M2 16l5-2m10-4 5-2M8 22l2-5" /></>,
    codex: <>{[0, 60, 120, 180, 240, 300].map(angle => <path key={angle} transform={`rotate(${angle} 12 12)`} d="M12 3a5 5 0 0 1 7 7l-7 4-4-2V7l4-2" />)}</>,
    pi: <><path d="M5 7h15M8 7v11m8-11v9c0 3 3 3 4 1M4 9l1-2" /></>,
    gemini: <path d="M12 2c1 6 4 9 10 10-6 1-9 4-10 10C11 16 8 13 2 12c6-1 9-4 10-10Z" />,
    qwen: <><path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6Z" /><path d="m7 9 5 8 5-8H7Z" /></>,
    kimi: <><path d="M6 4v16M18 4 6 13m5-4 8 11" /><path d="M18 2a3 3 0 0 0 4 4 3 3 0 0 1-4-4Z" /></>,
    opencode: <><path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-15-2 18" /></>,
    copilot: <><path d="M5 8 3 5l5-2h8l5 2-2 3M5 15v4l7 3 7-3v-4" /><rect x="2" y="8" width="9" height="7" rx="3" /><rect x="13" y="8" width="9" height="7" rx="3" /><path d="M11 11h2" /></>,
    cursor: <><path d="M5 2v18l5-5 4 7 4-2-4-7h7L5 2Z" /><path d="m5 2 9 11" /></>,
    goose: <><path d="M5 21c0-6 10-5 9-10-5 1-7-2-6-5 1-4 7-5 10-1l4 2-5 2v8c0 3-4 5-8 5" /><circle cx="14" cy="5" r=".7" fill="currentColor" /></>,
    droid: <><rect x="4" y="5" width="16" height="15" rx="4" /><path d="m7 5-2-3m12 3 2-3M8 10h1m6 0h1M8 15h8M1 9v7m22-7v7" /></>,
    hermes: <><path d="M10 22V6m-2 0 4-4 4 4M3 7l7 5m-7 0 7 5m11-10-7 5m7 0-7 5M5 7h14" /></>,
    cline: <><path d="M19 5H9a6 6 0 0 0 0 12h10M19 8H9a3 3 0 0 0 0 6h10" /><path d="M4 20h16" /></>,
    roo: <><path d="m6 3 6 5 7-5-1 8 3 7-7 4-8-4 2-7-2-8Z" /><path d="m9 13 3 2 4-2m-4 2v4" /></>,
    kiro: <><path d="M5 4v16M19 4 5 14m7-5 7 11" /><circle cx="19" cy="4" r="2" /></>,
    auggie: <><path d="m3 20 9-17 9 17M7 14h10M9 20l3-6 3 6" /></>,
    vibe: <><path d="M3 5h4v4h3v6h4V9h3V5h4v7h-4v4h-3v5h-4v-5H7v-4H3V5Z" /></>,
    junie: <><path d="M16 3v12a6 6 0 0 1-12 0m8-12h8M5 6l2 2m-5 2 3 1" /></>,
    amp: <><path d="m13 2-9 12h7l-1 8L21 8h-8l0-6Z" /></>,
    aider: <><path d="M3 20 12 3l9 17M7 14h10" /><path d="m9 18 3 3 3-3" /></>,
    trae: <><path d="M4 4h16v5H4zM9 9v12h6V9" /><path d="m4 14 3 3m13-3-3 3" /></>,
    generic: <><rect x="4" y="6" width="16" height="15" rx="4" /><path d="M12 2v4M8 11h.01M16 11h.01M8 16h8M1 10v6m22-6v6" /></>,
  };
  return <svg className="agent-vendor-icon" data-agent-vendor={vendor} aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={vendor === "codex" ? 1.2 : 1.7} strokeLinecap="round" strokeLinejoin="round" style={{ color: vendorColors[vendor] }}>{marks[vendor]}</svg>;
}
