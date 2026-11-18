import { contextBridge, ipcRenderer } from "electron";
import type { BatonDesktopBridge } from "./bridge.js";

const bridge: BatonDesktopBridge = {
  platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
  version: process.argv.find(value => value.startsWith("--baton-version="))?.slice(16) ?? "unknown",
  pickDirectory: (options) => ipcRenderer.invoke("baton:pick-directory", options) as Promise<string | null>,
  openExternal: (url) => ipcRenderer.invoke("baton:open-external", url) as Promise<void>,
  showItemInFolder: (path) => ipcRenderer.invoke("baton:show-item", path) as Promise<void>,
  setBadgeCount: (count) => { ipcRenderer.send("baton:badge", count); },
  setWindowChrome: (chrome) => { ipcRenderer.send("baton:window-chrome", chrome); },
};
// The console keeps room for the macOS traffic lights unless the window is in full screen (no lights there).
// (The desktop package compiles without the DOM lib; the preload only needs this one call.)
const root = (): { toggleAttribute(name: string, force: boolean): boolean } | undefined => (globalThis as { document?: { documentElement?: { toggleAttribute(name: string, force: boolean): boolean } } }).document?.documentElement;
ipcRenderer.on("baton:fullscreen", (_event, value: unknown) => { root()?.toggleAttribute("data-fullscreen", value === true); });
contextBridge.exposeInMainWorld("batonDesktop", Object.freeze(bridge));
