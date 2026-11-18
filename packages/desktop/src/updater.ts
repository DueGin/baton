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
import { app, shell, type BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { compareVersions, parseChecksums, readRelease, responseSize, updateTarget, UPDATE_REPO, type UpdateStatus } from "./update.js";

export interface UpdateManagerOptions {
  /** Environment of the login shell; `GITHUB_TOKEN` / `GH_TOKEN` are read from it. */
  env?: NodeJS.ProcessEnv;
  /** `desktop-settings.json` — holds the token entered in the settings page. */
  settingsPath: string;
  fetch?: typeof fetch;
  version?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Quit once the installer has been handed the job. */
  quitForUpdate: () => void;
  log?: (message: string) => void;
}

export class UpdateManager {
  private status: UpdateStatus;
  private readonly fetchImpl: typeof fetch;
  private readonly version: string;
  private readonly target: ReturnType<typeof updateTarget>;
  private readonly log: (message: string) => void;
  private readonly onQuit: () => void;
  private downloading = false;

  constructor(private readonly window: () => BrowserWindow | null, private readonly options: UpdateManagerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
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
    this.set({ phase: "checking", error: undefined, needsToken: undefined, savedPath: undefined, progress: undefined, received: undefined, total: undefined });
    try {
      if (!this.target) return this.set({ phase: "error", error: "这个平台暂不支持应用内更新，请到 Releases 手动下载。" });
      const token = await this.token();
      const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "baton-updater" };
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await this.fetchImpl(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers });
      if (response.status === 401 || response.status === 404) return this.set({ phase: "error", needsToken: true, error: "仓库是私有的，检查更新需要一个有读取权限的 GitHub 令牌。填在下面再试。" });
      if (!response.ok) return this.set({ phase: "error", error: `GitHub 返回 ${response.status}${response.status === 403 ? "：匿名请求的调用次数可能已经用完，填一个令牌即可。" : ""}` });
      const release = readRelease(await response.json() as unknown, this.target);
      if (!release) return this.set({ phase: "error", error: "最新版本没有适合这台电脑的安装包。" });
      const order = compareVersions(release.version, this.version);
      if (order === null) return this.set({ phase: "error", error: `无法比较版本号：${release.version}` });
      const checkedAt = new Date().toISOString();
      this.log(`latest ${release.version}, current ${this.version}, ${order > 0 ? "update" : "up to date"}`);
      return this.set(order > 0 ? { phase: "available", release, checkedAt } : { phase: "current", release, checkedAt });
    } catch (error) {
      return this.set({ phase: "error", error: `检查失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** Download the release asset, verifying it against SHA256SUMS.txt when the release ships one. */
  async download(): Promise<UpdateStatus> {
    const release = this.status.release;
    if (this.downloading || !release || this.status.phase !== "available") return this.get();
    this.downloading = true;
    try {
      const token = await this.token();
      const headers: Record<string, string> = { accept: "application/octet-stream", "user-agent": "baton-updater" };
      if (token) headers.authorization = `Bearer ${token}`;
      const directory = join(app.getPath("userData"), "updates", release.version);
      await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true });
      const file = join(directory, release.asset.name);
      this.set({ phase: "downloading", progress: 0, received: 0, total: release.asset.size, error: undefined });
      const response = await this.fetchImpl(release.asset.apiUrl, { headers, redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
      const total = responseSize(response.headers) ?? release.asset.size;
      let received = 0, last = 0;
      const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      body.on("data", (chunk: Buffer) => {
        received += chunk.length;
        const now = Date.now();
        if (now - last < 120) return;
        last = now;
        this.set({ phase: "downloading", progress: total ? Math.min(1, received / total) : undefined, received, total });
      });
      await pipeline(body, createWriteStream(file));
      if (release.checksum) {
        const sums = await this.fetchImpl(release.checksum.apiUrl, { headers });
        const expected = sums.ok ? parseChecksums(await sums.text()).get(release.asset.name) : undefined;
        if (expected) {
          const actual = await new Promise<string>((resolve, reject) => {
            const hash = createHash("sha256");
            createReadStream(file).on("data", chunk => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
          });
          if (actual !== expected) { await rm(file, { force: true }); throw new Error("下载的文件校验失败（SHA256 不一致），已删除。"); }
          this.log(`sha256 ok ${actual.slice(0, 12)}`);
        }
      }
      return this.set({ phase: "downloaded", progress: 1, received, total, savedPath: file });
    } catch (error) {
      return this.set({ phase: "error", error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.downloading = false;
    }
  }

  /**
   * Hand the app over to the installer and quit. The caller quits through its normal quit path (which
   * asks about active runs); this only prepares the swap.
   */
  async install(): Promise<UpdateStatus> {
    const file = this.status.savedPath;
    const release = this.status.release;
    if (!file || !release || this.status.phase !== "downloaded") return this.get();
    try {
      this.set({ phase: "installing" });
      if (process.platform === "darwin") await this.installMac(file, release.version);
      else if (process.platform === "win32") await this.installWindows(file);
      else throw new Error("这个平台不支持应用内安装。");
      return this.get();
    } catch (error) {
      if (error instanceof InstallUnsupported) return this.set({ phase: "error", error: error.message });
      return this.set({ phase: "error", error: `安装失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** Show the downloaded file (used when the app lives somewhere a silent swap cannot touch). */
  reveal(): void { if (this.status.savedPath) shell.showItemInFolder(this.status.savedPath); }

  private async installMac(zipPath: string, version: string): Promise<void> {
    // BATON_UPDATE_BUNDLE only exists for the updater smoke test, which installs into a throwaway copy.
    const current = (process.env.BATON_UPDATE_BUNDLE ?? app.getPath("exe").replace(/\/Contents\/MacOS\/[^/]+$/u, ""));
    if (!current.endsWith(".app")) throw new InstallUnsupported("找不到当前的应用位置，请到 Releases 手动下载安装。");
    if (!(await writableApp(current))) throw new InstallUnsupported(`baton 位于 ${current}，没有写入权限，请到 Releases 手动下载安装。`);
    const work = join(app.getPath("userData"), "updates", version, "unpacked");
    await rm(work, { recursive: true, force: true }); await mkdir(work, { recursive: true });
    await run("ditto", ["-x", "-k", zipPath, work]).catch(error => { throw new Error(`解压失败：${error instanceof Error ? error.message : String(error)}`); });
    const source = await findApp(work);
    if (!source) throw new Error("压缩包里没有 .app。");
    const script = join(dirname(work), "swap.sh");
    // The script outlives this process, so wait for our pid to disappear before touching the bundle.
    await writeFile(script, `#!/bin/bash
set -u
for _ in $(seq 1 120); do kill -0 ${process.pid} 2>/dev/null || break; sleep 0.5; done
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
    this.log(`swap ${current} ← ${source}`);
    spawn("/bin/bash", [script, current, source], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => this.onQuit(), 400);
  }

  private async installWindows(installer: string): Promise<void> {
    // NSIS: /S silent; /D=<dir> must come last, unquoted. The installer is per-user, so the current directory is right.
    const directory = dirname(app.getPath("exe"));
    const script = join(dirname(installer), "install.cmd");
    await writeFile(script, [
      "@echo off",
      "setlocal",
      ":wait",
      `tasklist /fi "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul`,
      "if not errorlevel 1 (timeout /t 1 /nobreak >nul & goto wait)",
      `"${installer}" /S /D=${directory}`,
      `start "" "${join(directory, "baton.exe")}"`,
      'del "%~f0"',
    ].join("\r\n") + "\r\n");
    this.log(`installer ${basename(installer)} /S /D=${directory}`);
    spawn("cmd.exe", ["/c", script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    setTimeout(() => this.onQuit(), 400);
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
