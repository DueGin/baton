import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SettingsResponse, UpdateSettingsRequest } from "@baton/protocol";

export interface StoredTitleModel {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function titleModel(value: unknown): StoredTitleModel {
  const input = object(value, "titleModel");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("titleModel.enabled must be a boolean");
  for (const key of ["baseUrl", "model", "apiKey", "apiKeyEnv"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "string") throw new Error(`titleModel.${key} must be a string`);
  }
  const enabled = input.enabled === true, baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "", model = typeof input.model === "string" ? input.model.trim() : "";
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error("titleModel.baseUrl must be an http(s) URL"); }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error("titleModel.baseUrl must be an http(s) URL without credentials, query or fragment");
  }
  if (enabled && (!baseUrl || !model)) throw new Error("An enabled titleModel requires baseUrl and model");
  const apiKeyEnv = typeof input.apiKeyEnv === "string" ? input.apiKeyEnv.trim() : undefined;
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error("Invalid titleModel.apiKeyEnv variable name");
  return { enabled, baseUrl, model, ...(input.apiKey ? { apiKey: input.apiKey as string } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}) };
}

/** Read on each operation so edits by other daemon features survive a settings update. */
export class Settings {
  readonly path: string;
  private writing: Promise<unknown> = Promise.resolve();
  constructor(home: string) { this.path = join(home, "config.json"); }
  async config(): Promise<Record<string, unknown>> {
    try { return object(JSON.parse(await readFile(this.path, "utf8")) as unknown, "config.json"); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
      throw error;
    }
  }
  private merge(config: Record<string, unknown>, update: UpdateSettingsRequest): Record<string, unknown> {
    const input = object(update, "Settings update"), next = { ...config };
    if (input.titleModel === null) delete next.titleModel;
    else if (input.titleModel !== undefined) {
      const patch = object(input.titleModel, "titleModel"), previous = config.titleModel ? object(config.titleModel, "titleModel") : {};
      const merged = { ...previous };
      for (const key of ["enabled", "baseUrl", "model", "apiKey", "apiKeyEnv"] as const) if (patch[key] !== undefined) merged[key] = patch[key];
      if (merged.apiKeyEnv === null || merged.apiKeyEnv === "") delete merged.apiKeyEnv;
      if (merged.apiKey === "") delete merged.apiKey;
      const valid = titleModel(merged);
      next.titleModel = { ...merged, ...valid };
    }
    return next;
  }
  async model(update?: UpdateSettingsRequest["titleModel"]): Promise<StoredTitleModel | undefined> {
    const config = this.merge(await this.config(), { titleModel: update });
    return config.titleModel === undefined ? undefined : titleModel(config.titleModel);
  }
  private response(config: Record<string, unknown>): SettingsResponse {
    if (config.titleModel === undefined) return {};
    const { apiKey, ...model } = titleModel(config.titleModel);
    return { titleModel: { ...model, hasApiKey: !!apiKey } };
  }
  async get(): Promise<SettingsResponse> { return this.response(await this.config()); }
  update(update: UpdateSettingsRequest): Promise<SettingsResponse> {
    const writing = this.writing.catch(() => {}).then(async () => {
      const config = this.merge(await this.config(), update), temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600);
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
      return this.response(config);
    });
    this.writing = writing; return writing;
  }
}
