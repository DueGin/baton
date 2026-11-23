import type { JSONContent } from "@tiptap/core";
import type { Root, RootContent, PhrasingContent, ListItem } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import { remarkBrTags } from "./markdown.js";
import { detectSuggestion } from "./composer-suggest.js";

/**
 * Markdown ⇄ composer document. The composer sends Markdown, so this is the editor's wire format.
 *
 * Parsing uses the same remark stack as the transcript (GFM, CJK-friendly emphasis, single newline =
 * line break), so pasted Markdown means in the editor what it will mean once sent. Serializing escapes
 * only when it has to: each text block is first written plainly and re-parsed; only if that would
 * change its meaning is the block written again with backslash escapes. Agents therefore receive
 * `my_module.py`, `a < b && c` and `src/**` as typed, not `my\_module.py` or `a &lt; b`.
 */

/** Inline image atom. `src` is the Markdown URL (`attachment:<id>` once uploaded); `key` names an upload still in flight. */
export const IMAGE_NODE = "composerImage";
/** Markdown the editor has no node for (tables, HTML blocks, footnotes), kept verbatim as an editable source block. */
export const RAW_NODE = "rawMarkdown";

type Mark = NonNullable<JSONContent["marks"]>[number];
type Node = JSONContent;

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkCjkFriendly).use(remarkCjkFriendlyGfmStrikethrough).use(remarkBreaks).use(remarkBrTags);
function parseMarkdown(markdown: string): Root {
  return processor.runSync(processor.parse(markdown)) as Root;
}

export function textareaSuggestion(value: string, caret: number) {
  const match = detectSuggestion(value.slice(0, caret), true);
  if (!match || match.kind === "command") return match;
  type PositionedNode = { type: string; position?: Root["position"]; children?: PositionedNode[] };
  const { from, to } = match;
  function overlapsCode(node: PositionedNode): boolean {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start !== undefined && end !== undefined && (start >= to || end <= from)) return false;
    if (node.type === "code" || node.type === "inlineCode") return true;
    return node.children?.some(overlapsCode) ?? false;
  }
  return parseMarkdown(value).children.some(overlapsCode) ? null : match;
}

// ───────────────────────────── Markdown → document ─────────────────────────────

const paragraph = (): Node => ({ type: "paragraph" });

export function markdownToDoc(markdown: string): Node {
  const text = markdown.replace(/\r\n?/g, "\n");
  const content = toBlocks(parseMarkdown(text).children, text);
  return { type: "doc", content: content.length ? content : [paragraph()] };
}

