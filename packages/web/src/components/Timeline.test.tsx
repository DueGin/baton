import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { idleScenario } from "../demo/idle.js";
import { Timeline } from "./Timeline.js";

describe("session timeline rendering", () => {
  it("renders work stats, broken axes and tool spans without a real-time now line", () => {
    const snapshot = idleScenario(Date.parse("2026-11-10T07:00:00Z"));
    const html = renderToStaticMarkup(<Timeline snapshot={snapshot} inspect={() => undefined} />);
    for (const text of ["工作时长", "8:00", "跨度", "2h 23m", "折叠空闲", "2 段", "平均并行度", "1.72", "空闲 2h 0m", "空闲 15m 0s", "压缩空闲", "真实时间", "跟随最新", "适应", "占比 71.9%", 'data-tool-kind="shell"']) expect(html).toContain(text);
    expect(html.match(/class="timeline-gap"/g)).toHaveLength(2);
    expect(html).not.toContain("NOW"); expect(html).not.toContain("跟随现在");
  });
  it("keeps a hatched pause band visible across the compressed axis and includes resume in the legend", () => {
    const base = Date.parse("2026-11-10T07:00:00Z"); const snapshot = idleScenario(base);
    snapshot.run.pauses = [{ at: new Date(base + 60000).toISOString(), resumedAt: new Date(base + 7380000).toISOString(), by: "human" }];
    const html = renderToStaticMarkup(<Timeline snapshot={snapshot} inspect={() => undefined} />);
    expect(html.match(/data-pause-band="normal"/g)).toHaveLength(2); expect(html.match(/data-pause-band="compressed"/g)).toHaveLength(1);
    expect(html).toContain("已暂停"); expect(html).toContain("resume"); expect(html).toContain('patternTransform="rotate(40)"');
  });
});
