import { describe, expect, it } from "vitest";
import { assetMatches, compareVersions, parseChecksums, parseVersion, readRelease, responseSize, updateTarget } from "./update.js";

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
});
