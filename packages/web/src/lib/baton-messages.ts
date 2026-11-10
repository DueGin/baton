/** Only the two baton message wrappers are recognized; all other content stays text. */
export interface AssignmentMessage {
  type: "assignment";
  delegationId: string;
  title: string;
  task: string;
  context?: string;
  acceptance: string[];
  readonly: boolean;
}
export interface DeliveredResult {
  delegationId: string;
  title: string;
  status: string;
  outcome: "success" | "partial" | "failed";
  summary: string;
  resultText?: string;
  artifactsText?: string;
  note?: string;
}
export type BatonMessagePart = { type: "text"; text: string } | AssignmentMessage | { type: "results"; results: DeliveredResult[] };

function decodeAttribute(value: string): string {
  return value.replace(/&(amp|quot|lt|gt|apos);/g, (_, entity: string) => ({ amp: "&", quot: '"', lt: "<", gt: ">", apos: "'" })[entity] ?? "");
}
function attributes(source: string, expected: string[]): Record<string, string> | null {
  const values: Record<string, string> = {};
  const matcher = /\s+([a-z]+)="([^"<\r\n]*)"/gy;
  let position = 0;
  while (position < source.length) {
    matcher.lastIndex = position;
    const match = matcher.exec(source);
    if (!match || !expected.includes(match[1]!) || Object.hasOwn(values, match[1]!)) return null;
    values[match[1]!] = decodeAttribute(match[2]!);
    position = matcher.lastIndex;
  }
  return expected.every(key => Object.hasOwn(values, key) && values[key] !== "") ? values : null;
}

function assignment(attrs: string, body: string): AssignmentMessage | null {
  const values = attributes(attrs, ["delegation"]);
  if (!values) return null;
  const match = /^\s*Title: ([^\n]+)\n\nTask:\n([\s\S]*)$/.exec(body);
  if (!match) return null;
  const finish = "\n\nWhen finished, call report_result once, then end your turn.";
  let content = match[2]!.trimEnd();
  if (!content.endsWith(finish)) return null;
  content = content.slice(0, -finish.length);
  const readonlyText = "\n\nREAD ONLY: do not modify any files. Inspect, analyse and report only.";
  const schemaText = "\n\nYour report_result `result` must match this JSON Schema:\n";
  const schemaAt = content.indexOf(schemaText);
  if (schemaAt >= 0) {
    try { JSON.parse(content.slice(schemaAt + schemaText.length)); } catch { return null; }
    content = content.slice(0, schemaAt);
  }
  const readonly = content.endsWith(readonlyText);
  if (readonly) content = content.slice(0, -readonlyText.length);
  const acceptanceAt = content.indexOf("\n\nAcceptance criteria:\n");
  const acceptance: string[] = [];
  if (acceptanceAt >= 0) {
    const lines = content.slice(acceptanceAt + "\n\nAcceptance criteria:\n".length).split("\n");
    for (const line of lines) {
      if (line.startsWith("- ")) acceptance.push(line.slice(2));
      else if (acceptance.length) acceptance[acceptance.length - 1] += `\n${line}`;
      else return null;
    }
    content = content.slice(0, acceptanceAt);
  }
  const contextAt = content.indexOf("\n\nContext:\n");
  const task = (contextAt < 0 ? content : content.slice(0, contextAt)).trim();
  if (!task) return null;
  return { type: "assignment", delegationId: values.delegation!, title: match[1]!, task, ...(contextAt < 0 ? {} : { context: content.slice(contextAt + "\n\nContext:\n".length).trim() }), acceptance, readonly };
}

function deliveredResult(attrs: string, body: string): DeliveredResult | null {
  const values = attributes(attrs, ["delegation", "status", "outcome", "title"]);
  if (!values || !["success", "partial", "failed"].includes(values.outcome!) || !["queued", "running", "completed", "failed", "canceled", "interrupted"].includes(values.status!)) return null;
  let text = body.trim();
  const noteText = "\n\n(The delegate did not call report_result; the summary is its final message.)";
  let note: string | undefined;
  if (text.endsWith(noteText)) { note = "子节点未调用 report_result，summary 来自最后一条回复。"; text = text.slice(0, -noteText.length); }
  const artifactsAt = text.indexOf("\n\nArtifacts:\n");
  const artifactsText = artifactsAt < 0 ? undefined : text.slice(artifactsAt + "\n\nArtifacts:\n".length);
  if (artifactsAt >= 0) text = text.slice(0, artifactsAt);
  const resultAt = text.indexOf("\n\nResult:\n");
  let resultText = resultAt < 0 ? undefined : text.slice(resultAt + "\n\nResult:\n".length);
  if (resultText) {
    // A server notification may truncate JSON at 8k; retain that text in the disclosure.
    try { resultText = JSON.stringify(JSON.parse(resultText), null, 2); } catch { /* Keep truncated result as escaped text. */ }
  }
  const summary = (resultAt < 0 ? text : text.slice(0, resultAt)).trim();
  if (!summary) return null;
  return { delegationId: values.delegation!, title: values.title!, status: values.status!, outcome: values.outcome as DeliveredResult["outcome"], summary, resultText, artifactsText, note };
}

/** Return null on an incomplete/malformed wrapper so the transcript can show the original. */
export function parseBatonMessage(text: string): BatonMessagePart[] | null {
  const parts: BatonMessagePart[] = [];
  const opener = /<(baton-assignment|baton-results)\b/;
  let rest = text.replace(/\r\n/g, "\n");
  let recognized = false;
  while (rest) {
    const start = opener.exec(rest);
    if (!start) { if (/<\/(?:baton-assignment|baton-results)>/.test(rest)) return null; parts.push({ type: "text", text: rest }); break; }
    if (start.index > 0) parts.push({ type: "text", text: rest.slice(0, start.index) });
    rest = rest.slice(start.index);
    const tag = start[1]!;
    const head = new RegExp(`^<${tag}((?:[^">]|"[^"]*")*)>`).exec(rest);
    const end = rest.indexOf(`</${tag}>`);
    if (!head || end < head[0].length) return null;
    const body = rest.slice(head[0].length, end);
    if (/<\/?(?:baton-assignment|baton-results)\b/.test(body)) return null;
    if (tag === "baton-assignment") {
      const parsed = assignment(head[1]!, body);
      if (!parsed) return null;
      parts.push(parsed);
    } else {
      if (head[1]!.trim()) return null;
      const results: DeliveredResult[] = [];
      let blocks = body.trim();
      while (blocks) {
        const result = /^<result((?:[^">]|"[^"]*")*)>\n?([\s\S]*?)<\/result>/.exec(blocks);
        if (!result || /<\/?result\b/.test(result[2]!)) return null;
        const parsed = deliveredResult(result[1]!, result[2]!);
        if (!parsed) return null;
        results.push(parsed); blocks = blocks.slice(result[0].length).trim();
      }
      if (!results.length) return null;
      parts.push({ type: "results", results });
    }
    recognized = true;
    rest = rest.slice(end + tag.length + 3);
  }
  return recognized ? parts.filter(part => part.type !== "text" || part.text.trim()) : null;
}
