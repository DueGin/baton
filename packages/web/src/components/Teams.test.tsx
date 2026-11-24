import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoClient } from "../demo/client.js";
import { demoAgents } from "../demo/scenario.js";
import { pendingProposals } from "../lib/teams.js";
import { NewSession } from "./NewRun.js";
import { CandidatesEditor } from "./TeamForms.js";
import { ProposalCard } from "./TeamProposal.js";
import { PresetEditor, RosterStrip, RunTeam, TeamsPage } from "./Teams.js";

const noop = (): undefined => undefined;
afterEach(() => { vi.unstubAllGlobals(); });

describe("team views", () => {
  it("renders an actionable approval roster, rationale and lead attribution safely", async () => {
    const client = new DemoClient(() => Date.parse("2026-11-10T07:00:00Z"));
    const run = (await client.runs()).find(entry => entry.title.startsWith("待确认团队"))!;
    const snapshot = await client.run(run.id); const proposal = pendingProposals(snapshot.run.team)[0]!;
    const html = renderToStaticMarkup(<ProposalCard proposal={{ ...proposal, rationale: '<img src=x onerror="bad()">' }} snapshot={snapshot} agents={demoAgents} approve={() => undefined} reject={() => undefined} busy={false} error={null} />);
    expect(html).toContain("确认团队名单"); expect(html).toContain("批准后开工"); expect(html).toContain("主导者"); expect(html).toContain("提案角色 1"); expect(html).toContain("批准"); expect(html).not.toContain("<img");
    expect(snapshot.nodes).toHaveLength(1);
    expect(html).toContain("2 个任务等待名单确认");
    expect(html).toContain("批准后创建节点");
    for (const edge of snapshot.delegations) expect(html).toContain(edge.brief.title);
  });
  it("renders replaced and active slots, delegation status counts and rationale", async () => {
    const client = new DemoClient(() => Date.parse("2026-11-10T07:00:00Z")); const snapshot = await client.run("run-demo");
    const html = renderToStaticMarkup(<RunTeam snapshot={snapshot} add={() => undefined} replace={() => undefined} remove={() => undefined} save={() => undefined} busy={false} inspect={() => undefined} />);
    expect(html).toContain("主导者的组队理由"); expect(html).toContain("已替换"); expect(html).toContain("member-replaced"); expect(html).toContain("换人"); expect(html).toContain("另存为预设");
    // Member ids are shortened with a copy button; the table has fixed columns so 操作 never wraps.
    const member = snapshot.run.team!.members[0]!;
    expect(html).toContain(`<code title="${member.id}">${member.id.slice(0, 8)}…</code>`); expect(html).toContain('aria-label="复制成员 ID"');
    expect(html).not.toContain(`<span class="muted mono">${member.id}</span>`); expect(html).toContain('<col class="col-actions"/>'); expect(html).toContain(`aria-label="查看 ${member.role} 的完整职责与理由"`); expect(html).toContain('class="duty-preview"');
  });
});

