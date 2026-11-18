import { useEffect, useState } from "react";
import { Icon } from "./common.js";

function useCopy(text: string): { copied: boolean; failed: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false); const [failed, setFailed] = useState(false);
  useEffect(() => { if (!copied && !failed) return; const timer = setTimeout(() => { setCopied(false); setFailed(false); }, 1500); return () => clearTimeout(timer); }, [copied, failed]);
  return { copied, failed, copy: () => { void Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => { setCopied(true); setFailed(false); }).catch(() => setFailed(true)); } };
}
export function CopyButton({ text, label = "复制源码" }: { text: string; label?: string }) {
  const { copied, failed, copy } = useCopy(text);
  return <button type="button" className="text-button code-copy" onClick={copy}>{copied ? "已复制" : failed ? "复制失败" : label}</button>;
}
/** A long id shown shortened (first characters + …) with an icon button that copies the full value. */
export function CopyableId({ id, label = "ID", head = 8 }: { id: string; label?: string; head?: number }) {
  const { copied, failed, copy } = useCopy(id);
  return <span className="copyable-id"><code title={id}>{id.length > head + 1 ? `${id.slice(0, head)}…` : id}</code>
    <button type="button" className="icon-button copyable-id-button" aria-label={`复制${label}`} title={copied ? "已复制" : failed ? "复制失败" : `复制完整${label}`} onClick={copy}>{copied ? <Icon name="check" size={11} /> : <Icon name="copy" size={11} />}</button></span>;
}
