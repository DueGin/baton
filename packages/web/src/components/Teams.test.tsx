import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoClient } from "../demo/client.js";
import { demoAgents } from "../demo/scenario.js";
import { pendingProposals } from "../lib/teams.js";
import { ProposalCard } from "./TeamProposal.js";
import { RunTeam } from "./Teams.js";

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
  });
});