function source(node: { position?: { start: { offset?: number }; end: { offset?: number } } }, markdown: string): string {
  const start = node.position?.start.offset; const end = node.position?.end.offset;
  return start === undefined || end === undefined ? "" : markdown.slice(start, end);
}
function raw(text: string): Node {
  return text ? { type: RAW_NODE, content: [{ type: "text", text }] } : paragraph();
}
function toBlocks(nodes: RootContent[], markdown: string): Node[] {
  return nodes.flatMap(node => toBlock(node, markdown));
}
function withLeadingParagraph(blocks: Node[]): Node[] {
  return blocks[0]?.type === "paragraph" ? blocks : [paragraph(), ...blocks];
}
function toBlock(node: RootContent, markdown: string): Node[] {
  switch (node.type) {
    case "paragraph": { const content = toInline(node.children, [], markdown); return [content.length ? { type: "paragraph", content } : paragraph()]; }
    case "heading": { const content = toInline(node.children, [], markdown).map(child => child.type === "hardBreak" ? { type: "text", text: " " } : child); return [{ type: "heading", attrs: { level: node.depth }, ...(content.length ? { content } : {}) }]; }
    case "blockquote": { const content = toBlocks(node.children, markdown); return [{ type: "blockquote", content: content.length ? content : [paragraph()] }]; }
    case "list": {
      const task = node.children.some(item => typeof item.checked === "boolean");
      const items = node.children.map((item: ListItem): Node => task
        ? { type: "taskItem", attrs: { checked: item.checked === true }, content: withLeadingParagraph(toBlocks(item.children, markdown)) }
        : { type: "listItem", content: withLeadingParagraph(toBlocks(item.children, markdown)) });
      if (task) return [{ type: "taskList", content: items }];
      return [node.ordered ? { type: "orderedList", attrs: { start: node.start ?? 1 }, content: items } : { type: "bulletList", content: items }];
    }
    case "code": return [{ type: "codeBlock", attrs: { language: node.lang || null }, ...(node.value ? { content: [{ type: "text", text: node.value }] } : {}) }];
    case "thematicBreak": return [{ type: "horizontalRule" }];
    case "html": return [raw(node.value)];
    default: return [raw(source(node, markdown))];
  }
}
/** Adjacent text with the same marks becomes one node (inline HTML and escapes split it while parsing). */
function mergeText(nodes: Node[]): Node[] {
  const out: Node[] = [];
  for (const node of nodes) {
    const last = out.at(-1);
    if (node.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) out[out.length - 1] = { ...last, text: (last.text ?? "") + (node.text ?? "") };
    else out.push(node);
  }
  return out;
}
function toInline(nodes: PhrasingContent[], marks: Mark[], markdown: string): Node[] {
  return mergeText(inlineNodes(nodes, marks, markdown));
}
function inlineNodes(nodes: PhrasingContent[], marks: Mark[], markdown: string): Node[] {
  const text = (value: string, extra: Mark[] = []): Node[] => {
    const all = [...marks, ...extra];
    return value ? [{ type: "text", text: value, ...(all.length ? { marks: all } : {}) }] : [];
  };
  return nodes.flatMap((node): Node[] => {
    switch (node.type) {
      case "text": return text(node.value);
      case "strong": return toInline(node.children, [...marks, { type: "bold" }], markdown);
      case "emphasis": return toInline(node.children, [...marks, { type: "italic" }], markdown);
      case "delete": return toInline(node.children, [...marks, { type: "strike" }], markdown);
      case "inlineCode": return text(node.value, [{ type: "code" }]);
      case "break": return [{ type: "hardBreak" }];
      case "link": return toInline(node.children, [...marks.filter(mark => mark.type !== "link"), { type: "link", attrs: { href: node.url } }], markdown);
      case "image": return [{ type: IMAGE_NODE, attrs: { src: node.url, alt: node.alt ?? "", key: null } }];
      // Raw HTML is never rendered in the transcript; in the editor it is literal text.
      case "html": return text(node.value);
      default: return text(source(node, markdown));
    }
  });
}

// ───────────────────────────── document → Markdown ─────────────────────────────

export interface SerializeOptions {
  /** URL for an image node; null drops it (an upload that has not finished). Defaults to `attrs.src`. */
  imageSrc?: (attrs: Record<string, unknown>) => string | null;
}

export function docToMarkdown(doc: Node, options: SerializeOptions = {}): string {
  const resolve = options.imageSrc ?? (attrs => typeof attrs.src === "string" && attrs.src ? attrs.src : null);
  return serializeBlocks(resolveImages(doc.content ?? [], resolve), false).replace(/^\n+|\s+$/g, "");
}

function resolveImages(nodes: Node[], resolve: (attrs: Record<string, unknown>) => string | null): Node[] {
  return nodes.flatMap(node => {
    if (node.type === IMAGE_NODE) {
      const src = resolve(node.attrs ?? {});
      return src ? [{ type: IMAGE_NODE, attrs: { src, alt: typeof node.attrs?.alt === "string" ? node.attrs.alt : "" } }] : [];
    }
    return node.content ? [{ ...node, content: resolveImages(node.content, resolve) }] : [node];
  });
}

