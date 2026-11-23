/**
 * In-app updates for the desktop app (DESIGN §4.15). Nothing here talks to the daemon; the console
 * (packages/web) drives it through the preload bridge.
 *
 * The repository is private, so GitHub needs a token. The console stores it in
 * `<userData>/desktop-settings.json` (mode 0600) through `setToken`; `GITHUB_TOKEN` / `GH_TOKEN` from
 * the login-shell environment are the fallback. The token never goes back to the page.
 *
 * Install:
 *  - macOS: the .zip is unpacked with `ditto`, the app quits, a detached script waits for the process
 *    to exit, swaps the .app bundle (wherever it currently lives), clears quarantine and reopens it.
 *    Unsigned builds cannot use Squirrel, hence the hand-rolled swap.
 *  - Windows: a detached .cmd waits for the pid to go away, runs the NSIS installer with /S, then
 *    reopens baton. Waiting matters: NSIS cannot replace a running .exe.
 */
import { app, net, shell, type BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { compareVersions, DOWNLOAD_ATTEMPTS, latestDownloadUrl, networkReason, parseChecksums, readRelease, releaseFromChecksums, responseSize, updateTarget, UPDATE_REPO, type ReleaseAsset, type UpdateRelease, type UpdateStatus } from "./update.js";

export interface UpdateManagerOptions {
  /** Environment of the login shell; `GITHUB_TOKEN` / `GH_TOKEN` are read from it. */
  env?: NodeJS.ProcessEnv;
  /** `desktop-settings.json` — holds the token entered in the settings page. */
  settingsPath: string;
  fetch?: typeof fetch;
  version?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /**
   * Exit right away once the installer has been handed the job: no second confirmation, no lingering — the swap
   * script waits for this process to be gone (DESIGN §4.15).
   */
  quitForUpdate: () => void;
  /** Asked before anything is handed over (e.g. "N 个活跃会话，安装更新会退出 baton"); false keeps the download ready. */
  confirmInstall?: () => Promise<boolean>;
  log?: (message: string) => void;
  /** First retry delay; later ones back off (default 2 s, up to 15 s). */
  retryDelayMs?: number;
  /** A download that receives nothing for this long is retried (default 45 s). */
  idleTimeoutMs?: number;
}
/** A failure that retrying will not fix (missing file, checksum mismatch, a 4xx other than 408/429). */
class FatalDownload extends Error {}
/**
 * Electron's main process patches fs so `.asar` files read as directories: a recursive rm of an unpacked update
 * (which contains Contents/Resources/app.asar) fails with ENOTEMPTY. Deletions use the unpatched `original-fs`
 * (plain node:fs outside Electron, e.g. in tests).
 */
const plainRm: typeof rm = (() => {
  try { return (createRequire(import.meta.url)("original-fs") as typeof import("node:fs")).promises.rm; } catch { return rm; }
})();
/** File-system failures (not network): reported as such and never retried. */
const fileSystemError = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E(?:ACCES|PERM|NOSPC|ROFS|NOTEMPTY|NOTDIR|ISDIR|EXIST|MFILE|DQUOT|IO)$/u.test(code) ? code : undefined;
};
/**
 * Chromium's stack (net.fetch) follows the system proxy; Node's fetch goes direct (or through a TUN). On flaky networks
 * either one can fail for minutes while the other works, so a request that fails to connect is tried once on the other.
 * Aborts and HTTP errors are not retried here; a body that breaks mid-stream is resumed by the download loop.
 */
