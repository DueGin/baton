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
const { DOWNLOAD_ATTEMPTS } = await import("./update.js");
type Options = ConstructorParameters<typeof UpdateManager>[1];

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

function manager(fetchImpl: typeof fetch, platform: NodeJS.Platform = "darwin", env: NodeJS.ProcessEnv = {}, extra: Partial<Options> = {}) {
  const quit = vi.fn(), logs: string[] = [];
  const instance = new UpdateManager(() => null, { fetch: fetchImpl, platform, arch: "arm64", version: "0.1.0", env, settingsPath: join(userData, "desktop-settings.json"), quitForUpdate: quit, log: (line) => { logs.push(line); }, retryDelayMs: 1, ...extra });
  return { instance, quit, logs };
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

// A larger asset served the way github.com serves it: Range requests, and connections that drop or stall mid-body.
const big = Buffer.from(Array.from({ length: 300_000 }, (_, index) => (index * 31 + 7) % 251));
const bigSha = createHash("sha256").update(big).digest("hex");
const API_LATEST = "https://api.github.com/repos/DueGin/baton/releases/latest";
const DOWNLOAD = "https://github.com/DueGin/baton/releases/download/v0.2.0/baton-0.2.0-mac-arm64.zip";
const SUMS = "https://github.com/DueGin/baton/releases/download/v0.2.0/SHA256SUMS.txt";
const SUMS_LATEST = "https://github.com/DueGin/baton/releases/latest/download/SHA256SUMS.txt";
const API_ASSET = "https://api.github.com/repos/DueGin/baton/releases/assets/1";
const bigRelease = { ...release, assets: [
  { name: "baton-0.2.0-mac-arm64.zip", size: big.length, url: API_ASSET, browser_download_url: DOWNLOAD },
  { name: "SHA256SUMS.txt", size: 120, url: "https://api.github.com/repos/DueGin/baton/releases/assets/2", browser_download_url: SUMS },
] };
type Step = { drop?: number; stall?: number; ignoreRange?: boolean; status?: number };
/** Streams `bytes` in 16 KB chunks; after `failure.after` bytes the connection drops, or stalls until the request is aborted. */
function streamed(bytes: Buffer, init: ResponseInit, failure?: { after: number; mode: "drop" | "stall" }, signal?: AbortSignal | null): Response {
  let sent = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failure && sent >= failure.after) {
        if (failure.mode === "drop") { controller.error(new TypeError("terminated")); return; }
        return new Promise<void>((resolve) => signal?.addEventListener("abort", () => { controller.error(signal.reason); resolve(); }, { once: true }));
      }
      if (sent >= bytes.length) { controller.close(); return; }
      const next = bytes.subarray(sent, Math.min(failure ? Math.min(failure.after, bytes.length) : bytes.length, sent + 16384));
      sent += next.length; controller.enqueue(next);
    },
  }), init);
}
function flaky(plan: Step[], options: { api?: "ok" | 403 | "down"; sums?: string; sumsStatus?: number; apiAsset?: boolean } = {}) {
  const calls: { url: string; range?: string; authorization?: string }[] = [];
  let downloads = 0;
  const serve = (headers: Record<string, string>, step: Step, signal?: AbortSignal | null): Response => {
    const offset = Number(/bytes=(\d+)-/u.exec(headers.range ?? "")?.[1] ?? 0);
    if (offset >= big.length) return new Response(null, { status: 416, headers: { "content-range": `bytes */${big.length}` } });
    const partial = offset > 0 && !step.ignoreRange, bytes = partial ? big.subarray(offset) : big;
    const init = partial ? { status: 206, headers: { "content-range": `bytes ${offset}-${big.length - 1}/${big.length}`, "content-length": String(bytes.length) } } : { status: 200, headers: { "content-length": String(big.length) } };
    return streamed(bytes, init, step.drop !== undefined ? { after: step.drop, mode: "drop" } : step.stall !== undefined ? { after: step.stall, mode: "stall" } : undefined, signal);
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, range: headers.range, authorization: headers.authorization });
    if (url === API_LATEST) {
      if (options.api === "down") throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
      return options.api === 403 ? respond("rate limited", { status: 403 }) : respond(JSON.stringify(bigRelease));
    }
    if (url === SUMS || url === SUMS_LATEST) return options.sumsStatus ? respond("x", { status: options.sumsStatus }) : respond(options.sums ?? `${bigSha}  baton-0.2.0-mac-arm64.zip\n${"0".repeat(64)}  baton-0.2.0-win-x64.exe\n`);
    if (url === API_ASSET && options.apiAsset) return serve(headers, {}, init?.signal);
    if (url === DOWNLOAD) {
      const step = plan[Math.min(downloads++, plan.length - 1)] ?? {};
      return step.status ? respond("x", { status: step.status }) : serve(headers, step, init?.signal);
    }
    return respond("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, downloadCalls: () => calls.filter((call) => call.url === DOWNLOAD) };
}
const part = () => join(userData, "updates", "0.2.0", "baton-0.2.0-mac-arm64.zip.part");

