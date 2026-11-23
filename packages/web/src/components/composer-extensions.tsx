import { createContext, useContext, useSyncExternalStore } from "react";
import { Extension, InputRule, markInputRule, Node, type AnyExtension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Code } from "@tiptap/extension-code";
import { Placeholder } from "@tiptap/extensions";
import { IMAGE_NODE, RAW_NODE } from "../lib/composer-markdown.js";
import { composerUploads } from "../lib/composer-uploads.js";
import { Icon } from "./common.js";

/** An image's identity in a draft: its upload, or its URL when it arrived as Markdown. Copies share it. */
type ImageAttrs = { readonly key?: unknown; readonly src?: unknown };
export function imageIdentity(attrs: ImageAttrs): string {
  return typeof attrs.key === "string" && attrs.key ? `key:${attrs.key}` : `src:${String(attrs.src ?? "")}`;
}
export type ComposerImageStatus = "uploading" | "ready" | "failed" | "missing";
export function imageStatus(attrs: ImageAttrs): ComposerImageStatus {
  const upload = composerUploads.get(typeof attrs.key === "string" ? attrs.key : null);
  if (upload) return upload.status;
  return typeof attrs.src === "string" && attrs.src ? "ready" : "missing";
}

/** The thumbnail row's order, which numbers each pill ("图片 #2"). */
export const ImageOrderContext = createContext<readonly string[]>([]);

function ImagePill({ node, selected }: NodeViewProps) {
  useSyncExternalStore(composerUploads.subscribe, composerUploads.getVersion, composerUploads.getVersion);
  const attrs = node.attrs as Record<string, unknown>;
  const number = useContext(ImageOrderContext).indexOf(imageIdentity(attrs)) + 1;
  const status = imageStatus(attrs);
  const name = typeof attrs.alt === "string" && attrs.alt ? attrs.alt : "图片";
  const error = composerUploads.get(typeof attrs.key === "string" ? attrs.key : null)?.error;
  const title = status === "uploading" ? `${name} · 上传中…` : status === "failed" ? `${name} · 上传失败${error ? `：${error}` : ""}（点上方缩略图重试）` : status === "missing" ? `${name} · 图片已失效，请移除后重新添加` : name;
  return <NodeViewWrapper as="span" className="composer-image-pill-wrapper">
    <span className={`composer-image-pill is-${status}`} data-selected={selected ? "true" : undefined} title={title} aria-label={`图片 #${number}${status === "ready" ? "" : status === "uploading" ? "（上传中）" : "（上传失败）"}`}>
      {status === "uploading" ? <span className="composer-pill-spinner" aria-hidden="true" /> : <Icon name={status === "ready" ? "image" : "warning"} size={12} />}
      <span>图片 #{number || "?"}</span>
    </span>
  </NodeViewWrapper>;
}

/** An inline image pill. Serialized as `![alt](src)`; `key` links it to an upload in progress. */
export const ComposerImage = Node.create({
  name: IMAGE_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null, parseHTML: element => element.getAttribute("data-src") || null, renderHTML: attributes => attributes.src ? { "data-src": attributes.src } : {} },
      key: { default: null, parseHTML: element => element.getAttribute("data-key") || null, renderHTML: attributes => attributes.key ? { "data-key": attributes.key } : {} },
      alt: { default: "", parseHTML: element => element.getAttribute("data-alt") ?? "", renderHTML: attributes => ({ "data-alt": attributes.alt ?? "" }) },
    };
  },
  parseHTML() { return [{ tag: "span[data-composer-image]" }]; },
  renderHTML({ HTMLAttributes, node }) { return ["span", { ...HTMLAttributes, "data-composer-image": "" }, `[${String(node.attrs.alt || "图片")}]`]; },
  renderText({ node }) { const src = composerUploads.src(node.attrs); return src ? `![${String(node.attrs.alt ?? "")}](${src})` : ""; },
  addNodeView() { return ReactNodeViewRenderer(ImagePill, { as: "span", className: "composer-image-node" }); },
});

/** Markdown the editor has no node for (a pasted table, an HTML block): editable source, sent verbatim. */
export const RawMarkdown = Node.create({
  name: RAW_NODE,
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  parseHTML() { return [{ tag: "pre[data-raw-markdown]", preserveWhitespace: "full" }]; },
  renderHTML() { return ["pre", { "data-raw-markdown": "", class: "composer-raw" }, ["code", 0]]; },
});

/**
 * Emphasis as you type, also right after CJK text: TipTap's own rules need whitespace before `**`,
 * so `请把**结果行**调高` would stay literal. `*` and `~~` may open after anything but the same
 * delimiter or a backslash (as in CommonMark with the CJK-friendly extension the transcript uses);
 * the lookbehind keeps the preceding character out of the replaced range.
 */
export const EMPHASIS_INPUT = {
  bold: /(?<=^|[^*\\])(\*\*(?![\s*])([^*]+?)(?<!\s)\*\*)$/,
  italic: /(?<=^|[^*\\])(\*(?![\s*])([^*]+?)(?<!\s)\*)$/,
  strike: /(?<=^|[^~\\])(~~(?![\s~])([^~]+?)(?<!\s)~~)$/,
};
const CjkEmphasis = Extension.create({
  name: "cjkEmphasis",
  addInputRules() {
    const marks = this.editor.schema.marks;
    return (["bold", "italic", "strike"] as const).flatMap(name => marks[name] ? [markInputRule({ find: EMPHASIS_INPUT[name], type: marks[name] })] : []);
  },
});

/** `- [ ] ` / `- [x] ` turns the bullet list into a task list, as in Typora (TipTap only knows `[ ] ` at a line start). */
const BulletToTask = Extension.create({
  name: "bulletToTask",
  addInputRules() {
    return [new InputRule({
      find: /^\[([ xX])\]\s$/,
      handler: ({ state, range, match }) => {
        const { taskList, taskItem } = state.schema.nodes;
        const $from = state.doc.resolve(range.from);
        if (!taskList || !taskItem || $from.depth < 3 || $from.node(-1).type.name !== "listItem" || $from.node(-2).type.name !== "bulletList" || $from.index(-1) !== 0) return null;
        const { tr } = state;
        const listPos = $from.before(-2); const current = $from.index(-2);
        tr.delete(range.from, range.to);
        const list = tr.doc.nodeAt(listPos); if (!list) return null;
        const items: PMNode[] = [];
        list.forEach((item, _offset, index) => { items.push(taskItem.create({ checked: index === current && match[1]?.toLowerCase() === "x" }, item.content)); });
        tr.replaceWith(listPos, listPos + list.nodeSize, taskList.create(null, items));
        tr.setSelection(TextSelection.create(tr.doc, range.from));
      },
    })];
  },
});

export function composerExtensions(options: { placeholder: () => string }): AnyExtension[] {
  return [
    // Typing right after `code` leaves the code span (TipTap's mark is inclusive by default).
    Code.extend({ inclusive: false }),
    StarterKit.configure({ underline: false, code: false, link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https", HTMLAttributes: { target: null, rel: "noopener noreferrer" } } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    ComposerImage,
    RawMarkdown,
    CjkEmphasis,
    BulletToTask,
    Placeholder.configure({ placeholder: () => options.placeholder(), showOnlyWhenEditable: false }),
  ];
}