describe("preset candidates in the console", () => {
  it("edits candidates in their own section: agent, model, thinking and an optional description, no role or mode", async () => {
    const client = new DemoClient(() => Date.parse("2026-11-10T07:00:00Z")); const preset = (await client.teams()).find(entry => entry.id === "preset-product")!;
    const html = renderToStaticMarkup(<PresetEditor initial={preset} agents={demoAgents} close={noop} save={async () => undefined} busy={false} error={null} />);
    expect(html.indexOf("固定角色")).toBeGreaterThan(-1); expect(html.indexOf("候选成员")).toBeGreaterThan(html.indexOf("固定角色"));
    expect(html).toContain("有候选时固定角色可以留空"); expect(html).toContain("添加候选");
    const rows = html.split("candidate-editor-row").slice(1);
    expect(rows).toHaveLength(3);
    for (const row of rows) { expect(row).toContain('aria-label="Agent"'); expect(row).toContain('aria-label="Model"'); expect(row).toContain('aria-label="Thinking"'); expect(row).toContain("描述（可选）"); expect(row).not.toContain('aria-label="Mode"'); expect(row).not.toContain("角色"); }
    expect(rows[0]).toContain("候选 1"); expect(rows[0]).toContain('title="GPT-5.3 Codex · gpt-5.3-codex"'); expect(rows[0]).toContain('value="前端、CSS 动画与交互细节"');
    const blank = renderToStaticMarkup(<CandidatesEditor agents={demoAgents} candidates={[]} onChange={noop} />);
    expect(blank).not.toContain("candidate-editor-row"); expect(blank).toContain("添加候选");
  });
  it("shows candidate counts and rows on preset cards", async () => {
    const client = new DemoClient(() => Date.parse("2026-11-10T07:00:00Z"));
    const html = renderToStaticMarkup(<TeamsPage presets={await client.teams()} agents={demoAgents} save={async () => true} remove={async () => true} busy={false} error={null} />);
    expect(html).toContain("2 roles · 3 候选"); expect(html).toContain("0 roles · 3 候选");
    expect(html).toContain("codex · gpt-5.3-codex · high"); expect(html).toContain("便宜快速，适合跑测试");
  });
  it("shows the run's candidates, who was hired from each, and the hired role's origin", async () => {
    const client = new DemoClient(() => Date.parse("2026-11-10T07:00:00Z"));
    const run = (await client.runs()).find(entry => entry.title.startsWith("候选成员"))!; const snapshot = await client.run(run.id);
    const html = renderToStaticMarkup(<RunTeam snapshot={snapshot} add={noop} replace={noop} remove={noop} save={noop} busy={false} inspect={noop} />);
    expect(html).toContain("候选成员"); expect(html).toContain("主导者按任务、模型和描述自主招入");
    expect(html).toContain("已招入 1 次"); expect(html).toContain("尚未招入"); expect(html).toContain("候选 c1");
    expect(html).toContain("架构评审、迁移方案与长文档"); expect(html.match(/candidate-card"/g)).toHaveLength(3);
    const strip = renderToStaticMarkup(<RosterStrip snapshot={snapshot} open={noop} />);
    expect(strip).toContain("候选 3"); expect(strip).toContain("从候选 c1 招入"); expect(strip).toContain("motion");
    const plain = await client.run("run-demo");
    expect(renderToStaticMarkup(<RunTeam snapshot={plain} add={noop} replace={noop} remove={noop} save={noop} busy={false} inspect={noop} />)).not.toContain("候选");
    expect(renderToStaticMarkup(<RosterStrip snapshot={plain} open={noop} />)).not.toContain("候选");
  });
  it("previews a preset's candidates when creating a run", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: noop });
    const client = new DemoClient(() => Date.parse("2026-11-10T07:00:00Z"));
    const props = { agents: demoAgents, presets: await client.teams(), create: async () => true, busy: false, client, error: null, projects: await client.projects(), projectId: "project-atlas", selectProject: noop, addProject: noop };
    const defaults = { maxDepth: 3, maxActiveChildren: 6, autoApprove: false };
    const html = renderToStaticMarkup(<NewSession {...props} defaults={{ ...defaults, mode: "preset" }} />);
    expect(html).toContain("产品交付小队 · 2 roles · 3 候选"); expect(html).toContain("候选成员 · 主导者按任务自主招入");
    expect(html).toContain("claude · claude-sonnet-4-6 · high"); expect(html).toContain("前端、CSS 动画与交互细节");
    expect(html).toContain("在预设的候选之外再加几个");
    const dynamic = renderToStaticMarkup(<NewSession {...props} defaults={{ ...defaults, mode: "dynamic" }} />);
    expect(dynamic).toContain("new-run-candidates"); expect(dynamic).toContain("不用填角色，"); expect(dynamic).toContain("预先指定成员");
    const solo = renderToStaticMarkup(<NewSession {...props} defaults={{ ...defaults, mode: "solo" }} />);
    expect(solo).not.toContain("new-run-candidates");
  });
  it("demo: New Run candidates become the dynamic run's candidate pool", async () => {
    const client = new DemoClient(() => Date.parse("2026-11-10T07:00:00Z"));
    const run = await client.createRun({ projectId: "project-atlas", agent: "claude", prompt: "做个登录页", policy: { mode: "dynamic", teamApproval: true }, candidates: [{ agentId: "codex", model: "gpt-5.3-codex", description: "前端" }] });
    expect(run.run.team?.candidates).toEqual([{ id: "c1", agentId: "codex", model: "gpt-5.3-codex", description: "前端" }]);
  });
});
