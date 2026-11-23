import { useEffect, useState } from "react";
import { desktopBridge, type UpdateStatus } from "../desktop.js";

const size = (bytes?: number): string => !bytes ? "" : bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB` : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(0)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const day = (value?: string): string => value ? new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }) : "";

/** Settings → 更新: check, download and install a new desktop build without leaving the app (DESIGN §4.15). */
export function UpdatesSettings() {
  const updates = desktopBridge()?.updates;
  const [status, setStatus] = useState<UpdateStatus>();
  const [token, setToken] = useState(""); const [saving, setSaving] = useState(false); const [saved, setSaved] = useState<string>();
  useEffect(() => {
    if (!updates) return;
    let active = true;
    void updates.status().then(current => { if (active && current) setStatus(current); }).catch(() => undefined);
    return updates.onStatus(next => { if (active) setStatus(next); });
  }, [updates]);
  if (!updates) return <section className="settings-card update-settings"><h2>更新</h2><p className="muted">在桌面应用中可以在这里检查和安装新版本。浏览器版随守护进程一起更新。</p></section>;
  const busy = status?.phase === "checking" || status?.phase === "downloading" || status?.phase === "installing";
  const run = (action: () => Promise<UpdateStatus | null>) => { void action().then(next => { if (next) setStatus(next); }).catch(() => undefined); };
  const saveToken = async (value: string) => {
    setSaving(true); setSaved(undefined);
    try { const result = await updates.setToken(value); setSaved(result.saved ? "令牌已保存" : "令牌已清除"); if (result.saved) setToken(""); } catch { setSaved("保存失败，请检查令牌格式"); } finally { setSaving(false); }
  };
  const release = status?.release;
  const canInstall = status?.phase === "downloaded";
  return <section className="settings-card update-settings"><h2>更新</h2><p className="muted">安装包来自 GitHub Releases，下载后校验 SHA256，安装时应用会退出并自动重新打开。</p>
    <div className="settings-row"><div><strong>baton {status?.currentVersion ?? desktopBridge()?.version ?? ""}</strong><p>{status?.phase === "checking" ? "正在检查…" : status?.phase === "current" ? `已是最新版本${status.checkedAt ? `（${day(status.checkedAt)} 检查）` : ""}` : status?.phase === "error" ? "上次检查没有完成，可以重试。" : status?.checkedAt ? `上次检查：${day(status.checkedAt)}` : "还没有检查过。"}</p></div><button className="button" disabled={busy} onClick={() => { run(() => updates.check()); }}>{status?.phase === "checking" ? "检查中…" : "检查更新"}</button></div>
    {release && status?.phase === "available" && <div className="settings-row"><div><strong>新版本 {release.version}</strong><p>{[release.publishedAt ? `${day(release.publishedAt)} 发布` : "", size(release.asset.size), release.asset.name].filter(Boolean).join(" · ")}</p>{release.notes && <details className="update-notes"><summary>更新说明</summary><pre>{release.notes}</pre></details>}</div><button className="button primary" disabled={busy} onClick={() => { run(() => updates.download()); }}>下载</button></div>}
    {status?.phase === "downloading" && <div className="settings-row"><div><strong>正在下载{release ? ` ${release.version}` : ""}</strong><p>{Math.round((status.progress ?? 0) * 100)}% · {size(status.received) || "0 KB"}{status.total ? ` / ${size(status.total)}` : ""}{status.retrying ? ` · 网络中断，正在重试（第 ${status.retrying} 次），已下载的部分会保留` : ""}</p><div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((status.progress ?? 0) * 100)}><span style={{ width: `${Math.round((status.progress ?? 0) * 100)}%` }} /></div></div></div>}
    {status?.phase === "downloaded" && <div className="settings-row"><div><strong>已下载 {release?.version}</strong><p>安装会退出 baton（有活跃会话时会先确认），替换应用后自动重新打开。</p></div><button className="button primary" disabled={!canInstall} onClick={() => { run(() => updates.install()); }}>立即安装并重启</button></div>}
    {status?.phase === "installing" && <div className="settings-row"><div><strong>正在安装…</strong><p>应用即将退出并重新打开。</p></div></div>}
    {status?.phase === "error" && <div className="settings-row"><div><strong>{status.failedStep === "download" ? "下载没有完成" : status.failedStep === "install" ? "安装没有完成" : "检查更新没有完成"}</strong><p className="update-error">{status.error}</p>{status.savedPath && <button className="button small" onClick={() => { void updates.reveal(); }}>打开下载的文件</button>}</div>{status.failedStep === "download" && release ? <button className="button primary" onClick={() => { run(() => updates.download()); }}>继续下载</button> : status.failedStep !== "install" && <button className="button" onClick={() => { run(() => updates.check()); }}>重试</button>}</div>}
    <div className="settings-row update-token"><div><strong>GitHub 令牌</strong><p>{"可选。匿名检查每小时有 60 次上限；访问私有仓库的 Releases 才必须要。只保存在本机的 desktop-settings.json 中。"}</p><p className="field-hint">也可以不保存，直接在登录 shell 里设置 GITHUB_TOKEN。公开仓库不填也能检查更新。</p></div><div className="update-token-input"><input type="password" aria-label="GitHub 令牌" autoComplete="off" placeholder="ghp_… 或 github_pat_…" value={token} onChange={event => setToken(event.target.value)} /><button className="button small" disabled={saving || !token.trim()} onClick={() => { void saveToken(token); }}>{saving ? "保存中…" : "保存"}</button><button className="button small subtle" disabled={saving} onClick={() => { void saveToken(""); }} title="清除已保存的令牌">清除</button></div></div>
    {saved && <p className="green-text" role="status">{saved}</p>}
  </section>;
}
