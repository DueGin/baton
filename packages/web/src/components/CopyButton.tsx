import { useEffect, useState } from "react";
export function CopyButton({ text, label = "复制源码" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false); const [failed, setFailed] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  return <button type="button" className="text-button code-copy" onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => { setCopied(true); setFailed(false); }).catch(() => setFailed(true)); }}>{copied ? "已复制" : failed ? "复制失败" : label}</button>;
}
