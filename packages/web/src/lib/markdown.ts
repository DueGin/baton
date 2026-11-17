export function safeLink(url: string): string | undefined {
  const trimmed = url.trim();
  return !/[\u0000-\u0020\u007f]/.test(trimmed) && /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : undefined;
}
export interface CodeFence { code: string; language: string; complete: boolean; start: number; end: number }
/** Inspect source fences rather than the recovered Markdown AST: an unfinished fence is valid Markdown too. */
export function codeFences(text: string): CodeFence[] {
  const lines = text.split(/\n/); const result: CodeFence[] = []; let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!; const opening = /^\s*(`{3,}|~{3,})([^\s]*)[^\n]*$/.exec(line);
    if (!opening) { offset += line.length + 1; continue; }
    const start = offset; const marker = opening[1]!; const language = opening[2]!.toLowerCase(); const code: string[] = [];
    offset += line.length + 1; let complete = false;
    while (++index < lines.length) {
      const next = lines[index]!; offset += next.length + 1;
      if (new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(next)) { complete = true; break; }
      code.push(next);
    }
    result.push({ start, end: Math.min(text.length, offset), language, code: code.join("\n"), complete });
  }
  return result;
}
export function diagramReady(complete: boolean, stableForMs: number): boolean { return complete && stableForMs >= 500; }

// Fullwidth / CJK characters never belong to a bare URL in agent prose ("…/create**。").
const CJK = "\\u2E80-\\u2FFF\\u3000-\\u303F\\u3040-\\u30FF\\u3100-\\u31FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF";
const BARE_URL = /(^|[^\w<(\[\]/"'=`])(https?:\/\/[^\s<>]+)/gu;
const URL_END = new RegExp(`(\\*\\*|__|~~|[*_~]+$|[${CJK}])`, "u");

/**
 * GFM autolink literals swallow trailing emphasis markers and CJK punctuation when there is no
 * space after the URL ("可以试 **http://127.0.0.1:25173/create**。" renders as a link ending in
 * "create**。" with a literal "**" in front). Wrap such bare URLs in angle brackets so the URL ends
 * exactly where it should and the surrounding emphasis parses. Code fences and inline code are left
 * untouched.
 */
export function fixBareUrls(text: string): string {
  const fences = codeFences(text);
  let out = "", cursor = 0;
  const prose = (chunk: string): string => chunk.split(/(`+[^`]*`+)/u).map((part, index) => index % 2 === 1 ? part : part.replace(BARE_URL, (match, lead: string, url: string) => {
    const cut = URL_END.exec(url);
    if (!cut || cut.index === 0) return match;
    return `${lead}<${url.slice(0, cut.index)}>${url.slice(cut.index)}`;
  })).join("");
  for (const fence of fences) {
    out += prose(text.slice(cursor, fence.start)) + text.slice(fence.start, fence.end);
    cursor = fence.end;
  }
  return out + prose(text.slice(cursor));
}

interface MdNode { type: string; value?: string; children?: MdNode[] }
/**
 * Raw HTML is never rendered, but agents often write `<br>` (especially inside table cells).
 * Turn exactly that tag into a Markdown line break; every other HTML node stays inert text.
 */
export function remarkBrTags() {
  const walk = (node: MdNode): void => {
    if (!node.children) return;
    node.children = node.children.map(child => child.type === "html" && /^<br\s*\/?>$/iu.test((child.value ?? "").trim()) ? { type: "break" } : child);
    node.children.forEach(walk);
  };
  return (tree: MdNode): void => walk(tree);
}

/** One-line plain text from Markdown, for titles, tooltips and single-line previews. */
export function markdownPlainText(text: string): string {
  return text
    .replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
