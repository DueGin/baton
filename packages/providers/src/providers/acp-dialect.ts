/** Derived from Orca src/main/acp/acp-dialects/{kimi,cursor}-dialect.ts @a5781b8 (MIT, Copyright 2026 Lovecast Inc.)
 * and Paseo providers/{copilot,kiro,trae,cursor}-acp-agent.ts @63ea3e5 (Apache-2.0).
 * Modified for baton's reduced timeline/catalog contract. */
import type { AcpAgentSpec } from "../acp-spec.js";
import { record, text } from "../session.js";
export interface AcpDialect {
  normalizeTool?(tool: Record<string, unknown>): Record<string, unknown>;
  toolName?(tool: Record<string, unknown>): string;
  extensionNotification?(method: string, params: Record<string, unknown>): string | undefined;
}
export function acpDialect(spec?: AcpAgentSpec): AcpDialect {
  switch (spec?.dialect) {
    case "kimi": return {
      normalizeTool(tool) {
        const result = { ...tool };
        if ((tool.status === "pending" || tool.status === "in_progress") && Array.isArray(tool.content)) result.content = tool.content.filter(raw => {
          const block = record(raw); return !(block.type === "content" && record(block.content).type === "text");
        });
        if (typeof tool.rawOutput === "string") {
          const match = tool.rawOutput.match(/^(?:([\s\S]*)\n)?Command failed with exit code: (-?\d+)\.$/);
          if (match) result.rawOutput = { stdout: match[1] ?? "", exitCode: Number(match[2]) };
          else result.rawOutput = { stdout: tool.rawOutput === "Command executed successfully." ? "" : tool.rawOutput, ...(tool.status === "completed" ? { exitCode: 0 } : {}) };
          if (Array.isArray(tool.content)) result.content = tool.content.filter(raw => {
            const block = record(raw); return !(block.type === "content" && record(block.content).type === "text" && record(block.content).text === tool.rawOutput);
          });
        }
        return result;
      },
      toolName(tool) { return text(tool.title).replace(/^Requesting approval to /, "").slice(0, 512) || text(tool.kind) || "tool"; },
    };
    case "kiro": return { extensionNotification(method, params) {
      if (method !== "_kiro.dev/commands/available") return;
      const commands = [...(Array.isArray(params.commands) ? params.commands : []), ...(Array.isArray(params.prompts) ? params.prompts : [])];
      return `Kiro commands available: ${commands.map(value => text(record(value).name)).filter(Boolean).join(", ")}`;
    } };
    case "cursor": return { toolName(tool) {
      const input = record(tool.rawInput);
      return text(input.toolName ?? input.name) || text(tool.title) || text(tool.kind) || "tool";
    } };
    default: return {};
  }
}