async function dualStackFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  try { return await (net.fetch(String(input), init) as Promise<Response>); }
  catch (error) {
    if (init?.signal?.aborted) throw error;
    try { return await fetch(input, init); }
    catch (second) { throw new Error(`${networkDetail(error)}; direct: ${networkDetail(second)}`, { cause: second }); }
  }
}
/** The innermost codes of a network error, for logs (net::ERR_…, ECONNRESET, …). */
function networkDetail(error: unknown): string {
  const parts: string[] = [];
  for (let current = error, depth = 0; current instanceof Error && depth < 4; current = (current as { cause?: unknown }).cause, depth++) parts.push(String((current as { code?: unknown }).code ?? current.message));
  return parts.join(" <- ") || String(error);
}
class StatusError extends Error { constructor(readonly status: number) { super(`GitHub 返回 ${status}`); } }
const retryable = (status: number): boolean => status === 408 || status === 429 || status >= 500;
const sizeOf = async (file: string): Promise<number> => (await stat(file).catch(() => undefined))?.size ?? 0;
const percent = (received: number, total?: number): string => total ? `${Math.floor(received / total * 100)}%` : `${Math.round(received / 1048576)} MB`;

export class UpdateManager {
  private status: UpdateStatus;
  private readonly fetchImpl: typeof fetch;
  private readonly version: string;
  private readonly target: ReturnType<typeof updateTarget>;
  private readonly log: (message: string) => void;
  private readonly onQuit: () => void;
  private downloading = false;

  constructor(private readonly window: () => BrowserWindow | null, private readonly options: UpdateManagerOptions) {
    this.fetchImpl = options.fetch ?? dualStackFetch;
    this.version = options.version ?? (app?.getVersion?.() || "0.0.0");
    this.target = updateTarget(options.platform ?? process.platform, options.arch ?? process.arch);
    this.log = options.log ?? (message => console.log(`[update] ${message}`));
    this.onQuit = options.quitForUpdate;
    this.status = { phase: "idle", currentVersion: this.version };
  }

  get(): UpdateStatus { return { ...this.status }; }

  private set(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = { ...this.status, ...patch, currentVersion: this.version };
    const target = this.window();
    if (target && !target.isDestroyed()) target.webContents.send("baton:update-status", this.get());
    return this.get();
  }

  /** The token for GitHub: the one saved in the settings page, else the environment. */
  async token(): Promise<string | undefined> {
    try {
      const saved = JSON.parse(await readFile(this.options.settingsPath, "utf8")) as Record<string, unknown> | null;
      if (typeof saved?.githubToken === "string" && saved.githubToken.trim()) return saved.githubToken.trim();
    } catch { /* No settings yet. */ }
    const env = this.options.env ?? process.env;
    return env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || undefined;
  }

  /** Store (or clear, with an empty string) the token used for GitHub. Returns whether one is now saved. */
  async setToken(input: unknown): Promise<{ saved: boolean }> {
    const token = typeof input === "string" ? input.trim() : "";
    if (token && (token.length > 200 || /\s/u.test(token))) throw new Error("Invalid token");
    await mkdir(dirname(this.options.settingsPath), { recursive: true });
    let current: Record<string, unknown> = {};
    try { current = JSON.parse(await readFile(this.options.settingsPath, "utf8")) as Record<string, unknown>; } catch { /* First write. */ }
    const next = { ...current };
    if (token) next.githubToken = token; else delete next.githubToken;
    await writeFile(this.options.settingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.options.settingsPath, 0o600).catch(() => undefined);
    return { saved: Boolean(token) };
  }

