import { describe, expect, it } from "vitest";
import { assetMatches, compareVersions, latestDownloadUrl, networkReason, parseChecksums, parseVersion, readRelease, releaseFromChecksums, responseSize, updateTarget } from "./update.js";

const release = {
  tag_name: "v0.2.0",
  body: "Frameless window.",
  html_url: "https://github.com/DueGin/baton/releases/tag/v0.2.0",
  published_at: "2026-11-19T00:00:00Z",
  assets: [
    { name: "baton-0.2.0-mac-arm64.dmg", size: 10, url: "api/dmg" },
    { name: "baton-0.2.0-mac-arm64.zip", size: 20, url: "api/zip" },
    { name: "baton-0.2.0-win-x64.exe", size: 30, url: "api/exe" },
    { name: "SHA256SUMS.txt", size: 4, url: "api/sums" },
  ],
};

describe("update helpers", () => {
  it("parses and orders versions, including prereleases", () => {
    expect(parseVersion("v0.2.0")).toEqual({ numbers: [0, 2, 0], prerelease: null });
    expect(parseVersion("1.2")).toEqual({ numbers: [1, 2], prerelease: null });
    for (const value of ["", "latest", "v", " 1.x "]) expect(parseVersion(value)).toBeNull();
    expect(compareVersions("0.2.0", "0.1.0")).toBe(1);
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.0", "0.1")).toBe(0);
    expect(compareVersions("0.2.0", "0.2.0-beta.1")).toBe(1);
    expect(compareVersions("0.2.0-beta.1", "0.2.0-beta.2")).toBe(-1);
    expect(compareVersions("nonsense", "0.1.0")).toBeNull();
  });
  it("chooses the asset for this machine", () => {
    expect(updateTarget("darwin", "arm64")).toBe("mac-arm64");
    expect(updateTarget("darwin", "x64")).toBe("mac-x64");
    expect(updateTarget("win32", "x64")).toBe("win-x64");
    expect(updateTarget("linux", "x64")).toBeNull();
    expect(assetMatches("baton-0.2.0-mac-arm64.zip", "mac-arm64")).toBe(true);
    expect(assetMatches("baton-0.2.0-mac-x64.zip", "mac-arm64")).toBe(false);
    expect(assetMatches("SHA256SUMS.txt", "win-x64")).toBe(false);
  });
  it("reads a GitHub release into the updater's shape", () => {
    expect(readRelease(release, "mac-arm64")).toMatchObject({ version: "0.2.0", asset: { name: "baton-0.2.0-mac-arm64.zip", apiUrl: "api/zip" }, checksum: { name: "SHA256SUMS.txt" } });
    expect(readRelease(release, "win-x64")?.asset.name).toBe("baton-0.2.0-win-x64.exe");
    expect(readRelease({ ...release, tag_name: "0.2.0" }, "mac-arm64")).toBeNull();       // the workflow tags v*
    expect(readRelease({ ...release, tag_name: "vnext" }, "mac-arm64")).toBeNull();
    expect(readRelease({ ...release, assets: [] }, "mac-arm64")).toBeNull();
    expect(readRelease(null, "mac-arm64")).toBeNull();
  });
  it("parses checksum files and response sizes", () => {
    const sums = parseChecksums("AB12".padEnd(64, "a") + "  baton-0.2.0-mac-arm64.zip\n" + "c".repeat(64) + " *baton-0.2.0-win-x64.exe\n\n");
    expect(sums.get("baton-0.2.0-mac-arm64.zip")).toBe("ab12".padEnd(64, "a"));
    expect(sums.get("baton-0.2.0-win-x64.exe")).toBe("c".repeat(64));
    expect(parseChecksums("not a checksum").size).toBe(0);
    const headers = (map: Record<string, string>) => ({ get: (name: string) => map[name.toLowerCase()] ?? null });
    expect(responseSize(headers({ "content-length": "2048" }))).toBe(2048);
    expect(responseSize(headers({ "content-range": "bytes 0-1023/8192" }))).toBe(8192);
    expect(responseSize(headers({}))).toBeUndefined();
  });
  it("sizes resumed responses from content-range, else from content-length plus the offset", () => {
    const headers = (map: Record<string, string>) => ({ get: (name: string) => map[name.toLowerCase()] ?? null });
    expect(responseSize(headers({ "content-range": "bytes 1000-4095/4096", "content-length": "3096" }), 1000)).toBe(4096);
    expect(responseSize(headers({ "content-range": "bytes */4096" }), 4096)).toBe(4096);   // 416: nothing left
    expect(responseSize(headers({ "content-length": "3096" }), 1000)).toBe(4096);
  });
  it("keeps the public download URL next to the API URL", () => {
    const withDownload = { ...release, assets: release.assets.map((asset) => ({ ...asset, browser_download_url: `https://github.com/DueGin/baton/releases/download/v0.2.0/${asset.name}` })) };
    expect(readRelease(withDownload, "mac-arm64")).toMatchObject({ asset: { apiUrl: "api/zip", downloadUrl: "https://github.com/DueGin/baton/releases/download/v0.2.0/baton-0.2.0-mac-arm64.zip" }, checksum: { downloadUrl: expect.stringContaining("SHA256SUMS.txt") as unknown as string } });
    expect(readRelease(release, "mac-arm64")?.asset.downloadUrl).toBeUndefined();
  });
  it("finds the latest release from its SHA256SUMS.txt alone", () => {
    expect(latestDownloadUrl("DueGin/baton", "SHA256SUMS.txt")).toBe("https://github.com/DueGin/baton/releases/latest/download/SHA256SUMS.txt");
    const sums = ["a".repeat(64) + "  baton-0.2.1-mac-arm64.dmg", "b".repeat(64) + "  baton-0.2.1-mac-arm64.zip", "c".repeat(64) + "  baton-0.2.1-win-x64.exe", "d".repeat(64) + "  baton-0.3.0-beta.1-mac-x64.zip"].join("\n");
    expect(releaseFromChecksums(sums, "mac-arm64", "DueGin/baton")).toEqual({ version: "0.2.1", notes: "", publishedAt: "", pageUrl: "https://github.com/DueGin/baton/releases/tag/v0.2.1", sha256: "b".repeat(64), asset: { name: "baton-0.2.1-mac-arm64.zip", size: 0, apiUrl: "", downloadUrl: "https://github.com/DueGin/baton/releases/download/v0.2.1/baton-0.2.1-mac-arm64.zip" } });
    expect(releaseFromChecksums(sums, "win-x64", "DueGin/baton")?.asset.name).toBe("baton-0.2.1-win-x64.exe");
    expect(releaseFromChecksums(sums, "mac-x64", "DueGin/baton")?.version).toBe("0.3.0-beta.1");
    expect(releaseFromChecksums("not a checksum file", "mac-arm64", "DueGin/baton")).toBeNull();
  });
  it("names network failures in plain words, for undici and Chromium errors alike", () => {
    const wrapped = (code: string, message = code) => new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
    expect(networkReason(new TypeError("terminated"))).toBe("网络连接中断");
    expect(networkReason(wrapped("ECONNRESET", "read ECONNRESET"))).toBe("网络连接中断");
    expect(networkReason(new Error("net::ERR_CONNECTION_CLOSED"))).toBe("网络连接中断");
    expect(networkReason(wrapped("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"))).toBe("连接超时");
    expect(networkReason(new Error("download stalled: timeout"))).toBe("连接超时");
    expect(networkReason(wrapped("ENOTFOUND", "getaddrinfo ENOTFOUND api.github.com"))).toBe("无法解析 GitHub 的域名");
    expect(networkReason(wrapped("ERR_SSL_WRONG_VERSION_NUMBER", "SSL routines"))).toBe("和 GitHub 的安全连接建立失败");
    expect(networkReason(new Error("net::ERR_PROXY_CONNECTION_FAILED"))).toBe("连接被拒绝（检查代理设置）");
    expect(networkReason(new TypeError("fetch failed"))).toBe("无法连接 GitHub");
    expect(networkReason(new Error("something specific"))).toBe("something specific");
  });
});
