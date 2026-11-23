import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSlashCommand } from "../../agent-sdk-types.js";
import { record, text } from "../../session.js";
import { COMMAND_TIMEOUT_MS, commandDeadline, normalizeCommands, readCommandMarkdown, scanCommandDirectory } from "../slash-commands.js";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./app-server-transport.js";

type Skill = { name: string; path: string; description?: string; argumentHint?: string; native: boolean };
type CodexTextOrSkill = { type: "text"; text: string } | { type: "skill"; name: string; path: string };

export class CodexSlashCommands {
    private readonly home: string;
    private readonly config: string;

    constructor(private readonly cwd: string, env: NodeJS.ProcessEnv, private readonly client?: CodexAppServerClient, private readonly timeoutMs = COMMAND_TIMEOUT_MS) {
        this.home = env.HOME || env.USERPROFILE || homedir();
        this.config = resolve(cwd, env.CODEX_HOME || join(this.home, ".codex"));
    }

    private async diskSkills(): Promise<Skill[]> {
        const dirs = [join(this.cwd, ".agents"), join(this.cwd, ".codex"), join(this.home, ".agents"), this.config];
        const lists = await Promise.all(dirs.map(dir => commandDeadline(() => scanCommandDirectory(join(dir, "skills"), "skill"), [])));
        return lists.flat().map(({ command, path }) => ({ ...command, path, native: false }));
    }

    private async skills(): Promise<Skill[]> {
        if (!this.client) return this.diskSkills();
        try {
            const result = record(await this.client.request("skills/list", { cwds: [this.cwd] }, this.timeoutMs));
            if (!Array.isArray(result.data)) return [];
            return result.data.map(record).flatMap(entry => Array.isArray(entry.skills) ? entry.skills.map(record).flatMap(skill => {
                const name = text(skill.name).trim().replace(/^\/+/, "");
                const path = text(skill.path);
                return name && path && skill.enabled !== false ? [{ name, path, description: text(skill.description), native: true }] : [];
            }) : []);
        } catch (error) {
            if (error instanceof CodexAppServerRpcError && error.code === -32601)
                return this.diskSkills();
            return [];
        }
    }

    async list(): Promise<AgentSlashCommand[]> {
        const [skills, prompts] = await Promise.all([
            commandDeadline(() => this.skills(), []),
            commandDeadline(() => scanCommandDirectory(join(this.config, "prompts"), "prompt", "prompts:"), []),
        ]);
        return normalizeCommands([
            ...skills.sort((left, right) => left.name.localeCompare(right.name)).map(({ name, description, argumentHint }): AgentSlashCommand => ({ name, description, argumentHint, kind: "skill" })),
            ...prompts.map(entry => entry.command),
        ]);
    }

    async expand(input: string): Promise<CodexTextOrSkill[]> {
        const invocation = /^\/([^\s/\\]+)(?:\s+([\s\S]*))?$/.exec(input);
        const name = invocation?.[1];
        if (name?.startsWith("prompts:")) {
            const prompt = await commandDeadline(() => readCommandMarkdown(join(this.config, "prompts", `${name.slice("prompts:".length)}.md`)), null);
            if (prompt) return [{ type: "text", text: expandPrompt(prompt.body, invocation?.[2] ?? "") }];
        } else if (name) {
            const skills = await commandDeadline(() => this.skills(), []);
            const skill = skills.find(entry => entry.name === name);
            if (skill) {
                const args = invocation?.[2] ?? "";
                if (skill.native) return [{ type: "skill", name, path: skill.path }, ...(args ? [{ type: "text" as const, text: args }] : [])];
                return [{ type: "text", text: `Use the ${name} skill. Read its instructions from ${skill.path}.${args ? `\n\n${args}` : ""}` }];
            }
        }
        return [{ type: "text", text: input }];
    }
}

function expandPrompt(body: string, args: string): string {
    const words = (args.match(/(?:[^\s'"\\]+|\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"|'[^']*')+/g) ?? [])
        .map(word => word.replace(/"((?:[^"\\]|\\[\s\S])*)"|'([^']*)'|\\([\s\S])/g, (_match, double: string | undefined, single: string | undefined, escaped: string | undefined) =>
            double?.replace(/\\(["\\$`])/g, "$1") ?? single ?? escaped ?? ""));
    return body.replace(/\$\$|\$ARGUMENTS\b|\$[1-9](?!\d)/g, placeholder => {
        if (placeholder === "$$") return "$";
        if (placeholder === "$ARGUMENTS") return words.join(" ");
        return words[Number(placeholder.slice(1)) - 1] ?? "";
    });
}
