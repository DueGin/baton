import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, matchesGlob } from "node:path";
import { z } from "zod";
import type { CreatePermissionRuleRequest, NodeRecord, PermissionDecision, PermissionRecord, PermissionRequest, PermissionRule } from "@baton/protocol";
import type { Store } from "../store/index.js";
export const HUMAN_DENIAL = "The human denied this action. Do not retry it; choose a different approach or ask_human.";
const ruleSchema = z.object({ agentId: z.string().min(1).optional(), toolName: z.string().trim().min(1), pattern: z.string().min(1).optional(), decision: z.enum(["allow", "deny"]), scope: z.enum(["global", "run"]), runId: z.string().optional() });
const normalizeCommand = (value: string): string => value.trim().replace(/\s+/g, " ");
export function permissionInput(request: PermissionRequest, cwd: string): { command?: string; file?: string } {
  const detail = request.detail;
  const command = detail?.type === "shell" ? detail.command : typeof request.input?.command === "string" ? request.input.command : undefined;
  const path = detail && "filePath" in detail && typeof detail.filePath === "string" ? detail.filePath : undefined;
  return { command: command === undefined ? undefined : normalizeCommand(command), file: path === undefined ? undefined : relative(cwd, isAbsolute(path) ? path : resolve(cwd, path)).replaceAll("\\", "/") };
}
export function ruleMatches(rule: PermissionRule, request: PermissionRequest, node: Pick<NodeRecord, "agentId" | "runId" | "cwd">): boolean {
  if (rule.scope === "run" && rule.runId !== node.runId) return false;
  if (rule.agentId && rule.agentId !== node.agentId) return false;
  if (rule.toolName !== "*" && rule.toolName.toLowerCase() !== request.name.toLowerCase()) return false;
  if (rule.pattern === undefined) return true;
  const input = permissionInput(request, node.cwd);
  if (input.command !== undefined) {
    const prefix = normalizeCommand(rule.pattern);
    return input.command === prefix || input.command.startsWith(prefix + " ");
  }
  return input.file !== undefined && matchesGlob(input.file, rule.pattern);
}
export class PermissionRules {
  constructor(readonly store: Store) {}
  create(input: CreatePermissionRuleRequest, createdFrom?: string): PermissionRule {
    const valid = ruleSchema.parse(input);
    if (valid.scope === "run") { if (!valid.runId) throw new Error("Run-scoped rules require runId"); this.store.snapshot(valid.runId); }
    const rule: PermissionRule = { ...valid, runId: valid.scope === "run" ? valid.runId : undefined, id: randomUUID(), createdFrom, createdAt: new Date().toISOString(), hits: 0 };
    this.store.saveRule(rule); return rule;
  }
  match(request: PermissionRequest, node: NodeRecord): PermissionRule | undefined {
    // Deny outranks allow across scopes. Within a decision, run-scoped rules outrank global;
    // equal-priority rules follow stable creation order from SQLite.
    const rules = this.store.rules().filter((r) => ruleMatches(r, request, node)).sort((a, b) => Number(a.decision !== "deny") - Number(b.decision !== "deny") || Number(a.scope !== "run") - Number(b.scope !== "run"));
    const rule = rules[0];
    if (!rule) return undefined;
    const hit = { ...rule, hits: rule.hits + 1, lastHitAt: new Date().toISOString() }; this.store.saveRule(hit); return hit;
  }
  remember(permission: PermissionRecord, input: NonNullable<PermissionDecision["remember"]>, node: NodeRecord, decision: "allow" | "deny", persist = true): PermissionRule {
    const remember = z.object({ scope: z.enum(["global", "run"]), pattern: z.string().min(1).optional(), agentOnly: z.boolean().optional() }).parse(input);
    const source = permissionInput(permission.request, node.cwd);
    const ruleInput = { toolName: permission.request.name, pattern: remember.pattern ?? source.command ?? source.file, agentId: remember.agentOnly ? node.agentId : undefined, scope: remember.scope, runId: remember.scope === "run" ? node.runId : undefined, decision };
    ruleSchema.parse(ruleInput);
    if (!persist) return { ...ruleInput, id: "", hits: 0, createdAt: "" };
    return this.create(ruleInput, permission.id);
  }
}
