import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Select, SelectListbox, type SelectOption } from "./Select.js";
import { ReasoningControls } from "./ReasoningControls.js";

const noop = (): undefined => undefined;
const options: SelectOption[] = [{ value: "run", label: "本 Run", description: "只对当前 Run 生效" }, { value: "global", label: "全局", hint: "所有 Run" }, { value: "off", label: "关闭", disabled: true }, { value: "plan", label: "Plan", warning: "不可用", separated: true, depth: 2 }];

describe("shared Select", () => {
  it("renders a combobox trigger showing the chosen option, with the list closed", () => {
    const html = renderToStaticMarkup(<Select label="作用域" value="global" options={options} onChange={noop} />);
    expect(html).toContain('role="combobox"'); expect(html).toContain('aria-label="作用域"'); expect(html).toContain('aria-haspopup="listbox"'); expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<span class="select-value">全局</span>'); expect(html).toContain('title="全局"'); expect(html).not.toContain('role="listbox"'); expect(html).not.toContain("<select");
    expect(html).toContain('type="button"'); expect(html).not.toContain("aria-controls");
    expect(renderToStaticMarkup(<Select label="作用域" value="run" options={options} onChange={noop} />)).toContain('title="本 Run · 只对当前 Run 生效"');
  });
  it("shows the placeholder for no value, the raw value for an unknown one, and disables the trigger", () => {
    expect(renderToStaticMarkup(<Select label="Run" value="" placeholder="选择 Run" options={options} onChange={noop} />)).toContain('<span class="select-value is-placeholder">选择 Run</span>');
    expect(renderToStaticMarkup(<Select label="Run" value="run-old" options={options} onChange={noop} />)).toContain('<span class="select-value">run-old</span>');
    const disabled = renderToStaticMarkup(<Select label="Thinking" value="run" options={options} onChange={noop} disabled />);
    expect(disabled).toMatch(/<button[^>]*disabled=""/);
    const warning = renderToStaticMarkup(<Select label="Mode" value="plan" variant="ghost" className="toolbar-select" options={options} onChange={noop} />);
    expect(warning).toContain('class="select toolbar-select"'); expect(warning).toContain("select-trigger is-ghost is-warning"); expect(warning).toContain('<small class="select-warning">不可用</small>');
  });
  it("renders options with selection, check, descriptions, hints, disabled rows, separators and depth", () => {
    const html = renderToStaticMarkup(<SelectListbox id="scope" label="作用域" options={options} value="global" active={0} />);
    expect(html).toContain('role="listbox"'); expect(html).toContain('aria-label="作用域"'); expect(html.match(/role="option"/g)).toHaveLength(4);
    expect(html).toContain('id="scope-option-0" role="option" aria-selected="false" class="select-option is-active"');
    expect(html).toMatch(/id="scope-option-1" role="option" aria-selected="true"[\s\S]*?所有 Run[\s\S]*?<path d="m5 12 4 4L19 6"/);
    expect(html.match(/m5 12 4 4L19 6/g)).toHaveLength(1);
    expect(html).toContain("<small>只对当前 Run 生效</small>"); expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('class="select-option is-separated is-warning" style="--depth:2"');
    // A separator never opens the list.
    expect(renderToStaticMarkup(<SelectListbox id="x" label="x" options={[options[3]!]} value="" />)).not.toContain("is-separated");
  });
  it("is what the console's former native selects render, keeping their accessible names", () => {
    const reasoning = renderToStaticMarkup(<ReasoningControls rows={[]} />);
    expect(reasoning).not.toContain("<select"); expect(reasoning).toContain('aria-label="思考过程显示"'); expect(reasoning).toContain(">折叠</span>");
    const settings = renderToStaticMarkup(<ReasoningControls settings />);
    expect(settings).toContain('role="combobox"'); expect(settings).toContain("思考过程显示");
  });
});