const LISTS = new Set(["bulletList", "orderedList", "taskList"]);
/** Blocks are separated by a blank line; inside a list item a nested list follows directly so the list stays tight. */
function serializeBlocks(nodes: Node[], inItem: boolean): string {
  let out = "";
  for (const node of nodes) {
    const text = serializeBlock(node);
    if (text === null) continue;
    out += out ? (inItem && LISTS.has(node.type ?? "") ? "\n" : "\n\n") + text : text;
  }
  return out;
}
function prefixLines(text: string, first: string, rest: string): string {
  return text.split("\n").map((line, index) => index === 0 ? first + line : line ? rest + line : "").join("\n");
}
function serializeBlock(node: Node): string | null {
  const children = node.content ?? [];
  switch (node.type) {
    case "paragraph": { const text = serializeTextblock(children, ""); return text.trim() ? text : null; }
    case "heading": { const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)); const prefix = `${"#".repeat(level)} `; const text = serializeTextblock(children.map(child => child.type === "hardBreak" ? { type: "text", text: " " } : child), prefix); return text.trim() ? prefix + text : null; }
    case "blockquote": { const text = serializeBlocks(children, false); return text ? text.split("\n").map(line => line ? `> ${line}` : ">").join("\n") : null; }
    case "bulletList": return children.map(item => listItem(item, "- ", 2)).join("\n");
    case "orderedList": { const start = Number(node.attrs?.start ?? 1) || 0; return children.map((item, index) => { const marker = `${start + index}. `; return listItem(item, marker, marker.length); }).join("\n"); }
    case "taskList": return children.map(item => listItem(item, `- [${item.attrs?.checked ? "x" : " "}] `, 2)).join("\n");
    case "codeBlock": {
      const code = children.map(child => child.text ?? "").join("");
      const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map(match => match[0].length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      const language = typeof node.attrs?.language === "string" ? node.attrs.language.replace(/[`\s]/g, "") : "";
      return `${fence}${language}\n${code}${code ? "\n" : ""}${fence}`;
    }
    case "horizontalRule": return "---";
    case RAW_NODE: { const text = children.map(child => child.text ?? "").join(""); return text.trim() ? text : null; }
    default: return children.length ? serializeBlocks(children, false) : null;
  }
}
function listItem(item: Node, marker: string, indent: number): string {
  return prefixLines(serializeBlocks(item.content ?? [], true), marker, " ".repeat(indent)).replace(/\s+$/, "");
}

/**
 * A paragraph or heading: plain if re-parsing reproduces it, escaped otherwise. Re-parsing to a block
 * the editor keeps as raw Markdown (a table typed by hand) counts as intended.
 */
function serializeTextblock(nodes: Node[], prefix: string): string {
  const content = trimBreaks(nodes);
  const plain = serializeInline(content, NO_ESCAPES);
  if (!/[\\`*_[\]~|<>&#+=\-!.)]/.test(plain) || roundTrips(prefix + plain, content)) return plain;
  // Escape everything, then drop each kind of escape the block does not need.
  let enabled = new Set(ESCAPES); let best = serializeInline(content, enabled);
  if (!roundTrips(prefix + best, content)) return best;
  for (const kind of ESCAPES) {
    const trial = new Set(enabled); trial.delete(kind);
    const candidate = serializeInline(content, trial);
    if (roundTrips(prefix + candidate, content)) { enabled = trial; best = candidate; }
  }
  return best;
}
function trimBreaks(nodes: Node[]): Node[] {
  let end = nodes.length;
  while (end > 0 && nodes[end - 1]!.type === "hardBreak") end--;
  return nodes.slice(0, end);
}
function roundTrips(markdown: string, content: Node[]): boolean {
  const blocks = markdownToDoc(markdown).content ?? [];
  if (blocks.some(block => block.type === RAW_NODE)) return true;
  if (blocks.length !== 1 || !["paragraph", "heading"].includes(blocks[0]!.type ?? "")) return false;
  const parsed = blocks[0]!.content ?? [];
  if (sameInline(parsed, content)) return true;
  const last = content.at(-1);
  if (!/[\t ]$/.test(markdown) || last?.type !== "text" || last.marks?.length || !last.text) return false;
  return sameInline(parsed, [...content.slice(0, -1), { ...last, text: last.text.replace(/[\t ]+$/, "") }]);
}

/** Inline nodes compared by meaning: adjacent text merged, mark order ignored, an autolink equal to plain text. */
export function normalizeInline(nodes: Node[]): string {
  const out: { type: string; text?: string; marks?: string; attrs?: string }[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const text = node.text ?? ""; if (!text) continue;
      const marks = (node.marks ?? []).filter(mark => !(mark.type === "link" && mark.attrs?.href === text)).map(mark => mark.type === "link" ? `link:${String(mark.attrs?.href)}` : mark.type).sort().join(",");
      const last = out.at(-1);
      if (last?.type === "text" && last.marks === marks) last.text += text; else out.push({ type: "text", text, marks });
    } else out.push({ type: node.type ?? "", attrs: node.type === IMAGE_NODE ? `${String(node.attrs?.src)}|${String(node.attrs?.alt ?? "")}` : undefined });
  }
  return JSON.stringify(out);
}
function sameInline(a: Node[], b: Node[]): boolean { return normalizeInline(a) === normalizeInline(b); }

const MARK_ORDER = ["link", "bold", "italic", "strike"];
const DELIMITER: Record<string, string> = { bold: "**", italic: "*", strike: "~~" };
const sameMark = (a: Mark, b: Mark) => a.type === b.type && (a.type !== "link" || a.attrs?.href === b.attrs?.href);

function linkDestination(href: string): string {
  return /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href;
}
function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const ticks = "`".repeat(longest + 1);
  const pad = /^[`\s]|[`\s]$/.test(text) && text.trim() ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}
const ESCAPES = ["backslash", "code", "star", "underscore", "bracket", "tilde", "pipe", "angle", "entity", "block"] as const;
type Escape = typeof ESCAPES[number];
const NO_ESCAPES: ReadonlySet<Escape> = new Set();
const ESCAPE_PATTERNS: [Escape, RegExp][] = [["code", /`/g], ["star", /\*/g], ["underscore", /_/g], ["bracket", /[[\]]/g], ["tilde", /~/g], ["pipe", /\|/g], ["angle", /<(?=[A-Za-z/!?])/g], ["entity", /&(?=#?\w+;)/g]];
/** Backslash-escape what could start Markdown syntax; `lineStart` also covers block markers. */
export function escapeText(text: string, lineStart: boolean, enabled: ReadonlySet<Escape> = new Set(ESCAPES)): string {
  let out = enabled.has("backslash") ? text.replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\") : text;
  for (const [kind, pattern] of ESCAPE_PATTERNS) if (enabled.has(kind)) out = out.replace(pattern, "\\$&");
  if (lineStart && enabled.has("block")) out = out.replace(/^(#{1,6}(?=\s|$)|>|[-+](?=\s|$)|[=-]+\s*$)/, "\\$1").replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2");
  return out;
}

function serializeInline(nodes: Node[], escapes: ReadonlySet<Escape>): string {
  let out = ""; let pending = ""; let lineStart = true;
  const open: Mark[] = [];
  const emit = (text: string) => { out += (lineStart ? "" : pending) + text; pending = ""; };
  const closeFrom = (index: number) => {
    for (let at = open.length - 1; at >= index; at--) {
      const mark = open[at]!;
      out += mark.type === "link" ? (mark.attrs?.bare ? "" : `](${linkDestination(String(mark.attrs?.href ?? ""))})`) : DELIMITER[mark.type] ?? "";
    }
    open.length = index;
  };
  nodes.forEach((node, index) => {
    // A line break ends every mark (they reopen on the next line) and drops whitespace around it.
    if (node.type === "hardBreak") { closeFrom(0); pending = ""; out += "\n"; lineStart = true; return; }
    if (node.type === IMAGE_NODE) {
      const alt = String(node.attrs?.alt ?? "").replace(/[\\[\]]/g, "\\$&");
      closeFrom(0); emit(`![${alt}](${linkDestination(String(node.attrs?.src ?? ""))})`); lineStart = false; return;
    }
    if (node.type !== "text" || !node.text) return;
    const marks = (node.marks ?? []).filter(mark => mark.type !== "code" && mark.type in { link: 1, ...DELIMITER });
    const code = (node.marks ?? []).some(mark => mark.type === "code");
    // Whitespace moves outside emphasis delimiters ("**bold** next"), which Markdown requires.
    const match = code ? null : /^(\s*)([\s\S]*?)(\s*)$/.exec(node.text);
    const lead = match?.[1] ?? ""; const core = match ? match[2] ?? "" : node.text; const trail = match?.[3] ?? "";
    if (!core) { pending += node.text; return; }
    // Close every open mark this node lacks (and those opened after it), before pending whitespace.
    const keep = open.findIndex(mark => !marks.some(other => sameMark(other, mark)));
    if (keep !== -1) closeFrom(keep);
    // Leading whitespace on a line means nothing in Markdown (four spaces would even start a code block).
    out += lineStart ? "" : pending + lead; pending = "";
    for (const mark of [...marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type))) {
      if (open.some(other => sameMark(other, mark))) continue;
      if (mark.type === "link") {
        // A link whose only text is its own URL is written bare (GFM autolinks it).
        const href = String(mark.attrs?.href ?? "");
        const span = nodes.slice(index).findIndex(next => !(next.marks ?? []).some(other => sameMark(other, mark)));
        const linked = nodes.slice(index, span === -1 ? undefined : index + span);
        const bare = /^https?:\/\/\S+$/i.test(href) && linked.length === 1 && node.text === href && marks.length === 1 && !code;
        open.push({ type: "link", attrs: { href, bare } }); if (!bare) out += "[";
      } else { open.push(mark); out += DELIMITER[mark.type]; }
    }
    const linkBare = open.some(mark => mark.type === "link" && mark.attrs?.bare);
    out += code ? codeSpan(core) : escapes.size && !linkBare ? escapeText(core, lineStart, escapes) : core;
    lineStart = false;
    pending = trail;
  });
  closeFrom(0);
  return out + pending;
}

// ───────────────────────────── queries ─────────────────────────────

/** True when the document would send nothing (whitespace only, no image). */
export function docIsEmpty(doc: Node): boolean {
  const walk = (node: Node): boolean => node.type === IMAGE_NODE || node.type === "horizontalRule" || (node.type === "text" && Boolean(node.text?.trim())) || (node.content ?? []).some(walk);
  return !walk(doc);
}

// ───────────────────────────── pasted text ─────────────────────────────

/**
 * How plain text pasted into the composer is read. Markdown (agent output, notes) becomes formatted
 * content like in Typora; code and logs with indented lines become a code block so their whitespace
 * and `__dunder__`/`# comment` syntax survive; anything else is literal text.
 */
export function pasteKind(text: string): "markdown" | "code" | "text" {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const lines = normalized.split("\n");
  if (/^ {0,3}(```|~~~)/m.test(normalized)) return "markdown";
  if (lines.length > 1 && lines.some(line => /^[ \t]+\S/.test(line) && !/^\s+([-*+]|\d{1,9}[.)])\s/.test(line))) return "code";
  if (/^ {0,3}(#{1,6}\s|>|[-*+]\s+\S|\d{1,9}[.)]\s+\S|(-{3,}|\*{3,})\s*$|\|.*\|\s*$)/m.test(normalized)) return "markdown";
  if (/\*\*\S[^\n]*?\*\*|`[^`\n]+`|~~\S[^\n]*?~~|!?\[[^\]\n]+\]\([^)\s]+\)|(^|\s)\*\S[^*\n]*?\*(?=[\s,.!?;:，。！？；：]|$)/.test(normalized)) return "markdown";
  return "text";
}

function textLines(text: string): Node[] {
  return text.split("\n").flatMap((line, index): Node[] => [...(index ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])]);
}
/** Literal text: blank lines separate paragraphs, single newlines are line breaks. */
export function plainTextDoc(text: string): Node {
  const blocks = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "").split(/\n{2,}/);
  return { type: "doc", content: blocks.map(block => { const content = textLines(block); return content.length ? { type: "paragraph", content } : paragraph(); }) };
}
function codeDoc(text: string, language: string | null): Node {
  const code = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return { type: "doc", content: [{ type: "codeBlock", attrs: { language }, ...(code ? { content: [{ type: "text", text: code }] } : {}) }] };
}

/**
 * The document for pasted text. `plain` (Shift+⌘V) keeps it literal; `language` is the source
 * editor's mode when it reports one (VS Code): Markdown is parsed, other code becomes a code block.
 */
export function pastedTextDoc(text: string, options: { plain?: boolean; language?: string | null } = {}): Node {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (options.plain) return plainTextDoc(normalized);
  const language = options.language?.toLowerCase();
  if (language === "markdown") return markdownToDoc(normalized);
  if (language && language !== "plaintext") return normalized.trim().includes("\n") ? codeDoc(normalized, language) : plainTextDoc(normalized);
  const kind = pasteKind(normalized);
  return kind === "markdown" ? markdownToDoc(normalized) : kind === "code" ? codeDoc(normalized, null) : plainTextDoc(normalized);
}