describe("UpdateManager on an unreliable network", () => {
  it("resumes with a Range request after the connection drops", async () => {
    const { fetchImpl, downloadCalls } = flaky([{ drop: 100_000 }, {}]);
    const { instance, logs } = manager(fetchImpl);
    expect(await instance.check()).toMatchObject({ phase: "available", release: { asset: { downloadUrl: DOWNLOAD } } });
    const status = await instance.download();
    expect(status).toMatchObject({ phase: "downloaded", progress: 1, received: big.length, total: big.length });
    expect((await readFile(status.savedPath!)).equals(big)).toBe(true);
    const [first, second] = downloadCalls();
    expect(first!.range).toBeUndefined();
    expect(Number(/bytes=(\d+)-/u.exec(second!.range ?? "")?.[1])).toBeGreaterThan(0);
    expect(logs.some((line) => line.startsWith("download attempt 1 failed") && line.includes("网络连接中断"))).toBe(true);
  });

  it("starts over when the server ignores Range", async () => {
    const { fetchImpl } = flaky([{ drop: 50_000 }, { ignoreRange: true }]);
    const { instance } = manager(fetchImpl);
    await instance.check();
    const status = await instance.download();
    expect(status.phase).toBe("downloaded");
    expect((await readFile(status.savedPath!)).equals(big)).toBe(true);
  });

  it("gives up after the retries with a plain message, keeps the partial file, and 继续下载 picks it up", async () => {
    const { fetchImpl, downloadCalls } = flaky([...Array.from({ length: DOWNLOAD_ATTEMPTS }, () => ({ drop: 20_000 })), {}]);
    const { instance } = manager(fetchImpl);
    await instance.check();
    const failed = await instance.download();
    expect(failed).toMatchObject({ phase: "error", failedStep: "download" });
    expect(failed.error).toMatch(new RegExp(`^下载中断：网络连接中断，已自动重试 ${DOWNLOAD_ATTEMPTS - 1} 次。已下载 \\d+%，点「继续下载」会从断点接着下。$`, "u"));
    expect(downloadCalls()).toHaveLength(DOWNLOAD_ATTEMPTS);
    const kept = (await stat(part())).size;
    expect(kept).toBeGreaterThanOrEqual(DOWNLOAD_ATTEMPTS * 16_384);
    const resumed = await instance.download();
    expect(resumed.phase).toBe("downloaded");
    expect(downloadCalls().at(-1)!.range).toBe(`bytes=${kept}-`);
    expect((await readFile(resumed.savedPath!)).equals(big)).toBe(true);
  });

  it("retries a download that stops sending data", async () => {
    const { fetchImpl } = flaky([{ stall: 40_000 }, {}]);
    const { instance, logs } = manager(fetchImpl, "darwin", {}, { idleTimeoutMs: 40 });
    await instance.check();
    expect((await instance.download()).phase).toBe("downloaded");
    expect(logs.some((line) => line.includes("连接超时"))).toBe(true);
  });

  it("finds the release through its SHA256SUMS.txt when the API is rate limited, and needs no second checksum fetch", async () => {
    const { fetchImpl, calls } = flaky([{}], { api: 403 });
    const { instance } = manager(fetchImpl);
    const checked = await instance.check();
    expect(checked).toMatchObject({ phase: "available", release: { version: "0.2.0", sha256: bigSha, pageUrl: "https://github.com/DueGin/baton/releases/tag/v0.2.0", asset: { name: "baton-0.2.0-mac-arm64.zip", size: 0, downloadUrl: DOWNLOAD } } });
    const status = await instance.download();
    expect(status).toMatchObject({ phase: "downloaded", total: big.length });
    expect(calls.map((call) => call.url)).toEqual([API_LATEST, SUMS_LATEST, DOWNLOAD]);
  });

  it("falls back when api.github.com cannot be reached at all", async () => {
    const { fetchImpl } = flaky([{}], { api: "down" });
    const { instance, logs } = manager(fetchImpl);
    expect(await instance.check()).toMatchObject({ phase: "available", release: { version: "0.2.0" } });
    expect(logs.some((line) => line.includes("via github.com"))).toBe(true);
  });

  it("says plainly when neither the API nor github.com answers", async () => {
    const { fetchImpl } = flaky([{}], { api: "down", sumsStatus: 502 });
    const { instance } = manager(fetchImpl);
    const status = await instance.check();
    expect(status).toMatchObject({ phase: "error", failedStep: "check" });
    expect(status.error).toBe("检查更新失败：网络连接中断，备用地址也没有连上（github.com 返回 502）。请检查网络或代理后重试。");
  });

  it("does not retry a missing file or a bad checksum", async () => {
    const missing = flaky([{ status: 404 }]);
    const first = manager(missing.fetchImpl);
    await first.instance.check();
    expect(await first.instance.download()).toMatchObject({ phase: "error", failedStep: "download", error: "下载失败：GitHub 返回 404。" });
    expect(missing.downloadCalls()).toHaveLength(1);
    const corrupt = flaky([{}], { sums: `${"1".repeat(64)}  baton-0.2.0-mac-arm64.zip\n` });
    const second = manager(corrupt.fetchImpl);
    await second.instance.check();
    expect(await second.instance.download()).toMatchObject({ phase: "error", error: expect.stringContaining("校验失败") as unknown as string });
    expect(corrupt.downloadCalls()).toHaveLength(1);
    await expect(stat(part())).rejects.toThrow();
  });

  it("uses the API asset URL with the token when github.com refuses a private download", async () => {
    await writeFile(join(userData, "desktop-settings.json"), JSON.stringify({ githubToken: "private-token" }));
    const { fetchImpl, calls } = flaky([{ status: 404 }], { apiAsset: true });
    const { instance } = manager(fetchImpl);
    await instance.check();
    expect((await instance.download()).phase).toBe("downloaded");
    expect(calls.find((call) => call.url === API_ASSET)).toMatchObject({ authorization: "Bearer private-token" });
    expect(calls.find((call) => call.url === DOWNLOAD)?.authorization).toBeUndefined();
  });
});