  async check(): Promise<UpdateStatus> {
    if (this.downloading) return this.get();
    this.set({ phase: "checking", error: undefined, needsToken: undefined, savedPath: undefined, progress: undefined, received: undefined, total: undefined, retrying: undefined, failedStep: undefined });
    if (!this.target) return this.set({ phase: "error", failedStep: "check", error: "这个平台暂不支持应用内更新，请到 Releases 手动下载。" });
    const token = await this.token();
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "baton-updater" };
    if (token) headers.authorization = `Bearer ${token}`;
    let api: Response | undefined, apiProblem: string | undefined;
    let apiDetail: string | undefined;
    try { api = await this.fetchImpl(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers, signal: AbortSignal.timeout(20000) }); }
    catch (error) { apiProblem = networkReason(error); apiDetail = networkDetail(error); }
    if (api?.ok) {
      try {
        const release = readRelease(await api.json() as unknown, this.target);
        return release ? this.decide(release, "api") : this.set({ phase: "error", failedStep: "check", error: "最新版本没有适合这台电脑的安装包。" });
      } catch (error) { apiProblem = networkReason(error); }
    }
    // The API is rate limited, unreachable or failing: the latest release's own SHA256SUMS.txt names it (no API quota).
    const fallback = await this.checkWithoutApi();
    if (fallback.release) return this.decide(fallback.release, "github.com");
    this.log(`check failed: api ${apiDetail ?? api?.status}, github.com ${fallback.detail ?? fallback.problem}`);
    if (api && (api.status === 401 || api.status === 404)) return this.set({ phase: "error", failedStep: "check", needsToken: true, error: "GitHub 找不到这个仓库的最新版本。如果仓库是私有的，需要一个有读取权限的令牌（填在下面）。" });
    const apiPart = apiProblem ?? (api?.status === 403 || api?.status === 429 ? "接口被限流（匿名每小时 60 次）" : `接口返回 ${api?.status}`);
    return this.set({ phase: "error", failedStep: "check", error: `检查更新失败：${apiPart}，备用地址也没有连上（${fallback.problem}）。请检查网络或代理后重试。` });
  }

  private decide(release: UpdateRelease, source: string): UpdateStatus {
    const order = compareVersions(release.version, this.version);
    if (order === null) return this.set({ phase: "error", failedStep: "check", error: `无法比较版本号：${release.version}` });
    this.log(`latest ${release.version} (via ${source}), current ${this.version}, ${order > 0 ? "update" : "up to date"}`);
    return this.set({ phase: order > 0 ? "available" : "current", release, checkedAt: new Date().toISOString() });
  }

  /** The latest release's SHA256SUMS.txt (tiny): a few tries, since this is the path taken when the network is already bad. */
  private async checkWithoutApi(): Promise<{ release?: UpdateRelease; problem?: string; detail?: string }> {
    let last: { problem: string; detail?: string } = { problem: "无法连接 GitHub" };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.fetchImpl(latestDownloadUrl(UPDATE_REPO, "SHA256SUMS.txt"), { headers: { "user-agent": "baton-updater" }, signal: AbortSignal.timeout(30000) });
        if (response.ok) {
          const release = releaseFromChecksums(await response.text(), this.target!, UPDATE_REPO);
          return release ? { release } : { problem: "最新版本没有适合这台电脑的安装包" };
        }
        last = { problem: `github.com 返回 ${response.status}` };
        if (!retryable(response.status)) return last;
      } catch (error) { last = { problem: networkReason(error), detail: networkDetail(error) }; }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, (this.options.retryDelayMs ?? 2000) * attempt));
    }
    return last;
  }

  /**
   * Download the release asset into `<asset>.part`, resuming with Range requests across network failures
   * (DOWNLOAD_ATTEMPTS tries, backing off; a stalled stream counts as a failure), then verify SHA256 and keep it.
   * A failed run keeps the partial file: calling download() again continues from it.
   */
  async download(): Promise<UpdateStatus> {
    const release = this.status.release;
    const resumable = this.status.phase === "available" || (this.status.phase === "error" && this.status.failedStep === "download");
    if (this.downloading || !release || !resumable) return this.get();
    this.downloading = true;
    const directory = join(app.getPath("userData"), "updates", release.version);
    const file = join(directory, release.asset.name), part = `${file}.part`;
    let total = release.asset.size || undefined;
    try {
      const token = await this.token();
      await mkdir(directory, { recursive: true });
      // Leftovers from an earlier install (unpacked app, swap script) must not block the download.
      for (const entry of await readdir(directory)) if (entry !== basename(part)) await this.remove(join(directory, entry));
      let received = await sizeOf(part);
      this.set({ phase: "downloading", progress: total ? received / total : 0, received, total, error: undefined, failedStep: undefined, retrying: undefined, savedPath: undefined });
      for (let attempt = 1; ; attempt++) {
        try {
          total = (await this.fetchPart(release.asset, part, received, token, total)) ?? total;
          received = await sizeOf(part);
          if (total !== undefined && received > total) { await plainRm(part, { force: true }); throw new Error("下载的文件比预期大，重新下载"); }
          if (total !== undefined && received < total) throw new Error("terminated: the connection closed early");
          break;
        } catch (error) {
          received = await sizeOf(part);
          if (error instanceof FatalDownload || fileSystemError(error) || attempt >= DOWNLOAD_ATTEMPTS) throw error;
          this.log(`download attempt ${attempt} failed at ${received}/${total ?? "?"}: ${networkReason(error)}`);
          this.set({ phase: "downloading", retrying: attempt, received, total, progress: total ? received / total : undefined });
          await new Promise((resolve) => setTimeout(resolve, Math.min(15000, (this.options.retryDelayMs ?? 2000) * 1.6 ** (attempt - 1))));
        }
      }
      const expected = release.sha256 ?? await this.expectedChecksum(release, token);
      if (!expected) throw new FatalDownload("拿不到这个版本的校验文件（SHA256SUMS.txt），为安全起见没有使用下载的文件。请稍后点「继续下载」重试。");
      const actual = await new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256");
        createReadStream(part).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
      });
      if (actual !== expected) { await plainRm(part, { force: true }); throw new FatalDownload("下载的文件校验失败（SHA256 不一致），已删除，请重新下载。"); }
      this.log(`sha256 ok ${actual.slice(0, 12)}`);
      await rename(part, file);
      return this.set({ phase: "downloaded", progress: 1, received, total, savedPath: file, retrying: undefined });
    } catch (error) {
      const received = await sizeOf(part);
      const fsCode = fileSystemError(error);
      const message = error instanceof FatalDownload ? error.message
        : fsCode ? `无法写入下载目录（${fsCode === "ENOSPC" || fsCode === "EDQUOT" ? "磁盘空间不足" : fsCode === "EACCES" || fsCode === "EPERM" || fsCode === "EROFS" ? "没有写入权限" : fsCode}）：${dirname(part)}。处理后点「继续下载」。`
        : error instanceof StatusError && !retryable(error.status) ? `下载失败：${error.message}。`
        : `下载中断：${networkReason(error)}，已自动重试 ${DOWNLOAD_ATTEMPTS - 1} 次。已下载 ${percent(received, total)}，点「继续下载」会从断点接着下。`;
      return this.set({ phase: "error", failedStep: "download", retrying: undefined, received, total, progress: total ? received / total : undefined, error: message });
    } finally {
      this.downloading = false;
    }
  }

  /** Best-effort removal: logs and moves on, since a leftover file never matters more than the update itself. */
  private async remove(path: string): Promise<void> {
    try { await plainRm(path, { recursive: true, force: true, maxRetries: 3 }); }
    catch (error) { this.log(`could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** One request for the rest of the file (Range from `offset`), appended to `part`. Returns the whole size when known. */
  private async fetchPart(asset: ReleaseAsset, part: string, offset: number, token: string | undefined, known?: number): Promise<number | undefined> {
    if (known !== undefined && offset === known) return known;
    const controller = new AbortController();
    let idle: NodeJS.Timeout | undefined;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(new Error("download stalled: timeout")), this.options.idleTimeoutMs ?? 45000); };
    arm();
    try {
      const response = await this.assetResponse(asset, offset, token, controller.signal);
      if (response.status === 416 && offset > 0) {
        // Nothing left past `offset`: complete if that is the whole file, otherwise start over.
        const total = responseSize(response.headers);
        await response.body?.cancel().catch(() => undefined);
        if (total === offset) return total;
        await plainRm(part, { force: true }); throw new Error("terminated: the partial file does not match, restarting");
      }
      if (!response.ok || !response.body) throw retryable(response.status) ? new StatusError(response.status) : new FatalDownload(`下载失败：GitHub 返回 ${response.status}。`);
      const resumed = offset > 0 && response.status === 206;   // a 200 means the server ignored Range: start over
      const start = resumed ? offset : 0, total = responseSize(response.headers, start);
      let received = start, last = 0;
      // Read the web stream directly (no read-ahead buffer) and put each chunk on disk before asking for the next:
      // when the connection drops, everything received so far is kept for the next Range request.
      const reader = response.body.getReader();
      const handle = await open(part, resumed ? "a" : "w");
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await handle.write(value); received += value.length; arm();
          const now = Date.now(); if (now - last < 120) continue; last = now;
          this.set({ phase: "downloading", retrying: undefined, progress: total ? Math.min(1, received / total) : undefined, received, total });
        }
      } finally { await handle.close(); reader.releaseLock(); }
      return total;
    } finally { clearTimeout(idle); }
  }

  /** The asset from github.com (public, no API quota); a private repository falls back to the API with the token. */
  private async assetResponse(asset: ReleaseAsset, offset: number, token: string | undefined, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/octet-stream", "user-agent": "baton-updater", ...(offset > 0 ? { range: `bytes=${offset}-` } : {}) };
    if (asset.downloadUrl) {
      const response = await this.fetchImpl(asset.downloadUrl, { headers, signal });
      if (!(token && asset.apiUrl && [401, 403, 404].includes(response.status))) return response;
      await response.body?.cancel().catch(() => undefined);
    }
    if (!asset.apiUrl) throw new FatalDownload("这个版本没有可下载的地址。");
    return this.fetchImpl(asset.apiUrl, { headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal });
  }

  /** The asset's hash from the release's SHA256SUMS.txt (a few tries: it is tiny, the network may not be). */
  private async expectedChecksum(release: UpdateRelease, token: string | undefined): Promise<string | undefined> {
    if (!release.checksum) return undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.assetResponse(release.checksum, 0, token, AbortSignal.timeout(30000));
        if (response.ok) return parseChecksums(await response.text()).get(release.asset.name);
        if (!retryable(response.status)) return undefined;
      } catch { /* retried below */ }
      await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? 2000));
    }
    return undefined;
  }

  /**
   * Prepare the installer (unpack, write the swap script), ask `confirmInstall`, and only then start the script and
   * quit. Cancelling leaves the downloaded update ready; nothing runs against the still-open app.
   */
  async install(): Promise<UpdateStatus> {
    const file = this.status.savedPath;
    const release = this.status.release;
    if (!file || !release || this.status.phase !== "downloaded") return this.get();
    try {
      this.set({ phase: "installing" });
      const launch = process.platform === "darwin" ? await this.prepareMac(file, release.version)
        : process.platform === "win32" ? await this.prepareWindows(file)
        : (() => { throw new InstallUnsupported("这个平台不支持应用内安装。"); })();
      if (!(await (this.options.confirmInstall?.() ?? Promise.resolve(true)))) {
        this.log("install cancelled at the confirmation");
        return this.set({ phase: "downloaded" });
      }
      launch();
      this.onQuit();
      return this.get();
    } catch (error) {
      if (error instanceof InstallUnsupported) return this.set({ phase: "error", failedStep: "install", error: error.message });
      return this.set({ phase: "error", failedStep: "install", error: `安装失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** Show the downloaded file (used when the app lives somewhere a silent swap cannot touch). */
  reveal(): void { if (this.status.savedPath) shell.showItemInFolder(this.status.savedPath); }

  /** Unpack and write swap.sh; returns the launcher (not yet started). */
  private async prepareMac(zipPath: string, version: string): Promise<() => void> {
    // BATON_UPDATE_BUNDLE only exists for the updater smoke test, which installs into a throwaway copy.
    const current = (process.env.BATON_UPDATE_BUNDLE ?? app.getPath("exe").replace(/\/Contents\/MacOS\/[^/]+$/u, ""));
    if (!current.endsWith(".app")) throw new InstallUnsupported("找不到当前的应用位置，请到 Releases 手动下载安装。");
    if (!(await writableApp(current))) throw new InstallUnsupported(`baton 位于 ${current}，没有写入权限，请到 Releases 手动下载安装。`);
    const work = join(app.getPath("userData"), "updates", version, "unpacked");
    await plainRm(work, { recursive: true, force: true, maxRetries: 3 }); await mkdir(work, { recursive: true });
    await run("ditto", ["-x", "-k", zipPath, work]).catch(error => { throw new Error(`解压失败：${error instanceof Error ? error.message : String(error)}`); });
    const source = await findApp(work);
    if (!source) throw new Error("压缩包里没有 .app。");
    const script = join(dirname(work), "swap.sh");
    // The script outlives this process: wait for our pid to disappear, and never replace a bundle that is still running.
    await writeFile(script, `#!/bin/bash
set -u
for _ in $(seq 1 120); do kill -0 ${process.pid} 2>/dev/null || break; sleep 0.5; done
if kill -0 ${process.pid} 2>/dev/null; then
  /usr/bin/osascript -e 'display notification "baton 没有退出，更新未安装。重新打开「设置 → 更新」再试一次。" with title "baton"'
  rm -f "$0"; exit 1
fi
sleep 0.6
rm -rf "$1.old" && mv "$1" "$1.old"
if ditto "$2" "$1"; then
  xattr -dr com.apple.quarantine "$1" 2>/dev/null
  rm -rf "$1.old"
  open "$1"
else
  rm -rf "$1" && mv "$1.old" "$1"
  /usr/bin/osascript -e 'display notification "更新失败，已恢复原版本。" with title "baton"'
fi
rm -f "$0"
`, { mode: 0o755 });
    return () => {
      this.log(`swap ${current} ← ${source}`);
      spawn("/bin/bash", [script, current, source], { detached: true, stdio: "ignore" }).unref();
    };
  }

  /** Write install.cmd; returns the launcher (not yet started). */
  private async prepareWindows(installer: string): Promise<() => void> {
    // NSIS: /S silent; /D=<dir> must come last, unquoted. The installer is per-user, so the current directory is right.
    const directory = dirname(app.getPath("exe"));
    const script = join(dirname(installer), "install.cmd");
    await writeFile(script, [
      "@echo off",
      "setlocal",
      "set /a tries=0",
      ":wait",
      `tasklist /fi "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul`,
      "if errorlevel 1 goto install",
      "set /a tries+=1",
      // NSIS cannot replace a running exe: give up rather than install under a live process.
      'if %tries% geq 120 (del "%~f0" & exit /b 1)',
      "timeout /t 1 /nobreak >nul",
      "goto wait",
      ":install",
      `"${installer}" /S /D=${directory}`,
      `start "" "${join(directory, "baton.exe")}"`,
      'del "%~f0"',
    ].join("\r\n") + "\r\n");
    return () => {
      this.log(`installer ${basename(installer)} /S /D=${directory}`);
      spawn("cmd.exe", ["/c", script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    };
  }
}

class InstallUnsupported extends Error {}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}

/** Whether the bundle can be replaced: its parent directory and the bundle itself must be writable. */
async function writableApp(bundle: string): Promise<boolean> {
  const { access, constants } = await import("node:fs/promises");
  try { await access(dirname(bundle), constants.W_OK); await access(bundle, constants.W_OK); return true; } catch { return false; }
}

async function findApp(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.name.endsWith(".app")) return full;
    if (entry.isDirectory()) { const found = await findApp(full); if (found) return found; }
  }
  return undefined;
}

/** `<userData>/desktop-settings.json` — the settings page's token lives here. */
export const settingsPathFor = (userData: string): string => join(userData, "desktop-settings.json");
