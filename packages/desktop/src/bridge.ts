/** Keep this deliberately small; DESIGN §4.12 is the bridge contract. */
export interface BatonDesktopBridge {
  platform: "darwin" | "win32" | "linux";
  version: string;
  pickDirectory(options?: { defaultPath?: string; title?: string }): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  setBadgeCount(count: number): void;
  /** Theme choice plus the colours behind the window controls; sets the native appearance and the Windows overlay. */
  setWindowChrome(chrome: { theme: "system" | "light" | "dark"; background: string; foreground: string }): void;
}
