import type { GithubSettings } from "@baton/protocol";
export interface GithubFormValue { ghPath: string; trackMentioned: boolean; env: Array<{ key: string; value: string }> }
export function githubForm(settings?: GithubSettings): GithubFormValue {
  return { ghPath: settings?.ghPath ?? "", trackMentioned: settings?.trackMentioned !== false, env: Object.entries(settings?.env ?? {}).map(([key, value]) => ({ key, value })) };
}
export function githubPayload(value: GithubFormValue): GithubSettings {
  const env: Record<string, string> = {};
  for (const row of value.env) {
    const key = row.key.trim(); if (!key && !row.value) continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw new Error("环境变量名只能包含字母、数字和下划线，且不能以数字开头");
    if (Object.hasOwn(env, key)) throw new Error(`环境变量 ${key} 重复`);
    Object.defineProperty(env, key, { value: row.value, enumerable: true });
  }
  return { ghPath: value.ghPath.trim(), env, trackMentioned: value.trackMentioned };
}
