import type { PermissionRecord, PermissionRule } from "@baton/protocol";
import { permissionPattern } from "./inbox.js";

function globMatches(pattern: string, path: string): boolean {
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") { expression += ".*"; i++; }
    else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(path);
}
/** Browser demo matcher mirrors the contract; the daemon owns real authorization. */
export function matchPermissionRule(rules: PermissionRule[], permission: PermissionRecord, agentId: string, cwd: string): PermissionRule | undefined {
  const input = permissionPattern(permission, cwd);
  return rules.filter(rule => {
    if (rule.scope === "run" && rule.runId !== permission.runId) return false;
    if (rule.agentId && rule.agentId !== agentId) return false;
    if (rule.toolName !== "*" && rule.toolName.toLowerCase() !== permission.request.name.toLowerCase()) return false;
    if (!rule.pattern) return true;
    if (permission.request.detail?.type === "shell" || typeof permission.request.input?.command === "string") { const prefix = rule.pattern.trim().replace(/\s+/g, " "); return input === prefix || input.startsWith(`${prefix} `); }
    return permission.request.detail && "filePath" in permission.request.detail ? globMatches(rule.pattern, input) : false;
  }).sort((a, b) => Number(b.decision === "deny") - Number(a.decision === "deny") || Number(b.scope === "run") - Number(a.scope === "run") || a.createdAt.localeCompare(b.createdAt))[0];
}
