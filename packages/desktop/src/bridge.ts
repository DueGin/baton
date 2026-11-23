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
  /** In-app updates (DESIGN §4.15); absent in desktop builds before the updater. */
  updates?: {
    status(): Promise<UpdateStatus | null>;
    check(): Promise<UpdateStatus | null>;
    download(): Promise<UpdateStatus | null>;
    /** Swaps the app and quits; rejects nothing — the status carries the error. */
    install(): Promise<UpdateStatus | null>;
    /** Store (or clear with an empty string) the GitHub token used for the private repository. */
    setToken(token: string): Promise<{ saved: boolean }>;
    reveal(): Promise<void>;
    onStatus(listener: (status: UpdateStatus) => void): () => void;
  };
}

export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "downloaded" | "installing" | "error";
export interface UpdateRelease { version: string; notes: string; pageUrl: string; publishedAt: string; asset: { name: string; size: number }; checksum?: { name: string } }
export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  release?: UpdateRelease;
  /** 0–1 while downloading. */
  progress?: number;
  received?: number;
  total?: number;
  error?: string;
  /** The private repository needs a token before the check can work. */
  needsToken?: boolean;
  savedPath?: string;
  checkedAt?: string;
  /** While downloading: the retry in progress after a network failure. */
  retrying?: number;
  /** Which step an error belongs to; a failed download can be resumed. */
  failedStep?: "check" | "download" | "install";
}
