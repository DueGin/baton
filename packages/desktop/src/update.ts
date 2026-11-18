/**
 * In-app updates (DESIGN §4.15). The repository is private, so both the check and the download go
 * through the GitHub API with a token the user configures once; nothing here talks to the daemon.
 *
 * States: idle → checking → available | up-to-date | error → downloading → downloaded → installing.
 * The pure helpers (version compare, asset choice, checksum parsing) are separated so they can be tested
 * without Electron or the network.
 */

export const UPDATE_REPO = "DueGin/baton";
export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "downloaded" | "installing" | "error";
export interface ReleaseAsset { name: string; size: number; apiUrl: string }
export interface UpdateRelease { version: string; notes: string; pageUrl: string; publishedAt: string; asset: ReleaseAsset; checksum?: ReleaseAsset }
export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  release?: UpdateRelease;
  /** 0–1 while downloading. */
  progress?: number;
  received?: number;
  total?: number;
  error?: string;
  /** True when the check failed for want of a token (private repository). */
  needsToken?: boolean;
  savedPath?: string;
  checkedAt?: string;
}

/** "v0.2.0-beta.1" → number[] / labels. Only numeric segments and a prerelease tag are meaningful here. */
export function parseVersion(value: string): { numbers: number[]; prerelease: string | null } | null {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/u.exec(value.trim());
  if (!match?.[1]) return null;
  return { numbers: match[1].split(".").map(Number), prerelease: match[2] ?? null };
}

/** Semver-ish comparison: > 0 when a is newer, 0 when equal, < 0 when older; null when unparsable. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index++) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;      // 0.2.0 is newer than 0.2.0-beta.1
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export type UpdateTarget = "mac-arm64" | "mac-x64" | "win-x64";
/** The asset a release should ship for this machine (macOS replaces its .app from the zip; Windows runs the installer). */
export function updateTarget(platform: NodeJS.Platform, arch: string): UpdateTarget | null {
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : null;
  if (platform === "win32") return arch === "x64" ? "win-x64" : null;
  return null;
}
const suffix: Record<UpdateTarget, string> = { "mac-arm64": "-mac-arm64.zip", "mac-x64": "-mac-x64.zip", "win-x64": "-win-x64.exe" };
export function assetMatches(name: string, target: UpdateTarget): boolean {
  return name.endsWith(suffix[target]) && /^baton-\d/u.test(name);
}

export interface GitHubRelease { tag_name?: unknown; body?: unknown; html_url?: unknown; published_at?: unknown; assets?: unknown }
export interface GitHubAsset { name?: unknown; size?: unknown; url?: unknown; browser_download_url?: unknown }

/** Pull what the updater needs out of `GET /repos/:owner/:repo/releases/latest`, or null when unusable. */
export function readRelease(raw: unknown, target: UpdateTarget): UpdateRelease | null {
  const release = (raw ?? {}) as GitHubRelease;
  if (typeof release.tag_name !== "string") return null;
  const version = release.tag_name.replace(/^v/u, "");
  if (!parseVersion(version) || (release.tag_name.startsWith("v")) === false) return null;
  const assets = Array.isArray(release.assets) ? (release.assets as GitHubAsset[]) : [];
  const usable = assets.filter(asset => typeof asset.name === "string" && typeof asset.url === "string" && typeof asset.size === "number");
  const chosen = usable.find(asset => assetMatches(asset.name as string, target));
  if (!chosen) return null;
  const sums = usable.find(asset => asset.name === "SHA256SUMS.txt");
  const toAsset = (asset: GitHubAsset): ReleaseAsset => ({ name: asset.name as string, size: asset.size as number, apiUrl: asset.url as string });
  return {
    version, pageUrl: typeof release.html_url === "string" ? release.html_url : "", notes: typeof release.body === "string" ? release.body : "",
    publishedAt: typeof release.published_at === "string" ? release.published_at : "",
    asset: toAsset(chosen), ...(sums ? { checksum: toAsset(sums) } : {}),
  };
}

/** `sha256sum` output (`<hash>  <file>`), keyed by file name (a leading `*` marks binary mode). */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*([0-9a-f]{64})\s+\*?(\S.*?)\s*$/iu.exec(line);
    if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** Total bytes from a `content-length`, or from a `content-range` (`bytes 0-1023/4096`) when GitHub omits it. */
export function responseSize(headers: { get(name: string): string | null }): number | undefined {
  const length = Number(headers.get("content-length"));
  if (Number.isFinite(length) && length > 0) return length;
  const range = /bytes\s+\d+-\d+\/(\d+)/u.exec(headers.get("content-range") ?? "");
  return range?.[1] ? Number(range[1]) : undefined;
}
