import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every test gets its own userData so a token saved by one never leaks into the next.
let userData = await mkdtemp(join(tmpdir(), "baton-updater-"));
beforeEach(async () => { userData = await mkdtemp(join(tmpdir(), "baton-updater-")); await rm(join(userData, "desktop-settings.json"), { force: true }); });
vi.mock("electron", () => ({
  app: { getPath: (name: string) => name === "userData" ? userData : join(userData, name), getVersion: () => "0.1.0" },
  shell: { showItemInFolder: () => undefined },
}));

const { UpdateManager } = await import("./updater.js");

const payload = Buffer.from("baton mac zip payload");
const sha = createHash("sha256").update(payload).digest("hex");
const release = {
  tag_name: "v0.2.0",
  body: "Frameless window.",
  html_url: "https://github.com/DueGin/baton/releases/tag/v0.2.0",
  published_at: "2026-11-19T00:00:00Z",
  assets: [
    { name: "baton-0.2.0-mac-arm64.zip", size: payload.length, url: "https://api.test/asset/zip" },
    { name: "SHA256SUMS.txt", size: 80, url: "https://api.test/asset/sums" },
  ],
};

type Call = { url: string; authorization?: string };
const respond = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body, init);

function manager(fetchImpl: typeof fetch, platform: NodeJS.Platform = "darwin", env: NodeJS.ProcessEnv = {}) {
  const quit = vi.fn();
  const instance = new UpdateManager(() => null, { fetch: fetchImpl, platform, arch: "arm64", version: "0.1.0", env, settingsPath: join(userData, "desktop-settings.json"), quitForUpdate: quit, log: () => undefined });
  return { instance, quit };
}
/** A fake GitHub: the release endpoint, the asset, and its checksum file; records the auth headers it saw. */
function github(options: { status?: number; sums?: string; upToDate?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.authorization });
    if (url.endsWith("/releases/latest")) return respond(JSON.stringify(options.upToDate ? { ...release, tag_name: "v0.1.0" } : release), { status: options.status ?? 200 });
    if (url.endsWith("/asset/zip")) return respond(payload, { status: 200, headers: { "content-length": String(payload.length) } });
    if (url.endsWith("/asset/sums")) return respond(options.sums ?? `${sha}  baton-0.2.0-mac-arm64.zip\n`);
    return respond("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("UpdateManager", () => {
  it("reports an available release and sends the saved token", async () => {
    await writeFile(join(userData, "desktop-settings.json"), JSON.stringify({ githubToken: "saved-token" }));
    const { fetchImpl, calls } = github();
    const { instance } = manager(fetchImpl);
    const status = await instance.check();
    expect(status).toMatchObject({ phase: "available", currentVersion: "0.1.0", release: { version: "0.2.0", asset: { name: "baton-0.2.0-mac-arm64.zip" } } });
    expect(calls[0]).toMatchObject({ url: "https://api.github.com/repos/DueGin/baton/releases/latest", authorization: "Bearer saved-token" });
  });

  it("asks for a token when the private repository answers 404", async () => {
    const { fetchImpl } = github({ status: 404 });
    const { instance } = manager(fetchImpl);
    expect(await instance.check()).toMatchObject({ phase: "error", needsToken: true });
  });

  it("falls back to GITHUB_TOKEN and reports an equal release as current", async () => {
    const { fetchImpl, calls } = github();
    const { instance } = manager(fetchImpl, "darwin", { GITHUB_TOKEN: "env-token" });
    expect((await instance.check()).phase).toBe("available");
    expect(calls[0]?.authorization).toBe("Bearer env-token");
    const { instance: same } = manager(github({ upToDate: true }).fetchImpl);
    expect(await same.check()).toMatchObject({ phase: "current", release: { version: "0.1.0" } });
  });

  it("downloads, verifies SHA256 and reaches the downloaded phase", async () => {
    const { fetchImpl, calls } = github();
    const { instance, quit } = manager(fetchImpl);
    await instance.check();
    const status = await instance.download();
    expect(status).toMatchObject({ phase: "downloaded", progress: 1, received: payload.length });
    expect(await readFile(status.savedPath!, "utf8")).toBe(payload.toString());
    expect(calls.filter(call => call.url.endsWith("/asset/zip"))[0]?.authorization).toBeUndefined();
    // Nothing is downloaded before a check found a release.
    expect(await manager(fetchImpl).instance.download()).toMatchObject({ phase: "idle" });
    expect(quit).not.toHaveBeenCalled();
  });

  it("reports unsupported platforms instead of downloading", async () => {
    const { instance } = manager(github().fetchImpl, "linux");
    expect(await instance.check()).toMatchObject({ phase: "error", error: expect.stringContaining("不支持") as unknown as string });
  });

  it("deletes a download whose checksum does not match", async () => {
    const { fetchImpl } = github({ sums: `${"0".repeat(64)}  baton-0.2.0-mac-arm64.zip\n` });
    const { instance } = manager(fetchImpl);
    await instance.check();
    const status = await instance.download();
    expect(status).toMatchObject({ phase: "error", error: expect.stringContaining("校验失败") as unknown as string });
    for (const name of ["baton-0.2.0-mac-arm64.zip"]) await expect(stat(join(userData, "updates", "0.2.0", name))).rejects.toThrow();
  });

  it("refuses to install without a downloaded file", async () => {
    const { instance, quit } = manager(github().fetchImpl);
    expect((await instance.install()).phase).toBe("idle");
    await instance.check();
    expect((await instance.install()).phase).toBe("available");   // not downloaded yet
    expect(quit).not.toHaveBeenCalled();
  });

  it("stores and clears the token with owner-only permissions", async () => {
    const { instance } = manager(github().fetchImpl);
    expect(await instance.setToken("  ghp_test  ")).toEqual({ saved: true });
    const file = join(userData, "desktop-settings.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ githubToken: "ghp_test" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await instance.token()).toBe("ghp_test");
    expect(await instance.setToken("")).toEqual({ saved: false });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
    await expect(instance.setToken("has space")).rejects.toThrow();
  });
});
