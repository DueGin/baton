// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/codex-app-server-agent.test.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log(process.env.FAKE_VERSION ?? '2.5.0'); process.exit(0); }
const kind = process.argv[2];
let turn = 0, pendingPrompt, requestId = 1000;
const permissions = new Map();
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const sessionId = 'fake-session';
const model = { id: 'fake-model', model: 'fake-model', displayName: 'Fake model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' };
const reply = (message, result = {}) => kind === 'pi' ? send({ type: 'response', id: message.id, command: message.type, success: true, data: result }) : send({ jsonrpc: '2.0', id: message.id, result });
function complete() {
 if (kind === 'codex') {
  notify('item/reasoning/summaryTextDelta', { threadId: sessionId, turnId: `turn-${turn}`, itemId: 'thinking', delta: 'thinking' });
  notify('item/agentMessage/delta', { threadId: sessionId, turnId: `turn-${turn}`, itemId: 'answer', delta: 'DONE' });
  const item = { id: 'shell-1', type: 'commandExecution', command: 'echo hello', cwd: process.cwd(), status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
  notify('item/started', { threadId: sessionId, turnId: `turn-${turn}`, item });
  notify('item/completed', { threadId: sessionId, turnId: `turn-${turn}`, item: { ...item, status: 'completed', aggregatedOutput: 'hello', exitCode: 0 } });
  notify('thread/tokenUsage/updated', { threadId: sessionId, tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4 }, last: { totalTokens: 14 }, modelContextWindow: 10000 } });
  notify('turn/completed', { threadId: sessionId, turn: { id: `turn-${turn}`, status: 'completed', error: null } });
 } else if (kind === 'pi') {
  send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' } });
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'DONE' } });
  send({ type: 'tool_execution_start', toolCallId: 'shell-1', toolName: 'bash', args: { command: 'echo hello' } });
  send({ type: 'tool_execution_end', toolCallId: 'shell-1', toolName: 'bash', result: { output: 'hello', exitCode: 0 }, isError: false });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }], usage: { input: 10, output: 4, cacheRead: 2, cost: { total: 0.001 } } } });
  send({ type: 'agent_end', willRetry: false, messages: [] });
  send({ type: 'agent_settled' });
 } else {
  const update = u => notify('session/update', { sessionId, update: u });
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DONE' } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'shell-1', title: 'Bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo hello' } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'shell-1', status: 'completed', rawOutput: { stdout: 'hello', exitCode: 0 } });
  reply(pendingPrompt, { stopReason: 'end_turn' }); pendingPrompt = undefined;
 }
}
function askPermission() {
 const id = ++requestId;
 if (kind === 'codex') {
  permissions.set(id, () => complete());
  send({ jsonrpc: '2.0', id, method: 'item/commandExecution/requestApproval', params: { threadId: sessionId, turnId: `turn-${turn}`, itemId: 'shell-1', command: 'echo hello', cwd: process.cwd() } });
 } else if (kind === 'pi') {
  permissions.set(String(id), () => complete());
  send({ type: 'extension_ui_request', id: String(id), method: 'confirm', title: 'Run shell?', message: 'echo hello' });
 } else {
  permissions.set(id, () => complete());
  send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'shell-1', title: 'Bash', kind: 'execute', rawInput: { command: 'echo hello' } }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] } });
 }
}
createInterface({ input: process.stdin }).on('line', line => {
 const message = JSON.parse(line);
 if (process.env.FAKE_CAPTURE) appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify(message) + '\n');
 if (permissions.has(message.id)) { const callback = permissions.get(message.id); permissions.delete(message.id); callback(); return; }
 if (kind === 'pi') {
  switch (message.type) {
   case 'get_state': return reply(message, { sessionId, sessionFile: `${process.env.BATON_HOME}/pi-session.jsonl`, model: { provider: 'fake', id: 'fake-model' } });
   case 'get_available_models': return reply(message, { models: [{ provider: 'fake', id: 'fake-model', name: 'Fake', reasoning: true }] });
   case 'get_commands': return reply(message, { commands: process.env.FAKE_MCP === 'none' ? [] : [{ name: 'mcp', source: 'extension', sourceInfo: { path: process.env.FAKE_MCP === 'adapter' ? '/extensions/pi-mcp-adapter/index.ts' : 'builtin:mcp' } }] });
   case 'prompt': turn++; reply(message); if (message.message.includes('hold')) return; if (message.message.includes('permission')) return askPermission(); if (message.message.includes('exit')) return process.exit(3); return complete();
   case 'steer': reply(message); return complete();
   case 'abort': reply(message); return send({ type: 'agent_end', messages: [] });
   default: return reply(message);
  }
 }
 if (message.method === 'initialize') return reply(message, kind === 'acp' ? { protocolVersion: 1, _meta: { models: { currentModelId: 'fake-model', availableModels: [{ modelId: 'fake-model', name: 'Fake model' }] } }, agentInfo: { name: 'fake', version: '1' }, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true } } } : {});
 if (message.method === 'cursor/list_available_models') return reply(message, { models: [{ value: 'cursor-model', name: 'Cursor Model' }] });
 if (message.method === 'fake/env') return reply(message, { models: [{ value: process.env.COPILOT_ALLOW_ALL ?? 'scrubbed', name: 'env' }] });
 if (message.method === 'initialized') return;
 if (message.method === 'model/list') return reply(message, { data: [model], nextCursor: null });
 if (message.method === 'thread/start' || message.method === 'thread/resume') return reply(message, { thread: { id: sessionId }, model: model.id });
 if (message.method === 'session/new' || message.method === 'session/load') return reply(message, { sessionId, modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] }, models: { currentModelId: 'fake-model', availableModels: [{ modelId: 'fake-model', name: 'Fake model' }] } });
 if (message.method === 'session/set_mode' || message.method === 'session/set_model') return reply(message);
 if (message.method === 'turn/start') {
  turn++; reply(message, { turn: { id: `turn-${turn}` } });
  notify('turn/started', { threadId: sessionId, turn: { id: `turn-${turn}` } });
  const prompt = message.params.input[0].text;
  if (prompt.includes('hold')) { notify('item/started', { threadId: sessionId, turnId: `turn-${turn}`, item: { id: 'live-shell', type: 'commandExecution', command: 'wait', cwd: process.cwd(), status: 'inProgress', commandActions: [], processId: 'process-42' } }); return; }
  if (prompt.includes('permission')) return askPermission();
  if (prompt.includes('exit')) return process.exit(3);
  return complete();
 }
 if (kind === 'acp' && message.method === 'session/prompt' && message.params.prompt[0].text.includes('terminal')) {
  pendingPrompt = message;
  const terminalRequestId = ++requestId;
  permissions.set(terminalRequestId, () => complete());
  send({ jsonrpc: '2.0', id: terminalRequestId, method: 'terminal/create', params: { sessionId, command: process.execPath, args: ['-e', 'process.stdout.write("terminal output")'], outputByteLimit: 100 } });
  return;
 }
 if (message.method === 'session/prompt') {
  pendingPrompt = message; turn++;
  const prompt = message.params.prompt[0].text;
  if (prompt.includes('hold')) { notify('item/started', { threadId: sessionId, turnId: `turn-${turn}`, item: { id: 'live-shell', type: 'commandExecution', command: 'wait', cwd: process.cwd(), status: 'inProgress', commandActions: [], processId: 'process-42' } }); return; }
  if (prompt.includes('elicitation')) {
   const id = ++requestId;
   const url = prompt.includes('url-elicitation');
   permissions.set(id, () => complete());
   send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: url ? { mode: 'url', message: 'Sign in', url: 'https://example.test/signin', elicitationId: 'e1' } : { mode: 'form', message: 'Choose a flavor', requestedSchema: { type: 'object', properties: { flavor: { type: 'string', enum: ['Vanilla', 'Chocolate'] } }, required: ['flavor'] } } });
   return;
  }
  if (prompt.includes('permission')) return askPermission();
  if (prompt.includes('exit')) return process.exit(3);
  return complete();
 }
 if (message.method === 'turn/steer') { reply(message); return complete(); }
 if (message.method === 'turn/interrupt') { reply(message); return notify('turn/completed', { threadId: sessionId, turn: { id: `turn-${turn}`, status: 'interrupted' } }); }
 if (message.method === 'session/cancel') { if (pendingPrompt) { reply(pendingPrompt, { stopReason: 'cancelled' }); pendingPrompt = undefined; } return; }
 if (message.id) reply(message);
});
