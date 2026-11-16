import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectRecord } from "@baton/protocol";
import type { BatonClient } from "../api.js";
import { desktopBridge } from "../desktop.js";
import { pathBasename } from "../lib/projects.js";
import { errorText } from "../store.js";
import { Modal } from "./TeamForms.js";

export function DesktopAddProject({ client, close, added, manual }: { client: BatonClient; close: () => void; added: (project: ProjectRecord) => Promise<void>; manual: ReactNode }) {
  const [busy, setBusy] = useState(false), [name, setName] = useState(""), [path, setPath] = useState(""), [error, setError] = useState<string>();
  const started = useRef(false);
  const pick = async () => {
    const bridge = desktopBridge(); if (!bridge) return;
    setBusy(true); setError(undefined);
    try {
      const selected = await bridge.pickDirectory({ title: "选择项目文件夹", ...(path ? { defaultPath: path } : {}) });
      if (!selected) return;
      setPath(selected);
      const project = await client.createProject({ path: selected, name: name.trim() || pathBasename(selected) });
      await added(project);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };
  // Opening “添加项目…” from New Run or the sidebar goes straight to the system picker.
  useEffect(() => { if (!started.current) { started.current = true; void pick(); } }, []);
  return <Modal title="添加项目" close={() => { if (!busy) close(); }}><p className="muted">选择项目的工作文件夹。项目名称默认使用文件夹名称。</p><label className="form-field">项目名称（可选）<input aria-label="项目名称" value={name} disabled={busy} placeholder={path ? pathBasename(path) : "使用文件夹名称"} onChange={event => setName(event.target.value)} /></label>{path && <p><code>{path}</code></p>}{error && <div className="error-panel" role="alert">{error}</div>}<div className="dialog-footer"><button className="button" type="button" disabled={busy} onClick={close}>取消</button><button className="button primary" type="button" disabled={busy} onClick={() => { void pick(); }}>{busy ? "正在选择或添加…" : "选择文件夹…"}</button></div><details><summary>其他方式</summary>{manual}</details></Modal>;
}
