import { describe, expect, it } from "vitest";
import { containsPath, directoryParent, pathKey, windowsRoots } from "./platform.js";

describe("Windows project directory logic", () => {
  it("compares realpaths case-insensitively and rejects sibling/other-drive escapes", () => {
    expect(pathKey("C:\\Projects\\Demo\\", "win32")).toBe(pathKey("c:/projects/demo", "win32"));
    expect(containsPath("C:\\Projects\\Demo", "c:\\PROJECTS\\demo\\src", "win32")).toBe(true);
    expect(containsPath("C:\\Projects\\Demo", "C:\\Projects\\Demo2", "win32")).toBe(false);
    expect(containsPath("C:\\Projects\\Demo", "D:\\Projects\\Demo", "win32")).toBe(false);
    expect(containsPath("C:\\Projects\\Demo", "C:\\Projects\\Demo\\..\\other", "win32")).toBe(false);
    expect(containsPath("C:\\", "c:\\Projects\\Demo", "win32")).toBe(true);
    expect(containsPath("/project", "/Project/file", "darwin")).toBe(false);
  });
  it("uses the virtual drive list as the parent of a drive root", () => {
    expect(directoryParent("C:\\", "win32")).toBe("");
    expect(directoryParent("D:/", "win32")).toBe("");
    expect(directoryParent("C:\\Projects", "win32")).toBe("C:\\");
    expect(directoryParent("/", "darwin")).toBeUndefined();
  });
  it("probes A–Z and lists only existing drives with project markers", async () => {
    const probes: string[] = [];
    const result = await windowsRoots("C:\\Users\\Person", async (path) => { probes.push(path); return ["C:\\", "F:\\"].includes(path); }, ["c:/"]);
    expect(probes).toHaveLength(26);
    expect(result).toEqual({ path: "", home: "C:\\Users\\Person", dirs: [{ name: "C:", path: "C:\\", isGitRepo: false, isProject: true }, { name: "F:", path: "F:\\", isGitRepo: false, isProject: false }] });
  });
});
