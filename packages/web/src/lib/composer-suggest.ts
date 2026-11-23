import type { AgentCommand, SearchFilesResponse } from "@baton/protocol";
import type { BatonClient, CommandQuery } from "../api.js";
import { moveActive, type SelectOption } from "./listbox.js";

const LIMIT = 50;
const COMMAND_TTL = 60_000;
const FILE_DEBOUNCE = 120;

export interface SuggestionMatch {
  kind: "command" | "file";
  from: number;
  to: number;
  query: string;
}

export function detectSuggestion(beforeCaret: string, firstParagraph: boolean): SuggestionMatch | null {
  const to = beforeCaret.length;
  if (firstParagraph && /^\/[^\s\uFFFC]*$/.test(beforeCaret) && !/\s$/.test(beforeCaret)) {
    return { kind: "command", from: 0, to, query: beforeCaret.slice(1) };
  }
  const quoted = /(?:^|\s)@"((?:[^"\\\r\n\uFFFC]|\\["\\])*)$/.exec(beforeCaret);
  if (quoted) return { kind: "file", from: to - quoted[1]!.length - 2, to, query: quoted[1]!.replace(/\\(["\\])/g, "$1") };
  const file = /(?:^|\s)@([^\s"\uFFFC]*)$/.exec(beforeCaret);
  return file && !/\s$/.test(beforeCaret) ? { kind: "file", from: to - file[1]!.length - 1, to, query: file[1]! } : null;
}

export function rankCommands(commands: readonly AgentCommand[], query: string): AgentCommand[] {
  const needle = query.toLowerCase();
  const groups: AgentCommand[][] = [[], [], []];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    const rank = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : command.description?.toLowerCase().includes(needle) ? 2 : -1;
    if (rank >= 0) groups[rank]!.push(command);
  }
  return groups.flat().slice(0, LIMIT);
}

export function fileInsertion(file: SearchFilesResponse["files"][number]): string {
  const directory = file.kind === "dir";
  const path = directory && !file.path.endsWith("/") ? `${file.path}/` : file.path;
  return /[\s"]/.test(path) ? `@"${path.replace(/["\\]/g, "\\$&")}${directory ? "" : '" '}` : `@${path}${directory ? "" : " "}`;
}

interface CommandCacheEntry { commands?: AgentCommand[]; fetchedAt?: number; pending?: Promise<AgentCommand[]> }
const nodeCommands = new Map<string, CommandCacheEntry>();

function fetchCommands(client: BatonClient, query: CommandQuery, entry: CommandCacheEntry): Promise<AgentCommand[]> {
  return entry.pending ??= Promise.resolve().then(() => client.commands(query)).then(({ commands }) => {
    entry.commands = commands;
    entry.fetchedAt = Date.now();
    return commands;
  }).finally(() => { delete entry.pending; });
}

const commandLabels = { builtin: "命令", command: "命令", skill: "技能", prompt: "提示词" };
export interface SuggestionState {
  match: SuggestionMatch;
  options: SelectOption[];
  active: number;
  loading: boolean;
}
export interface SuggestionSource { client: BatonClient; cwd: string; commandQuery: CommandQuery | null }
type ReplaceSuggestion = (match: SuggestionMatch, text: string) => void;

function sourceKey(source: SuggestionSource, kind: SuggestionMatch["kind"]): string {
  if (kind === "file") return `files:${source.cwd}`;
  const query = source.commandQuery;
  return !query ? "" : "nodeId" in query ? `node:${query.nodeId}` : `agent:${JSON.stringify([query.agentId, query.cwd])}`;
}

export function sameSuggestion(left: SuggestionMatch | null, right: SuggestionMatch | null): boolean {
  return left === right || !!left && !!right && left.kind === right.kind && left.from === right.from && left.to === right.to && left.query === right.query;
}

export class SuggestionSession {
  private state: SuggestionState | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private source = "";
  private client: BatonClient | undefined;
  private dismissed: SuggestionMatch | null = null;
  private commands: AgentCommand[] | undefined;
  private scans = new Map<string, CommandCacheEntry>();

  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private publish(state: SuggestionState | null) {
    if (state === this.state) return;
    this.state = state;
    this.listeners.forEach(listener => listener());
  }

  close = () => {
    this.revision++;
    clearTimeout(this.timer);
    this.commands = undefined;
    this.publish(null);
  };

  dismiss = () => {
    this.dismissed = this.state?.match ?? this.dismissed;
    this.close();
  };

  private showCommands(match: SuggestionMatch) {
    const options = rankCommands(this.commands ?? [], match.query).map(command => ({
      value: `/${command.name} `, label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
      description: command.description, hint: commandLabels[command.kind ?? "command"],
    }));
    this.publish({ match, options, active: options.length ? 0 : -1, loading: !this.commands });
  }

  update(match: SuggestionMatch | null, source: SuggestionSource) {
    const key = match ? sourceKey(source, match.kind) : this.source;
    if (key !== this.source || source.client !== this.client) {
      if (source.client !== this.client) this.scans.clear();
      this.source = key;
      this.client = source.client;
      this.dismissed = null;
      this.close();
    }
    if (!match || (match.kind === "file" && !source.cwd) || (match.kind === "command" && !source.commandQuery)) {
      this.dismissed = null;
      this.close();
      return;
    }
    if (sameSuggestion(this.dismissed, match) || sameSuggestion(this.state?.match ?? null, match)) return;
    this.dismissed = null;
    if (source.commandQuery && match.kind === "command") {
      if (this.state?.match.kind === "command") { this.showCommands(match); return; }
      const entries = "nodeId" in source.commandQuery ? nodeCommands : this.scans;
      const cacheKey = "nodeId" in source.commandQuery ? source.commandQuery.nodeId : key;
      const entry = entries.get(cacheKey) ?? {};
      entries.set(cacheKey, entry);
      this.commands = entry.commands;
      this.showCommands(match);
      if (entry.fetchedAt !== undefined && Date.now() - entry.fetchedAt < COMMAND_TTL) return;
      const revision = ++this.revision;
      void fetchCommands(source.client, source.commandQuery, entry).then(commands => {
        if (revision !== this.revision || !this.state) return;
        this.commands = commands;
        this.showCommands(this.state.match);
      }, () => { if (revision === this.revision) this.dismiss(); });
      return;
    }
    const revision = ++this.revision;
    this.publish({ match, options: [], active: -1, loading: true });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void Promise.resolve().then(() => source.client.searchFiles(source.cwd, match.query)).then(({ files }) => {
        if (revision !== this.revision) return;
        const options = files.slice(0, LIMIT).map(file => ({ value: fileInsertion(file), label: file.path, hint: file.kind === "dir" ? "目录" : "文件" }));
        this.publish({ match, options, active: options.length ? 0 : -1, loading: false });
      }, () => { if (revision === this.revision) this.dismiss(); });
    }, FILE_DEBOUNCE);
  }

  activate(index: number) {
    const state = this.state;
    if (state?.options[index] && state.active !== index) this.publish({ ...state, active: index });
  }

  choose(index: number, replace: ReplaceSuggestion) {
    const state = this.state;
    const option = state?.options[index];
    if (state && option) replace(state.match, option.value);
  }

  keyDown(event: Pick<KeyboardEvent, "key" | "isComposing" | "keyCode">, replace: ReplaceSuggestion): boolean {
    const state = this.state;
    if (!state || event.isComposing || event.keyCode === 229) return false;
    if (event.key === "Escape") this.dismiss();
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") this.activate(moveActive(state.options, state.active, event.key));
    else if (event.key === "Enter" || event.key === "Tab") this.choose(state.active, replace);
    else return false;
    return true;
  }
}
