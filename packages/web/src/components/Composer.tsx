import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import { Slice, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { BatonClient } from "../api.js";
import { docIsEmpty, docToMarkdown, IMAGE_NODE, pastedTextDoc } from "../lib/composer-markdown.js";
import { acceptImages, attachmentName, composerUploads } from "../lib/composer-uploads.js";
import { IMAGE_ACCEPT, imageSource, useImageContext, useImageUrl } from "../lib/images.js";
import { composerExtensions, imageIdentity, ImageOrderContext, imageStatus, type ComposerImageStatus } from "./composer-extensions.js";
import { ImageLightbox } from "./Images.js";
import { Icon } from "./common.js";

export interface ComposerHandle {
  /** Send the draft (unless images are still uploading or failed). */
  submit(): void;
  /** Add images at the caret (gated on the agent's image capability). */
  attach(files: File[]): void;
  focus(): void;
}
export interface ComposerStatus { empty: boolean; uploading: boolean; failed: boolean; hint?: string }

/** Unsent drafts per node, kept while the page lives (switching nodes or views keeps them). */
const drafts = new Map<string, JSONContent>();

interface DraftImage { identity: string; key: string | null; src: string | null; alt: string }
function draftImages(doc: JSONContent | undefined): DraftImage[] {
  const seen = new Map<string, DraftImage>();
  const walk = (node: JSONContent) => {
    if (node.type === IMAGE_NODE) {
      const attrs = node.attrs ?? {}; const identity = imageIdentity(attrs);
      if (!seen.has(identity)) seen.set(identity, { identity, key: typeof attrs.key === "string" ? attrs.key : null, src: typeof attrs.src === "string" ? attrs.src : null, alt: typeof attrs.alt === "string" ? attrs.alt : "" });
    }
    node.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return [...seen.values()];
}

function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter(file => file.type.startsWith("image/"));
}
/** A slice that merges into the paragraph around the caret when its edges are paragraphs. */
function sliceFor(schema: Schema, json: JSONContent): Slice {
  const doc = schema.nodeFromJSON(json);
  const open = (node: PMNode | null) => node?.type.name === "paragraph" ? 1 : 0;
  return new Slice(doc.content, open(doc.firstChild), open(doc.lastChild));
}
/** Selection → Markdown for text/plain, except text inside one code block, which copies as itself. */
function clipboardMarkdown(slice: Slice): string {
  const content = slice.content;
  if (content.childCount === 1 && content.firstChild!.type.spec.code && slice.openStart > 0) return content.firstChild!.textContent;
  const json = content.toJSON() as JSONContent[] | null ?? [];
  const blocks = json.length && json[0]!.type && content.firstChild!.isInline ? [{ type: "paragraph", content: json }] : json;
  return docToMarkdown({ type: "doc", content: blocks }, { imageSrc: attrs => composerUploads.src(attrs) });
}
/** Drop buttons and code-block chrome when HTML is copied from the transcript. */
function cleanPastedHTML(html: string): string {
  if (!/<button|code-language|<script|<style/i.test(html) || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("button, .code-language, script, style").forEach(element => element.remove());
  return doc.body.innerHTML;
}

export function Composer({ ref, nodeId, client, placeholder, disabled, imagesEnabled, onSend, onStatus }: {
  ref?: Ref<ComposerHandle>; nodeId: string; client: BatonClient; placeholder: string; disabled: boolean; imagesEnabled: boolean;
  onSend: (markdown: string) => void; onStatus: (status: ComposerStatus) => void;
}) {
  const props = useRef({ client, placeholder, disabled, imagesEnabled, onSend });
  props.current = { client, placeholder, disabled, imagesEnabled, onSend };
  const [doc, setDoc] = useState<JSONContent | undefined>(() => drafts.get(nodeId));
  const [hint, setHint] = useState<{ text: string; serial: number } | null>(null);
  const flash = (text: string) => setHint(previous => ({ text, serial: (previous?.serial ?? 0) + 1 }));
  useEffect(() => { if (!hint) return; const timer = setTimeout(() => setHint(null), 3200); return () => clearTimeout(timer); }, [hint]);
  useSyncExternalStore(composerUploads.subscribe, composerUploads.getVersion, composerUploads.getVersion);
  const images = useMemo(() => draftImages(doc), [doc]);
  const order = useMemo(() => images.map(image => image.identity), [images]);
  const statuses = images.map(image => imageStatus(image));
  const status: ComposerStatus = { empty: !doc || docIsEmpty(doc), uploading: statuses.includes("uploading"), failed: statuses.some(entry => entry === "failed" || entry === "missing"), ...(hint ? { hint: hint.text } : {}) };
  const reported = useRef("");
  useLayoutEffect(() => {
    const key = JSON.stringify(status);
    if (key !== reported.current) { reported.current = key; onStatus(status); }
  });

  // Paste/drop handlers are created once; they reach the current editor and props through refs.
  const actions = useRef({ submit: () => undefined as void, attach: (_files: File[], _at?: number) => undefined as void });
  const shiftHeld = useRef(false);
  const options = useMemo(() => ({
    immediatelyRender: typeof window !== "undefined",
    shouldRerenderOnTransaction: false,
    enablePasteRules: ["link"],
    extensions: composerExtensions({ placeholder: () => props.current.placeholder, submit: () => actions.current.submit() }),
    content: drafts.get(nodeId) ?? "",
    editable: !disabled,
    editorProps: {
      attributes: () => ({ class: "composer-editor", role: "textbox", "aria-multiline": "true", "aria-label": "消息", "aria-placeholder": props.current.placeholder, ...(props.current.disabled ? { "aria-disabled": "true" } : {}) }),
      handleDOMEvents: { keydown: (_view: unknown, event: KeyboardEvent) => { shiftHeld.current = event.shiftKey; return false; } },
      handlePaste: (view: Editor["view"], event: ClipboardEvent) => {
        const data = event.clipboardData; if (!data) return false;
        const files = imageFiles(data.files); const text = data.getData("text/plain");
        if (files.length && (!text.trim() || (files.length === 1 && text.trim() === files[0]!.name))) { event.preventDefault(); actions.current.attach(files); return true; }
        if (view.state.selection.$from.parent.type.spec.code || !text) return false;
        // VS Code says what it copied: Markdown is parsed, code in another language becomes a code block.
        const vscode = data.getData("vscode-editor-data");
        if (!vscode) return false;
        let language: string | null = null;
        try { const parsed: unknown = JSON.parse(vscode); if (parsed && typeof parsed === "object" && "mode" in parsed && typeof parsed.mode === "string") language = parsed.mode; } catch { /* not JSON */ }
        view.dispatch(view.state.tr.replaceSelection(sliceFor(view.state.schema, pastedTextDoc(text, { plain: shiftHeld.current, language: language ?? "plaintext" }))).scrollIntoView().setMeta("uiEvent", "paste"));
        return true;
      },
      clipboardTextParser: (text: string, _context: unknown, plain: boolean, view: Editor["view"]) => sliceFor(view.state.schema, pastedTextDoc(text, { plain })),
      clipboardTextSerializer: (slice: Slice) => clipboardMarkdown(slice),
      transformPastedHTML: (html: string) => cleanPastedHTML(html),
      handleDrop: (view: Editor["view"], event: DragEvent, _slice: Slice, moved: boolean) => {
        if (moved) return false;
        const files = imageFiles(event.dataTransfer?.files);
        if (!files.length) return false;
        event.preventDefault();
        actions.current.attach(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
    },
    onUpdate: ({ editor }: { editor: Editor }) => {
      const json = editor.getJSON();
      if (docIsEmpty(json) && !draftImages(json).length) drafts.delete(nodeId); else drafts.set(nodeId, json);
      setDoc(json);
    },
  // The component is keyed by node; everything that changes later goes through refs.
  }), []);
  const editor = useEditor(options, []);

  useEffect(() => { if (editor && editor.isEditable === disabled) editor.setEditable(!disabled, false); }, [editor, disabled]);
  // The placeholder plugin reads the current text on the next view update.
  useEffect(() => { if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta("composerPlaceholder", placeholder)); }, [editor, placeholder]);

  actions.current.submit = () => {
    if (!editor || editor.isDestroyed || props.current.disabled) return;
    const json = editor.getJSON(); const current = draftImages(json).map(image => imageStatus(image));
    if (current.includes("uploading")) return flash("图片上传中，完成后再发送");
    if (current.some(entry => entry === "failed" || entry === "missing")) return flash("有图片上传失败，请重试或移除后再发送");
    const markdown = docToMarkdown(json, { imageSrc: attrs => composerUploads.src(attrs) });
    if (!markdown) return;
    props.current.onSend(markdown);
    editor.commands.clearContent(true);
  };
  actions.current.attach = (files, at) => {
    if (!editor || editor.isDestroyed || props.current.disabled) return;
    const { accepted, hint: problem } = acceptImages(files, props.current.imagesEnabled);
    if (problem) flash(problem);
    if (!accepted.length) return;
    const pills: JSONContent[] = accepted.map(file => { const name = attachmentName(file); return { type: IMAGE_NODE, attrs: { key: composerUploads.start(props.current.client, file, name), alt: name, src: null } }; });
    const { state } = editor;
    let from = at ?? state.selection.from; let to = at ?? state.selection.to;
    const $from = state.doc.resolve(from);
    // Pills are inline text content; in a code block they go into a new paragraph after it.
    if ($from.parent.type.spec.code || !$from.parent.inlineContent) {
      const after = $from.parent.inlineContent ? $from.after() : from;
      editor.chain().focus().insertContentAt(after, { type: "paragraph", content: pills.flatMap((pill, index) => index ? [{ type: "text", text: " " }, pill] : [pill]) }).run();
      return;
    }
    const before = $from.parentOffset > 0 ? state.doc.textBetween(from - 1, from, "", "￼") : "";
    const $to = state.doc.resolve(to);
    const after = $to.parentOffset < $to.parent.content.size ? state.doc.textBetween(to, to + 1, "", "￼") : "";
    const space = { type: "text", text: " " };
    const content = [...(before && !/\s/.test(before) ? [space] : []), ...pills.flatMap((pill, index) => index ? [space, pill] : [pill]), ...(/^\s/.test(after) ? [] : [space])];
    if (from > to) [from, to] = [to, from];
    editor.chain().focus().insertContentAt({ from, to }, content).run();
  };
  useImperativeHandle(ref, () => ({
    submit: () => actions.current.submit(),
    attach: files => actions.current.attach(files),
    focus: () => { editor?.commands.focus(); },
  }), [editor]);

  const remove = (identity: string) => {
    if (!editor || editor.isDestroyed) return;
    editor.chain().focus().command(({ tr }) => {
      const positions: number[] = [];
      tr.doc.descendants((node, pos) => { if (node.type.name === IMAGE_NODE && imageIdentity(node.attrs) === identity) positions.push(pos); });
      for (const pos of positions.reverse()) {
        const $pos = tr.doc.resolve(pos);
        const before = $pos.parentOffset > 0 ? tr.doc.textBetween(pos - 1, pos, "", "￼") : "";
        const after = pos + 1 < $pos.end() ? tr.doc.textBetween(pos + 1, pos + 2, "", "￼") : "";
        tr.delete(pos, pos + 1 + (after === " " && (!before || before === " ") ? 1 : 0));
      }
      return positions.length > 0;
    }).run();
  };

  return <div className={`composer-body${disabled ? " is-disabled" : ""}`}>
    {images.length > 0 && <div className="composer-images" aria-label="已添加的图片">{images.map((image, index) => <ComposerThumb key={image.identity} image={image} number={index + 1} client={client} remove={() => remove(image.identity)} retry={() => { if (image.key) composerUploads.retry(client, image.key); }} />)}</div>}
    <ImageOrderContext value={order}>
      {editor ? <EditorContent editor={editor} className="composer-editor-scroll" />
        : <div className="composer-editor-scroll"><div className="composer-editor" role="textbox" aria-multiline="true" aria-label="消息" aria-placeholder={placeholder} aria-disabled={disabled || undefined}><p className="is-editor-empty" data-placeholder={placeholder} /></div></div>}
    </ImageOrderContext>
  </div>;
}

function ComposerThumb({ image, number, client, remove, retry }: { image: DraftImage; number: number; client: BatonClient; remove: () => void; retry: () => void }) {
  const { cwd } = useImageContext();
  const upload = composerUploads.get(image.key);
  const state = useImageUrl(upload ? null : imageSource(image.src, cwd), client);
  const url = upload?.preview ?? (state.status === "ready" ? state.url : undefined);
  const status: ComposerImageStatus = imageStatus(image);
  const [open, setOpen] = useState(false);
  const label = `图片 #${number}`;
  const title = status === "uploading" ? `${image.alt || label} · 上传中…` : status === "failed" ? `上传失败${upload?.error ? `：${upload.error}` : ""} · 点击重试` : status === "missing" ? "图片已失效，请移除" : image.alt || label;
  return <div className={`composer-thumb is-${status}`} title={title}>
    <button type="button" className="composer-thumb-open" aria-label={status === "failed" ? `重试上传${label}` : `查看${label}`} onClick={() => { if (status === "failed") retry(); else if (url) setOpen(true); }}>
      {url ? <img src={url} alt={image.alt} /> : <Icon name="image" size={16} />}
      {status === "failed" && <span className="composer-thumb-retry" aria-hidden="true"><Icon name="refresh" size={14} /></span>}
    </button>
    <span className="composer-thumb-number" aria-hidden="true">{number}</span>
    {status === "uploading" && <span className="composer-thumb-progress" role="progressbar" aria-label={`${label}上传中`} />}
    <button type="button" className="composer-thumb-remove" aria-label={`移除${label}`} title="移除" onClick={remove}>×</button>
    {open && url && <ImageLightbox url={url} alt={image.alt || label} close={() => setOpen(false)} />}
  </div>;
}

/** Image icon in the composer footer; disabled with a reason when the node's agent cannot take images. */
export function AttachImageButton({ enabled, disabled, attach }: { enabled: boolean; disabled: boolean; attach: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <button type="button" className="icon-button composer-attach" aria-label="添加图片" title={enabled ? "添加图片 · 也可直接粘贴或拖入" : "当前 agent 不支持图片"} disabled={disabled || !enabled} onClick={() => input.current?.click()}><Icon name="image" size={16} /></button>
    <input ref={input} type="file" accept={IMAGE_ACCEPT} multiple hidden tabIndex={-1} onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ""; attach(files); }} />
  </>;
}
