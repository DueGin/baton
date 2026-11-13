import { useEffect, useState } from "react";
import type { SettingsResponse, TestTitleModelResponse, UpdateSettingsRequest } from "@baton/protocol";
import type { BatonClient } from "../api.js";
import { errorText } from "../store.js";
import { Toggle } from "./common.js";

export function TitleModelSettings({ client }: { client: BatonClient }) {
  const [saved, setSaved] = useState<SettingsResponse>();
  const [enabled, setEnabled] = useState(false); const [baseUrl, setBaseUrl] = useState(""); const [model, setModel] = useState("");
  const [key, setKey] = useState(""); const [keyEdited, setKeyEdited] = useState(false); const [auth, setAuth] = useState<"key" | "env">("key"); const [env, setEnv] = useState("");
  const [busy, setBusy] = useState<"load" | "save" | "test" | null>("load"); const [error, setError] = useState<string>(); const [message, setMessage] = useState<string>(); const [result, setResult] = useState<TestTitleModelResponse>();
  const accept = (settings: SettingsResponse) => { const value = settings.titleModel; setSaved(settings); setEnabled(value?.enabled ?? false); setBaseUrl(value?.baseUrl ?? ""); setModel(value?.model ?? ""); setEnv(value?.apiKeyEnv ?? ""); setAuth(value?.apiKeyEnv ? "env" : "key"); setKey(""); setKeyEdited(false); };
  useEffect(() => { let active = true; void client.settings().then(value => { if (active) accept(value); }).catch((cause: unknown) => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setBusy(null); }); return () => { active = false; }; }, [client]);
  const request = (): UpdateSettingsRequest => ({ titleModel: { enabled, baseUrl: baseUrl.trim(), model: model.trim(), apiKeyEnv: auth === "env" ? env.trim() || null : null, ...(keyEdited ? { apiKey: key } : {}) } });
  const run = async (action: "save" | "test") => {
    setBusy(action); setError(undefined); setMessage(undefined); setResult(undefined);
    try {
      if (action === "save") { accept(await client.updateSettings(request())); setMessage("标题模型设置已保存"); }
      else setResult(await client.testTitleModel({ sample: "为项目实现全局搜索和独立审查", titleModel: request().titleModel }));
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  return <section className="settings-card title-model-settings"><h2>标题模型</h2><p className="muted">使用 OpenAI 兼容端点为新 Run 命名。手动修改的标题会保留，也可以随时重新生成。</p><div className="settings-row"><div><strong>自动命名</strong><p>后台生成标题，通过事件更新 Run 列表。</p></div><Toggle label="启用标题模型" checked={enabled} disabled={Boolean(busy)} onChange={setEnabled} /></div>
    <div className="title-model-fields"><label className="form-field">Base URL<input aria-label="标题模型 Base URL" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:3425/v1" /></label><label className="form-field">Model<input aria-label="标题模型 Model" value={model} onChange={event => setModel(event.target.value)} placeholder="模型 ID" /></label><label className="form-field">密钥来源<select aria-label="标题模型密钥来源" value={auth} onChange={event => setAuth(event.target.value === "env" ? "env" : "key")}><option value="key">API Key</option><option value="env">环境变量</option></select></label>
    {auth === "key" ? <label className="form-field">API Key <span className="muted">{saved?.titleModel?.hasApiKey ? "已保存 · 只写，不回显" : "未保存"}</span><div className="title-key-row"><input aria-label="标题模型 API Key" type="password" autoComplete="new-password" value={key} onChange={event => { setKey(event.target.value); setKeyEdited(true); }} placeholder={saved?.titleModel?.hasApiKey ? "留空保留已有密钥" : "可选"} /><button className="button small" type="button" onClick={() => { setKey(""); setKeyEdited(true); }}>清除</button></div>{keyEdited && !key && <span className="muted">保存后清除已有密钥</span>}</label> : <label className="form-field">API key 环境变量<input aria-label="标题模型 API Key 环境变量" value={env} onChange={event => setEnv(event.target.value)} placeholder="OPENAI_API_KEY" /></label>}</div>
    <div className="title-settings-actions"><button className="button primary" disabled={Boolean(busy)} onClick={() => { void run("save"); }}>{busy === "save" ? "保存中…" : "保存"}</button><button className="button" disabled={Boolean(busy) || !baseUrl.trim() || !model.trim()} onClick={() => { void run("test"); }}>{busy === "test" ? "测试中…" : "测试"}</button></div>{message && <p className="green-text" role="status">{message}</p>}{result && <div className={result.ok ? "title-test-result" : "error-panel"} role="status">{result.ok ? <>生成标题：<strong>{result.title}</strong></> : result.error ?? "测试失败"}<span> · {result.latencyMs} ms</span></div>}{error && <div className="error-panel" role="alert">{error}</div>}
  </section>;
}
