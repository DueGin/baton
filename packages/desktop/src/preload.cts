import { contextBridge, ipcRenderer } from "electron";
import type { BatonDesktopBridge } from "./bridge.js";

const bridge: BatonDesktopBridge = {
  platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
  version: process.argv.find(value => value.startsWith("--baton-version="))?.slice(16) ?? "unknown",
  pickDirectory: (options) => ipcRenderer.invoke("baton:pick-directory", options) as Promise<string | null>,
  openExternal: (url) => ipcRenderer.invoke("baton:open-external", url) as Promise<void>,
  showItemInFolder: (path) => ipcRenderer.invoke("baton:show-item", path) as Promise<void>,
  setBadgeCount: (count) => { ipcRenderer.send("baton:badge", count); },
};
contextBridge.exposeInMainWorld("batonDesktop", Object.freeze(bridge));
